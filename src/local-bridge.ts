import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  collectClaudeSessions,
  collectCodexSessions,
  collectCursorSessions,
  getClaudeDir,
  getCodexDir,
  getCursorUserDir,
  type NormalizedTurn,
  seedClaudeConversation,
  seedCodexConversation,
} from './agents'
import { getAntigravityDir, getArgValue } from './config'
import { extractTurns } from './markdown-exporter'
import { findRegisteredProject } from './registry'
import {
  seedAntigravitySidebarConversation,
  seedClineFamilySidebarConversation,
  seedCursorSidebarConversation,
  seedGeminiCliSidebarConversation,
  seedVsCodeChatSidebarConversation,
} from './sidebar-seeders'
import {
  collectAiderSessions,
  collectClineFamilySessions,
  collectCopilotSessions,
  collectGeminiCliSessions,
  getGeminiCliDir,
  getVsCodeUserDir,
  getWindsurfUserDir,
  writeUniversalWorkspaceContext,
} from './universal-agents'

export interface LocalLiveSession {
  id: string
  agent: string
  agentLabel: string
  title: string
  updatedAt: string
  turns: NormalizedTurn[]
}

export function collectLocalAntigravitySessions(opts: {
  projectSlug: string
  legacyProjectSlugs?: string[]
  excludedIds?: Set<string>
  agyDir?: string
}): LocalLiveSession[] {
  const agyDir = opts.agyDir || getAntigravityDir()
  const sumDbPath = join(agyDir, 'conversation_summaries.db')
  if (!existsSync(sumDbPath)) return []

  const targets = [opts.projectSlug, ...(opts.legacyProjectSlugs || [])].map(s => s.toLowerCase()).filter(Boolean)
  const out: LocalLiveSession[] = []

  try {
    const db = new Database(sumDbPath, { readonly: true })
    const rows = db
      .query("SELECT conversation_id, title, preview, step_count, source, workspace_uris, last_modified_time FROM conversation_summaries WHERE parent_conversation_id = '' ORDER BY last_modified_time ASC")
      .all() as any[]

    for (const r of rows) {
      if (opts.excludedIds?.has(r.conversation_id)) continue
      const srcTag = String(r.source || '')
      if (srcTag.startsWith('chatsync-mirror:')) {
        const seededSteps = Number(srcTag.split(':')[1] || 0)
        if ((r.step_count ?? 0) <= seededSteps) continue
      }
      let ws = String(r.workspace_uris || '')
      try {
        ws = decodeURIComponent(ws)
      } catch {}
      const low = ws.toLowerCase()
      if (!targets.some(t => low.includes(t))) continue

      const turns = extractTurns(agyDir, db, r.conversation_id)
      if (turns.length === 0) continue

      const title =
        r.title ||
        r.preview ||
        turns.find(t => t.role === 'user')?.text.replace(/\s+/g, ' ').trim().slice(0, 72) ||
        `Antigravity ${r.conversation_id.slice(0, 8)}`

      out.push({
        id: r.conversation_id,
        agent: 'antigravity',
        agentLabel: 'Antigravity',
        title,
        updatedAt: String(r.last_modified_time || new Date().toISOString()),
        turns: turns.map(t => ({ role: t.role, text: t.text, timestamp: t.timestamp, tools: t.tools })),
      })
    }
    db.close()
  } catch {}

  return out
}

