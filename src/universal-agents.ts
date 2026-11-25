import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { NormalizedTurn } from './agents'
import { redactText } from './redact'

export type UniversalAgentId =
  | 'antigravity'
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'windsurf'
  | 'copilot'
  | 'cline'
  | 'roocode'
  | 'gemini'
  | 'aider'
  | 'opencode'
  | 'universal'

export const UNIVERSAL_AGENT_LABELS: Record<string, string> = {
  antigravity: 'Antigravity',
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  copilot: 'GitHub Copilot',
  cline: 'Cline',
  roocode: 'Roo Code',
  gemini: 'Gemini CLI',
  aider: 'Aider',
  opencode: 'OpenCode',
  universal: 'Universal Context (.chatsync)',
}

export interface DiscoveredUniversalSession {
  id: string
  agent: string
  agentLabel: string
  title: string
  updatedAt: string
  stepCount: number
  workspacePath?: string
  turns: NormalizedTurn[]
  rawFormat: string
  rawPayload: string
}

function getAppDataRoaming(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support')
  }
  return join(homedir(), '.config')
}

export function getVsCodeUserDir(): string {
  return process.env.VSCODE_USER_DIR || join(getAppDataRoaming(), 'Code', 'User')
}

export function getWindsurfUserDir(): string {
  return process.env.WINDSURF_USER_DIR || join(getAppDataRoaming(), 'Windsurf', 'User')
}

export function getWindsurfCodeiumDir(): string {
  return process.env.WINDSURF_CODEIUM_DIR || join(homedir(), '.codeium', 'windsurf')
}

export function getGeminiCliDir(): string {
  return process.env.GEMINI_CLI_HOME || join(homedir(), '.gemini')
}

