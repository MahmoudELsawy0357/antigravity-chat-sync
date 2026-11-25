import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAntigravityDir, getArgValue, loadConfig, REPO_ROOT } from './config'
import {
  detectLocalProjectId,
  getActualConvDbStepCount,
  hasLocalProjectConfig,
  isLanguageServerRunning,
  isPidAlive,
  parseProtoFields,
  toWorkspaceUris,
} from './protobuf'

const config = loadConfig()
const agyDir = getAntigravityDir()
const explicitWs = getArgValue('--workspace')
let targetWorkspacePath: string | null = explicitWs ? resolve(explicitWs) : null
if (!targetWorkspacePath) {
  const sibling = resolve(REPO_ROOT, '..', config.projectSlug)
  if (existsSync(sibling)) targetWorkspacePath = sibling
}

const targetUris = targetWorkspacePath ? toWorkspaceUris(targetWorkspacePath) : null
const localProjectId = detectLocalProjectId(agyDir, targetUris)
const lsRunning = isLanguageServerRunning()

console.log(`\n🩺 Antigravity Chat Sync Status — "${config.projectDisplayName}" (${config.projectSlug})`)
console.log('─'.repeat(76))
console.log(`📁 Workspace Path   : ${targetWorkspacePath ?? '⚠️ Not found (pass --workspace <path>)'}`)
console.log(
  `🆔 Local Project ID : ${
    localProjectId
      ? `${localProjectId} (${hasLocalProjectConfig(agyDir, localProjectId) ? '✅ config exists' : '⚠️ missing config JSON'})`
      : '⚠️ Not detected yet (will auto-create on restore)'
  }`,
)
console.log(`⚙️ Antigravity LS   : ${lsRunning ? '🟡 Running (close before restore or use --wait)' : '🟢 Stopped (safe to restore)'}`)

const safeSlug = config.projectSlug.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'project'
let startupPath = ''
if (process.platform === 'win32') {
  const sq = spawnSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Startup')"], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const sDir =
    String(sq.stdout || '').trim() ||
    join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  startupPath = join(sDir, `antigravity-chatsync-${safeSlug}.vbs`)
} else if (process.platform === 'darwin') {
  startupPath = join(homedir(), 'Library', 'LaunchAgents', `com.antigravity.chatsync.${safeSlug}.plist`)
} else {
  startupPath = join(homedir(), '.config', 'autostart', `antigravity-chatsync-${safeSlug}.desktop`)
}

const lockPath = join(REPO_ROOT, '.daemon.lock')
let daemonPid: number | null = null
if (existsSync(lockPath)) {
  try {
    const info = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (info?.pid && isPidAlive(Number(info.pid))) daemonPid = Number(info.pid)
  } catch {}
}
const startupEnabled = existsSync(startupPath)
console.log(
  `🤖 Auto-Sync Daemon : ${daemonPid ? `🟢 Running (PID ${daemonPid})` : '⚪ Stopped (run `bun run autostart`)'} | OS Autostart: ${startupEnabled ? '✅ Enabled' : '⚪ Not installed'}`,
)
const daemonLogPath = join(REPO_ROOT, '.daemon.log')
if (existsSync(daemonLogPath)) {
  const lines = readFileSync(daemonLogPath, 'utf8').trim().split('\n').filter(Boolean)
  const lastSyncLine = [...lines].reverse().find(l => l.includes('Auto-sync succeeded') || l.includes('Daemon started'))
  if (lastSyncLine) console.log(`🕒 Last Watcher Log : ${lastSyncLine}`)
}

const slugLower = config.projectSlug.toLowerCase()
const legacyLowers = config.legacyProjectSlugs.map(s => s.toLowerCase()).filter(Boolean)
const excludedSet = new Set(config.excludedConversationIds)
const extraSet = new Set(config.extraConversationIds)

// Load archive summaries
const summariesPath = join(REPO_ROOT, 'antigravity-backup', 'summaries.json')
const archiveMap = new Map<string, any>()
if (existsSync(summariesPath)) {
  const { summaries } = JSON.parse(readFileSync(summariesPath, 'utf8'))
  for (const s of summaries || []) {
    if (!s.parent_conversation_id) archiveMap.set(s.conversation_id, s)
  }
}

// Load local summaries
const localMap = new Map<string, any>()
const summaryDbPath = join(agyDir, 'conversation_summaries.db')
let foreignProjCount = 0