export function discoverAllLocalProjectSessions(opts: {
  workspacePath: string
  projectSlug?: string
  legacyProjectSlugs?: string[]
  excludedIds?: Set<string>
  agyDir?: string
  claudeDir?: string
  codexDir?: string
  cursorUserDir?: string
  vsCodeUserDir?: string
  geminiDir?: string
}): LocalLiveSession[] {
  const ws = resolve(opts.workspacePath)
  const projectSlug = opts.projectSlug || basename(ws)
  const legacyProjectSlugs = opts.legacyProjectSlugs || []

  const sessions: LocalLiveSession[] = [
    ...collectLocalAntigravitySessions({
      projectSlug,
      legacyProjectSlugs,
      excludedIds: opts.excludedIds,
      agyDir: opts.agyDir,
    }),
    ...collectClaudeSessions({
      projectSlug,
      legacyProjectSlugs,
      excludedIds: opts.excludedIds,
      claudeDir: opts.claudeDir,
    }).map(s => ({
      id: s.id,
      agent: 'claude',
      agentLabel: 'Claude Code',
      title: s.title,
      updatedAt: s.updatedAt,
      turns: s.turns,
    })),
    ...collectCodexSessions({
      projectSlug,
      legacyProjectSlugs,
      excludedIds: opts.excludedIds,
      codexDir: opts.codexDir,
    }).map(s => ({
      id: s.id,
      agent: 'codex',
      agentLabel: 'Codex',
      title: s.title,
      updatedAt: s.updatedAt,
      turns: s.turns,
    })),
    ...collectCursorSessions({
      projectSlug,
      legacyProjectSlugs,
      excludedIds: opts.excludedIds,
      cursorUserDir: opts.cursorUserDir,
    }).map(s => ({
      id: s.id,
      agent: 'cursor',
      agentLabel: 'Cursor',
      title: s.title,
      updatedAt: s.updatedAt,
      turns: s.turns,
    })),
    ...collectCopilotSessions({
      projectSlug,
      legacyProjectSlugs,
      vsCodeUserDir: opts.vsCodeUserDir,
    }),
    ...collectClineFamilySessions({
      projectSlug,
      legacyProjectSlugs,
      ideUserDirs: opts.vsCodeUserDir ? [opts.vsCodeUserDir] : undefined,
    }),
    ...collectGeminiCliSessions({
      projectSlug,
      legacyProjectSlugs,
      geminiDir: opts.geminiDir,
    }),
    ...collectAiderSessions({
      workspacePath: ws,
      projectSlug,
    }),
  ]

  return sessions.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
}

export interface LocalBridgeResult {
  projectSlug: string
  workspacePath: string
  sourceSessionsCount: number
  bridgedTargets: Array<{
    targetAgent: string
    syncedCount: number
    location: string
    resumeHint: string
  }>
}

/**
 * Injects live project conversations DIRECTLY into the native Sidebar / History databases
 * of installed AI IDEs & CLI agents on a single PC — ZERO GitHub repo & ZERO `.md` handoff files!
 */
