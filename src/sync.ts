import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  AGENT_LABELS,
  type AgentKind,
  collectAllExternalAgentSessions,
  type ExternalAgentSession,
  writeExternalSessionMarkdown,
} from './agents'
import { getAntigravityDir, getArgValue, loadConfig, REPO_ROOT } from './config'
import { slugify, writeConversationMarkdown } from './markdown-exporter'
import { ARCHIVE_SCHEMA_REV, getActualConvDbStepCount } from './protobuf'
import { redactBufferSameLength, redactText, sanitizeSqliteCopy } from './redact'

const config = loadConfig()
const agyDir = getAntigravityDir()
const maxChunkBytes = config.maxChunkMB * 1024 * 1024
const maxMdPartBytes = config.maxMarkdownPartKB * 1024
const excludedSet = new Set(config.excludedConversationIds)
const extraSet = new Set(config.extraConversationIds)

if (existsSync(join(REPO_ROOT, '.git'))) {
  const remotes = spawnSync('git', ['remote'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (remotes.stdout && remotes.stdout.trim().length > 0) {
    console.log('🔄 Pulling latest updates from GitHub before merging...')
    spawnSync('git', ['pull', '--rebase', '--autostash'], { cwd: REPO_ROOT, stdio: 'inherit' })
  }
}

const convRootDir = join(REPO_ROOT, 'conversations')
const backupDir = join(REPO_ROOT, 'antigravity-backup')
const dbChunksDir = join(backupDir, 'db-chunks')
const brainArchivesDir = join(backupDir, 'brain-archives')
const extBackupDir = join(REPO_ROOT, 'agent-backups')
const extSessionsDir = join(extBackupDir, 'sessions')

mkdirSync(convRootDir, { recursive: true })
mkdirSync(dbChunksDir, { recursive: true })
mkdirSync(brainArchivesDir, { recursive: true })
mkdirSync(extSessionsDir, { recursive: true })

const manifestPath = join(backupDir, 'manifest.json')
const summariesPath = join(backupDir, 'summaries.json')
const metaExtrasPath = join(backupDir, 'meta-extras.json')
const extManifestPath = join(extBackupDir, 'manifest.json')

const existingRecordsMap = new Map<string, any>()
const existingSummariesMap = new Map<string, any>()
const existingFtsMap = new Map<string, any[]>()
const existingExtMap = new Map<string, any>()
const existingMetaExtras: Record<string, { annotationPbtxt?: string; chapterTitlesB64?: string }> = existsSync(metaExtrasPath)
  ? JSON.parse(readFileSync(metaExtrasPath, 'utf8'))
  : {}

let prevExportedAt: string | null = null
if (existsSync(manifestPath)) {
  const prevManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  prevExportedAt = prevManifest.exported_at ?? null
  for (const r of prevManifest.records || []) existingRecordsMap.set(r.conversation_id, r)
}
if (existsSync(summariesPath)) {
  const prevSum = JSON.parse(readFileSync(summariesPath, 'utf8'))
  for (const s of prevSum.summaries || []) existingSummariesMap.set(s.conversation_id, s)
  for (const f of prevSum.fts || []) {
    const arr = existingFtsMap.get(f.c0) || []
    arr.push(f)
    existingFtsMap.set(f.c0, arr)
  }
}
if (existsSync(extManifestPath)) {
  try {
    const prevExt = JSON.parse(readFileSync(extManifestPath, 'utf8'))
    for (const s of prevExt.sessions || []) existingExtMap.set(`${s.agent}:${s.id}`, s)
  } catch {}
}

function writeChunkedGzip(rawBuf: Uint8Array, destDir: string, baseName: string): string[] {
  const singleName = `${baseName}.gz`
  const partPrefix = `${baseName}.gz.part`
  for (const existing of readdirSync(destDir)) {
    if (existing === singleName || existing.startsWith(partPrefix)) {
      try {
        rmSync(join(destDir, existing), { force: true })
      } catch {}
    }
  }

  const gz = Bun.gzipSync(rawBuf as Uint8Array<ArrayBuffer>)
  const files: string[] = []
  if (gz.byteLength <= maxChunkBytes) {
    writeFileSync(join(destDir, singleName), gz)
    files.push(singleName)
  } else {
    let part = 0
    for (let offset = 0; offset < gz.byteLength; offset += maxChunkBytes) {
      part++
      const fName = `${partPrefix}${String(part).padStart(2, '0')}`
      writeFileSync(join(destDir, fName), gz.subarray(offset, offset + maxChunkBytes))
      files.push(fName)
    }
  }
  return files
}

const slugLower = config.projectSlug.toLowerCase()
const legacyLowers = config.legacyProjectSlugs.map(s => s.toLowerCase()).filter(Boolean)
const changedIds = new Set<string>()
const changedExtKeys = new Set<string>()

// ── Part A: Google Antigravity Conversations (when installed on this machine) ──
const summaryDbPath = join(agyDir, 'conversation_summaries.db')
let summaryDb: Database | null = null
let localTopRows: any[] = []
let localTopIds: string[] = []

if (existsSync(summaryDbPath)) {
  summaryDb = new Database(summaryDbPath, { readonly: true })
  const allTopCandidates = summaryDb
    .query(`SELECT * FROM conversation_summaries WHERE parent_conversation_id = '' ORDER BY last_modified_time ASC`)
    .all() as any[]

  localTopRows = allTopCandidates.filter(r => {
    if (excludedSet.has(r.conversation_id)) return false
    if (extraSet.has(r.conversation_id)) return true
    const ws = String(r.workspace_uris || '').toLowerCase()
    return ws.includes(slugLower) || legacyLowers.some(leg => ws.includes(leg))
  })

  localTopIds = localTopRows.map(r => r.conversation_id)
  const placeholders = localTopIds.map(() => '?').join(',')
  const localChildRows =
    localTopIds.length > 0
      ? (summaryDb
          .query(`SELECT * FROM conversation_summaries WHERE parent_conversation_id IN (${placeholders}) ORDER BY last_modified_time ASC`)
          .all(...localTopIds) as any[])
      : []
  const localAllRows = [...localTopRows, ...localChildRows]

  const tempWorkDir = join(REPO_ROOT, '.tmp-sanitize')
  mkdirSync(tempWorkDir, { recursive: true })

  for (const row of localAllRows) {
    const id = row.conversation_id
    const prevSummary = existingSummariesMap.get(id)
    const prevRecord = existingRecordsMap.get(id)
    const srcDbPath = join(agyDir, 'conversations', `${id}.db`)
    const actualDbSteps = getActualConvDbStepCount(srcDbPath)
    const localSteps = Math.max(row.step_count ?? 0, actualDbSteps > 0 ? actualDbSteps : 0)
    const prevSteps = prevSummary?.step_count ?? -1

    if (prevSummary && prevSteps > localSteps) {
      console.log(`ℹ️ Skipping ${id}: remote has newer version (${prevSteps} vs ${localSteps} steps).`)
      continue
    }

    const dbUnchanged =
      prevSummary &&
      prevSteps === localSteps &&
      prevRecord &&
      Array.isArray(prevRecord.db_chunks) &&
      prevRecord.db_chunks.every((c: string) => existsSync(join(dbChunksDir, c)))

    let dbChunkNames: string[] = prevRecord?.db_chunks || []
    let brainBundleChunks: string[] | undefined = prevRecord?.brain_files_bundle

    if (!dbUnchanged) {
      changedIds.add(id)
      console.log(`📦 [Antigravity] Packing & sanitizing: ${row.title || row.preview || id} (${localSteps} steps)...`)
      if (existsSync(srcDbPath)) {
        const tmpCopy = join(tempWorkDir, `${id}.db`)
        cpSync(srcDbPath, tmpCopy)
        if (existsSync(`${srcDbPath}-wal`)) cpSync(`${srcDbPath}-wal`, `${tmpCopy}-wal`)
        if (existsSync(`${srcDbPath}-shm`)) cpSync(`${srcDbPath}-shm`, `${tmpCopy}-shm`)
        sanitizeSqliteCopy(tmpCopy)
        dbChunkNames = writeChunkedGzip(readFileSync(tmpCopy), dbChunksDir, `${id}.db`)
        try {
          rmSync(tmpCopy, { force: true })
          rmSync(`${tmpCopy}-wal`, { force: true })
          rmSync(`${tmpCopy}-shm`, { force: true })
        } catch {}
      }

      const srcBrainDir = join(agyDir, 'brain', id)
      if (existsSync(srcBrainDir)) {
        const filesMap: Array<{ relPath: string; base64: string }> = []
        function collect(dir: string) {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, e.name)
            const rel = relative(srcBrainDir, full).replace(/\\/g, '/')
            if (
              rel === 'scratch' ||
              rel.startsWith('scratch/') ||
              rel.startsWith('.system_generated/logs/chunks') ||
              rel.startsWith('.system_generated/steps')
            ) {
              continue
            }
            if (e.isDirectory()) collect(full)
            else if (e.isFile()) {
              let fileBuf = readFileSync(full)
              if (/\.(md|json|jsonl|txt)$/.test(rel)) {
                fileBuf = Buffer.from(redactText(fileBuf.toString('utf8')), 'utf8')
              }
              filesMap.push({ relPath: rel, base64: fileBuf.toString('base64') })
            }
          }
        }
        collect(srcBrainDir)
        if (filesMap.length > 0) {
          brainBundleChunks = writeChunkedGzip(
            Buffer.from(JSON.stringify(filesMap), 'utf8'),
            brainArchivesDir,
            `${id}.brain.json`,
          )
        }
      }
    }

    const resolvedTitle = row.title || prevSummary?.title || ''
    const resolvedPreview = row.preview || prevSummary?.preview || ''
    const copySum = { ...row, title: resolvedTitle, preview: resolvedPreview, step_count: localSteps }
    if (copySum.raw_summary instanceof Uint8Array) {
      copySum.raw_summary_b64 = Buffer.from(redactBufferSameLength(copySum.raw_summary).buf).toString('base64')
      delete copySum.raw_summary
    }
    existingSummariesMap.set(id, copySum)

    const annPath = join(agyDir, 'annotations', `${id}.pbtxt`)
    const chapPath = join(agyDir, 'chapter_titles', `${id}.pb`)
    const extraEntry: { annotationPbtxt?: string; chapterTitlesB64?: string } = { ...(existingMetaExtras[id] || {}) }
    if (existsSync(annPath)) {
      extraEntry.annotationPbtxt = redactText(readFileSync(annPath, 'utf8'))
    }
    if (existsSync(chapPath)) {
      extraEntry.chapterTitlesB64 = Buffer.from(redactBufferSameLength(readFileSync(chapPath)).buf).toString('base64')
    }
    if (extraEntry.annotationPbtxt || extraEntry.chapterTitlesB64) {
      existingMetaExtras[id] = extraEntry
    }

    const ftsRows = summaryDb
      .query(`SELECT c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14 FROM conversations_fts_content WHERE c0 = '${id}'`)
      .all() as any[]
    if (ftsRows.length > 0) {
      existingFtsMap.set(
        id,
        ftsRows.map(r => ({
          ...r,
          c8_b64: r.c8 ? Buffer.from(r.c8).toString('base64') : null,
          c9_b64: r.c9 ? Buffer.from(r.c9).toString('base64') : null,
          c13: r.c13 ? redactText(String(r.c13)) : r.c13,
          c14: r.c14 ? redactText(String(r.c14)) : r.c14,
          c8: undefined,
          c9: undefined,
        })),
      )
    }

    existingRecordsMap.set(id, {
      ...prevRecord,
      conversation_id: id,
      is_subagent: !!row.parent_conversation_id,
      parent_conversation_id: row.parent_conversation_id || '',
      db_chunks: dbChunkNames,
      brain_files_bundle: brainBundleChunks,
    })
  }

  try {
    rmSync(tempWorkDir, { recursive: true, force: true })
  } catch {}
}

