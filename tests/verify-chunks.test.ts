import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditArchiveDirs } from '../src/verify'

const tempDirs: string[] = []
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'agy-sync-verify-'))
  tempDirs.push(d)
  return d
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('verify multi-part chunked archive scanning', () => {
  test('reassembles .gz.part01 + .gz.part02 and catches secret hidden in part02', () => {
    const root = makeTempDir()
    const chunksDir = join(root, 'antigravity-backup', 'db-chunks')
    mkdirSync(chunksDir, { recursive: true })

    // Create a payload where the secret sits near the end (part02 after splitting)
    const filler = 'hello world safe text '.repeat(5000)
    const payload = Buffer.from(
      `${filler} POSTMAN_API_KEY=PMAK-000000000000000000000000-leakedInsideSecondChunk999`,
      'utf8',
    )
    const gz = Bun.gzipSync(payload)
    const half = Math.floor(gz.byteLength / 2)
    writeFileSync(join(chunksDir, 'big-conv.db.gz.part01'), gz.subarray(0, half))
    writeFileSync(join(chunksDir, 'big-conv.db.gz.part02'), gz.subarray(half))

    const report = auditArchiveDirs([join(root, 'antigravity-backup')], root)
    expect(report.chunkedArchivesScanned).toBe(1)
    expect(report.leaks.length).toBe(1)
    expect(report.leaks[0].label).toBe('POSTMAN_API_KEY')
    expect(report.leaks[0].file).toContain('big-conv.db.gz (2 parts)')
  })

  test('passes cleanly when chunked archive has zero secrets', () => {
    const root = makeTempDir()
    const chunksDir = join(root, 'antigravity-backup', 'db-chunks')
    mkdirSync(chunksDir, { recursive: true })

    const gz = Bun.gzipSync(Buffer.from('clean engineering conversation '.repeat(2000), 'utf8'))
    const half = Math.floor(gz.byteLength / 2)
    writeFileSync(join(chunksDir, 'clean.db.gz.part01'), gz.subarray(0, half))
    writeFileSync(join(chunksDir, 'clean.db.gz.part02'), gz.subarray(half))

    const report = auditArchiveDirs([join(root, 'antigravity-backup')], root)
    expect(report.chunkedArchivesScanned).toBe(1)
    expect(report.leaks.length).toBe(0)
  })
})
