import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const PROTO_WIRE_SCHEMA_ID = 'd197e124-2b46-7b82-eb2e-fed011db8749'
export const ARCHIVE_SCHEMA_REV = 'acs-2.0-d197e124'

export interface WorkspaceUris {
  plainUri: string
  encodedUri: string
}

export interface ProtoField {
  fieldNo: number
  wireType: number
  rawBytes: Uint8Array
  valueBytes: Uint8Array
}

export function readVarint(buf: Uint8Array, offset: number): [bigint, number] {
  let res = 0n
  let shift = 0n
  let pos = offset
  while (pos < buf.length) {
    const b = buf[pos++]
    res |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return [res, pos]
    shift += 7n
  }
  throw new Error('Truncated protobuf varint')
}

export function encodeVarint(val: bigint | number): Buffer {
  let n = typeof val === 'bigint' ? val : BigInt(val)
  const bytes: number[] = []
  while (n >= 0x80n) {
    bytes.push(Number(n & 0x7fn) | 0x80)
    n >>= 7n
  }
  bytes.push(Number(n))
  return Buffer.from(bytes)
}

export function encodeLenDelim(fieldNo: number, payload: Uint8Array): Buffer {
  return Buffer.concat([
    encodeVarint((BigInt(fieldNo) << 3n) | 2n),
    encodeVarint(payload.length),
    Buffer.from(payload),
  ])
}

export function parseProtoFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = []
  let pos = 0
  while (pos < buf.length) {
    const start = pos
    const [tag, p1] = readVarint(buf, pos)
    const fieldNo = Number(tag >> 3n)
    const wireType = Number(tag & 7n)
    if (wireType === 0) {
      const [, p2] = readVarint(buf, p1)
      out.push({ fieldNo, wireType, rawBytes: buf.subarray(start, p2), valueBytes: buf.subarray(p1, p2) })
      pos = p2
    } else if (wireType === 1) {
      const p2 = p1 + 8
      out.push({ fieldNo, wireType, rawBytes: buf.subarray(start, p2), valueBytes: buf.subarray(p1, p2) })
      pos = p2
    } else if (wireType === 5) {
      const p2 = p1 + 4
      out.push({ fieldNo, wireType, rawBytes: buf.subarray(start, p2), valueBytes: buf.subarray(p1, p2) })
      pos = p2
    } else if (wireType === 2) {
      const [lenBig, p2] = readVarint(buf, p1)
      const p3 = p2 + Number(lenBig)
      out.push({ fieldNo, wireType, rawBytes: buf.subarray(start, p3), valueBytes: buf.subarray(p2, p3) })
      pos = p3
    } else {
      throw new Error(`Unsupported protobuf wireType ${wireType} at offset ${start}`)
    }
  }
  return out
}

export function getProtoStepCount(rawSummaryBuf: Uint8Array): number {
  try {
    for (const f of parseProtoFields(rawSummaryBuf)) {
      if (f.fieldNo === 2 && f.wireType === 0) {
        const [v] = readVarint(f.valueBytes, 0)
        return Number(v)
      }
    }
  } catch {}
  return 0
}

export function toWorkspaceUris(wsPath: string): WorkspaceUris {
  const normalized = wsPath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[A-Za-z]:\//.test(normalized)) {
    const drive = normalized[0].toLowerCase()
    const rest = normalized.slice(2)
    return {
      plainUri: `file:///${drive}:${rest}`,
      encodedUri: `file:///${drive}%3A${rest}`,
    }
  }
  return {
    plainUri: `file://${normalized}`,
    encodedUri: `file://${normalized}`,
  }
}

export function uriToLocalPath(uri: string): string | null {
  try {
    const decoded = decodeURIComponent(uri)
    if (decoded.startsWith('file:///')) {
      const rest = decoded.slice('file:///'.length)
      return /^[A-Za-z]:\//.test(rest) ? rest : `/${rest}`
    }
    return null
  } catch {
    return null
  }
}

export function hasLocalProjectConfig(agyDir: string, projectId: string): boolean {
  if (!projectId || projectId === 'outside-of-project') return false
  const projectsConfigDir = join(dirname(agyDir), 'config', 'projects')
  return existsSync(join(projectsConfigDir, `${projectId}.json`))
}

