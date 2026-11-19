import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getAntigravityDir, getArgValue, loadConfig, REPO_ROOT } from './config'
import {
  createProjectAdapter,
  detectLocalProjectId,
  hasLocalProjectConfig,
  patchAgyhubSummariesProto,
  toWorkspaceUris,
} from './protobuf'

const config = loadConfig()
const agyDir = getAntigravityDir()
const backupDir = join(REPO_ROOT, 'antigravity-backup')
const dbChunksDir = join(backupDir, 'db-chunks')
const brainArchivesDir = join(backupDir, 'brain-archives')
const isIndexOnly = process.argv.includes('--index-only')

function isLanguageServerRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', "(Get-Process -Name 'language_server*' -ErrorAction SilentlyContinue).Count"],
        { encoding: 'utf8' },
      )
      return Number(String(res.stdout || '0').trim()) > 0
    }
    const res = spawnSync('pgrep', ['-f', 'language_server'], { encoding: 'utf8' })
    return res.status === 0
  } catch {
    return false
  }
}

if (!isIndexOnly && existsSync(join(REPO_ROOT, '.git'))) {
  const remotes = spawnSync('git', ['remote'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (remotes.stdout && remotes.stdout.trim().length > 0) {
    console.log('🔄 Pulling latest conversations from GitHub...')
    spawnSync('git', ['pull', '--rebase', '--autostash'], { cwd: REPO_ROOT, stdio: 'inherit' })
  }
}

if (!existsSync(agyDir)) {
  console.error(`❌ Antigravity directory not found at: ${agyDir}`)
  process.exit(1)
}

const explicitWs = getArgValue('--workspace')
let targetWorkspacePath: string | null = explicitWs ? resolve(explicitWs) : null
if (!targetWorkspacePath) {
  const sibling = resolve(REPO_ROOT, '..', config.projectSlug)
  if (existsSync(sibling)) targetWorkspacePath = sibling
}

const targetUris = targetWorkspacePath ? toWorkspaceUris(targetWorkspacePath) : null
const localProjectId = detectLocalProjectId(agyDir, targetUris)
const adapter = createProjectAdapter({
  projectSlug: config.projectSlug,
  legacyProjectSlugs: config.legacyProjectSlugs,
  targetUris,
  localProjectId,
})

function readChunkedGzip(dir: string, chunkNames: string[]): Uint8Array {
  const buffers = chunkNames.map(name => readFileSync(join(dir, name)))
  return Bun.gunzipSync(Buffer.concat(buffers))
}

function getActualConvDbStepCount(convDbPath: string): number {
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

function adaptConvDbMetadataBlob(convDbPath: string): boolean {
  if (!existsSync(convDbPath)) return false
  try {
    const db = new Database(convDbPath)
    db.exec('PRAGMA busy_timeout = 5000;')
    const row = db.query("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as { data: Uint8Array } | null
    let changed = false
    if (row?.data) {
      const orig = Buffer.from(row.data)
      const adapted = adapter.adaptTrajectoryMetadataProto(orig)
      if (Buffer.compare(orig, adapted) !== 0) {
        db.query("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'").run(adapted)
        changed = true
      }
    }
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      try {
        db.exec('PRAGMA wal_checkpoint(PASSIVE);')
      } catch {}
    }
    db.close()
    return changed
  } catch (err: any) {
    console.warn(`⚠️ Failed to adapt trajectory_metadata_blob in ${convDbPath}: ${err?.message || err}`)
    return false
  }
}

const manifestPath = join(backupDir, 'manifest.json')
const summariesPath = join(backupDir, 'summaries.json')
if (!existsSync(manifestPath) || !existsSync(summariesPath)) {
  console.error('❌ Backup manifest or summaries.json not found. Run `bun run sync` first on a machine with conversations.')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const { summaries, fts } = JSON.parse(readFileSync(summariesPath, 'utf8'))
const summaryById = new Map<string, any>(summaries.map((s: any) => [s.conversation_id, s]))

const convsTargetDir = join(agyDir, 'conversations')
const brainTargetDir = join(agyDir, 'brain')
mkdirSync(convsTargetDir, { recursive: true })
mkdirSync(brainTargetDir, { recursive: true })

let restoredCount = 0
let skippedCount = 0
let metadataPatchedCount = 0

if (!isIndexOnly) {
  for (const rec of manifest.records) {
    const id = rec.conversation_id
    const remoteSum = summaryById.get(id)
    const remoteSteps = remoteSum?.step_count ?? 0
    const localDbPath = join(convsTargetDir, `${id}.db`)
    const localActualSteps = getActualConvDbStepCount(localDbPath)

    if (localActualSteps >= remoteSteps && localActualSteps > 0) {
      if (adaptConvDbMetadataBlob(localDbPath)) metadataPatchedCount++
      skippedCount++
      continue
    }

    if (Array.isArray(rec.db_chunks) && rec.db_chunks.length > 0) {
      try { rmSync(`${localDbPath}-wal`, { force: true }) } catch {}
      try { rmSync(`${localDbPath}-shm`, { force: true }) } catch {}
      writeFileSync(localDbPath, readChunkedGzip(dbChunksDir, rec.db_chunks))
      if (adaptConvDbMetadataBlob(localDbPath)) metadataPatchedCount++
    }

    if (Array.isArray(rec.brain_files_bundle) && rec.brain_files_bundle.length > 0) {
      const rawBrainJson = readChunkedGzip(brainArchivesDir, rec.brain_files_bundle)
      const files: Array<{ relPath: string; base64: string }> = JSON.parse(Buffer.from(rawBrainJson).toString('utf8'))
      for (const f of files) {
        const targetFile = join(brainTargetDir, id, f.relPath)
        mkdirSync(dirname(targetFile), { recursive: true })
        writeFileSync(targetFile, Buffer.from(f.base64, 'base64'))
      }
    }

    restoredCount++
    console.log(`✅ Restored: ${remoteSum?.title || remoteSum?.preview || id} (${remoteSteps} steps)`)
  }
}

// Precompute adapted raw summaries for all archive records whose remote version >= local steps
const eligibleIds = new Set<string>()
const adaptedRawById = new Map<string, Buffer>()
const remoteStepsById = new Map<string, number>()

for (const r of summaries) {
  const id = r.conversation_id
  const remoteSteps = r.step_count ?? 0
  remoteStepsById.set(id, remoteSteps)
  const localActualSteps = getActualConvDbStepCount(join(convsTargetDir, `${id}.db`))
  if (localActualSteps > remoteSteps && localActualSteps > 0) {
    continue
  }
  eligibleIds.add(id)
  if (r.raw_summary_b64) {
    adaptedRawById.set(id, adapter.adaptRawSummaryProto(Buffer.from(r.raw_summary_b64, 'base64')))
  }
}

const summaryDbPath = join(agyDir, 'conversation_summaries.db')
const slugLower = config.projectSlug.toLowerCase()
let localReboundCount = 0

if (existsSync(summaryDbPath)) {
  const sdb = new Database(summaryDbPath)
  sdb.exec('PRAGMA busy_timeout = 5000;')

  const insertSummary = sdb.prepare(`
    INSERT OR REPLACE INTO conversation_summaries (
      conversation_id, title, preview, step_count, last_modified_time,
      workspace_uris, status, source, project_id, agent_name,
      parent_conversation_id, nesting_depth, battle_id, winning_conversation_id,
      not_fully_idle, killed, last_user_input_time, last_user_input_step_index,
      app_data_dir, raw_summary, group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const deleteFts = sdb.prepare('DELETE FROM conversations_fts WHERE conversation_id = ?')
  const insertFts = sdb.prepare(`
    INSERT INTO conversations_fts (
      conversation_id, chunk_index, chunk_first_step, chunk_last_step,
      last_modified_time, step_count, last_step_created_at, archived,
      user_step_byte_offsets, agent_step_byte_offsets,
      title, workspace, project, user_body, agent_body
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  sdb.transaction(() => {
    for (const r of summaries) {
      if (!eligibleIds.has(r.conversation_id)) continue
      insertSummary.run(
        r.conversation_id,
        r.title ?? '',
        r.preview ?? '',
        r.step_count ?? 0,
        r.last_modified_time,
        adapter.adaptWorkspaceUrisJson(r.workspace_uris ?? '[]'),
        r.status ?? 'CASCADE_RUN_STATUS_IDLE',
        r.source ?? '',
        localProjectId || r.project_id || '',
        r.agent_name ?? '',
        r.parent_conversation_id ?? '',
        r.nesting_depth ?? 0,
        r.battle_id ?? '',
        r.winning_conversation_id ?? '',
        r.not_fully_idle ?? 0,
        r.killed ?? 0,
        r.last_user_input_time ?? r.last_modified_time,
        r.last_user_input_step_index ?? -1,
        r.app_data_dir ?? 'antigravity',
        adaptedRawById.get(r.conversation_id) ?? null,
        r.group_id ?? '',
      )
      deleteFts.run(r.conversation_id)
    }

    for (const f of fts) {
      if (!eligibleIds.has(f.c0)) continue
      insertFts.run(
        f.c0,
        f.c1,
        f.c2,
        f.c3,
        f.c4,
        f.c5,
        f.c6,
        f.c7,
        f.c8_b64 ? Buffer.from(f.c8_b64, 'base64') : null,
        f.c9_b64 ? Buffer.from(f.c9_b64, 'base64') : null,
        f.c10,
        targetUris ? targetUris.encodedUri : f.c11,
        localProjectId || f.c12 || '',
        f.c13,
        f.c14,
      )
    }

    // Rebind any newer local or foreign-project conversations for this slug in-place (never downgrading steps!)
    const localRows = sdb
      .query('SELECT conversation_id, workspace_uris, project_id, raw_summary FROM conversation_summaries WHERE lower(workspace_uris) LIKE ?')
      .all(`%${slugLower}%`) as Array<{
      conversation_id: string
      workspace_uris: string
      project_id: string
      raw_summary: Uint8Array | null
    }>

    const updateLocalStmt = sdb.prepare(
      'UPDATE conversation_summaries SET workspace_uris = ?, project_id = ?, raw_summary = ? WHERE conversation_id = ?',
    )
    for (const lr of localRows) {
      if (eligibleIds.has(lr.conversation_id)) continue
      const foreignProject = Boolean(lr.project_id && localProjectId && lr.project_id !== localProjectId && !hasLocalProjectConfig(agyDir, lr.project_id))
      const newWs = adapter.adaptWorkspaceUrisJson(lr.workspace_uris || '[]')
      const newProj = localProjectId && (foreignProject || !lr.project_id) ? localProjectId : lr.project_id
      const origRaw = lr.raw_summary ? Buffer.from(lr.raw_summary) : null
      const newRaw = origRaw ? adapter.adaptRawSummaryProto(origRaw) : null
      const rawChanged = origRaw && newRaw ? Buffer.compare(origRaw, newRaw) !== 0 : false

      if (newWs !== lr.workspace_uris || newProj !== lr.project_id || rawChanged) {
        updateLocalStmt.run(newWs, newProj, newRaw, lr.conversation_id)
        if (adaptConvDbMetadataBlob(join(convsTargetDir, `${lr.conversation_id}.db`))) metadataPatchedCount++
        localReboundCount++
      }
    }
    updateLocalStmt.finalize()
  })()

  insertSummary.finalize()
  deleteFts.finalize()
  insertFts.finalize()
  try {
    sdb.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  } catch {
    try {
      sdb.exec('PRAGMA wal_checkpoint(PASSIVE);')
    } catch {}
  }
  sdb.close()
}

// Update Antigravity 2.x primary summary index (agyhub_summaries_proto.pb)
const hubUpdated = patchAgyhubSummariesProto({
  agyDir,
  adaptedRawById,
  remoteStepsById,
  adapter,
})

console.log(
  `\n🎉 Restore complete! Imported/updated: ${restoredCount} | Up-to-date: ${skippedCount} | .db metadata patched: ${metadataPatchedCount} | Index synced: ${eligibleIds.size + localReboundCount} (${hubUpdated} agyhub updates).`,
)
if (targetWorkspacePath) {
  console.log(`🔗 Bound workspace to: ${targetWorkspacePath}${localProjectId ? ` (Project ID: ${localProjectId})` : ''}`)
}
if (isLanguageServerRunning()) {
  console.log('\n⚠️ Warning: Antigravity (language_server) is currently running and may overwrite agyhub_summaries_proto.pb from RAM!')
  console.log('👉 For changes to stick 100%, fully quit Antigravity (File -> Exit), then run from an external terminal:')
  console.log(`   cd "${REPO_ROOT}" && bun run restore`)
  console.log('   Then reopen Antigravity.')
} else {
  console.log('✅ Antigravity is closed — index updates are safely persisted. You can open Antigravity now!')
}