if (existsSync(summaryDbPath)) {
  const db = new Database(summaryDbPath, { readonly: true })
  const rows = db
    .query("SELECT conversation_id, title, preview, step_count, workspace_uris, project_id, last_modified_time FROM conversation_summaries WHERE parent_conversation_id = ''")
    .all() as any[]
  db.close()

  for (const r of rows) {
    if (excludedSet.has(r.conversation_id)) continue
    const ws = String(r.workspace_uris || '').toLowerCase()
    const matches =
      extraSet.has(r.conversation_id) ||
      archiveMap.has(r.conversation_id) ||
      ws.includes(slugLower) ||
      legacyLowers.some(leg => ws.includes(leg))
    if (!matches) continue

    const actualSteps = getActualConvDbStepCount(join(agyDir, 'conversations', `${r.conversation_id}.db`))
    const effectiveSteps = Math.max(r.step_count ?? 0, actualSteps > 0 ? actualSteps : 0)
    const isForeignProj = Boolean(
      localProjectId && r.project_id && r.project_id !== localProjectId && !hasLocalProjectConfig(agyDir, r.project_id),
    )
    if (isForeignProj) foreignProjCount++
    localMap.set(r.conversation_id, { ...r, effectiveSteps, isForeignProj })
  }
}

// Check agyhub_summaries_proto.pb for foreign project_id entries belonging to this project
let agyhubForeignCount = 0
const hubPbPath = join(agyDir, 'agyhub_summaries_proto.pb')
if (existsSync(hubPbPath) && localProjectId) {
  const hub = readFileSync(hubPbPath)
  for (const tf of parseProtoFields(hub)) {
    if (tf.fieldNo !== 1 || tf.wireType !== 2) continue
    const ef = parseProtoFields(tf.valueBytes)
    const vf = ef.find(x => x.fieldNo === 2 && x.wireType === 2)
    if (!vf) continue
    const txt = Buffer.from(vf.valueBytes).toString('utf8').toLowerCase()
    if (!txt.includes(slugLower)) continue
    const f17 = parseProtoFields(vf.valueBytes).find(x => x.fieldNo === 17 && x.wireType === 2)
    if (!f17) continue
    const f18 = parseProtoFields(f17.valueBytes).find(x => x.fieldNo === 18 && x.wireType === 2)
    const pid = f18 ? Buffer.from(f18.valueBytes).toString('utf8') : ''
    if (!pid || (pid !== localProjectId && !hasLocalProjectConfig(agyDir, pid))) {
      agyhubForeignCount++
    }
  }
}

const allIds = new Set<string>([...archiveMap.keys(), ...localMap.keys()])
const tableData: Array<{ ID: string; Title: string; Local: number | string; Archive: number | string; Status: string }> = []

let needPush = 0
let needPull = 0

for (const id of allIds) {
  const loc = localMap.get(id)
  const arc = archiveMap.get(id)
  const title = (loc?.title || arc?.title || loc?.preview || arc?.preview || '(untitled)').slice(0, 36)
  const locSteps = loc ? loc.effectiveSteps : '—'
  const arcSteps = arc ? (arc.step_count ?? 0) : '—'

  let status = '✅ Synced'
  if (loc && !arc) {
    status = '🆕 Local only (run sync)'
    needPush++
  } else if (!loc && arc) {
    status = '☁️ Archive only (run restore)'
    needPull++
  } else if (loc && arc) {
    if (loc.effectiveSteps > (arc.step_count ?? 0)) {
      status = '⬆️ Local newer (run sync)'
      needPush++
    } else if (loc.effectiveSteps < (arc.step_count ?? 0)) {
      status = '⬇️ Archive newer (run restore)'
      needPull++
    }
    if (loc.isForeignProj) {
      status += ' | ⚠️ Foreign project_id'
    }
  }

  tableData.push({ ID: id.slice(0, 8), Title: title, Local: locSteps, Archive: arcSteps, Status: status })
}

console.log('')
if (tableData.length === 0) {
  console.log('ℹ️ No conversations found locally or in the archive for this project yet.')
} else {
  console.table(tableData)
}

console.log(`📊 Summary: ${allIds.size} main chat(s) | Push needed: ${needPush} | Restore needed: ${needPull}`)
if (foreignProjCount > 0 || agyhubForeignCount > 0) {
  console.log(
    `⚠️ Health check: Found ${foreignProjCount} SQLite row(s) and ${agyhubForeignCount} agyhub entry(s) with foreign/missing project_id. Run \`bun run restore --wait\` to rebind them.`,
  )
} else {
  console.log('✅ Health check: All local project bindings look healthy!')
}
