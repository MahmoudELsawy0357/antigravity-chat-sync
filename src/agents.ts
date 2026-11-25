import { Database } from 'bun:sqlite'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { redactText } from './redact'

/**
 * Generates an RFC 9562 monotonic time-ordered UUIDv7 (`019...`) required by Codex's Rust thread engine.
 */
export function generateUuidV7(nowMs = Date.now()): string {
  const bytes = randomBytes(16)
  const ts = BigInt(nowMs)
  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)
  bytes[6] = (bytes[6] & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122/9562 variant
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export type AgentKind = 'antigravity' | 'claude' | 'codex' | 'cursor'
export type ExternalAgentKind = Exclude<AgentKind, 'antigravity'>

export const AGENT_LABELS: Record<AgentKind, string> = {
  antigravity: 'Antigravity',
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
}

export interface NormalizedTurn {
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
  tools?: string[]
}

export interface ExternalAgentSession {
  id: string
  agent: ExternalAgentKind
  title: string
  updatedAt: string
  stepCount: number
  workspacePath?: string
  turns: NormalizedTurn[]
  rawFormat: 'claude-jsonl' | 'codex-jsonl' | 'cursor-json'
  rawPayload: string
}

export function getClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function getCodexDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

export function getCursorUserDir(): string {
  if (process.env.CURSOR_USER_DIR) return process.env.CURSOR_USER_DIR
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'User')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User')
  }
  return join(homedir(), '.config', 'Cursor', 'User')
}

export function encodeClaudeProjectDirName(workspacePath: string): string {
  return resolve(workspacePath).replace(/[:\\/]/g, '-')
}