// ── Part B: Universal External Agent Sessions (Claude, Codex, Cursor, Copilot, Cline, Roo, Gemini, Aider) ──
const explicitSyncWs = getArgValue('--workspace')
const siblingSyncWs = join(REPO_ROOT, '..', config.projectSlug)
const syncWorkspacePath = explicitSyncWs ? explicitSyncWs : existsSync(siblingSyncWs) ? siblingSyncWs : undefined

const localExternalSessions = collectAllExternalAgentSessions({
  projectSlug: config.projectSlug,
  legacyProjectSlugs: config.legacyProjectSlugs,
  excludedIds: excludedSet,
  workspacePath: syncWorkspacePath,
})
const localExtByKey = new Map<string, ExternalAgentSession>()

for (const ext of localExternalSessions) {
  const key = `${ext.agent}:${ext.id}`
  localExtByKey.set(key, ext)
  const prev = existingExtMap.get(key)

  if (prev && (prev.stepCount ?? 0) > ext.stepCount) {
    continue
  }

  const unchanged =
    prev &&
    prev.stepCount === ext.stepCount &&
    Array.isArray(prev.chunks) &&
    prev.chunks.every((c: string) => existsSync(join(extSessionsDir, c)))

  let chunks: string[] = prev?.chunks || []
  if (!unchanged) {
    changedExtKeys.add(key)
    console.log(`📦 [${AGENT_LABELS[ext.agent]}] Packing & sanitizing: ${ext.title} (${ext.turns.length} msgs)...`)
    const serialized = Buffer.from(JSON.stringify(ext), 'utf8')
    chunks = writeChunkedGzip(serialized, extSessionsDir, `${ext.agent}-${ext.id}.json`)
  }

  existingExtMap.set(key, {
    id: ext.id,
    agent: ext.agent,
    title: ext.title,
    updatedAt: ext.updatedAt,
    stepCount: ext.stepCount,
    turnsCount: ext.turns.length,
    folderName: prev?.folderName,
    chunks,
  })
}

