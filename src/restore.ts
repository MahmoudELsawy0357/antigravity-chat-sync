import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getAntigravityDir, getArgValue, loadConfig, REPO_ROOT } from './config'

const config = loadConfig()
const agyDir = getAntigravityDir()
const backupDir = join(REPO_ROOT, 'antigravity-backup')
const dbChunksDir = join(backupDir, 'db-chunks')
const brainArchivesDir = join(backupDir, 'brain-archives')

if (existsSync(join(REPO_ROOT, '.git'))) {
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

function adaptWorkspaceUris(rawUris: string): string {
  if (!targetWorkspacePath) return rawUris
  const normalized = targetWorkspacePath.replace(/\\/g, '/')
  const encodedUri = normalized.match(/^[A-Za-z]:\//)
    ? `file:///${normalized[0].toLowerCase()}%3A${normalized.slice(2)}`
    : `file://${normalized}`
  try {
    const arr: string[] = JSON.parse(rawUris || '[]')
    const slugLower = config.projectSlug.toLowerCase()
    const mapped = arr.map(u => (u.toLowerCase().includes(slugLower) ? encodedUri : u))
    if (!mapped.some(u => u.toLowerCase().includes(slugLower))) mapped.push(encodedUri)
    return JSON.stringify(mapped)
  } catch {
    return JSON.stringify([encodedUri])
  }
}

function readChunkedGzip(dir: string, chunkNames: string[]): Uint8Array {
  const buffers = chunkNames.map(name => readFileSync(join(dir, name)))
  return Bun.gunzipSync(Buffer.concat(buffers))
}

const manifestPath = join(backupDir, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.log('ℹ️ No backup manifest found yet in antigravity-backup/manifest.json.')
  process.exit(0)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const { summaries, fts } = JSON.parse(readFileSync(join(backupDir, 'summaries.json'), 'utf8'))
const summaryById = new Map<string, any>(summaries.map((s: any) => [s.conversation_id, s]))

const convsTargetDir = join(agyDir, 'conversations')
const brainTargetDir = join(agyDir, 'brain')
mkdirSync(convsTargetDir, { recursive: true })
mkdirSync(brainTargetDir, { recursive: true })

const summaryDbPath = join(agyDir, 'conversation_summaries.db')
const localStepCounts = new Map<string, number>()
if (existsSync(summaryDbPath)) {
  const tmpDb = new Database(summaryDbPath, { readonly: true })
  const rows = tmpDb.query('SELECT conversation_id, step_count FROM conversation_summaries').all() as any[]
  for (const r of rows) localStepCounts.set(r.conversation_id, r.step_count ?? 0)
  tmpDb.close()
}

let restoredCount = 0
let skippedCount = 0
const restoredIds = new Set<string>()

for (const rec of manifest.records) {
  const id = rec.conversation_id
  const remoteSum = summaryById.get(id)
  const remoteSteps = remoteSum?.step_count ?? 0
  const localSteps = localStepCounts.get(id) ?? -1
  const localDbExists = existsSync(join(convsTargetDir, `${id}.db`))

  if (localDbExists && localSteps >= remoteSteps && localSteps > 0) {
    skippedCount++
    continue
  }

  if (Array.isArray(rec.db_chunks) && rec.db_chunks.length > 0) {
    writeFileSync(join(convsTargetDir, `${id}.db`), readChunkedGzip(dbChunksDir, rec.db_chunks))
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

  restoredIds.add(id)
  restoredCount++
  console.log(`✅ Restored: ${remoteSum?.title || remoteSum?.preview || id} (${remoteSteps} steps)`)
}

if (restoredIds.size > 0 && existsSync(summaryDbPath)) {
  const sdb = new Database(summaryDbPath)
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
      if (!restoredIds.has(r.conversation_id)) continue
      insertSummary.run(
        r.conversation_id,
        r.title ?? '',
        r.preview ?? '',
        r.step_count ?? 0,
        r.last_modified_time,
        adaptWorkspaceUris(r.workspace_uris ?? '[]'),
        r.status ?? 'CASCADE_RUN_STATUS_IDLE',
        r.source ?? '',
        r.project_id ?? '',
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
        r.raw_summary_b64 ? Buffer.from(r.raw_summary_b64, 'base64') : null,
        r.group_id ?? '',
      )
      deleteFts.run(r.conversation_id)
    }

    for (const f of fts) {
      if (!restoredIds.has(f.c0)) continue
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
        f.c11,
        f.c12,
        f.c13,
        f.c14,
      )
    }
  })()

  insertSummary.finalize()
  deleteFts.finalize()
  insertFts.finalize()
  sdb.close()
}

console.log(`\n🎉 Restore complete! Imported/updated: ${restoredCount} | Already up-to-date locally: ${skippedCount}`)
if (targetWorkspacePath) {
  console.log(`🔗 Bound workspace_uris to: ${targetWorkspacePath}`)
}
console.log('💡 Tip: Run "Developer: Reload Window" in Antigravity so the sidebar refreshes immediately.')