function matchesProjectPath(
  candidatePathOrUri: string | undefined | null,
  projectSlug: string,
  legacySlugs: string[],
): boolean {
  if (!candidatePathOrUri) return false
  let decoded = candidatePathOrUri
  try {
    decoded = decodeURIComponent(candidatePathOrUri)
  } catch {}
  const norm = decoded.toLowerCase().replace(/\\/g, '/')
  const targets = [projectSlug, ...legacySlugs].map(s => s.toLowerCase()).filter(Boolean)
  return targets.some(slug => {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|/|-)${escaped}(/|$)`).test(norm) || norm.endsWith(`/${slug}`)
  })
}

function deriveTitleFromTurns(turns: NormalizedTurn[], fallback: string): string {
  const firstUser = turns.find(t => t.role === 'user' && t.text.trim().length > 0)
  if (!firstUser) return fallback
  const firstLine = firstUser.text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!firstLine) return fallback
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine
}

// ── 1. Claude Code Adapter (~/.claude/projects/<encoded-ws>/<id>.jsonl) ──────

function extractClaudeContentText(content: unknown): { text: string; tools: string[] } {
  if (typeof content === 'string') {
    return { text: content.trim(), tools: [] }
  }
  if (!Array.isArray(content)) return { text: '', tools: [] }

  const texts: string[] = []
  const tools: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, any>
    if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text.trim())
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      tools.push(b.name)
    }
  }
  return { text: texts.filter(Boolean).join('\n\n'), tools }
}

export function collectClaudeSessions(opts: {
  projectSlug: string
  legacyProjectSlugs?: string[]
  excludedIds?: Set<string>
  claudeDir?: string
}): ExternalAgentSession[] {
  const root = join(opts.claudeDir || getClaudeDir(), 'projects')
  if (!existsSync(root)) return []

  const legacy = opts.legacyProjectSlugs || []
  const excluded = opts.excludedIds || new Set<string>()
  const sessions: ExternalAgentSession[] = []

  for (const projEntry of readdirSync(root, { withFileTypes: true })) {
    if (!projEntry.isDirectory()) continue
    const projFolder = join(root, projEntry.name)
    const dirMatchesSlug = matchesProjectPath(projEntry.name, opts.projectSlug, legacy)

    for (const file of readdirSync(projFolder)) {
      if (!file.endsWith('.jsonl')) continue
      const fullPath = join(projFolder, file)
      const rawText = readFileSync(fullPath, 'utf8')
      const lines = rawText.split(/\r?\n/).filter(Boolean)
      if (lines.length === 0) continue

      let sessionId = file.replace(/\.jsonl$/, '')
      let cwd: string | undefined
      let summaryTitle = ''
      let lastTimestamp = ''
      const turns: NormalizedTurn[] = []

      for (const line of lines) {
        try {
          const obj = JSON.parse(line)
          if (obj.sessionId && typeof obj.sessionId === 'string') sessionId = obj.sessionId
          if (obj.cwd && typeof obj.cwd === 'string') cwd = obj.cwd
          if (obj.timestamp && typeof obj.timestamp === 'string') lastTimestamp = obj.timestamp
          if (obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary.trim()) {
            summaryTitle = obj.summary.trim()
          } else if (obj.type === 'user' || obj.type === 'assistant') {
            const msg = obj.message || obj
            const { text, tools } = extractClaudeContentText(msg.content)
            if (text || tools.length > 0) {
              turns.push({
                role: obj.type === 'user' ? 'user' : 'assistant',
                text: redactText(text),
                timestamp: obj.timestamp,
                tools: tools.length > 0 ? tools : undefined,
              })
            }
          }
        } catch {}
      }

      if (excluded.has(sessionId) || turns.length === 0) continue
      if (!dirMatchesSlug && !matchesProjectPath(cwd, opts.projectSlug, legacy)) continue

      const updatedAt = lastTimestamp || statSync(fullPath).mtime.toISOString()
      sessions.push({
        id: sessionId,
        agent: 'claude',
        title: redactText(summaryTitle || deriveTitleFromTurns(turns, `Claude Session ${sessionId.slice(0, 8)}`)),
        updatedAt,
        stepCount: lines.length,
        workspacePath: cwd,
        turns,
        rawFormat: 'claude-jsonl',
        rawPayload: redactText(rawText),
      })
    }
  }

  return sessions
}

export function restoreClaudeSession(
  session: ExternalAgentSession,
  targetWorkspacePath: string,
  claudeDir = getClaudeDir(),
): boolean {
  const encodedDir = encodeClaudeProjectDirName(targetWorkspacePath)
  const destFolder = join(claudeDir, 'projects', encodedDir)
  mkdirSync(destFolder, { recursive: true })
  const destFile = join(destFolder, `${session.id}.jsonl`)

  if (existsSync(destFile)) {
    const existingLines = readFileSync(destFile, 'utf8').split(/\r?\n/).filter(Boolean).length
    if (existingLines >= session.stepCount) return false
  }

  const rewrittenLines = session.rawPayload
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        const obj = JSON.parse(line)
        if (obj.cwd) obj.cwd = resolve(targetWorkspacePath)
        return JSON.stringify(obj)
      } catch {
        return line
      }
    })

  writeFileSync(destFile, rewrittenLines.join('\n') + '\n', 'utf8')
  return true
}

// ── 2. OpenAI Codex Adapter (~/.codex/session_index.jsonl & sessions/**/*.jsonl) ──

function collectJsonlRecursive(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectJsonlRecursive(full, acc)
    else if (entry.name.endsWith('.jsonl')) acc.push(full)
  }
  return acc
}

function isCodexSystemBoilerplate(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed.startsWith('# AGENTS.md instructions for ') ||
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<permissions instructions>')
  )
}

export function collectCodexSessions(opts: {
  projectSlug: string
  legacyProjectSlugs?: string[]
  excludedIds?: Set<string>
  codexDir?: string
}): ExternalAgentSession[] {
  const root = opts.codexDir || getCodexDir()
  const sessionsDir = join(root, 'sessions')
  if (!existsSync(sessionsDir)) return []

  const legacy = opts.legacyProjectSlugs || []
  const excluded = opts.excludedIds || new Set<string>()

  const threadNames = new Map<string, { name: string; updatedAt?: string }>()
  const indexFile = join(root, 'session_index.jsonl')
  if (existsSync(indexFile)) {
    for (const line of readFileSync(indexFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const row = JSON.parse(line)
        if (row.id && row.thread_name) {
          threadNames.set(String(row.id), { name: String(row.thread_name), updatedAt: row.updated_at })
        }
      } catch {}
    }
  }

  const rolloutFiles = collectJsonlRecursive(sessionsDir)
  const sessions: ExternalAgentSession[] = []

  for (const fullPath of rolloutFiles) {
    const rawText = readFileSync(fullPath, 'utf8')
    const lines = rawText.split(/\r?\n/).filter(Boolean)
    if (lines.length === 0) continue

    let sessionId = ''
    let cwd: string | undefined
    let lastTimestamp = ''
    const turns: NormalizedTurn[] = []

    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.timestamp && typeof obj.timestamp === 'string') lastTimestamp = obj.timestamp

        if (obj.type === 'session_meta' && obj.payload) {
          sessionId = obj.payload.session_id || obj.payload.id || sessionId
          cwd = obj.payload.cwd || cwd
        } else if (obj.type === 'response_item' && obj.payload) {
          const p = obj.payload
          if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
            const blocks = Array.isArray(p.content) ? p.content : []
            const textParts: string[] = []
            for (const b of blocks) {
              if (b && typeof b.text === 'string') textParts.push(b.text)
            }
            const joined = textParts.join('\n').trim()
            if (!joined) continue
            if (p.role === 'user' && isCodexSystemBoilerplate(joined)) continue
            turns.push({
              role: p.role,
              text: redactText(joined),
              timestamp: obj.timestamp,
            })
          } else if (p.type === 'function_call' && typeof p.name === 'string') {
            const prev = turns[turns.length - 1]
            if (prev && prev.role === 'assistant') {
              prev.tools = [...new Set([...(prev.tools || []), p.name])]
            }
          }
        }
      } catch {}
    }

    if (!sessionId || excluded.has(sessionId) || turns.length === 0) continue
    if (!matchesProjectPath(cwd, opts.projectSlug, legacy)) continue

    const idxMeta = threadNames.get(sessionId)
    const updatedAt = idxMeta?.updatedAt || lastTimestamp || statSync(fullPath).mtime.toISOString()
    const title = redactText(idxMeta?.name || deriveTitleFromTurns(turns, `Codex Session ${sessionId.slice(0, 8)}`))

    sessions.push({
      id: sessionId,
      agent: 'codex',
      title,
      updatedAt,
      stepCount: lines.length,
      workspacePath: cwd,
      turns,
      rawFormat: 'codex-jsonl',
      rawPayload: redactText(rawText),
    })
  }

  return sessions
}

export function restoreCodexSession(
  session: ExternalAgentSession,
  targetWorkspacePath: string,
  codexDir = getCodexDir(),
): boolean {
  const sessionsRoot = join(codexDir, 'sessions')
  const existingFiles = collectJsonlRecursive(sessionsRoot).filter(f => f.includes(session.id))
  if (existingFiles.length > 0) {
    const existingCount = readFileSync(existingFiles[0], 'utf8').split(/\r?\n/).filter(Boolean).length
    if (existingCount >= session.stepCount) return false
  }

  const dateObj = new Date(session.updatedAt || Date.now())
  const yyyy = String(dateObj.getUTCFullYear())
  const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dateObj.getUTCDate()).padStart(2, '0')
  const dayDir = join(sessionsRoot, yyyy, mm, dd)
  mkdirSync(dayDir, { recursive: true })

  const targetFile =
    existingFiles[0] ||
    join(dayDir, `rollout-${yyyy}-${mm}-${dd}T00-00-00-${session.id}.jsonl`)

  const resolvedWs = resolve(targetWorkspacePath)
  const rewrittenLines = session.rawPayload
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'session_meta' && obj.payload) {
          obj.payload.cwd = resolvedWs
        }
        return JSON.stringify(obj)
      } catch {
        return line
      }
    })

  writeFileSync(targetFile, rewrittenLines.join('\n') + '\n', 'utf8')

  // Upsert into session_index.jsonl
  const indexFile = join(codexDir, 'session_index.jsonl')
  const indexLines = existsSync(indexFile) ? readFileSync(indexFile, 'utf8').split(/\r?\n/).filter(Boolean) : []
  const filtered = indexLines.filter((l) => {
    try {
      return JSON.parse(l).id !== session.id
    } catch {
      return true
    }
  })
  filtered.push(
    JSON.stringify({
      id: session.id,
      thread_name: session.title,
      updated_at: session.updatedAt,
    }),
  )
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(indexFile, filtered.join('\n') + '\n', 'utf8')
  return true
}

// ── 3. Cursor IDE Adapter (workspaceStorage/<hash>/state.vscdb) ──────────────

export function collectCursorSessions(opts: {
  projectSlug: string
  legacyProjectSlugs?: string[]
  excludedIds?: Set<string>
  cursorUserDir?: string
}): ExternalAgentSession[] {
  const userDir = opts.cursorUserDir || getCursorUserDir()
  const wsStorageDir = join(userDir, 'workspaceStorage')
  if (!existsSync(wsStorageDir)) return []

  const legacy = opts.legacyProjectSlugs || []
  const excluded = opts.excludedIds || new Set<string>()
  const sessions: ExternalAgentSession[] = []

  const globalDbPath = join(userDir, 'globalStorage', 'state.vscdb')
  let globalDb: Database | null = null
  if (existsSync(globalDbPath)) {
    try {
      globalDb = new Database(globalDbPath, { readonly: true })
    } catch {}
  }

  try {
    for (const entry of readdirSync(wsStorageDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const subDir = join(wsStorageDir, entry.name)
      const wsJsonPath = join(subDir, 'workspace.json')
      const stateDbPath = join(subDir, 'state.vscdb')
      if (!existsSync(wsJsonPath) || !existsSync(stateDbPath)) continue

      let folderUri = ''
      try {
        const wsJson = JSON.parse(readFileSync(wsJsonPath, 'utf8'))
        folderUri = wsJson.folder || wsJson.workspace || ''
      } catch {}

      if (!matchesProjectPath(folderUri, opts.projectSlug, legacy)) continue

      try {
        const db = new Database(stateDbPath, { readonly: true })
        const rows = db
          .query(
            "SELECT key, value FROM ItemTable WHERE key IN ('workbench.panel.aichat.view.aichat.chatdata', 'composer.composerData')",
          )
          .all() as Array<{ key: string; value: string | Uint8Array }>
        db.close()

        for (const row of rows) {
          const valStr = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8')
          const parsed = JSON.parse(valStr)

          // Classic Cursor Chat Tabs
          if (row.key === 'workbench.panel.aichat.view.aichat.chatdata' && Array.isArray(parsed?.tabs)) {
            for (const tab of parsed.tabs) {
              const id = String(tab.tabId || '')
              if (!id || excluded.has(id)) continue
              const turns: NormalizedTurn[] = []
              for (const b of tab.bubbles || []) {
                const txt = String(b.text || b.rawText || '').trim()
                if (!txt) continue
                turns.push({
                  role: b.type === 'user' ? 'user' : 'assistant',
                  text: redactText(txt),
                })
              }
              if (turns.length === 0) continue
              const updatedAt = tab.lastSendTime
                ? new Date(Number(tab.lastSendTime)).toISOString()
                : statSync(stateDbPath).mtime.toISOString()
              const title = redactText(String(tab.chatTitle || deriveTitleFromTurns(turns, `Cursor Chat ${id.slice(0, 8)}`)))
              sessions.push({
                id,
                agent: 'cursor',
                title,
                updatedAt,
                stepCount: turns.length,
                workspacePath: folderUri,
                turns,
                rawFormat: 'cursor-json',
                rawPayload: JSON.stringify({ id, title, updatedAt, turns }),
              })
            }
          }

          // Cursor Composer / Agent Threads
          if (row.key === 'composer.composerData' && Array.isArray(parsed?.allComposers)) {
            for (const comp of parsed.allComposers) {
              const id = String(comp.composerId || '')
              if (!id || excluded.has(id)) continue
              let conversation = Array.isArray(comp.conversation) ? comp.conversation : []

              // Check globalStorage cursorDiskKV if composer conversation is stored externally
              if (conversation.length === 0 && globalDb) {
                try {
                  const gRow = globalDb
                    .query('SELECT value FROM cursorDiskKV WHERE key = ?')
                    .get(`composerData:${id}`) as { value: string | Uint8Array } | null
                  if (gRow?.value) {
                    const gStr = typeof gRow.value === 'string' ? gRow.value : Buffer.from(gRow.value).toString('utf8')
                    const gParsed = JSON.parse(gStr)
                    if (Array.isArray(gParsed?.conversation)) {
                      conversation = gParsed.conversation
                    }
                  }
                } catch {}
              }

              const turns: NormalizedTurn[] = []
              for (const msg of conversation) {
                const txt = String(msg.text || msg.rawText || '').trim()
                if (!txt) continue
                const isUser = msg.type === 1 || msg.role === 'user'
                turns.push({
                  role: isUser ? 'user' : 'assistant',
                  text: redactText(txt),
                })
              }
              if (turns.length === 0) continue
              const ts = comp.lastUpdatedAt || comp.createdAt
              const updatedAt = ts ? new Date(Number(ts)).toISOString() : statSync(stateDbPath).mtime.toISOString()
              const title = redactText(String(comp.name || deriveTitleFromTurns(turns, `Cursor Composer ${id.slice(0, 8)}`)))
              sessions.push({
                id,
                agent: 'cursor',
                title,
                updatedAt,
                stepCount: turns.length,
                workspacePath: folderUri,
                turns,
                rawFormat: 'cursor-json',
                rawPayload: JSON.stringify({ id, title, updatedAt, turns }),
              })
            }
          }
        }
      } catch {}
    }
  } finally {
    try {
      globalDb?.close()
    } catch {}
  }

  return sessions
}

// ── 4. Unified External Collector & Markdown Exporter ────────────────────────

export function collectAllExternalAgentSessions(opts: {
  projectSlug: string
  legacyProjectSlugs?: string[]
  excludedIds?: Set<string>
  claudeDir?: string
  codexDir?: string
  cursorUserDir?: string
}): ExternalAgentSession[] {
  return [
    ...collectClaudeSessions(opts),
    ...collectCodexSessions(opts),
    ...collectCursorSessions(opts),
  ]
}

export function writeExternalSessionMarkdown(opts: {
  convRootDir: string
  num: string
  folderName: string
  session: ExternalAgentSession
  maxPartBytes: number
}): { turnsCount: number } {
  const { convRootDir, num, folderName, session, maxPartBytes } = opts
  const targetDir = join(convRootDir, folderName)
  mkdirSync(targetDir, { recursive: true })

  const agentLabel = AGENT_LABELS[session.agent]
  const header = [
    `# ${num}. ${session.title}`,
    '',
    `> - **Agent:** \`${agentLabel}\``,
    `> - **Conversation ID:** \`${session.id}\``,
    `> - **Last Updated:** \`${session.updatedAt}\``,
    `> - **Messages:** \`${session.turns.length}\` (\`${session.stepCount}\` raw steps)`,
    '',
    '---',
    '',
  ].join('\n')

  const blocks = session.turns.map((turn, idx) => {
    const speaker = turn.role === 'user' ? 'User' : agentLabel
    const toolLine =
      turn.tools && turn.tools.length > 0
        ? `\n> *Tools used: \`${turn.tools.join('`, `')}\`*\n`
        : ''
    return `### ${idx + 1}. ${speaker}\n${toolLine}\n${turn.text}\n\n---\n`
  })

  const fullText = header + blocks.join('\n')
  if (Buffer.byteLength(fullText, 'utf8') <= maxPartBytes) {
    writeFileSync(join(targetDir, 'conversation.md'), fullText, 'utf8')
    return { turnsCount: session.turns.length }
  }

  // Paginate large external transcripts just like Antigravity transcripts
  const parts: string[] = []
  let current = ''
  for (const b of blocks) {
    if (current && Buffer.byteLength(current + '\n' + b, 'utf8') > maxPartBytes) {
      parts.push(current)
      current = b
    } else {
      current = current ? `${current}\n${b}` : b
    }
  }
  if (current) parts.push(current)

  const partLinks = parts
    .map((_, i) => `- [Part ${String(i + 1).padStart(2, '0')}](./part-${String(i + 1).padStart(2, '0')}.md)`)
    .join('\n')
  writeFileSync(
    join(targetDir, 'conversation.md'),
    `${header}This conversation is split into ${parts.length} parts for full GitHub rendering:\n\n${partLinks}\n`,
    'utf8',
  )
  parts.forEach((pContent, i) => {
    const pName = `part-${String(i + 1).padStart(2, '0')}.md`
    writeFileSync(join(targetDir, pName), `${header}${pContent}`, 'utf8')
  })

  return { turnsCount: session.turns.length }
}