// ── Part C: Unified Chronological Timeline & ARCHIVE_INDEX.md ────────────────
const mergedSummaries = Array.from(existingSummariesMap.values()).sort((a, b) =>
  String(a.last_modified_time).localeCompare(String(b.last_modified_time)),
)
const mergedTop = mergedSummaries.filter(r => !r.parent_conversation_id)
const mergedSub = mergedSummaries.filter(r => !!r.parent_conversation_id)
const localTopIdsSet = new Set(localTopIds)

interface UnifiedTimelineItem {
  kind: 'antigravity' | 'external'
  agent: AgentKind
  id: string
  updatedAt: string
  agyRow?: any
  extMeta?: any
}

const timeline: UnifiedTimelineItem[] = [
  ...mergedTop.map(r => ({
    kind: 'antigravity' as const,
    agent: 'antigravity' as const,
    id: r.conversation_id,
    updatedAt: String(r.last_modified_time || ''),
    agyRow: r,
  })),
  ...Array.from(existingExtMap.values()).map(m => ({
    kind: 'external' as const,
    agent: m.agent as AgentKind,
    id: m.id,
    updatedAt: String(m.updatedAt || ''),
    extMeta: m,
  })),
].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))

const indexEntries: any[] = []

for (let idx = 0; idx < timeline.length; idx++) {
  const item = timeline[idx]
  const num = String(idx + 1).padStart(2, '0')

  if (item.kind === 'antigravity') {
    const row = item.agyRow
    const id = row.conversation_id
    const title = row.title || row.preview || `Conversation ${num}`
    const dateStr = String(row.last_modified_time).slice(0, 10)
    const rec = existingRecordsMap.get(id) || {}
    const prevFolder = rec.folder_name
    const desiredFolder = `${num}-${dateStr}-${slugify(title)}`

    const localRow = localTopRows.find(x => x.conversation_id === id)
    const canRenderLocal =
      summaryDb !== null &&
      localTopIdsSet.has(id) &&
      (!localRow || (localRow.step_count ?? 0) >= (row.step_count ?? 0))
    const needMd =
      canRenderLocal &&
      (changedIds.has(id) ||
        !prevFolder ||
        !existsSync(join(convRootDir, prevFolder, 'conversation.md')) ||
        prevFolder !== desiredFolder)

    let finalFolder = prevFolder || desiredFolder
    let turnsCount = rec.turns_count ?? 0
    let artifacts: string[] = rec.artifacts || []

    if (needMd && summaryDb) {
      if (prevFolder && prevFolder !== desiredFolder && existsSync(join(convRootDir, prevFolder))) {
        rmSync(join(convRootDir, prevFolder), { recursive: true, force: true })
      }
      finalFolder = desiredFolder
      const res = writeConversationMarkdown({
        agyDir,
        summaryDb,
        convRootDir,
        num,
        row,
        folderName: finalFolder,
        maxPartBytes: maxMdPartBytes,
      })
      turnsCount = res.turnsCount
      artifacts = res.artifacts
    } else if (prevFolder && prevFolder !== desiredFolder && existsSync(join(convRootDir, prevFolder))) {
      cpSync(join(convRootDir, prevFolder), join(convRootDir, desiredFolder), { recursive: true })
      rmSync(join(convRootDir, prevFolder), { recursive: true, force: true })
      finalFolder = desiredFolder
    }

    rec.folder_name = finalFolder
    rec.turns_count = turnsCount
    rec.artifacts = artifacts
    existingRecordsMap.set(id, rec)

    indexEntries.push({
      num,
      agentLabel: AGENT_LABELS.antigravity,
      title,
      date: String(row.last_modified_time).slice(0, 16),
      steps: row.step_count,
      turnsCount,
      folderName: finalFolder,
      mainMdLink: `./conversations/${encodeURIComponent(finalFolder)}/conversation.md`,
      artifacts,
    })
  } else {
    const extMeta = item.extMeta
    const key = `${extMeta.agent}:${extMeta.id}`
    const title = extMeta.title || `${AGENT_LABELS[item.agent]} ${num}`
    const dateStr = String(extMeta.updatedAt).slice(0, 10)
    const prevFolder = extMeta.folderName
    const desiredFolder = `${num}-${dateStr}-${item.agent}-${slugify(title)}`
    const localSession = localExtByKey.get(key)
    const needMd =
      Boolean(localSession) &&
      (changedExtKeys.has(key) ||
        !prevFolder ||
        !existsSync(join(convRootDir, prevFolder, 'conversation.md')) ||
        prevFolder !== desiredFolder)

    let finalFolder = prevFolder || desiredFolder
    let turnsCount = extMeta.turnsCount ?? 0

    if (needMd && localSession) {
      if (prevFolder && prevFolder !== desiredFolder && existsSync(join(convRootDir, prevFolder))) {
        rmSync(join(convRootDir, prevFolder), { recursive: true, force: true })
      }
      finalFolder = desiredFolder
      const res = writeExternalSessionMarkdown({
        convRootDir,
        num,
        folderName: finalFolder,
        session: localSession,
        maxPartBytes: maxMdPartBytes,
      })
      turnsCount = res.turnsCount
    } else if (prevFolder && prevFolder !== desiredFolder && existsSync(join(convRootDir, prevFolder))) {
      cpSync(join(convRootDir, prevFolder), join(convRootDir, desiredFolder), { recursive: true })
      rmSync(join(convRootDir, prevFolder), { recursive: true, force: true })
      finalFolder = desiredFolder
    }

    extMeta.folderName = finalFolder
    extMeta.turnsCount = turnsCount
    existingExtMap.set(key, extMeta)

    indexEntries.push({
      num,
      agentLabel: AGENT_LABELS[item.agent],
      title,
      date: String(extMeta.updatedAt).slice(0, 16),
      steps: extMeta.stepCount,
      turnsCount,
      folderName: finalFolder,
      mainMdLink: `./conversations/${encodeURIComponent(finalFolder)}/conversation.md`,
      artifacts: [],
    })
  }
}

