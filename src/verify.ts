import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from './config'
import { SECRET_RULES } from './redact'

let totalBytes = 0
let maxBytes = 0
let maxFile = ''
let secretLeaks = 0

function scanDir(dir: string) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'src') continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      scanDir(fullPath)
    } else if (entry.isFile()) {
      const sz = statSync(fullPath).size
      totalBytes += sz
      if (sz > maxBytes) {
        maxBytes = sz
        maxFile = relative(REPO_ROOT, fullPath)
      }

      let rawBuf = readFileSync(fullPath)
      if (fullPath.endsWith('.gz')) {
        rawBuf = Buffer.from(Bun.gunzipSync(rawBuf))
      }
      const content = rawBuf.toString('latin1')
      for (const rule of SECRET_RULES) {
        rule.regex.lastIndex = 0
        const matches = content.match(rule.regex)
        if (matches && matches.length > 0) {
          console.error(`❌ Secret leak [${rule.label}] in ${relative(REPO_ROOT, fullPath)} (${matches.length} occurrence(s))`)
          secretLeaks += matches.length
        }
      }
    }
  }
}

scanDir(join(REPO_ROOT, 'conversations'))
scanDir(join(REPO_ROOT, 'antigravity-backup'))

console.log({
  archiveTotalMB: (totalBytes / 1048576).toFixed(2),
  largestFile: maxFile || 'none',
  largestFileMB: (maxBytes / 1048576).toFixed(2),
  secretLeaksFound: secretLeaks,
})

if (secretLeaks > 0 || maxBytes > 95 * 1024 * 1024) {
  process.exit(1)
}
console.log('✅ Verification passed: zero secret leaks and all files well below GitHub limits!')
