import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProjectAdapter,
  encodeLenDelim,
  encodeVarint,
  ensureLocalProjectId,
  getProtoStepCount,
  parseProtoFields,
  patchAgyhubSummariesProto,
  readVarint,
  rewriteForeignBrainPaths,
  toWorkspaceUris,
} from '../src/protobuf'

const tempDirs: string[] = []
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'agy-sync-proto-'))
  tempDirs.push(d)
  return d
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function buildSampleRawSummary(opts: {
  title?: string
  steps: number
  plainWsUris: string[]
  encodedWsUris: string[]
  projectId?: string
}): Buffer {
  const wsInfos = opts.plainWsUris.map(u =>
    Buffer.concat([
      encodeLenDelim(1, Buffer.from(u, 'utf8')),
      encodeLenDelim(2, Buffer.from(u, 'utf8')),
      encodeLenDelim(4, Buffer.from('develop', 'utf8')),
    ]),
  )

  const f17Parts: Buffer[] = [
    ...wsInfos.map(w => encodeLenDelim(1, w)),
    ...opts.encodedWsUris.map(u => encodeLenDelim(7, Buffer.from(u, 'utf8'))),
  ]
  if (opts.projectId) {
    f17Parts.push(encodeLenDelim(18, Buffer.from(opts.projectId, 'utf8')))
  }
  const f17 = Buffer.concat(f17Parts)

  const topParts: Buffer[] = []
  if (opts.title) topParts.push(encodeLenDelim(1, Buffer.from(opts.title, 'utf8')))
  // f2: varint step_count
  topParts.push(Buffer.concat([encodeVarint((2n << 3n) | 0n), encodeVarint(opts.steps)]))
  for (const w of wsInfos) topParts.push(encodeLenDelim(9, w))
  topParts.push(encodeLenDelim(17, f17))
  return Buffer.concat(topParts)
}