export function getActualConvDbStepCount(convDbPath: string): number {
  if (!existsSync(convDbPath)) return -1
  try {
    const db = new Database(convDbPath, { readonly: true })
    const r = db.query('SELECT count(*) as c FROM steps').get() as { c: number } | null
    db.close()
    return r?.c ?? -1
  } catch {
    return -1
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

export function isLanguageServerRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('tasklist', ['/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true })
      return String(res.stdout || '').toLowerCase().includes('language_server')
    }
    const res = spawnSync('pgrep', ['-f', 'language_server'], { encoding: 'utf8' })
    return res.status === 0
  } catch {
    return false
  }
}

export function isAntigravityRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('tasklist', ['/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true })
      const out = String(res.stdout || '').toLowerCase()
      return out.includes('"antigravity.exe"') || out.includes('language_server')
    }
    if (process.platform === 'darwin') {
      const ui = spawnSync('pgrep', ['-f', 'Antigravity.app'], { encoding: 'utf8' })
      if (ui.status === 0) return true
    } else {
      const ui = spawnSync('pgrep', ['-f', 'antigravity'], { encoding: 'utf8' })
      if (ui.status === 0) return true
    }
    return isLanguageServerRunning()
  } catch {
    return false
  }
}

/**
 * Rewrites foreign-machine Antigravity brain root paths inside restored Markdown/JSON/JSONL
 * artifacts so file:// and local links resolve to the current user's Antigravity brain folder.
 */