summaryDb?.close()

writeFileSync(
  summariesPath,
  JSON.stringify({ summaries: mergedSummaries, fts: Array.from(existingFtsMap.values()).flat() }, null, 2),
  'utf8',
)
if (Object.keys(existingMetaExtras).length > 0) {
  writeFileSync(metaExtrasPath, JSON.stringify(existingMetaExtras, null, 2), 'utf8')
}

const nextRecords = mergedSummaries.map(s => existingRecordsMap.get(s.conversation_id)).filter(Boolean)
const anyChanged = changedIds.size > 0 || changedExtKeys.size > 0
const exportedAt = anyChanged || !prevExportedAt ? new Date().toISOString() : prevExportedAt

writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      schema_rev: ARCHIVE_SCHEMA_REV,
      project: config.projectSlug,
      exported_at: exportedAt,
      main_conversations_count: mergedTop.length,
      subagent_conversations_count: mergedSub.length,
      records: nextRecords,
    },
    null,
    2,
  ),
  'utf8',
)

if (existingExtMap.size > 0 || existsSync(extManifestPath)) {
  writeFileSync(
    extManifestPath,
    JSON.stringify(
      {
        schema_rev: ARCHIVE_SCHEMA_REV,
        project: config.projectSlug,
        exported_at: exportedAt,
        sessions: Array.from(existingExtMap.values()),
      },
      null,
      2,
    ),
    'utf8',
  )
}