describe('protobuf wire helpers & Antigravity 2.x remapping', () => {
  test('varint encode/decode roundtrip', () => {
    for (const n of [0n, 1n, 127n, 128n, 16598n, 1795110601n]) {
      const enc = encodeVarint(n)
      const [dec, next] = readVarint(enc, 0)
      expect(dec).toBe(n)
      expect(next).toBe(enc.length)
    }
  })

  test('adapts workspace URIs, drops non-existent foreign workspace, and rewrites project_id', () => {
    const dir = makeTempDir()
    const targetWs = join(dir, 'my-app')
    mkdirSync(targetWs, { recursive: true })
    const targetUris = toWorkspaceUris(targetWs)

    const raw = buildSampleRawSummary({
      title: 'Fix Auth Flow',
      steps: 420,
      plainWsUris: ['file:///z:/does-not-exist/my-app', 'file:///z:/does-not-exist/other-backend'],
      encodedWsUris: ['file:///z%3A/does-not-exist/my-app', 'file:///z%3A/does-not-exist/other-backend'],
      projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    })

    const adapter = createProjectAdapter({
      projectSlug: 'my-app',
      targetUris,
      localProjectId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    })

    const adapted = adapter.adaptRawSummaryProto(raw)
    expect(getProtoStepCount(adapted)).toBe(420)

    const fields = parseProtoFields(adapted)
    // Only 1 workspace info should remain (non-existent other-backend dropped)
    const f9List = fields.filter(f => f.fieldNo === 9)
    expect(f9List.length).toBe(1)
    const f9Sub = parseProtoFields(f9List[0].valueBytes)
    expect(Buffer.from(f9Sub.find(x => x.fieldNo === 1)!.valueBytes).toString('utf8')).toBe(targetUris.plainUri)

    const f17 = fields.find(f => f.fieldNo === 17)!
    const f17Sub = parseProtoFields(f17.valueBytes)
    const f7s = f17Sub.filter(x => x.fieldNo === 7).map(x => Buffer.from(x.valueBytes).toString('utf8'))
    expect(f7s).toEqual([targetUris.encodedUri])
    const f18 = Buffer.from(f17Sub.find(x => x.fieldNo === 18)!.valueBytes).toString('utf8')
    expect(f18).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  })

  test('appends missing project_id (f18) and remaps legacyProjectSlugs', () => {
    const dir = makeTempDir()
    const targetWs = join(dir, 'new-name')
    mkdirSync(targetWs, { recursive: true })
    const targetUris = toWorkspaceUris(targetWs)

    const raw = buildSampleRawSummary({
      steps: 105,
      plainWsUris: ['file:///d:/old-base-template'],
      encodedWsUris: ['file:///d%3A/old-base-template'],
      // No projectId (pre-2.x conversation)
    })

    const adapter = createProjectAdapter({
      projectSlug: 'new-name',
      legacyProjectSlugs: ['old-base-template'],
      targetUris,
      localProjectId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    })

    const adapted = adapter.adaptRawSummaryProto(raw)
    const f17 = parseProtoFields(adapted).find(x => x.fieldNo === 17)!
    const f17Sub = parseProtoFields(f17.valueBytes)
    const f18 = Buffer.from(f17Sub.find(x => x.fieldNo === 18)!.valueBytes).toString('utf8')
    const f7 = Buffer.from(f17Sub.find(x => x.fieldNo === 7)!.valueBytes).toString('utf8')
    expect(f18).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc')
    expect(f7).toBe(targetUris.encodedUri)
  })

  test('patchAgyhubSummariesProto preserves unrelated projects byte-for-byte & rebinds newer local chats in-place', () => {
    const root = makeTempDir()
    const agyDir = join(root, '.gemini', 'antigravity')
    const targetWs = join(root, 'my-app')
    mkdirSync(agyDir, { recursive: true })
    mkdirSync(targetWs, { recursive: true })
    const targetUris = toWorkspaceUris(targetWs)
    const localPid = 'd197e124-2b46-7b82-eb2e-fed011db8749'

    const unrelatedRaw = buildSampleRawSummary({
      title: 'Unrelated App',
      steps: 50,
      plainWsUris: ['file:///e:/other-project'],
      encodedWsUris: ['file:///e%3A/other-project'],
      projectId: 'da403ebc-f241-d68c-e7bc-7f7b4ec6f67b',
    })
    const newerLocalRaw = buildSampleRawSummary({
      title: 'My App Newer Chat',
      steps: 900, // Newer than archive's 500 steps!
      plainWsUris: ['file:///d:/my-app'],
      encodedWsUris: ['file:///d%3A/my-app'],
      projectId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    })
    const archiveRaw = buildSampleRawSummary({
      title: 'My App Newer Chat',
      steps: 500,
      plainWsUris: ['file:///d:/my-app'],
      encodedWsUris: ['file:///d%3A/my-app'],
      projectId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    })
    const missingFromHubRaw = buildSampleRawSummary({
      title: 'Brand New From Other PC',
      steps: 77,
      plainWsUris: ['file:///d:/my-app'],
      encodedWsUris: ['file:///d%3A/my-app'],
      projectId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    })

    const initialHub = Buffer.concat([
      encodeLenDelim(
        1,
        Buffer.concat([encodeLenDelim(1, Buffer.from('unrelated-id', 'utf8')), encodeLenDelim(2, unrelatedRaw)]),
      ),
      encodeLenDelim(
        1,
        Buffer.concat([encodeLenDelim(1, Buffer.from('newer-local-id', 'utf8')), encodeLenDelim(2, newerLocalRaw)]),
      ),
    ])
    writeFileSync(join(agyDir, 'agyhub_summaries_proto.pb'), initialHub)

    const adapter = createProjectAdapter({ projectSlug: 'my-app', targetUris, localProjectId: localPid })
    const adaptedRawById = new Map<string, Buffer>([
      ['newer-local-id', adapter.adaptRawSummaryProto(archiveRaw)],
      ['brand-new-id', adapter.adaptRawSummaryProto(missingFromHubRaw)],
    ])
    const remoteStepsById = new Map<string, number>([
      ['newer-local-id', 500],
      ['brand-new-id', 77],
    ])

    const updates = patchAgyhubSummariesProto({ agyDir, adaptedRawById, remoteStepsById, adapter })
    expect(updates).toBe(2)

    const updatedHub = readFileSync(join(agyDir, 'agyhub_summaries_proto.pb'))
    const entries = parseProtoFields(updatedHub)
    expect(entries.length).toBe(3)

    const map = new Map<string, Buffer>()
    for (const e of entries) {
      const ef = parseProtoFields(e.valueBytes)
      const k = Buffer.from(ef.find(x => x.fieldNo === 1)!.valueBytes).toString('utf8')
      const v = Buffer.from(ef.find(x => x.fieldNo === 2)!.valueBytes)
      map.set(k, v)
    }

    // 1. Unrelated project untouched byte-for-byte
    expect(Buffer.compare(map.get('unrelated-id')!, unrelatedRaw)).toBe(0)
    // 2. Newer local chat KEPT 900 steps (not downgraded to 500!) AND got rebound to localPid!
    expect(getProtoStepCount(map.get('newer-local-id')!)).toBe(900)
    expect(map.get('newer-local-id')!.toString('utf8')).toContain(localPid)
    expect(map.get('newer-local-id')!.toString('utf8')).not.toContain('dddddddd-dddd')
    // 3. Missing chat appended with localPid
    expect(getProtoStepCount(map.get('brand-new-id')!)).toBe(77)
    expect(map.get('brand-new-id')!.toString('utf8')).toContain(localPid)
  })

  test('ensureLocalProjectId auto-creates ~/.gemini/config/projects/<uuid>.json on new machines', () => {
    const root = makeTempDir()
    const agyDir = join(root, '.gemini', 'antigravity')
    const targetWs = join(root, 'fresh-project')
    mkdirSync(agyDir, { recursive: true })
    mkdirSync(targetWs, { recursive: true })
    const targetUris = toWorkspaceUris(targetWs)

    const first = ensureLocalProjectId(agyDir, targetWs, targetUris, 'fresh-project')
    expect(first.created).toBe(true)
    expect(first.projectId).toBeTruthy()
    expect(existsSync(join(root, '.gemini', 'config', 'projects', `${first.projectId}.json`))).toBe(true)

    // Second call detects the existing config without creating another
    const second = ensureLocalProjectId(agyDir, targetWs, targetUris, 'fresh-project')
    expect(second.created).toBe(false)
    expect(second.projectId).toBe(first.projectId)
  })

  test('rewriteForeignBrainPaths adapts Windows & POSIX user brain links', () => {
    const input = [
      'See [plan](file:///C:/Users/alice/.gemini/antigravity/brain/abc/plan.md)',
      'And file:///c%3A/Users/alice/.gemini/antigravity/brain/abc/walkthrough.md',
      'Plain: C:\\Users\\alice\\.gemini\\antigravity\\brain\\abc\\notes.md',
      'Unix: /Users/bob/.gemini/antigravity/brain/abc/a.md',
    ].join('\n')

    const out = rewriteForeignBrainPaths(input, 'C:\\Users\\mahmoud\\.gemini\\antigravity')
    expect(out).not.toContain('alice')
    expect(out).not.toContain('bob')
    expect(out).toContain('file:///C:/Users/mahmoud/.gemini/antigravity/brain/abc/plan.md')
    expect(out).toContain('file:///c%3A/Users/mahmoud/.gemini/antigravity/brain/abc/walkthrough.md')
    expect(out).toContain('C:\\Users\\mahmoud\\.gemini\\antigravity\\brain\\abc\\notes.md')
    expect(out).toContain('C:/Users/mahmoud/.gemini/antigravity/brain/abc/a.md')
  })
})