export function rewriteForeignBrainPaths(text: string, localAgyDir: string): string {
  const localForward = join(localAgyDir, 'brain').replace(/\\/g, '/')
  const localBackslash = join(localAgyDir, 'brain').replace(/\//g, '\\')
  const localEncodedUri = /^[A-Za-z]:\//.test(localForward)
    ? `file:///${localForward[0].toLowerCase()}%3A${localForward.slice(2)}`
    : `file://${localForward}`
  const localPlainUri = /^[A-Za-z]:\//.test(localForward) ? `file:///${localForward}` : `file://${localForward}`

  // Single-pass alternation prevents secondary regexes from double-matching already-rewritten file:/// URIs
  const forwardRe =
    /(file:\/\/\/[A-Za-z]%3[Aa]\/Users\/[^/\s"'`<>]+\/\.gemini\/antigravity\/brain)|(file:\/\/\/[A-Za-z]:\/Users\/[^/\s"'`<>]+\/\.gemini\/antigravity\/brain)|(file:\/\/\/(?:Users|home)\/[^/\s"'`<>]+\/\.gemini\/antigravity\/brain)|((?:[A-Za-z]:\/Users|\/Users|\/home)\/[^/\s"'`<>]+\/\.gemini\/antigravity\/brain)/g

  let out = text.replace(forwardRe, (_m, gEnc, gPlainWin, gPosixUri) => {
    if (gEnc) return localEncodedUri
    if (gPlainWin || gPosixUri) return localPlainUri
    return localForward
  })

  // Windows backslash paths (both JSON-escaped \\ and plain \)
  out = out.replace(
    /[A-Za-z]:\\\\Users\\\\[^\\\s"'`<>]+\\\\\.gemini\\\\antigravity\\\\brain/g,
    localBackslash.replace(/\\/g, '\\\\'),
  )
  out = out.replace(
    /[A-Za-z]:\\Users\\[^\\\s"'`<>]+\\\.gemini\\antigravity\\brain/g,
    localBackslash,
  )
  return out
}

function detectGitDefaultBranch(workspacePath: string): string {
  try {
    const res = spawnSync('git', ['-C', workspacePath, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' })
    const branch = String(res.stdout || '').trim()
    if (branch) return branch
  } catch {}
  return 'main'
}

/**
 * Ensures a local Antigravity 2.x project config JSON exists for the target workspace.
 * If this is a brand-new machine where the folder hasn't been opened in Antigravity yet,
 * creates ~/.gemini/config/projects/<uuid>.json automatically so restored chats bind cleanly.
 */
export function ensureLocalProjectId(
  agyDir: string,
  targetWorkspacePath: string | null,
  targetUris: WorkspaceUris | null,
  projectSlug: string,
): { projectId: string | null; created: boolean } {
  const existing = detectLocalProjectId(agyDir, targetUris)
  if (existing) return { projectId: existing, created: false }
  if (!targetWorkspacePath || !targetUris || !existsSync(targetWorkspacePath)) {
    return { projectId: null, created: false }
  }

  const projectsConfigDir = join(dirname(agyDir), 'config', 'projects')
  mkdirSync(projectsConfigDir, { recursive: true })
  const newId = randomUUID()
  const isGitRepo = existsSync(join(targetWorkspacePath, '.git'))
  const resource = isGitRepo
    ? {
        gitFolder: {
          folderUri: targetUris.encodedUri,
          defaultBranch: detectGitDefaultBranch(targetWorkspacePath),
        },
      }
    : {
        folder: {
          folderUri: targetUris.encodedUri,
        },
      }

  const cfg = {
    id: newId,
    name: projectSlug,
    projectResources: {
      resources: [resource],
    },
    permissionGrants: {
      v2Migrated: true,
    },
    settings: {},
    isWorkspaceOnly: false,
  }

  writeFileSync(join(projectsConfigDir, `${newId}.json`), JSON.stringify(cfg, null, 2), 'utf8')
  return { projectId: newId, created: true }
}

/**
 * Auto-detects the Antigravity 2.x local project_id UUID for the target workspace
 * by scanning ~/.gemini/config/projects/*.json (with a SQLite fallback).
 */
export function detectLocalProjectId(agyDir: string, targetUris: WorkspaceUris | null): string | null {
  if (!targetUris) return null
  const targetNorm = decodeURIComponent(targetUris.encodedUri).toLowerCase()

  const projectsConfigDir = join(dirname(agyDir), 'config', 'projects')
  if (existsSync(projectsConfigDir)) {
    for (const f of readdirSync(projectsConfigDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const cfg = JSON.parse(readFileSync(join(projectsConfigDir, f), 'utf8'))
        const resources: any[] = cfg?.projectResources?.resources || []
        for (const r of resources) {
          const folderUri = r?.gitFolder?.folderUri || r?.folder?.folderUri || ''
          if (folderUri && decodeURIComponent(String(folderUri)).toLowerCase() === targetNorm) {
            return String(cfg.id)
          }
        }
      } catch {}
    }
  }

  const sumDbPath = join(agyDir, 'conversation_summaries.db')
  if (existsSync(sumDbPath)) {
    try {
      const db = new Database(sumDbPath, { readonly: true })
      const rows = db
        .query("SELECT workspace_uris, project_id FROM conversation_summaries WHERE project_id != '' AND project_id != 'outside-of-project'")
        .all() as Array<{ workspace_uris: string; project_id: string }>
      db.close()
      for (const r of rows) {
        if (
          decodeURIComponent(r.workspace_uris || '').toLowerCase().includes(targetNorm) &&
          (!existsSync(projectsConfigDir) || hasLocalProjectConfig(agyDir, r.project_id))
        ) {
          return r.project_id
        }
      }
    } catch {}
  }

  return null
}

export interface ProjectAdapterOptions {
  projectSlug: string
  legacyProjectSlugs?: string[]
  targetUris: WorkspaceUris | null
  localProjectId: string | null
}

export function createProjectAdapter(opts: ProjectAdapterOptions) {
  const slugLower = opts.projectSlug.toLowerCase()
  const legacyLowers = (opts.legacyProjectSlugs ?? []).map(s => s.toLowerCase()).filter(Boolean)

  function shouldDropMissingUri(uri: string): boolean {
    const localPath = uriToLocalPath(uri)
    if (!localPath) return false
    return !existsSync(localPath)
  }

  function shouldMapUri(uri: string, hasExplicitSlug: boolean): boolean {
    const low = uri.toLowerCase()
    if (low.includes(slugLower)) return true
    if (!hasExplicitSlug && legacyLowers.some(leg => low.includes(leg))) return true
    return false
  }

  function adaptWorkspaceInfoProto(buf: Uint8Array, hasExplicitSlug: boolean): Buffer | null {
    if (!opts.targetUris) return Buffer.from(buf)
    const fields = parseProtoFields(buf)
    const parts: Buffer[] = []
    let mappedAny = false
    let firstUri: string | null = null

    for (const f of fields) {
      if ((f.fieldNo === 1 || f.fieldNo === 2) && f.wireType === 2) {
        const str = Buffer.from(f.valueBytes).toString('utf8')
        if (!firstUri) firstUri = str
        if (shouldMapUri(str, hasExplicitSlug)) {
          mappedAny = true
          parts.push(encodeLenDelim(f.fieldNo, Buffer.from(opts.targetUris.plainUri, 'utf8')))
          continue
        }
      }
      parts.push(Buffer.from(f.rawBytes))
    }

    if (!mappedAny && firstUri && shouldDropMissingUri(firstUri)) {
      return null
    }
    return Buffer.concat(parts)
  }

  function adaptTrajectoryMetadataProto(buf: Uint8Array): Buffer {
    if (!opts.targetUris && !opts.localProjectId) return Buffer.from(buf)
    const fields = parseProtoFields(buf)
    const hasExplicitSlug = fields.some(
      f => f.fieldNo === 7 && f.wireType === 2 && Buffer.from(f.valueBytes).toString('utf8').toLowerCase().includes(slugLower),
    )

    const parts: Buffer[] = []
    const seenF7 = new Set<string>()
    let sawF18 = false

    for (const f of fields) {
      if (f.fieldNo === 1 && f.wireType === 2 && opts.targetUris) {
        const adaptedWs = adaptWorkspaceInfoProto(f.valueBytes, hasExplicitSlug)
        if (adaptedWs) parts.push(encodeLenDelim(1, adaptedWs))
      } else if (f.fieldNo === 7 && f.wireType === 2 && opts.targetUris) {
        const str = Buffer.from(f.valueBytes).toString('utf8')
        const isMapped = shouldMapUri(str, hasExplicitSlug)
        if (!isMapped && shouldDropMissingUri(str)) continue
        const mapped = isMapped ? opts.targetUris.encodedUri : str
        if (!seenF7.has(mapped)) {
          seenF7.add(mapped)
          parts.push(encodeLenDelim(7, Buffer.from(mapped, 'utf8')))
        }
      } else if (f.fieldNo === 18 && f.wireType === 2 && opts.localProjectId) {
        sawF18 = true
        parts.push(encodeLenDelim(18, Buffer.from(opts.localProjectId, 'utf8')))
      } else {
        parts.push(Buffer.from(f.rawBytes))
      }
    }

    if (opts.targetUris && !seenF7.has(opts.targetUris.encodedUri)) {
      parts.push(encodeLenDelim(7, Buffer.from(opts.targetUris.encodedUri, 'utf8')))
    }
    if (opts.localProjectId && !sawF18) {
      parts.push(encodeLenDelim(18, Buffer.from(opts.localProjectId, 'utf8')))
    }
    return Buffer.concat(parts)
  }

  function adaptRawSummaryProto(buf: Uint8Array): Buffer {
    if (!opts.targetUris && !opts.localProjectId) return Buffer.from(buf)
    const fields = parseProtoFields(buf)
    const hasExplicitSlug = fields.some(f => {
      if (f.fieldNo !== 9 || f.wireType !== 2) return false
      return parseProtoFields(f.valueBytes).some(
        sf => (sf.fieldNo === 1 || sf.fieldNo === 2) && sf.wireType === 2 && Buffer.from(sf.valueBytes).toString('utf8').toLowerCase().includes(slugLower),
      )
    })

    const parts: Buffer[] = []
    for (const f of fields) {
      if (f.fieldNo === 9 && f.wireType === 2 && opts.targetUris) {
        const adaptedWs = adaptWorkspaceInfoProto(f.valueBytes, hasExplicitSlug)
        if (adaptedWs) parts.push(encodeLenDelim(9, adaptedWs))
      } else if (f.fieldNo === 17 && f.wireType === 2) {
        parts.push(encodeLenDelim(17, adaptTrajectoryMetadataProto(f.valueBytes)))
      } else {
        parts.push(Buffer.from(f.rawBytes))
      }
    }
    return Buffer.concat(parts)
  }

  function adaptWorkspaceUrisJson(rawUris: string): string {
    if (!opts.targetUris) return rawUris
    try {
      const arr: string[] = JSON.parse(rawUris || '[]')
      const hasExplicit = arr.some(u => u.toLowerCase().includes(slugLower))
      const mapped: string[] = []
      for (const u of arr) {
        if (shouldMapUri(u, hasExplicit)) {
          mapped.push(opts.targetUris.encodedUri)
        } else if (!shouldDropMissingUri(u)) {
          mapped.push(u)
        }
      }
      if (!mapped.includes(opts.targetUris.encodedUri)) {
        mapped.unshift(opts.targetUris.encodedUri)
      }
      return JSON.stringify([...new Set(mapped)])
    } catch {
      return JSON.stringify([opts.targetUris.encodedUri])
    }
  }

  function rawSummaryMatchesProject(rawSummaryBuf: Uint8Array): boolean {
    const low = Buffer.from(rawSummaryBuf).toString('utf8').toLowerCase()
    return low.includes(slugLower)
  }

  return {
    adaptWorkspaceUrisJson,
    adaptTrajectoryMetadataProto,
    adaptRawSummaryProto,
    rawSummaryMatchesProject,
  }
}

export interface PatchAgyhubOptions {
  agyDir: string
  adaptedRawById: Map<string, Buffer>
  remoteStepsById: Map<string, number>
  adapter: ReturnType<typeof createProjectAdapter>
}

/**
 * Losslessly updates Antigravity 2.x's primary summary index (agyhub_summaries_proto.pb)
 * while preserving all unrelated projects byte-for-byte and rebinding newer local
 * project conversations in-place without downgrading their step count.
 */
export function patchAgyhubSummariesProto(opts: PatchAgyhubOptions): number {
  const hubPbPath = join(opts.agyDir, 'agyhub_summaries_proto.pb')
  if (!existsSync(hubPbPath)) return 0

  const bakPath = `${hubPbPath}.bak`
  if (!existsSync(bakPath)) {
    copyFileSync(hubPbPath, bakPath)
  }

  const origHub = readFileSync(hubPbPath)
  const topFields = parseProtoFields(origHub)
  const outEntries: Buffer[] = []
  const handledIds = new Set<string>()
  let hubUpdated = 0

  for (const tf of topFields) {
    if (tf.fieldNo === 1 && tf.wireType === 2) {
      const entryFields = parseProtoFields(tf.valueBytes)
      const keyField = entryFields.find(ef => ef.fieldNo === 1 && ef.wireType === 2)
      const valField = entryFields.find(ef => ef.fieldNo === 2 && ef.wireType === 2)
      const convId = keyField ? Buffer.from(keyField.valueBytes).toString('utf8') : ''

      if (convId && opts.adaptedRawById.has(convId)) {
        const targetRaw = opts.adaptedRawById.get(convId)!
        const existingSteps = valField ? getProtoStepCount(valField.valueBytes) : 0
        const remoteSteps = opts.remoteStepsById.get(convId) ?? 0

        handledIds.add(convId)
        const nextRaw = existingSteps > remoteSteps && valField
          ? opts.adapter.adaptRawSummaryProto(valField.valueBytes)
          : targetRaw
        const newEntry = Buffer.concat([
          encodeLenDelim(1, Buffer.from(convId, 'utf8')),
          encodeLenDelim(2, nextRaw),
        ])
        if (Buffer.compare(Buffer.from(tf.valueBytes), newEntry) !== 0) {
          hubUpdated++
        }
        outEntries.push(encodeLenDelim(1, newEntry))
        continue
      }

      if (convId && valField && opts.adapter.rawSummaryMatchesProject(valField.valueBytes)) {
        const nextRaw = opts.adapter.adaptRawSummaryProto(valField.valueBytes)
        const newEntry = Buffer.concat([
          encodeLenDelim(1, Buffer.from(convId, 'utf8')),
          encodeLenDelim(2, nextRaw),
        ])
        if (Buffer.compare(Buffer.from(tf.valueBytes), newEntry) !== 0) {
          hubUpdated++
        }
        outEntries.push(encodeLenDelim(1, newEntry))
        continue
      }
    }
    outEntries.push(Buffer.from(tf.rawBytes))
  }

  for (const [convId, targetRaw] of opts.adaptedRawById.entries()) {
    if (handledIds.has(convId)) continue
    const newEntry = Buffer.concat([
      encodeLenDelim(1, Buffer.from(convId, 'utf8')),
      encodeLenDelim(2, targetRaw),
    ])
    outEntries.push(encodeLenDelim(1, newEntry))
    hubUpdated++
  }

  const finalHub = Buffer.concat(outEntries)
  if (Buffer.compare(origHub, finalHub) !== 0) {
    const tmpHub = `${hubPbPath}.tmp-${process.pid}`
    writeFileSync(tmpHub, finalHub)
    renameSync(tmpHub, hubPbPath)
  }

  return hubUpdated
}