function matchesSlug(pathOrUri: string | undefined | null, projectSlug: string, legacySlugs: string[] = []): boolean {
  if (!pathOrUri) return false
  let decoded = pathOrUri
  try {
    decoded = decodeURIComponent(pathOrUri)
  } catch {}
  const norm = decoded.toLowerCase().replace(/\\/g, '/')
  const slugs = [projectSlug, ...legacySlugs].map(s => s.toLowerCase()).filter(Boolean)
  return slugs.some(s => {
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[\\s/\\\\"':-])${esc}([\\s/\\\\"':.,]|$)`).test(norm) || norm.endsWith(`/${s}`)
  })
}

function titleFromTurns(turns: NormalizedTurn[], fallback: string): string {
  const u = turns.find(t => t.role === 'user' && t.text.trim().length > 0)
  if (!u) return fallback
  const line = u.text.replace(/\s+/g, ' ').trim()
  return line.length > 72 ? `${line.slice(0, 69)}...` : line || fallback
}

/**
 * 1. GitHub Copilot Chat (VS Code workspaceStorage/<hash>/chatSessions/<id>.json)
 */
export function collectCopilotSessions(opts: {
  projectSlug: string
  legacyProjectSlugs?: string[]
  vsCodeUserDir?: string
}): DiscoveredUniversalSession[] {
  const wsStorage = join(opts.vsCodeUserDir || getVsCodeUserDir(), 'workspaceStorage')
  if (!existsSync(wsStorage)) return []

  const out: DiscoveredUniversalSession[] = []
  for (const hashDir of readdirSync(wsStorage)) {
    const fullHash = join(wsStorage, hashDir)
    try {
      if (!statSync(fullHash).isDirectory()) continue
      const wsJsonPath = join(fullHash, 'workspace.json')
      if (!existsSync(wsJsonPath)) continue
      const wsJson = JSON.parse(readFileSync(wsJsonPath, 'utf8'))
      const folderUri = wsJson.folder || wsJson.workspace || ''
      if (!matchesSlug(folderUri, opts.projectSlug, opts.legacyProjectSlugs)) continue

      const chatDir = join(fullHash, 'chatSessions')
      if (!existsSync(chatDir)) continue

      for (const f of readdirSync(chatDir)) {
        if (!f.endsWith('.json')) continue
        const fp = join(chatDir, f)
        const raw = JSON.parse(readFileSync(fp, 'utf8'))
        const requests: any[] = Array.isArray(raw?.requests) ? raw.requests : []
        const turns: NormalizedTurn[] = []

        for (const req of requests) {
          const userMsg = typeof req?.message?.text === 'string' ? redactText(req.message.text.trim()) : ''
          if (userMsg) turns.push({ role: 'user', text: userMsg })

          const respParts: string[] = []
          if (Array.isArray(req?.response)) {
            for (const part of req.response) {
              if (typeof part?.value === 'string') respParts.push(part.value.trim())
              else if (typeof part?.content?.value === 'string') respParts.push(part.content.value.trim())
            }
          }
          const assistantMsg = redactText(respParts.filter(Boolean).join('\n\n'))
          if (assistantMsg) turns.push({ role: 'assistant', text: assistantMsg })
        }

        if (turns.length === 0) continue
        const id = raw.sessionId || f.replace(/\.json$/, '')
        const updatedAt = raw.lastMessageDate
          ? new Date(raw.lastMessageDate).toISOString()
          : statSync(fp).mtime.toISOString()

        out.push({
          id,
          agent: 'copilot',
          agentLabel: UNIVERSAL_AGENT_LABELS.copilot,
          title: raw.customTitle || titleFromTurns(turns, `Copilot Session ${id.slice(0, 8)}`),
          updatedAt,
          stepCount: turns.length,
          turns,
          rawFormat: 'copilot-json',
          rawPayload: JSON.stringify({ id, updatedAt, turns }),
        })
      }
    } catch {}
  }
  return out
}

/**
 * 2. Cline & Roo Code (VS Code / Cursor / Windsurf globalStorage tasks/<id>/ui_messages.json)
 */
export function collectClineFamilySessions(opts: {
  projectSlug: string
  legacyProjectSlugs?: string[]
  ideUserDirs?: string[]
}): DiscoveredUniversalSession[] {
  const userDirs = opts.ideUserDirs || [
    getVsCodeUserDir(),
    join(getAppDataRoaming(), 'Cursor', 'User'),
    getWindsurfUserDir(),
  ]
  const extTargets = [
    { extId: 'saoudrizwan.claude-dev', agent: 'cline', label: 'Cline' },
    { extId: 'rooveterinaryinc.roo-cline', agent: 'roocode', label: 'Roo Code' },
  ]

  const out: DiscoveredUniversalSession[] = []
  const seenIds = new Set<string>()

  for (const uDir of userDirs) {
    for (const ext of extTargets) {
      const tasksDir = join(uDir, 'globalStorage', ext.extId, 'tasks')
      if (!existsSync(tasksDir)) continue

      for (const taskId of readdirSync(tasksDir)) {
        if (seenIds.has(`${ext.agent}:${taskId}`)) continue
        const tFolder = join(tasksDir, taskId)
        try {
          if (!statSync(tFolder).isDirectory()) continue
          const uiPath = join(tFolder, 'ui_messages.json')
          if (!existsSync(uiPath)) continue
          const rawText = readFileSync(uiPath, 'utf8')
          if (!matchesSlug(rawText, opts.projectSlug, opts.legacyProjectSlugs)) continue

          const msgs: any[] = JSON.parse(rawText)
          if (!Array.isArray(msgs)) continue
          const turns: NormalizedTurn[] = []

          for (const m of msgs) {
            const text = typeof m?.text === 'string' ? redactText(m.text.trim()) : ''
            if (!text) continue
            if (m.type === 'say' && (m.say === 'task' || m.say === 'user_feedback')) {
              turns.push({ role: 'user', text, timestamp: m.ts ? new Date(m.ts).toISOString() : undefined })
            } else if (m.type === 'say' && (m.say === 'text' || m.say === 'completion_result')) {
              turns.push({ role: 'assistant', text, timestamp: m.ts ? new Date(m.ts).toISOString() : undefined })
            }
          }

          if (turns.length === 0) continue
          seenIds.add(`${ext.agent}:${taskId}`)
          const updatedAt = statSync(uiPath).mtime.toISOString()
          out.push({
            id: taskId,
            agent: ext.agent,
            agentLabel: ext.label,
            title: titleFromTurns(turns, `${ext.label} Task ${taskId.slice(0, 8)}`),
            updatedAt,
            stepCount: turns.length,
            turns,
            rawFormat: `${ext.agent}-json`,
            rawPayload: JSON.stringify({ id: taskId, updatedAt, turns }),
          })
        } catch {}
      }
    }
  }
  return out
}

/**
 * 3. Aider (<workspace>/.aider.chat.history.md)
 */
export function collectAiderSessions(opts: {
  workspacePath?: string
  projectSlug: string
}): DiscoveredUniversalSession[] {
  if (!opts.workspacePath) return []
  const histPath = join(opts.workspacePath, '.aider.chat.history.md')
  if (!existsSync(histPath)) return []

  try {
    const raw = readFileSync(histPath, 'utf8')
    const blocks = raw.split(/^#\s+aider chat started at\s+/m).filter(b => b.trim().length > 0)
    const out: DiscoveredUniversalSession[] = []

    blocks.forEach((blk, idx) => {
      const lines = blk.split(/\r?\n/)
      const dateHeader = (lines[0] || '').trim()
      const body = lines.slice(1).join('\n')
      const turns: NormalizedTurn[] = []

      let curRole: 'user' | 'assistant' | null = null
      let curLines: string[] = []

      for (const l of body.split(/\r?\n/)) {
        if (l.startsWith('#### ')) {
          if (curRole && curLines.length > 0) {
            turns.push({ role: curRole, text: redactText(curLines.join('\n').trim()) })
          }
          curRole = 'user'
          curLines = [l.slice(5)]
        } else {
          if (curRole === 'user' && l.trim() === '') {
            if (curLines.join('\n').trim()) {
              turns.push({ role: 'user', text: redactText(curLines.join('\n').trim()) })
            }
            curRole = 'assistant'
            curLines = []
          } else if (curRole) {
            curLines.push(l)
          }
        }
      }
      if (curRole && curLines.join('\n').trim()) {
        turns.push({ role: curRole, text: redactText(curLines.join('\n').trim()) })
      }

      if (turns.length > 0) {
        const id = `aider-${opts.projectSlug}-${idx + 1}`
        out.push({
          id,
          agent: 'aider',
          agentLabel: 'Aider',
          title: titleFromTurns(turns, `Aider Session #${idx + 1}`),
          updatedAt: statSync(histPath).mtime.toISOString(),
          stepCount: turns.length,
          workspacePath: opts.workspacePath,
          turns,
          rawFormat: 'aider-md',
          rawPayload: JSON.stringify({ id, dateHeader, turns }),
        })
      }
    })
    return out
  } catch {
    return []
  }
}

/**
 * 4. Gemini CLI (~/.gemini/tmp/<hash>/chats/session-<id>.json)
 */
export function collectGeminiCliSessions(opts: {
  projectSlug: string
  legacyProjectSlugs?: string[]
  geminiDir?: string
}): DiscoveredUniversalSession[] {
  const tmpRoot = join(opts.geminiDir || getGeminiCliDir(), 'tmp')
  if (!existsSync(tmpRoot)) return []

  const out: DiscoveredUniversalSession[] = []
  for (const hashDir of readdirSync(tmpRoot)) {
    const chatsDir = join(tmpRoot, hashDir, 'chats')
    if (!existsSync(chatsDir)) continue
    try {
      for (const f of readdirSync(chatsDir)) {
        if (!f.endsWith('.json')) continue
        const fp = join(chatsDir, f)
        const rawStr = readFileSync(fp, 'utf8')
        if (!matchesSlug(rawStr, opts.projectSlug, opts.legacyProjectSlugs)) continue

        const parsed = JSON.parse(rawStr)
        const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : Array.isArray(parsed) ? parsed : []
        const turns: NormalizedTurn[] = []

        for (const m of messages) {
          const role = m?.role === 'user' ? 'user' : m?.role === 'model' || m?.role === 'assistant' ? 'assistant' : null
          if (!role) continue
          const text =
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.parts)
                ? m.parts.map((p: any) => p?.text || '').join('\n')
                : ''
          if (text.trim()) {
            turns.push({ role, text: redactText(text.trim()) })
          }
        }

        if (turns.length === 0) continue
        const id = parsed.sessionId || f.replace(/\.json$/, '')
        const updatedAt = statSync(fp).mtime.toISOString()
        out.push({
          id,
          agent: 'gemini',
          agentLabel: 'Gemini CLI',
          title: titleFromTurns(turns, `Gemini CLI ${id.slice(0, 8)}`),
          updatedAt,
          stepCount: turns.length,
          turns,
          rawFormat: 'gemini-json',
          rawPayload: JSON.stringify({ id, updatedAt, turns }),
        })
      }
    } catch {}
  }
  return out
}

export function detectAllInstalledAgentLabels(): string[] {
  const found: string[] = []
  const home = homedir()
  if (existsSync(join(home, '.gemini', 'antigravity'))) found.push('Antigravity')
  if (existsSync(join(home, '.claude'))) found.push('Claude Code')
  if (existsSync(join(home, '.codex'))) found.push('Codex')
  if (existsSync(join(getAppDataRoaming(), 'Cursor', 'User'))) found.push('Cursor')
  if (existsSync(getWindsurfUserDir()) || existsSync(getWindsurfCodeiumDir())) found.push('Windsurf')
  if (existsSync(getVsCodeUserDir())) found.push('VS Code / Copilot')
  if (
    existsSync(join(getVsCodeUserDir(), 'globalStorage', 'saoudrizwan.claude-dev')) ||
    existsSync(join(getAppDataRoaming(), 'Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev'))
  ) {
    found.push('Cline')
  }
  if (
    existsSync(join(getVsCodeUserDir(), 'globalStorage', 'rooveterinaryinc.roo-cline')) ||
    existsSync(join(getAppDataRoaming(), 'Cursor', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline'))
  ) {
    found.push('Roo Code')
  }
  if (existsSync(join(home, '.gemini', 'tmp'))) found.push('Gemini CLI')
  return found
}

function ensureWorkspaceGitExclude(workspacePath: string, patterns: string[]): void {
  const gitInfoDir = join(workspacePath, '.git', 'info')
  if (!existsSync(gitInfoDir)) return
  const excludeFile = join(gitInfoDir, 'exclude')
  let content = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
  let added = false
  for (const pat of patterns) {
    if (!content.includes(pat)) {
      if (!added) {
        content = content.trimEnd() + '\n\n# Local chatsync universal context bridge\n'
        added = true
      }
      content += `${pat}\n`
    }
  }
  if (added) writeFileSync(excludeFile, content, 'utf8')
}

/**
 * Materializes a session into rule/context files for Windsurf, Cline/Roo, Copilot,
 * AND the Universal Open Context Bridge (`.chatsync/latest.md` + `.chatsync/sessions/`)
 * so ANY AI agent in the world (even brand-new or web-based tools) can pick up immediately!
 */
export function writeUniversalWorkspaceContext(opts: {
  workspacePath: string
  projectSlug?: string
  targetAgent: 'windsurf' | 'cline' | 'roocode' | 'copilot' | 'gemini' | 'aider' | 'opencode' | 'universal' | 'cursor'
  sessions: Array<{
    id: string
    agentLabel: string
    title: string
    updatedAt: string
    turns: NormalizedTurn[]
  }>
}): { location: string; resumeHint: string } {
  const ws = resolve(opts.workspacePath)
  const slug = opts.projectSlug || basename(ws)
  const chatsyncDir = join(ws, '.chatsync')
  const sessionsDir = join(chatsyncDir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })

  const excludePatterns = ['.chatsync/', '.ai-handoff.md', '.ai-chats/']
  const ordered = [...opts.sessions]
  const newest = ordered[ordered.length - 1]

  const renderSessionBrief = (s: (typeof ordered)[number], maxTurns = 40): string => {
    const slice = s.turns.slice(-maxTurns)
    const transcript = slice
      .map(t => `### ${t.role === 'user' ? '👤 User' : `🤖 ${s.agentLabel}`}\n\n${t.text}`)
      .join('\n\n---\n\n')
    return [
      `# Session Handoff — \`${slug}\``,
      '',
      `- **Source Agent:** ${s.agentLabel}`,
      `- **Title:** ${s.title}`,
      `- **Session ID:** \`${s.id}\``,
      `- **Updated:** \`${s.updatedAt}\``,
      '',
      '---',
      '',
      transcript,
      '',
      '---',
      '**Instruction:** Continue seamlessly from the latest state above without repeating completed work.',
    ].join('\n')
  }

  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i]
    const safeSlug = s.title
      .toLowerCase()
      .replace(/[^\w\u0600-\u06FF\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 48) || s.id.slice(0, 12)
    writeFileSync(
      join(sessionsDir, `${String(i + 1).padStart(2, '0')}-${s.agentLabel.toLowerCase().replace(/\s+/g, '-')}-${safeSlug}.md`),
      renderSessionBrief(s, 60) + '\n',
      'utf8',
    )
  }

  const latestBrief = newest ? renderSessionBrief(newest, 50) : `# Session Handoff — \`${slug}\`\n`
  const latestPath = join(chatsyncDir, 'latest.md')
  writeFileSync(latestPath, latestBrief + '\n', 'utf8')
  // Keep legacy .ai-handoff.md in sync too for backward compatibility
  writeFileSync(join(ws, '.ai-handoff.md'), latestBrief + '\n', 'utf8')

  if (opts.targetAgent === 'cursor') {
    const rulesDir = join(ws, '.cursor', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    const mdcPath = join(rulesDir, 'chatsync-handoff.mdc')
    writeFileSync(
      mdcPath,
      `---\ndescription: Synced project conversation context (${ordered.length} session(s)) via chatsync\nglobs: \nalwaysApply: false\n---\n\n${latestBrief}\n`,
      'utf8',
    )
    excludePatterns.push('.cursor/rules/chatsync-handoff.mdc')
    ensureWorkspaceGitExclude(ws, excludePatterns)
    return {
      location: mdcPath,
      resumeHint: `In Cursor Composer: tag @chatsync-handoff.mdc or @.chatsync/latest.md to continue immediately!`,
    }
  }

  if (opts.targetAgent === 'windsurf') {
    const rulesDir = join(ws, '.windsurf', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    const rulePath = join(rulesDir, 'chatsync-handoff.md')
    writeFileSync(rulePath, `---\ntrigger: model_decision\ndescription: Active cross-agent session context synced by chatsync\n---\n\n${latestBrief}\n`, 'utf8')
    excludePatterns.push('.windsurf/rules/chatsync-handoff.md')
    ensureWorkspaceGitExclude(ws, excludePatterns)
    return {
      location: rulePath,
      resumeHint: `In Windsurf Cascade: tag @.chatsync/latest.md (or Cascade will auto-read .windsurf/rules/chatsync-handoff.md)!`,
    }
  }

  if (opts.targetAgent === 'cline' || opts.targetAgent === 'roocode') {
    const rulesDir = join(ws, '.clinerules')
    mkdirSync(rulesDir, { recursive: true })
    const rulePath = join(rulesDir, 'chatsync-handoff.md')
    writeFileSync(rulePath, latestBrief + '\n', 'utf8')
    excludePatterns.push('.clinerules/chatsync-handoff.md')
    ensureWorkspaceGitExclude(ws, excludePatterns)
    return {
      location: rulePath,
      resumeHint: `Open ${UNIVERSAL_AGENT_LABELS[opts.targetAgent]} in "${slug}" — .clinerules/chatsync-handoff.md is loaded automatically!`,
    }
  }

  ensureWorkspaceGitExclude(ws, excludePatterns)
  return {
    location: latestPath,
    resumeHint: `In ANY AI agent (${UNIVERSAL_AGENT_LABELS[opts.targetAgent] || opts.targetAgent}): reference \`.chatsync/latest.md\` (all ${ordered.length} session(s) also in \`.chatsync/sessions/\`)!`,
  }
}
