import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getAntigravityDir, getArgValue, loadConfig, REPO_ROOT } from './config'
import { getActualConvDbStepCount, isAntigravityRunning, isLanguageServerRunning, isPidAlive } from './protobuf'

const IDLE_SYNC_MS = 3 * 60 * 1000 // 3 minutes of quiet after new steps
const MAX_UNSYNCED_MS = 15 * 60 * 1000 // Max 15 minutes during non-stop work
const RETRY_BACKOFF_MS = 5 * 60 * 1000 // 5 minutes backoff if offline / network error
const ACTIVE_POLL_MS = 15 * 1000 // Poll every 15s while Antigravity is open
const DORMANT_POLL_MS = 20 * 1000 // Poll every 20s while Antigravity is closed
const CLOSE_GRACE_MS = 12 * 1000 // Ignore transient Reload Window / Server Restart dips
const MAX_LOG_BYTES = 256 * 1024 // Cap .daemon.log at 256 KB

const LOCK_PATH = join(REPO_ROOT, '.daemon.lock')
const LOG_PATH = join(REPO_ROOT, '.daemon.log')

function logEvent(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  console.log(line.trimEnd())
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_LOG_BYTES) {
      const tail = readFileSync(LOG_PATH, 'utf8').slice(-Math.floor(MAX_LOG_BYTES / 2))
      writeFileSync(LOG_PATH, tail, 'utf8')
    }
    appendFileSync(LOG_PATH, line, 'utf8')
  } catch {}
}

// Single-instance guard
if (existsSync(LOCK_PATH)) {
  try {
    const prev = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    if (prev?.pid && prev.pid !== process.pid && isPidAlive(Number(prev.pid))) {
      console.log(`ℹ️ Auto-sync daemon is already running (PID ${prev.pid}).`)
      process.exit(0)
    }
  } catch {}
}

writeFileSync(
  LOCK_PATH,
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), repo: REPO_ROOT }, null, 2),
  'utf8',
)

const cleanupLock = () => {
  try {
    if (existsSync(LOCK_PATH)) {
      const cur = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
      if (cur?.pid === process.pid) rmSync(LOCK_PATH, { force: true })
    }
  } catch {}
}
process.on('exit', cleanupLock)
process.on('SIGINT', () => {
  cleanupLock()
  process.exit(0)
})
process.on('SIGTERM', () => {
  cleanupLock()
  process.exit(0)
})

const config = loadConfig()
const agyDir = getAntigravityDir()
const explicitWs = getArgValue('--workspace')
let targetWorkspacePath: string | null = explicitWs ? resolve(explicitWs) : null
if (!targetWorkspacePath) {
  const sibling = resolve(REPO_ROOT, '..', config.projectSlug)
  if (existsSync(sibling)) targetWorkspacePath = sibling
}

const slugLower = config.projectSlug.toLowerCase()
const legacyLowers = config.legacyProjectSlugs.map(s => s.toLowerCase()).filter(Boolean)
const excludedSet = new Set(config.excludedConversationIds)
const extraSet = new Set(config.extraConversationIds)

function getArchivedProjectTotalSteps(): number {
  const summariesPath = join(REPO_ROOT, 'antigravity-backup', 'summaries.json')
  if (!existsSync(summariesPath)) return 0
  try {
    const { summaries } = JSON.parse(readFileSync(summariesPath, 'utf8'))
    let total = 0
    for (const s of summaries || []) {
      if (excludedSet.has(s.conversation_id)) continue
      total += s.step_count ?? 0
    }
    return total
  } catch {
    return 0
  }
}

function getLocalProjectTotalSteps(): number {
  const summaryDbPath = join(agyDir, 'conversation_summaries.db')
  if (!existsSync(summaryDbPath)) return 0
  try {
    const db = new Database(summaryDbPath, { readonly: true })
    const topRows = db
      .query("SELECT conversation_id, step_count, workspace_uris FROM conversation_summaries WHERE parent_conversation_id = ''")
      .all() as Array<{ conversation_id: string; step_count: number; workspace_uris: string }>

    const matchedTopIds: string[] = []
    let total = 0
    for (const r of topRows) {
      if (excludedSet.has(r.conversation_id)) continue
      const ws = String(r.workspace_uris || '').toLowerCase()
      if (extraSet.has(r.conversation_id) || ws.includes(slugLower) || legacyLowers.some(leg => ws.includes(leg))) {
        matchedTopIds.push(r.conversation_id)
        const dbSteps = getActualConvDbStepCount(join(agyDir, 'conversations', `${r.conversation_id}.db`))
        total += Math.max(r.step_count ?? 0, dbSteps > 0 ? dbSteps : 0)
      }
    }

    if (matchedTopIds.length > 0) {
      const ph = matchedTopIds.map(() => '?').join(',')
      const childRows = db
        .query(`SELECT conversation_id, step_count FROM conversation_summaries WHERE parent_conversation_id IN (${ph})`)
        .all(...matchedTopIds) as Array<{ conversation_id: string; step_count: number }>
      for (const c of childRows) {
        if (excludedSet.has(c.conversation_id)) continue
        const dbSteps = getActualConvDbStepCount(join(agyDir, 'conversations', `${c.conversation_id}.db`))
        total += Math.max(c.step_count ?? 0, dbSteps > 0 ? dbSteps : 0)
      }
    }
    db.close()
    return total
  } catch {
    return 0
  }
}

