import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from './config'
import { SECRET_RULES } from './redact'

export interface SecretLeakHit {
  file: string
  label: string
  count: number
}

export interface AuditReport {
  totalBytes: number
  maxBytes: number
  maxFile: string
  chunkedArchivesScanned: number
  leaks: SecretLeakHit[]
}

const PART_RE = /^(.+\.gz)\.part(\d+)$/

function scanBuffer(rawBuf: Uint8Array, displayName: string, leaks: SecretLeakHit[]): void {
  const content = Buffer.from(rawBuf).toString('latin1')
  for (const rule of SECRET_RULES) {
    rule.regex.lastIndex = 0
    const matches = content.match(rule.regex)
    if (matches && matches.length > 0) {
      leaks.push({ file: displayName, label: rule.label, count: matches.length })
    }
  }
}

export function auditArchiveDirs(dirs: string[], rootDir = REPO_ROOT): AuditReport {
  let totalBytes = 0
  let maxBytes = 0
  let maxFile = ''
  let chunkedArchivesScanned = 0
  const leaks: SecretLeakHit[] = []

  // Group multi-part .gz.partNN files per directory so we reassemble and gunzip them in order
  const chunkGroups = new Map<string, Array<{ partNo: number; fullPath: string }>>()

  function scanDir(dir: string) {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'src' || entry.name === 'tests') continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        scanDir(fullPath)
      } else if (entry.isFile()) {
        const sz = statSync(fullPath).size
        totalBytes += sz
        if (sz > maxBytes) {
          maxBytes = sz
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
  const report = auditArchiveDirs([join(REPO_ROOT, 'conversations'), join(REPO_ROOT, 'antigravity-backup')], REPO_ROOT)

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
  console.log('✅ Verification passed: zero secret leaks (including multi-part archives) and all files well below GitHub limits!')
}
