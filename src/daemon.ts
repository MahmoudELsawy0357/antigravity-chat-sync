import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { collectAllExternalAgentSessions } from './agents'
import { getAntigravityDir, getArgValue, loadConfig, REPO_ROOT } from './config'
import { getActualConvDbStepCount, isAntigravityRunning, isLanguageServerRunning, isPidAlive } from './protobuf'

const IDLE_SYNC_MS = 3 * 60 * 1000 // 3 minutes of quiet after new steps
const MAX_UNSYNCED_MS = 15 * 60 * 1000 // Max 15 minutes during non-stop work
const RETRY_BACKOFF_MS = 5 * 60 * 1000 // 5 minutes backoff if offline / network error
const ACTIVE_POLL_MS = 15 * 1000 // Poll every 15s while active
const DORMANT_POLL_MS = 20 * 1000 // Poll every 20s while closed
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
  let total = 0
  const summariesPath = join(REPO_ROOT, 'antigravity-backup', 'summaries.json')
  if (existsSync(summariesPath)) {
    try {
      const { summaries } = JSON.parse(readFileSync(summariesPath, 'utf8'))
      for (const s of summaries || []) {
        if (excludedSet.has(s.conversation_id)) continue
        total += s.step_count ?? 0
      }
    } catch {}
  }

  const extManifestPath = join(REPO_ROOT, 'agent-backups', 'manifest.json')
  if (existsSync(extManifestPath)) {
    try {
      const extManifest = JSON.parse(readFileSync(extManifestPath, 'utf8'))
      for (const s of extManifest.sessions || []) {
        if (excludedSet.has(s.id)) continue
        total += s.stepCount ?? 0
      }
    } catch {}
  }

  return total
}

function getLocalProjectTotalSteps(): number {
  let total = 0
  const summaryDbPath = join(agyDir, 'conversation_summaries.db')
  if (existsSync(summaryDbPath)) {
    try {
      const db = new Database(summaryDbPath, { readonly: true })
      const topRows = db
        .query("SELECT conversation_id, step_count, workspace_uris FROM conversation_summaries WHERE parent_conversation_id = ''")
        .all() as Array<{ conversation_id: string; step_count: number; workspace_uris: string }>

      const matchedTopIds: string[] = []
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
          const dbSteps = getActualConvDbStepCount(join(agyDir, 'conversations', `${c.conversation_id}.db`))
          total += Math.max(c.step_count ?? 0, dbSteps > 0 ? dbSteps : 0)
        }
      }
      db.close()
    } catch {}
  }

  try {
    const extSessions = collectAllExternalAgentSessions({
      projectSlug: config.projectSlug,
      legacyProjectSlugs: config.legacyProjectSlugs,
      excludedIds: excludedSet,
    })
    for (const s of extSessions) {
      total += s.stepCount
    }
  } catch {}

  return total
}

function runScript(scriptRelPath: string, extraArgs: string[] = []): boolean {
  const res = spawnSync(process.execPath, ['run', join(REPO_ROOT, scriptRelPath), ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (res.status !== 0) {
    const errSnippet = String(res.stderr || res.stdout || '')
      .trim()
      .split('\n')
      .slice(-3)
      .join(' | ')
    logEvent(`⚠️ ${scriptRelPath} failed (code ${res.status}): ${errSnippet}`)
    return false
  }
  return true
}

function runSafeSync(reason: string): boolean {
  logEvent(`🔄 Triggering auto-sync (${reason})...`)
  const ok = runScript('src/sync.ts')
  if (ok) {
    logEvent(`✅ Auto-sync succeeded (${reason}).`)
  }
  return ok
}

function runSafeStartupRestore() {
  if (isAntigravityRunning() || isLanguageServerRunning()) return
  const restoreArgs = targetWorkspacePath ? ['--workspace', targetWorkspacePath] : []
  const ok = runScript('src/restore.ts', restoreArgs)
  if (ok) {
    logEvent(`📥 Startup restore check completed cleanly.`)
  }
}

logEvent(`🟢 Daemon started (PID ${process.pid}) for "${config.projectDisplayName}" — watching Antigravity, Claude, Codex & Cursor (3m idle / 15m / exit).`)

runSafeStartupRestore()

let wasAgyOpen = isAntigravityRunning() || isLanguageServerRunning()
let lastSyncedSteps = getArchivedProjectTotalSteps()
let lastObservedSteps = Math.max(lastSyncedSteps, getLocalProjectTotalSteps())
let lastStepChangeAt = lastObservedSteps > lastSyncedSteps ? Date.now() : 0
let unsyncedSince = lastObservedSteps > lastSyncedSteps ? Date.now() : 0
let nextRetryAllowedAt = 0

while (true) {
  const isOpen = isAntigravityRunning() || isLanguageServerRunning()

  if (!wasAgyOpen && isOpen) {
    logEvent('🚀 Antigravity session detected — active watcher engaged.')
    wasAgyOpen = true
  } else if (wasAgyOpen && !isOpen) {
    await Bun.sleep(CLOSE_GRACE_MS)
    const reopened = isAntigravityRunning() || isLanguageServerRunning()
    if (!reopened) {
      wasAgyOpen = false
      const finalLocalSteps = getLocalProjectTotalSteps()
      if (finalLocalSteps > lastSyncedSteps) {
        if (runSafeSync('Antigravity closed')) {
          lastSyncedSteps = Math.max(finalLocalSteps, getArchivedProjectTotalSteps())
          lastObservedSteps = lastSyncedSteps
          unsyncedSince = 0
        } else {
          nextRetryAllowedAt = Date.now() + RETRY_BACKOFF_MS
        }
      } else {
        logEvent('👋 Antigravity closed — archive already up to date.')
      }
    }
  }

  // Always check local steps across all agents (Claude, Codex, Cursor work even when Antigravity is closed!)
  const now = Date.now()
  const currentSteps = getLocalProjectTotalSteps()

  if (currentSteps > lastObservedSteps) {
    lastObservedSteps = currentSteps
    lastStepChangeAt = now
    if (unsyncedSince === 0) unsyncedSince = now
  }

  if (currentSteps > lastSyncedSteps && now >= nextRetryAllowedAt) {
    const idleElapsed = lastStepChangeAt > 0 ? now - lastStepChangeAt : IDLE_SYNC_MS
    const totalUnsyncedElapsed = unsyncedSince > 0 ? now - unsyncedSince : MAX_UNSYNCED_MS

    if (idleElapsed >= IDLE_SYNC_MS || totalUnsyncedElapsed >= MAX_UNSYNCED_MS) {
      const triggerReason = idleElapsed >= IDLE_SYNC_MS ? '3m idle' : '15m checkpoint'
      if (runSafeSync(triggerReason)) {
        lastSyncedSteps = Math.max(currentSteps, getArchivedProjectTotalSteps())
        lastObservedSteps = lastSyncedSteps
        unsyncedSince = 0
      } else {
        nextRetryAllowedAt = Date.now() + RETRY_BACKOFF_MS
      }
    }
  }

  await Bun.sleep(isOpen ? ACTIVE_POLL_MS : DORMANT_POLL_MS)
}