const tableRows = indexEntries
  .map(e => {
    const arts =
      e.artifacts && e.artifacts.length > 0
        ? e.artifacts
            .map((a: string) => `[${a}](./conversations/${encodeURIComponent(e.folderName)}/artifacts/${encodeURIComponent(a)})`)
            .join('<br/>')
        : '—'
    return `| ${e.num} | \`${e.agentLabel}\` | [**${e.title}**](${e.mainMdLink}) | \`${e.date}\` | ${e.turnsCount} msgs (${e.steps} steps) | ${arts} |`
  })
  .join('\n')

writeFileSync(
  join(REPO_ROOT, 'ARCHIVE_INDEX.md'),
  `# ${config.projectDisplayName} — Conversation Archive (${timeline.length})\n\n| # | Agent | Title | Updated | Size | Artifacts |\n|---|---|---|---|---|---|\n${tableRows}\n`,
  'utf8',
)

if (syncWorkspacePath && !process.argv.includes('--no-bridge')) {
  try {
    const { executeLocalBridge } = await import('./local-bridge')
    const bridged = executeLocalBridge({
      workspacePath: syncWorkspacePath,
      projectSlug: config.projectSlug,
      legacyProjectSlugs: config.legacyProjectSlugs,
      excludedIds: excludedSet,
      targetAgent: 'all',
    })
    if (bridged.bridgedTargets.length > 0) {
      console.log(
        `⚡ Auto-bridged ${bridged.sourceSessionsCount} conversation(s) locally into: ${bridged.bridgedTargets.map(t => t.targetAgent).join(' · ')}`,
      )
    }
  } catch {}
}

if (existsSync(join(REPO_ROOT, '.git')) && !process.argv.includes('--no-push')) {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (!status.stdout || status.stdout.trim().length === 0) {
    console.log('✨ Everything is already up to date on GitHub!')
  } else {
    spawnSync('git', ['add', '-A'], { cwd: REPO_ROOT, stdio: 'inherit' })
    spawnSync('git', ['commit', '-m', `chore: sync ${config.projectSlug} conversations (${new Date().toISOString().slice(0, 10)})`], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
    const pushRes = spawnSync('git', ['push'], { cwd: REPO_ROOT, stdio: 'inherit' })
    if (pushRes.status !== 0) {
      console.error('❌ Git push failed! Your commit is saved locally — run `git push` when back online.')
      process.exit(1)
    }
    console.log('🎉 Synced and pushed successfully!')
  }
}
