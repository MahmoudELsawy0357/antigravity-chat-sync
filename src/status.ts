import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { AGENT_LABELS, type AgentKind, collectAllExternalAgentSessions } from './agents'
import { getAntigravityDir, getArgValue, loadConfig, REPO_ROOT, type SyncConfig } from './config'
import {
  detectLocalProjectId,
  getActualConvDbStepCount,
  hasLocalProjectConfig,
  isLanguageServerRunning,
  isPidAlive,
  parseProtoFields,
  toWorkspaceUris,
} from './protobuf'
import { findRegisteredProject } from './registry'
import { detectAllInstalledAgentLabels } from './universal-agents'

const explicitWs = getArgValue('--workspace')
const explicitProject = getArgValue('--project')
const explicitDir = getArgValue('--dir')

let archiveDir: string | null = null
if (explicitDir && existsSync(join(resolve(explicitDir), 'sync.config.json'))) {
  archiveDir = resolve(explicitDir)
} else if (existsSync(join(process.cwd(), 'sync.config.json'))) {
  archiveDir = process.cwd()
} else if (existsSync(join(REPO_ROOT, 'sync.config.json'))) {
  archiveDir = REPO_ROOT
} else {
  const lookup = explicitProject || explicitWs || process.cwd()
  const reg = findRegisteredProject(lookup)
  if (reg && existsSync(join(reg.archiveDir, 'sync.config.json'))) {
    archiveDir = reg.archiveDir
  }
}

let config: SyncConfig
if (archiveDir) {
  process.chdir(archiveDir)
  config = loadConfig()
} else {
  const inferredWs = explicitWs ? resolve(explicitWs) : process.cwd()
  const inferredSlug = explicitProject || basename(inferredWs)
  config = {
    projectSlug: inferredSlug,
    projectDisplayName: inferredSlug,
    legacyProjectSlugs: [],
    archiveRepo: '',
    maxChunkMB: 45,
    maxMarkdownPartKB: 350,
    excludedConversationIds: [],
    extraConversationIds: [],
  }
}

const agyDir = getAntigravityDir()
let targetWorkspacePath: string | null = explicitWs ? resolve(explicitWs) : null
if (!targetWorkspacePath) {
  if (archiveDir) {
    const reg = findRegisteredProject(config.projectSlug)
    const sibling = resolve(archiveDir, '..', config.projectSlug)
    if (reg?.workspacePath && existsSync(reg.workspacePath)) {
      targetWorkspacePath = reg.workspacePath
    } else if (existsSync(sibling)) {
      targetWorkspacePath = sibling
    }
  } else if (existsSync(process.cwd())) {
    targetWorkspacePath = process.cwd()
  }
}

const targetUris = targetWorkspacePath ? toWorkspaceUris(targetWorkspacePath) : null
const localProjectId = existsSync(agyDir) ? detectLocalProjectId(agyDir, targetUris) : null
const lsRunning = isLanguageServerRunning()
const detectedAgents = detectAllInstalledAgentLabels()

console.log(`\n🩺 chatsync v3.0 Status — "${config.projectDisplayName}" (${config.projectSlug})`)
console.log('─'.repeat(82))
console.log(`📁 Workspace Path   : ${targetWorkspacePath ?? '⚠️ Not found (pass --workspace <path>)'}`)
console.log(
  `🔄 Operating Mode   : ${
    archiveDir
      ? `☁️ Multi-PC GitHub Archive (${config.archiveRepo || archiveDir})`
      : '⚡ Single-PC Local Bridge Mode (zero GitHub needed — run `chatsync bridge`!)'
  }`,
)
console.log(`🧩 Installed Agents : ${detectedAgents.length > 0 ? detectedAgents.join(' · ') : 'None detected'}`)
if (existsSync(agyDir)) {
  console.log(
    `🆔 Antigravity ID   : ${
      localProjectId
        ? `${localProjectId} (${hasLocalProjectConfig(agyDir, localProjectId) ? '✅ config exists' : '⚠️ missing config JSON'})`
        : '⚠️ Not detected yet (will auto-create on restore)'
    }`,
  )
  console.log(`⚙️ Antigravity LS   : ${lsRunning ? '🟡 Running (close before restore or use --wait)' : '🟢 Stopped (safe to restore)'}`)
}

