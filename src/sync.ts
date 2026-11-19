import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { getAntigravityDir, loadConfig, REPO_ROOT } from './config'
import { slugify, writeConversationMarkdown } from './markdown-exporter'
import { getActualConvDbStepCount } from './protobuf'
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
mkdirSync(convRootDir, { recursive: true })
mkdirSync(dbChunksDir, { recursive: true })
mkdirSync(brainArchivesDir, { recursive: true })

const manifestPath = join(backupDir, 'manifest.json')
const summariesPath = join(backupDir, 'summaries.json')
const metaExtrasPath = join(backupDir, 'meta-extras.json')

const existingRecordsMap = new Map<string, any>()
const existingSummariesMap = new Map<string, any>()
const existingFtsMap = new Map<string, any[]>()
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

const summaryDbPath = join(agyDir, 'conversation_summaries.db')
if (!existsSync(summaryDbPath)) {
  console.error(`❌ Antigravity database not found at: ${summaryDbPath}`)
  process.exit(1)
}

const summaryDb = new Database(summaryDbPath, { readonly: true })
const allTopCandidates = summaryDb
  .query(`SELECT * FROM conversation_summaries WHERE parent_conversation_id = '' ORDER BY last_modified_time ASC`)
  .all() as any[]

const slugLower = config.projectSlug.toLowerCase()
const legacyLowers = config.legacyProjectSlugs.map(s => s.toLowerCase()).filter(Boolean)
const localTopRows = allTopCandidates.filter(r => {
  if (excludedSet.has(r.conversation_id)) return false
  if (extraSet.has(r.conversation_id)) return true
  const ws = String(r.workspace_uris || '').toLowerCase()
  return ws.includes(slugLower) || legacyLowers.some(leg => ws.includes(leg))
})

const localTopIds = localTopRows.map(r => r.conversation_id)
const placeholders = localTopIds.map(() => '?').join(',')
const localChildRows =
  localTopIds.length > 0
    ? (summaryDb
        .query(`SELECT * FROM conversation_summaries WHERE parent_conversation_id IN (${placeholders}) ORDER BY last_modified_time ASC`)
        .all(...localTopIds) as any[])
    : []
const localAllRows = [...localTopRows, ...localChildRows]

function writeChunkedGzip(rawBuf: Uint8Array, destDir: string, baseName: string): string[] {
  // Remove any previously written single or split chunks for this archive before writing new ones
  const singleName = `${baseName}.gz`
  const partPrefix = `${baseName}.gz.part`
  for (const existing of readdirSync(destDir)) {
    if (existing === singleName || existing.startsWith(partPrefix)) {
      try {
        rmSync(join(destDir, existing), { force: true })
      } catch {}
    }
  }

  const gz = Bun.gzipSync(rawBuf)
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

const tempWorkDir = join(REPO_ROOT, '.tmp-sanitize')
mkdirSync(tempWorkDir, { recursive: true })
const changedIds = new Set<string>()

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
    console.log(`📦 Packing & sanitizing conversation: ${row.title || row.preview || id} (${localSteps} steps)...`)
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

  // Capture lightweight per-conversation annotations & chapter titles if present
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

const mergedSummaries = Array.from(existingSummariesMap.values()).sort((a, b) =>
  String(a.last_modified_time).localeCompare(String(b.last_modified_time)),
)
const mergedTop = mergedSummaries.filter(r => !r.parent_conversation_id)
const mergedSub = mergedSummaries.filter(r => !!r.parent_conversation_id)
const localTopIdsSet = new Set(localTopIds)

const indexEntries: any[] = []
for (let idx = 0; idx < mergedTop.length; idx++) {
  const row = mergedTop[idx]
  const id = row.conversation_id
  const num = String(idx + 1).padStart(2, '0')
  const title = row.title || row.preview || `Conversation ${num}`
  const dateStr = String(row.last_modified_time).slice(0, 10)
  const rec = existingRecordsMap.get(id) || {}
  const prevFolder = rec.folder_name
  const desiredFolder = `${num}-${dateStr}-${slugify(title)}`

  const localRow = localTopRows.find(x => x.conversation_id === id)
  const canRenderLocal = localTopIdsSet.has(id) && (!localRow || (localRow.step_count ?? 0) >= (row.step_count ?? 0))
  const needMd =
    canRenderLocal &&
    (changedIds.has(id) || !prevFolder || !existsSync(join(convRootDir, prevFolder, 'conversation.md')) || prevFolder !== desiredFolder)

  let finalFolder = prevFolder || desiredFolder
  let turnsCount = rec.turns_count ?? 0
  let artifacts: string[] = rec.artifacts || []

  if (needMd) {
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
  }

  rec.folder_name = finalFolder
  rec.turns_count = turnsCount
  rec.artifacts = artifacts
  existingRecordsMap.set(id, rec)

  indexEntries.push({
    num,
    title,
    date: String(row.last_modified_time).slice(0, 16),
    steps: row.step_count,
    turnsCount,
    folderName: finalFolder,
    mainMdLink: `./conversations/${encodeURIComponent(finalFolder)}/conversation.md`,
    artifacts,
  })
}

summaryDb.close()

writeFileSync(
  summariesPath,
  JSON.stringify({ summaries: mergedSummaries, fts: Array.from(existingFtsMap.values()).flat() }, null, 2),
  'utf8',
)
if (Object.keys(existingMetaExtras).length > 0) {
  writeFileSync(metaExtrasPath, JSON.stringify(existingMetaExtras, null, 2), 'utf8')
}
const nextRecords = mergedSummaries.map(s => existingRecordsMap.get(s.conversation_id)).filter(Boolean)
const exportedAt = changedIds.size > 0 || !prevExportedAt ? new Date().toISOString() : prevExportedAt

writeFileSync(
  manifestPath,
  JSON.stringify(
    {
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

// Only overwrite ARCHIVE_INDEX.md (keeping template README.md intact unless running inside a dedicated archive repo)
const tableRows = indexEntries
  .map(e => {
    const arts =
      e.artifacts && e.artifacts.length > 0
        ? e.artifacts
            .map((a: string) => `[${a}](./conversations/${encodeURIComponent(e.folderName)}/artifacts/${encodeURIComponent(a)})`)
            .join('<br/>')
        : '—'
    return `| ${e.num} | [**${e.title}**](${e.mainMdLink}) | \`${e.date}\` | ${e.turnsCount} msgs (${e.steps} steps) | ${arts} |`
  })
  .join('\n')

writeFileSync(
  join(REPO_ROOT, 'ARCHIVE_INDEX.md'),
  `# 💬 ${config.projectDisplayName} — Conversation Archive (${mergedTop.length})\n\n| # | Title | Updated | Size | Artifacts |\n|---|---|---|---|---|\n${tableRows}\n`,
  'utf8',
)

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
