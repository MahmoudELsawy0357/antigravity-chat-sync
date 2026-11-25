import { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAntigravityDir, getArgValue, loadConfig, REPO_ROOT } from './config'
import { getActualConvDbStepCount, isAntigravityRunning, isLanguageServerRunning } from './protobuf'

const IDLE_SYNC_MS = 3 * 60 * 1000 // 3 minutes of quiet after new steps
const MAX_UNSYNCED_MS = 15 * 60 * 1000 // Max 15 minutes during non-stop work
const RETRY_BACKOFF_MS = 5 * 60 * 1000 // 5 minutes backoff if offline
const POLL_INTERVAL_MS = 15 * 1000 // Check every 15s (local disk only, 0 network)
const CLOSE_GRACE_MS = 12 * 1000 // Ignore transient Reload Window / Server Restart dips

const config = loadConfig()
const agyDir = getAntigravityDir()
const explicitWs = getArgValue('--workspace')
let targetWorkspacePath: string | null = explicitWs ? resolve(explicitWs) : null
if (!targetWorkspacePath) {
  const sibling = resolve(REPO_ROOT, '..', config.projectSlug)
  if (existsSync(sibling)) targetWorkspacePath = sibling
}

function findAntigravityExecutable(): string | null {
  if (process.env.ANTIGRAVITY_BIN && existsSync(process.env.ANTIGRAVITY_BIN)) {
    return process.env.ANTIGRAVITY_BIN
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const candidates = [
      join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      'C:\\Program Files\\Antigravity\\Antigravity.exe',
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
  } else if (process.platform === 'darwin') {
    const macApp = '/Applications/Antigravity.app/Contents/MacOS/Electron'
    if (existsSync(macApp)) return macApp
  } else {
    const which = spawnSync('which', ['antigravity'], { encoding: 'utf8' })
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim()
  }
  return null
}

const slugLower = config.projectSlug.toLowerCase()
const legacyLowers = config.legacyProjectSlugs.map(s => s.toLowerCase()).filter(Boolean)
const excludedSet = new Set(config.excludedConversationIds)
const extraSet = new Set(config.extraConversationIds)

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
  const stamp = new Date().toLocaleTimeString()
  console.log(`\n⬆️ [${stamp}] Auto-syncing "${config.projectDisplayName}" (${reason})...`)
  const syncRes = spawnSync(process.execPath, ['run', join(import.meta.dir, 'sync.ts')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  if (syncRes.status === 0) {
    spawnSync(process.execPath, ['run', join(import.meta.dir, 'verify.ts')], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
    return true
  }
  return false
}

const agyExe = findAntigravityExecutable()
if (!agyExe) {
  console.error('❌ Could not locate Antigravity executable. Set ANTIGRAVITY_BIN env var to its path.')
  process.exit(1)
}

const restoreArgs = ['run', join(import.meta.dir, 'restore.ts')]
if (targetWorkspacePath) restoreArgs.push('--workspace', targetWorkspacePath)

// 1. Pull & restore latest conversations while Antigravity is closed
if (!isLanguageServerRunning()) {
  console.log(`\n⬇️ [1/3] Pulling & restoring latest "${config.projectDisplayName}" conversations...`)
  spawnSync(process.execPath, restoreArgs, { cwd: REPO_ROOT, stdio: 'inherit' })
} else {
  console.log('\nℹ️ Antigravity is already running — skipping pre-launch restore.')
}

// 2. Launch Antigravity on the project folder
console.log(`\n🚀 [2/3] Launching Antigravity${targetWorkspacePath ? ` -> ${targetWorkspacePath}` : ''}...`)
const launchArgs = targetWorkspacePath ? [targetWorkspacePath] : []
const child = spawn(agyExe, launchArgs, {
  detached: true,
  stdio: 'ignore',
})
child.unref()

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

// Wait up to 35 seconds for Antigravity UI or language_server to spin up
for (let i = 0; i < 70; i++) {
  if (isAntigravityRunning()) break
  await Bun.sleep(500)
}

if (!isAntigravityRunning()) {
  console.warn('⚠️ Could not detect Antigravity startup; exiting launcher without auto-sync.')
  process.exit(0)
}

console.log(
  '🟢 Antigravity is open! Auto-sync runs after 3 min of idle (or every 15 min of active work), plus on exit.',
)

let lastSyncedSteps = getArchivedProjectTotalSteps()
let prevPolledSteps = getLocalProjectTotalSteps()
let lastActivityAt = Date.now()
let unsyncedSince: number | null = prevPolledSteps > lastSyncedSteps ? Date.now() : null
let nextAllowedSyncAt = 0

// Watch while Antigravity is open: reload-proof periodic smart auto-sync + exit detection
while (true) {
  await Bun.sleep(POLL_INTERVAL_MS)
  if (!isAntigravityRunning()) {
    await Bun.sleep(CLOSE_GRACE_MS)
    if (!isAntigravityRunning()) break
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

// 3. Final sync on Antigravity exit (only if new steps happened since the last auto-sync!)
await Bun.sleep(1000)
const finalSteps = getLocalProjectTotalSteps()
if (finalSteps > lastSyncedSteps) {
  runSyncAndVerify('Antigravity closed')
} else {
  console.log('\n✨ [3/3] Antigravity closed — all conversations were already auto-synced to GitHub!')
}
console.log('✅ All done! Have a great day.')