if (archiveDir) {
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

  const lockPath = join(archiveDir, '.daemon.lock')
  let daemonPid: number | null = null
  if (existsSync(lockPath)) {
    try {
      const info = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (info?.pid && isPidAlive(Number(info.pid))) daemonPid = Number(info.pid)
    } catch {}
  }
  const startupEnabled = existsSync(startupPath)
  console.log(
    `🤖 Auto-Sync Daemon : ${daemonPid ? `🟢 Running (PID ${daemonPid})` : '⚪ Stopped (run `chatsync autostart`)'} | OS Autostart: ${startupEnabled ? '✅ Enabled' : '⚪ Not installed'}`,
  )
  const daemonLogPath = join(archiveDir, '.daemon.log')
  if (existsSync(daemonLogPath)) {
    const lines = readFileSync(daemonLogPath, 'utf8').trim().split('\n').filter(Boolean)
    const lastSyncLine = [...lines].reverse().find(l => l.includes('Auto-sync succeeded') || l.includes('Daemon started'))
    if (lastSyncLine) console.log(`🕒 Last Watcher Log : ${lastSyncLine}`)
  }
}

const slugLower = config.projectSlug.toLowerCase()
const legacyLowers = config.legacyProjectSlugs.map(s => s.toLowerCase()).filter(Boolean)
const excludedSet = new Set(config.excludedConversationIds)
const extraSet = new Set(config.extraConversationIds)

interface StatusEntry {
  key: string
  id: string
  agent: AgentKind
  title: string
  localSteps: number | null
  archiveSteps: number | null
  isForeignProj?: boolean
}

const statusMap = new Map<string, StatusEntry>()

// 1. Archive Antigravity summaries (if archive exists)
if (archiveDir) {
  const summariesPath = join(archiveDir, 'antigravity-backup', 'summaries.json')
  if (existsSync(summariesPath)) {
    const { summaries } = JSON.parse(readFileSync(summariesPath, 'utf8'))
    for (const s of summaries || []) {
      if (s.parent_conversation_id) continue
      const key = `antigravity:${s.conversation_id}`
      statusMap.set(key, {
        key,
        id: s.conversation_id,
        agent: 'antigravity',
        title: s.title || s.preview || '(untitled)',
        localSteps: null,
        archiveSteps: s.step_count ?? 0,
      })
    }
  }
}

// 2. Local Antigravity summaries
const summaryDbPath = join(agyDir, 'conversation_summaries.db')
let foreignProjCount = 0
if (existsSync(summaryDbPath)) {
  const db = new Database(summaryDbPath, { readonly: true })
  const rows = db
    .query("SELECT conversation_id, title, preview, step_count, workspace_uris, project_id FROM conversation_summaries WHERE parent_conversation_id = ''")
    .all() as any[]
  db.close()

  for (const r of rows) {
    if (excludedSet.has(r.conversation_id)) continue
    const key = `antigravity:${r.conversation_id}`
    const ws = String(r.workspace_uris || '').toLowerCase()
    const matches =
      extraSet.has(r.conversation_id) ||
      statusMap.has(key) ||
      ws.includes(slugLower) ||
      legacyLowers.some(leg => ws.includes(leg))
    if (!matches) continue

    const actualSteps = getActualConvDbStepCount(join(agyDir, 'conversations', `${r.conversation_id}.db`))
    const effectiveSteps = Math.max(r.step_count ?? 0, actualSteps > 0 ? actualSteps : 0)
    const isForeignProj = Boolean(
      localProjectId && r.project_id && r.project_id !== localProjectId && !hasLocalProjectConfig(agyDir, r.project_id),
    )
    if (isForeignProj) foreignProjCount++

    const existing = statusMap.get(key)
    statusMap.set(key, {
      key,
      id: r.conversation_id,
      agent: 'antigravity',
      title: r.title || existing?.title || r.preview || '(untitled)',
      localSteps: effectiveSteps,
      archiveSteps: existing?.archiveSteps ?? null,
      isForeignProj,
    })
  }
}