// ── 5. Seed New Session Files for Cross-Agent Handoff ────────────────────────

export function createSeededClaudeSession(opts: {
  workspacePath: string
  title: string
  handoffBrief: string
  ackText: string
  claudeDir?: string
}): { sessionId: string; filePath: string } {
  const sessionId = randomUUID()
  const now = new Date().toISOString()
  const resolvedWs = resolve(opts.workspacePath)
  const destDir = join(opts.claudeDir || getClaudeDir(), 'projects', encodeClaudeProjectDirName(resolvedWs))
  mkdirSync(destDir, { recursive: true })

  const userUuid = randomUUID()
  const asstUuid = randomUUID()
  const lines = [
    JSON.stringify({ type: 'summary', summary: opts.title, leafUuid: asstUuid }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: resolvedWs,
      sessionId,
      type: 'user',
      message: { role: 'user', content: opts.handoffBrief },
      uuid: userUuid,
      timestamp: now,
    }),
    JSON.stringify({
      parentUuid: userUuid,
      isSidechain: false,
      userType: 'external',
      cwd: resolvedWs,
      sessionId,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: opts.ackText }] },
      uuid: asstUuid,
      timestamp: now,
    }),
  ]

  const filePath = join(destDir, `${sessionId}.jsonl`)
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf8')
  return { sessionId, filePath }
}

