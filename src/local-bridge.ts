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
  type NormalizedTurn,
  seedClaudeConversation,
  seedCodexConversation,
} from './agents'
import { getAntigravityDir, getArgValue } from './config'
import { extractTurns } from './markdown-exporter'
import { findRegisteredProject } from './registry'
import {
  collectAiderSessions,
  collectClineFamilySessions,
  collectCopilotSessions,
  collectGeminiCliSessions,
  getWindsurfCodeiumDir,
  getWindsurfUserDir,
  UNIVERSAL_AGENT_LABELS,
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
      .query("SELECT conversation_id, title, preview, workspace_uris, last_modified_time FROM conversation_summaries WHERE parent_conversation_id = '' ORDER BY last_modified_time ASC")
      .all() as any[]

    for (const r of rows) {
      if (opts.excludedIds?.has(r.conversation_id)) continue
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

/**
 * Discovers ALL live conversations for a project directly from every installed AI agent
 * on the current PC — requiring ZERO GitHub repo, ZERO sync.config.json, and ZERO prior setup!
 */
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

  // Sort oldest-to-newest soNewest is last
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
 * Bridges live project sessions directly across AI agents on a SINGLE machine (Zero GitHub required!).
 */
export function executeLocalBridge(opts: {
  workspacePath: string
  projectSlug?: string
  legacyProjectSlugs?: string[]
  targetAgent?: string // 'all' | 'claude' | 'codex' | 'cursor' | 'windsurf' | 'cline' | 'roocode' | 'copilot' | 'gemini' | 'universal'
  fromAgent?: string
  sessionId?: string
  latestOnly?: boolean
  excludedIds?: Set<string>
  agyDir?: string
  claudeDir?: string
  codexDir?: string
  cursorUserDir?: string
  vsCodeUserDir?: string
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

  const targetsToRun: string[] = []
  if (rawTarget === 'all' || rawTarget === 'auto') {
    const claudeRoot = opts.claudeDir || getClaudeDir()
    const codexRoot = opts.codexDir || getCodexDir()
    const cursorRoot =
      opts.cursorUserDir ||
      join(
        process.platform === 'win32'
          ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
          : process.platform === 'darwin'
            ? join(homedir(), 'Library', 'Application Support')
            : join(homedir(), '.config'),
        'Cursor',
        'User',
      )
    if (existsSync(claudeRoot)) targetsToRun.push('claude')
    if (existsSync(codexRoot)) targetsToRun.push('codex')
    if (existsSync(cursorRoot)) targetsToRun.push('cursor')
    if (existsSync(getWindsurfUserDir()) || existsSync(getWindsurfCodeiumDir())) targetsToRun.push('windsurf')
    targetsToRun.push('universal')
  } else {
    targetsToRun.push(rawTarget === 'markdown' || rawTarget === 'any' ? 'universal' : rawTarget)
  }

  const bridgedTargets: LocalBridgeResult['bridgedTargets'] = []

  for (const tgt of targetsToRun) {
    if (tgt === 'claude') {
      const nonClaude = selected.filter(s => s.agent !== 'claude')
      const pool = nonClaude.length > 0 ? nonClaude : selected
      let lastPath = ''
      for (const s of pool) {
        const seeded = seedClaudeConversation({
          sourceId: s.id,
          workspacePath: ws,
          title: `[${s.agentLabel}] ${s.title}`,
          updatedAt: s.updatedAt,
          turns: s.turns.slice(-70),
          claudeDir: opts.claudeDir,
        })
        lastPath = seeded.filePath
      }
      if (lastPath) {
        bridgedTargets.push({
          targetAgent: 'Claude Code',
          syncedCount: pool.length,
          location: resolve(lastPath, '..'),
          resumeHint: `cd "${ws}" && claude --resume`,
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
          title: `[${s.agentLabel}] ${s.title}`,
          updatedAt: s.updatedAt,
          turns: s.turns.slice(-70),
          codexDir: opts.codexDir,
        })
        lastPath = seeded.filePath
      }
      if (lastPath) {
        bridgedTargets.push({
          targetAgent: 'Codex',
          syncedCount: pool.length,
          location: resolve(lastPath, '..', '..', '..'),
          resumeHint: `Reload VS Code / Codex window -> ${pool.length} conversation(s) appear in Codex Chats!`,
        })
      }
    } else {
      const mappedTarget = (
        ['cursor', 'windsurf', 'cline', 'roocode', 'copilot', 'gemini', 'aider', 'opencode'].includes(tgt)
          ? tgt
          : 'universal'
      ) as any
      const res = writeUniversalWorkspaceContext({
        workspacePath: ws,
        projectSlug,
        targetAgent: mappedTarget,
        sessions: selected,
      })
      bridgedTargets.push({
        targetAgent: UNIVERSAL_AGENT_LABELS[mappedTarget] || tgt,
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

  // Support positional `chatsync to <agent>` or `--to <agent>`
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
    `\n⚡ Local AI Bridge Complete — "${res.projectSlug}" (${res.sourceSessionsCount} session(s) bridged with zero GitHub needed!)`,
  )
  console.log('─'.repeat(80))
  for (const b of res.bridgedTargets) {
    console.log(`  ✓ ${b.targetAgent.padEnd(28, ' ')} -> ${b.resumeHint}`)
  }
  console.log('─'.repeat(80) + '\n')
}