function runSyncAndVerify(reason: string): boolean {
  logEvent(`⬆️ Auto-syncing "${config.projectDisplayName}" (${reason})...`)
  const syncRes = spawnSync(process.execPath, ['run', join(import.meta.dir, 'sync.ts')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (syncRes.status === 0) {
    const verRes = spawnSync(process.execPath, ['run', join(import.meta.dir, 'verify.ts')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    })
    logEvent(`✅ Auto-sync succeeded (${reason}) [verify=${verRes.status === 0 ? 'ok' : 'warn'}]`)
    return true
  }
  logEvent(`⚠️ Auto-sync failed (${reason}): ${String(syncRes.stderr || syncRes.stdout || '').trim().slice(0, 200)}`)
  return false
}

function runBootRestoreIfClosed() {
  if (isAntigravityRunning() || isLanguageServerRunning()) return
  logEvent(`⬇️ Antigravity is closed on daemon startup — pulling & restoring latest "${config.projectDisplayName}" chats...`)
  const restoreArgs = ['run', join(import.meta.dir, 'restore.ts')]
  if (targetWorkspacePath) restoreArgs.push('--workspace', targetWorkspacePath)
  const res = spawnSync(process.execPath, restoreArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
  logEvent(`⬇️ Boot restore finished (exit=${res.status ?? -1})`)
}

logEvent(
  `🟢 Daemon started (PID ${process.pid}) for "${config.projectDisplayName}" — watching 3m idle / 15m checkpoint / exit sync.`,
)

runBootRestoreIfClosed()

let lastSyncedSteps = getArchivedProjectTotalSteps()
let prevPolledSteps = getLocalProjectTotalSteps()
let lastActivityAt = Date.now()
let unsyncedSince: number | null = prevPolledSteps > lastSyncedSteps ? Date.now() : null
let nextAllowedSyncAt = 0
let wasRunning = isAntigravityRunning()

while (true) {
  await Bun.sleep(wasRunning ? ACTIVE_POLL_MS : DORMANT_POLL_MS)

  let nowRunning = isAntigravityRunning()
  if (wasRunning && !nowRunning) {
    await Bun.sleep(CLOSE_GRACE_MS)
    nowRunning = isAntigravityRunning()
  }

  const curSteps = getLocalProjectTotalSteps()
  const now = Date.now()

  if (curSteps > prevPolledSteps) {
    lastActivityAt = now
    if (unsyncedSince === null && curSteps > lastSyncedSteps) {
      unsyncedSince = now
    }
  }
  prevPolledSteps = curSteps

  if (wasRunning && !nowRunning) {
    logEvent('🔵 Antigravity closed — checking for unsynced steps...')
    if (curSteps > lastSyncedSteps && now >= nextAllowedSyncAt) {
      const ok = runSyncAndVerify('Antigravity closed')
      if (ok) {
        lastSyncedSteps = Math.max(getArchivedProjectTotalSteps(), getLocalProjectTotalSteps())
        prevPolledSteps = lastSyncedSteps
        unsyncedSince = null
      } else {
        nextAllowedSyncAt = Date.now() + RETRY_BACKOFF_MS
      }
    }
    wasRunning = false
    continue
  }

  if (!wasRunning && nowRunning) {
    logEvent('🟢 Antigravity opened — active auto-sync monitoring engaged.')
  }
  wasRunning = nowRunning

  if (curSteps > lastSyncedSteps && now >= nextAllowedSyncAt) {
    if (unsyncedSince === null) unsyncedSince = now
    const idleReady = now - lastActivityAt >= IDLE_SYNC_MS
    const maxReady = now - unsyncedSince >= MAX_UNSYNCED_MS

    if (idleReady || maxReady) {
      const ok = runSyncAndVerify(idleReady ? '3m idle after new steps' : '15m periodic checkpoint')
      if (ok) {
        lastSyncedSteps = Math.max(getArchivedProjectTotalSteps(), getLocalProjectTotalSteps())
        prevPolledSteps = lastSyncedSteps
        unsyncedSince = null
      } else {
        nextAllowedSyncAt = Date.now() + RETRY_BACKOFF_MS
      }
    }
  }
}