export function executeLocalBridge(opts: {
  workspacePath: string
  projectSlug?: string
  legacyProjectSlugs?: string[]
  targetAgent?: string // 'all' | 'antigravity' | 'claude' | 'codex' | 'cursor' | 'copilot' | 'windsurf' | 'cline' | 'roocode' | 'gemini' | 'universal'
  fromAgent?: string
  sessionId?: string
  latestOnly?: boolean
  excludedIds?: Set<string>
  agyDir?: string
  claudeDir?: string
  codexDir?: string
  cursorUserDir?: string
  vsCodeUserDir?: string
  windsurfUserDir?: string
  geminiDir?: string
}): LocalBridgeResult {
  const ws = resolve(opts.workspacePath)
  const projectSlug = opts.projectSlug || basename(ws)
  let discovered = discoverAllLocalProjectSessions({
    workspacePath: ws,
    projectSlug,
    legacyProjectSlugs: opts.legacyProjectSlugs,
    excludedIds: opts.excludedIds,
    agyDir: opts.agyDir,
    claudeDir: opts.claudeDir,
    codexDir: opts.codexDir,
    cursorUserDir: opts.cursorUserDir,
    vsCodeUserDir: opts.vsCodeUserDir,
    geminiDir: opts.geminiDir,
  })

  if (opts.fromAgent) {
    const f = opts.fromAgent.toLowerCase()
    discovered = discovered.filter(s => s.agent.toLowerCase() === f)
  }

  if (opts.sessionId) {
    discovered = discovered.filter(s => s.id === opts.sessionId || s.id.startsWith(opts.sessionId!))
  }

  if (discovered.length === 0) {
    throw new Error(`No local AI sessions found on this machine for project "${projectSlug}" (${ws}).`)
  }

  const selected = opts.latestOnly ? [discovered[discovered.length - 1]] : discovered
  const rawTarget = (opts.targetAgent || 'all').toLowerCase()

  const agyRoot = opts.agyDir || getAntigravityDir()
  const claudeRoot = opts.claudeDir || getClaudeDir()
  const codexRoot = opts.codexDir || getCodexDir()
  const cursorRoot = opts.cursorUserDir || getCursorUserDir()
  const vsCodeRoot = opts.vsCodeUserDir || getVsCodeUserDir()
  const windsurfRoot = opts.windsurfUserDir || getWindsurfUserDir()
  const geminiRoot = opts.geminiDir || getGeminiCliDir()

  const targetsToRun: string[] = []
  if (rawTarget === 'all' || rawTarget === 'auto') {
    if (existsSync(agyRoot)) targetsToRun.push('antigravity')
    if (existsSync(claudeRoot)) targetsToRun.push('claude')
    if (existsSync(codexRoot)) targetsToRun.push('codex')
    if (existsSync(cursorRoot)) targetsToRun.push('cursor')
    if (existsSync(vsCodeRoot)) targetsToRun.push('copilot')
    if (existsSync(windsurfRoot)) targetsToRun.push('windsurf')
    if (
      existsSync(join(vsCodeRoot, 'globalStorage', 'saoudrizwan.claude-dev')) ||
      existsSync(join(cursorRoot, 'globalStorage', 'saoudrizwan.claude-dev'))
    ) {
      targetsToRun.push('cline')
    }
    if (
      existsSync(join(vsCodeRoot, 'globalStorage', 'rooveterinaryinc.roo-cline')) ||
      existsSync(join(cursorRoot, 'globalStorage', 'rooveterinaryinc.roo-cline'))
    ) {
      targetsToRun.push('roocode')
    }
    if (existsSync(join(geminiRoot, 'tmp'))) targetsToRun.push('gemini')
  } else {
    targetsToRun.push(rawTarget === 'vscode' ? 'copilot' : rawTarget)
  }

  const bridgedTargets: LocalBridgeResult['bridgedTargets'] = []

  for (const tgt of targetsToRun) {
    if (tgt === 'antigravity') {
      const nonAgy = selected.filter(s => s.agent !== 'antigravity')
      if (nonAgy.length > 0) {
        let lastDb = ''
        for (const s of nonAgy) {
          const seeded = seedAntigravitySidebarConversation({
            sourceId: s.id,
            workspacePath: ws,
            title: s.title,
            updatedAt: s.updatedAt,
            turns: s.turns.slice(-80),
            agyDir: agyRoot,
          })
          lastDb = seeded.dbPath
        }
        bridgedTargets.push({
          targetAgent: 'Antigravity Sidebar',
          syncedCount: nonAgy.length,
          location: resolve(lastDb, '..'),
          resumeHint: `${nonAgy.length} external conversation(s) injected into Antigravity Sidebar (restart Antigravity if open)`,
        })
      }
    } else if (tgt === 'claude') {
      const nonClaude = selected.filter(s => s.agent !== 'claude')
      const pool = nonClaude.length > 0 ? nonClaude : selected
      let lastPath = ''
      for (const s of pool) {
        const seeded = seedClaudeConversation({
          sourceId: s.id,
          workspacePath: ws,
          title: s.title,
          updatedAt: s.updatedAt,
          turns: s.turns.slice(-80),
          claudeDir: claudeRoot,
        })
        lastPath = seeded.filePath
      }
      if (lastPath) {
        bridgedTargets.push({
          targetAgent: 'Claude Code Sidebar',
          syncedCount: pool.length,
          location: resolve(lastPath, '..'),
          resumeHint: `Open Claude Code Sidebar ("Past Conversations") or \`claude --resume\` -> ${pool.length} chat(s) ready!`,
        })
      }
    } else if (tgt === 'codex') {
      const nonCodex = selected.filter(s => s.agent !== 'codex')
      const pool = nonCodex.length > 0 ? nonCodex : selected
      let lastPath = ''
      for (const s of pool) {
        const seeded = seedCodexConversation({
          sourceId: s.id,
          workspacePath: ws,
          title: s.title,
          updatedAt: s.updatedAt,
          turns: s.turns.slice(-80),
          codexDir: codexRoot,
        })
        lastPath = seeded.filePath
      }
      if (lastPath) {
        bridgedTargets.push({
          targetAgent: 'Codex Sidebar',
          syncedCount: pool.length,
          location: resolve(lastPath, '..', '..', '..'),
          resumeHint: `Open Codex "Chats" Sidebar in VS Code (Reload Window if open) -> ${pool.length} chat(s) ready!`,
        })
      }
    } else if (tgt === 'cursor') {
      const nonCursor = selected.filter(s => s.agent !== 'cursor')
      const pool = nonCursor.length > 0 ? nonCursor : selected
      let lastDb = ''
      for (const s of pool) {
        const seeded = seedCursorSidebarConversation({
          sourceId: s.id,
          workspacePath: ws,
          title: s.title,
          updatedAt: s.updatedAt,
          turns: s.turns.slice(-80),
          cursorUserDir: cursorRoot,
        })
        lastDb = seeded.stateDbPath
      }
      if (lastDb) {
        bridgedTargets.push({
          targetAgent: 'Cursor Sidebar',
          syncedCount: pool.length,
          location: resolve(lastDb, '..'),
          resumeHint: `Open Cursor Agent/Composer Sidebar (Reload Window if open) -> ${pool.length} chat(s) appear directly in Sidebar!`,
        })
      }
    } else if (tgt === 'copilot') {
      const nonCopilot = selected.filter(s => s.agent !== 'copilot')
      const pool = nonCopilot.length > 0 ? nonCopilot : selected
      let lastFile = ''
      for (const s of pool) {
        const seeded = seedVsCodeChatSidebarConversation({
          sourceId: s.id,
          workspacePath: ws,
          title: s.title,
          updatedAt: s.updatedAt,
          turns: s.turns.slice(-80),
          ideUserDir: vsCodeRoot,
          responderLabel: 'GitHub Copilot',
        })
        lastFile = seeded.sessionFilePath
      }
      if (lastFile) {
        bridgedTargets.push({
          targetAgent: 'VS Code Copilot Sidebar',
          syncedCount: pool.length,
          location: resolve(lastFile, '..'),
          resumeHint: `Open VS Code Chat History icon (Reload Window if open) -> ${pool.length} chat(s) appear directly in Sidebar!`,
        })
      }
    } else if (tgt === 'windsurf') {
      let lastFile = ''
      for (const s of selected) {
        const seeded = seedVsCodeChatSidebarConversation({
          sourceId: s.id,
          workspacePath: ws,
          title: s.title,
          updatedAt: s.updatedAt,
          turns: s.turns.slice(-80),
          ideUserDir: windsurfRoot,
          responderLabel: 'Windsurf',
        })
        lastFile = seeded.sessionFilePath
      }
      if (lastFile) {
        bridgedTargets.push({
          targetAgent: 'Windsurf Chat Sidebar',
          syncedCount: selected.length,
          location: resolve(lastFile, '..'),
          resumeHint: `Open Windsurf Chat History Sidebar (Reload Window if open) -> ${selected.length} chat(s) ready!`,
        })
      }
    } else if (tgt === 'cline' || tgt === 'roocode') {
      const targetIdeDir = existsSync(join(cursorRoot, 'globalStorage')) && !existsSync(vsCodeRoot) ? cursorRoot : vsCodeRoot
      let lastDir = ''
      for (const s of selected) {
        const seeded = seedClineFamilySidebarConversation({
          sourceId: s.id,
          workspacePath: ws,
          title: s.title,
          updatedAt: s.updatedAt,
          turns: s.turns.slice(-80),
          variant: tgt,
          ideUserDir: targetIdeDir,
        })
        lastDir = seeded.taskDir
      }
      if (lastDir) {
        bridgedTargets.push({
          targetAgent: tgt === 'roocode' ? 'Roo Code History Sidebar' : 'Cline History Sidebar',
          syncedCount: selected.length,
          location: resolve(lastDir, '..'),
          resumeHint: `Open ${tgt === 'roocode' ? 'Roo Code' : 'Cline'} "History" tab -> ${selected.length} task(s) appear directly!`,
        })
      }
    } else if (tgt === 'gemini') {
      let lastFile = ''
      for (const s of selected) {
        const seeded = seedGeminiCliSidebarConversation({
          sourceId: s.id,
          workspacePath: ws,
          title: s.title,
          updatedAt: s.updatedAt,
          turns: s.turns.slice(-80),
          geminiDir: geminiRoot,
        })
        lastFile = seeded.filePath
      }
      if (lastFile) {
        bridgedTargets.push({
          targetAgent: 'Gemini CLI (/chat resume)',
          syncedCount: selected.length,
          location: resolve(lastFile, '..'),
          resumeHint: `Run \`gemini\` in "${ws}" and type \`/chat resume\` -> ${selected.length} session(s) listed!`,
        })
      }
    } else {
      // Explicit `chatsync to universal` fallback for web/custom tools with no local sidebar DB
      const res = writeUniversalWorkspaceContext({
        workspacePath: ws,
        projectSlug,
        targetAgent: 'universal',
        sessions: selected,
      })
      bridgedTargets.push({
        targetAgent: 'Universal Context (.chatsync)',
        syncedCount: selected.length,
        location: res.location,
        resumeHint: res.resumeHint,
      })
    }
  }

  return {
    projectSlug,
    workspacePath: ws,
    sourceSessionsCount: selected.length,
    bridgedTargets,
  }
}

