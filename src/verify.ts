import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from './config'
import { SECRET_RULES } from './redact'

export interface LeakFinding {
  label: string
  file: string
  count: number
}

export interface VerifyReport {
  totalBytes: number
  maxBytes: number
  maxFile: string
  chunkedArchivesScanned: number
  leaks: LeakFinding[]
}

const PART_RE = /^(.+\.gz)\.part(\d+)$/

function scanBuffer(rawBuf: Uint8Array, displayPath: string, leaks: LeakFinding[]) {
  const contentStr = Buffer.from(rawBuf).toString('latin1')
  for (const rule of SECRET_RULES) {
    const re = new RegExp(rule.regex.source, rule.regex.flags)
    let matchCount = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(contentStr)) !== null) {
      if (!m[0].includes('REDACTED_')) matchCount++
    }
    if (matchCount > 0) {
      leaks.push({ label: rule.label, file: displayPath, count: matchCount })
    }
  }
}

export function auditArchiveDirs(dirs: string[], rootDir = REPO_ROOT): VerifyReport {
  let totalBytes = 0
  let maxBytes = 0
  let maxFile = ''
  let chunkedArchivesScanned = 0
  const leaks: LeakFinding[] = []
  const chunkGroups = new Map<string, Array<{ partNo: number; fullPath: string }>>()

  function scanDir(dir: string) {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        scanDir(fullPath)
      } else if (entry.isFile()) {
        const size = statSync(fullPath).size
        totalBytes += size
        if (size > maxBytes) {
          maxBytes = size
          maxFile = relative(rootDir, fullPath)
        }

        const partMatch = entry.name.match(PART_RE)
        if (partMatch) {
          const groupKey = join(dir, partMatch[1])
          const arr = chunkGroups.get(groupKey) || []
          arr.push({ partNo: Number(partMatch[2]), fullPath })
          chunkGroups.set(groupKey, arr)
          continue
        }

        const fileBuf = readFileSync(fullPath)
        const rawBuf: Uint8Array = fullPath.endsWith('.gz') ? Bun.gunzipSync(fileBuf) : fileBuf
        scanBuffer(rawBuf, relative(rootDir, fullPath), leaks)
      }
    }
  }

  for (const d of dirs) {
    scanDir(d)
  }

  // Reassemble, gunzip, and audit all chunked archives (.gz.part01 + .part02 + ...)
  for (const [basePath, parts] of chunkGroups.entries()) {
    parts.sort((a, b) => a.partNo - b.partNo)
    const combined = Buffer.concat(parts.map(p => readFileSync(p.fullPath)))
    const inflated = Bun.gunzipSync(combined)
    chunkedArchivesScanned++
    scanBuffer(inflated, `${relative(rootDir, basePath)} (${parts.length} parts)`, leaks)
  }

  return { totalBytes, maxBytes, maxFile, chunkedArchivesScanned, leaks }
}

if (import.meta.main) {
  const report = auditArchiveDirs(
    [join(REPO_ROOT, 'conversations'), join(REPO_ROOT, 'antigravity-backup'), join(REPO_ROOT, 'agent-backups')],
    REPO_ROOT,
  )

  for (const leak of report.leaks) {
    console.error(`❌ Secret leak [${leak.label}] in ${leak.file} (${leak.count} occurrence(s))`)
  }

  const totalLeakCount = report.leaks.reduce((sum, l) => sum + l.count, 0)
  console.log({
    archiveTotalMB: (report.totalBytes / 1048576).toFixed(2),
    largestFile: report.maxFile || 'none',
    largestFileMB: (report.maxBytes / 1048576).toFixed(2),
    chunkedArchivesScanned: report.chunkedArchivesScanned,
    secretLeaksFound: totalLeakCount,
  })

  if (totalLeakCount > 0 || report.maxBytes > 95 * 1024 * 1024) {
    process.exit(1)
  }
  console.log('✅ Verification passed: zero secret leaks (across Antigravity, Claude, Codex & Cursor archives) and all files below GitHub limits!')
}