// 3. Archive External Agents (if archive exists)
if (archiveDir) {
  const extManifestPath = join(archiveDir, 'agent-backups', 'manifest.json')
  if (existsSync(extManifestPath)) {
    try {
      const extManifest = JSON.parse(readFileSync(extManifestPath, 'utf8'))
      for (const s of extManifest.sessions || []) {
        const key = `${s.agent}:${s.id}`
        statusMap.set(key, {
          key,
          id: s.id,
          agent: s.agent,
          title: s.title || '(untitled)',
          localSteps: null,
          archiveSteps: s.stepCount ?? 0,
        })
      }
    } catch {}
  }
}

// 4. Local Universal External Agents (Claude, Codex, Cursor, Copilot, Cline, Roo, Gemini, Aider)
const localExternals = collectAllExternalAgentSessions({
  projectSlug: config.projectSlug,
  legacyProjectSlugs: config.legacyProjectSlugs,
  excludedIds: excludedSet,
  workspacePath: targetWorkspacePath ?? undefined,
})
for (const ext of localExternals) {
  const key = `${ext.agent}:${ext.id}`
  const existing = statusMap.get(key)
  statusMap.set(key, {
    key,
    id: ext.id,
    agent: ext.agent,
    title: ext.title || existing?.title || '(untitled)',
    localSteps: ext.stepCount,
    archiveSteps: existing?.archiveSteps ?? null,
  })
}

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

const tableData: Array<{
  Agent: string
  ID: string
  Title: string
  Local: number | string
  Archive: number | string
  Status: string
}> = []

let needPush = 0
let needPull = 0

for (const entry of statusMap.values()) {
  const hasLoc = entry.localSteps !== null
  const hasArc = entry.archiveSteps !== null

  let status = '✅ Synced'
  if (!archiveDir) {
    status = '⚡ Ready to bridge (`chatsync bridge`)'
  } else if (hasLoc && !hasArc) {
    status = '🆕 Local only (run `chatsync sync`)'
    needPush++
  } else if (!hasLoc && hasArc) {
    status = '☁️ Archive only (run `chatsync restore`)'
    needPull++
  } else if (hasLoc && hasArc) {
    if (entry.localSteps! > entry.archiveSteps!) {
      status = '⬆️ Local newer (run `chatsync sync`)'
      needPush++
    } else if (entry.localSteps! < entry.archiveSteps!) {
      status = '⬇️ Archive newer (run `chatsync restore`)'
      needPull++
    }
    if (entry.isForeignProj) {
      status += ' | ⚠️ Foreign project_id'
    }
  }

  tableData.push({
    Agent: AGENT_LABELS[entry.agent] || entry.agent,
    ID: entry.id.slice(0, 8),
    Title: entry.title.slice(0, 34),
    Local: hasLoc ? entry.localSteps! : '—',
    Archive: archiveDir ? (hasArc ? entry.archiveSteps! : '—') : '— (local)',
    Status: status,
  })
}

console.log('')
if (tableData.length === 0) {
  console.log('ℹ️ No conversations found locally for this project yet.')
} else {
  console.table(tableData)
}

if (archiveDir) {
  console.log(`📊 Summary: ${statusMap.size} session(s) across agents | Push needed: ${needPush} | Restore needed: ${needPull}`)
} else {
  console.log(`📊 Summary: ${statusMap.size} live local session(s) detected across your AI agents!`)
  console.log(`💡 Single-PC Bridge : \`chatsync bridge\` (links all agents) or \`chatsync to claude|codex|cursor|windsurf|cline|copilot\``)
  console.log(`💡 Multi-PC Backup  : \`chatsync setup\` (optional — only if you want private GitHub sync across 2+ PCs)`)
}

if (foreignProjCount > 0 || agyhubForeignCount > 0) {
  console.log(
    `⚠️ Health check: Found ${foreignProjCount} SQLite row(s) and ${agyhubForeignCount} agyhub entry(s) with foreign/missing project_id. Run \`chatsync restore --wait\` to rebind them.`,
  )
} else {
  console.log('✅ Health check: All local project bindings look healthy!')
}