if (import.meta.main) {
  const wsFlag = getArgValue('--workspace')
  const projFlag = getArgValue('--project')
  let workspacePath = wsFlag ? resolve(wsFlag) : process.cwd()

  if (!wsFlag && projFlag) {
    const reg = findRegisteredProject(projFlag)
    if (reg?.workspacePath && existsSync(reg.workspacePath)) {
      workspacePath = reg.workspacePath
    }
  }

  const args = process.argv.slice(2)
  let targetAgent = getArgValue('--to') || 'all'
  if (!getArgValue('--to') && args[0] && !args[0].startsWith('--')) {
    targetAgent = args[0] === 'to' && args[1] ? args[1] : args[0]
  }

  const excludeFlag = getArgValue('--exclude')
  const excludedIds = excludeFlag ? new Set([excludeFlag]) : undefined

  const res = executeLocalBridge({
    workspacePath,
    projectSlug: projFlag || basename(workspacePath),
    targetAgent,
    fromAgent: getArgValue('--from'),
    sessionId: getArgValue('--id'),
    latestOnly: process.argv.includes('--latest'),
    excludedIds,
  })

  console.log(
    `\n⚡ Native Sidebar Bridge Complete — "${res.projectSlug}" (${res.sourceSessionsCount} conversation(s) injected directly into AI Sidebars!)`,
  )
  console.log('─'.repeat(86))
  for (const b of res.bridgedTargets) {
    console.log(`  ✓ ${b.targetAgent.padEnd(26, ' ')} -> ${b.resumeHint}`)
  }
  console.log('─'.repeat(86) + '\n')
}