export function createSeededCodexSession(opts: {
  workspacePath: string
  title: string
  handoffBrief: string
  ackText: string
  codexDir?: string
}): { sessionId: string; filePath: string } {
  const now = new Date()
  const nowMs = now.getTime()
  const nowSec = Math.floor(nowMs / 1000)
  const sessionId = generateUuidV7(nowMs)
  const turnId = generateUuidV7(nowMs + 1)
  const iso = now.toISOString()
  const yyyy = String(now.getUTCFullYear())
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  const hh = String(now.getUTCHours()).padStart(2, '0')
  const mi = String(now.getUTCMinutes()).padStart(2, '0')
  const ss = String(now.getUTCSeconds()).padStart(2, '0')

  const root = opts.codexDir || getCodexDir()
  const dayDir = join(root, 'sessions', yyyy, mm, dd)
  mkdirSync(dayDir, { recursive: true })

  const resolvedWs = resolve(opts.workspacePath)
  const rolloutCwd =
    process.platform === 'win32'
      ? resolvedWs.replace(/^[A-Z]:/, m => m.toLowerCase())
      : resolvedWs
  const sqliteCwd =
    process.platform === 'win32'
      ? `\\\\?\\${resolvedWs.replace(/^[a-z]:/, m => m.toUpperCase())}`
      : resolvedWs

  const filePath = join(dayDir, `rollout-${yyyy}-${mm}-${dd}T${hh}-${mi}-${ss}-${sessionId}.jsonl`)

  const line0 = JSON.stringify({
    timestamp: iso,
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: sessionId,
      id: sessionId,
      timestamp: iso,
      cwd: rolloutCwd,
      originator: 'codex_vscode',
      cli_version: '0.104.0-alpha.1',
      source: 'vscode',
      model_provider: 'openai',
      base_instructions: {
        text: 'You are Codex, a pragmatic software engineering agent collaborating with the user in their workspace.',
      },
      history_mode: 'paginated',
    },
  })

  const turnLines = [
    JSON.stringify({
      timestamp: iso,
      ordinal: 1,
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: turnId,
        model_context_window: 258400,
        collaboration_mode_kind: 'default',
      },
    }),
    JSON.stringify({
      timestamp: iso,
      ordinal: 2,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: opts.handoffBrief }],
      },
    }),
    JSON.stringify({
      timestamp: iso,
      ordinal: 3,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: sessionId,
        turn_id: turnId,
        item: {
          type: 'UserMessage',
          id: 'item-1',
          content: [{ type: 'text', text: opts.handoffBrief }],
        },
      },
    }),
    JSON.stringify({
      timestamp: iso,
      ordinal: 4,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: sessionId,
        turn_id: turnId,
        item: {
          type: 'AgentMessage',
          id: 'item-2',
          content: [{ type: 'Text', text: opts.ackText }],
        },
        completed_at_ms: nowMs,
      },
    }),
    JSON.stringify({
      timestamp: iso,
      ordinal: 5,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: opts.ackText }],
      },
    }),
    JSON.stringify({
      timestamp: iso,
      ordinal: 6,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: opts.ackText,
      },
    }),
  ]

  const turnByteOffset = Buffer.byteLength(line0 + '\n', 'utf8')
  const fullContent = [line0, ...turnLines].join('\n') + '\n'
  const totalBytes = Buffer.byteLength(fullContent, 'utf8')
  writeFileSync(filePath, fullContent, 'utf8')

  // 1. Upsert into session_index.jsonl (for Codex CLI)
  const indexFile = join(root, 'session_index.jsonl')
  const existing = existsSync(indexFile) ? readFileSync(indexFile, 'utf8').trimEnd() : ''
  const entry = JSON.stringify({ id: sessionId, thread_name: opts.title, updated_at: iso })
  writeFileSync(indexFile, (existing ? `${existing}\n${entry}` : entry) + '\n', 'utf8')

  // 2. Upsert into Codex VS Code SQLite state_*.sqlite (threads sidebar list)
  try {
    const stateFiles = readdirSync(root).filter(f => /^state_\d+\.sqlite$/.test(f)).sort()
    for (const sf of stateFiles) {
      const sdb = new Database(join(root, sf))
      sdb.exec('PRAGMA busy_timeout = 5000;')
      const cols = (sdb.query('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map(c => c.name)
      if (cols.includes('id') && cols.includes('rollout_path')) {
        const colValues: Record<string, any> = {
          id: sessionId,
          rollout_path: filePath,
          created_at: nowSec,
          updated_at: nowSec,
          source: 'vscode',
          model_provider: 'openai',
          cwd: sqliteCwd,
          title: opts.title,
          sandbox_policy: '{"type":"disabled"}',
          approval_mode: 'never',
          tokens_used: 0,
          has_user_event: 1,
          archived: 0,
          cli_version: '0.104.0-alpha.1',
          first_user_message: opts.handoffBrief,
          memory_mode: 'enabled',
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
          preview: opts.title,
          recency_at: nowSec,
          recency_at_ms: nowMs,
          history_mode: 'paginated',
          name: opts.title,
          is_pinned: 0,
          originator: 'codex_vscode',
        }
        const activeCols = Object.keys(colValues).filter(k => cols.includes(k))
        const placeholders = activeCols.map(() => '?').join(', ')
        sdb
          .query(`INSERT OR REPLACE INTO threads (${activeCols.join(', ')}) VALUES (${placeholders})`)
          .run(...activeCols.map(k => colValues[k]))
      }
      sdb.close()
    }
  } catch {}

  // 3. Upsert into Codex VS Code thread_history_*.sqlite (paginated turn & message items)
  try {
    const histFiles = readdirSync(root).filter(f => /^thread_history_\d+\.sqlite$/.test(f)).sort()
    for (const hf of histFiles) {
      const hdb = new Database(join(root, hf))
      hdb.exec('PRAGMA busy_timeout = 5000;')
      const tables = new Set(
        (hdb.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name),
      )
      if (tables.has('thread_turns') && tables.has('thread_items')) {
        hdb
          .query(
            `INSERT OR REPLACE INTO thread_turns (
              thread_id, turn_id, rollout_ordinal, status, first_user_item_id, final_agent_item_id,
              rollout_byte_offset, rollout_end_ordinal, rollout_end_byte_offset
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(sessionId, turnId, 1, 'completed', 'item-1', 'item-2', turnByteOffset, 6, totalBytes)

        const userItemJson = JSON.stringify({
          type: 'userMessage',
          id: 'item-1',
          clientId: null,
          content: [{ type: 'text', text: opts.handoffBrief, text_elements: [] }],
        })
        const agentItemJson = JSON.stringify({
          type: 'agentMessage',
          id: 'item-2',
          text: opts.ackText,
          phase: null,
          memoryCitation: null,
          delivery: null,
          questions: null,
        })

        hdb
          .query(
            `INSERT OR REPLACE INTO thread_items (
              thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal, completed_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(sessionId, turnId, 'item-1', 3, nowMs, userItemJson, 'userMessage', 3, nowMs)

        hdb
          .query(
            `INSERT OR REPLACE INTO thread_items (
              thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal, completed_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(sessionId, turnId, 'item-2', 4, nowMs + 1, agentItemJson, 'agentMessage', 4, nowMs + 1)

        if (tables.has('thread_history_projection_state')) {
          hdb
            .query(
              'INSERT OR REPLACE INTO thread_history_projection_state (thread_id, next_rollout_byte_offset, next_rollout_ordinal) VALUES (?, ?, ?)',
            )
            .run(sessionId, totalBytes, 7)
        }
      }
      hdb.close()
    }
  } catch {}

  return { sessionId, filePath }
}
