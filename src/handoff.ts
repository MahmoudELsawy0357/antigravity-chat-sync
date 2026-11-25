import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  AGENT_LABELS,
  type AgentKind,
  type NormalizedTurn,
  seedClaudeConversation,
  seedCodexConversation,
} from './agents'
import { getArgValue, loadConfig, REPO_ROOT } from './config'
import { findRegisteredProject } from './registry'

export interface ArchivedSessionMeta {
  id: string
  agent: AgentKind
  title: string
  updatedAt: string
  folderName: string
  folderPath: string
  transcriptPath: string
}

function ensureGitExcludeEntries(workspacePath: string, patterns: string[]): void {
  const gitInfoDir = join(workspacePath, '.git', 'info')
  if (!existsSync(gitInfoDir)) return
  const excludeFile = join(gitInfoDir, 'exclude')
  let content = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
  let appended = false
  for (const pat of patterns) {
    if (!content.includes(pat)) {
      if (!appended) {
        content = content.trimEnd() + '\n\n# Local AI session handoff context\n'
        appended = true
      }
      content += `${pat}\n`
    }
  }
  if (appended) {
    writeFileSync(excludeFile, content, 'utf8')
  }
}

export function listArchivedSessions(archiveRoot: string): ArchivedSessionMeta[] {
  const convRoot = join(archiveRoot, 'conversations')
  if (!existsSync(convRoot)) return []

  const items: ArchivedSessionMeta[] = []
  for (const folder of readdirSync(convRoot)) {
    const fullFolder = join(convRoot, folder)
    if (!statSync(fullFolder).isDirectory()) continue
    const mainMd = join(fullFolder, 'conversation.md')
    if (!existsSync(mainMd)) continue

    const head = readFileSync(mainMd, 'utf8').slice(0, 2800)
    const titleMatch = head.match(/^#\s+(?:\d+\.\s+)?(.+)$/m)
    const idMatch = head.match(/Conversation ID\)?:\*\*\s*`([^`]+)`/i)
    const agentMatch = head.match(/\*\*Agent:\*\*\s*`([^`]+)`/i)
    const updatedMatch = head.match(/(?:Last (?:Modified|Updated)|آخر تحديث):\*\*\s*`([^`]+)`/i)

    let agent: AgentKind = 'antigravity'
    const rawAgent = (agentMatch?.[1] || '').toLowerCase()
    if (rawAgent.includes('claude')) agent = 'claude'
    else if (rawAgent.includes('codex')) agent = 'codex'
    else if (rawAgent.includes('cursor')) agent = 'cursor'

    const parts = readdirSync(fullFolder)
      .filter(f => /^part-\d+\.md$/.test(f))
      .sort()
    const latestTranscriptPath = parts.length > 0 ? join(fullFolder, parts[parts.length - 1]) : mainMd

    items.push({
      id: idMatch?.[1] || folder,
      agent,
      title: (titleMatch?.[1] || folder).replace(/\s+—\s+Part\s+\d+\s+of\s+\d+$/i, '').trim(),
      updatedAt: updatedMatch?.[1] || `${folder.slice(3, 13)}T12:00:00Z`,
      folderName: folder,
      folderPath: fullFolder,
      transcriptPath: latestTranscriptPath,
    })
  }

  // Chronological newest-first
  return items.sort((a, b) => b.folderName.localeCompare(a.folderName))
}

const SPEAKER_HEADING_RE = /^###\s+(👤.*|🤖.*|(?:\d+\.\s+)?(?:User|Assistant|Antigravity|Claude Code|Codex|Cursor)\b.*)$/gm
const DETAILS_TOOLS_RE = /<details>[\s\S]*?<\/details>/g

/**
 * Parses real User & Assistant message bubbles from an archived conversation folder
 * (supporting both single `conversation.md` and multi-part `part-01.md..part-NN.md`).
 * Caps giant conversations to the most recent `maxTurns` bubbles so target IDEs stay snappy.
 */
export function extractTurnsFromArchivedConversation(
  meta: ArchivedSessionMeta,
  maxTurns = 70,
): NormalizedTurn[] {
  const parts = readdirSync(meta.folderPath)
    .filter(f => /^part-\d+\.md$/.test(f))
    .sort()

  // For multi-part mega-conversations, read the last 2 parts (~700 KB max) so we get ~70+ recent turns instantaneously
  const filesToRead =
    parts.length > 0
      ? parts.slice(-2).map(p => join(meta.folderPath, p))
      : [join(meta.folderPath, 'conversation.md')]

  const parsedTurns: NormalizedTurn[] = []

  for (const fp of filesToRead) {
    if (!existsSync(fp)) continue
    const content = readFileSync(fp, 'utf8')
    const matches = Array.from(content.matchAll(SPEAKER_HEADING_RE))

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]
      const heading = m[1]
      const isUser = heading.startsWith('👤') || /^(?:\d+\.\s+)?User\b/i.test(heading)
      const bodyStart = (m.index || 0) + m[0].length
      const bodyEnd = i + 1 < matches.length ? (matches[i + 1].index || content.length) : content.length

      const body = content
        .slice(bodyStart, bodyEnd)
        .replace(DETAILS_TOOLS_RE, '')
        .replace(/\n---\s*$/g, '')
        .trim()

      if (!body) continue
      const cappedBody = body.length > 8000 ? `${body.slice(0, 8000)}\n\n...(truncated — full text in archive)...` : body
      parsedTurns.push({
        role: isUser ? 'user' : 'assistant',
        text: cappedBody,
      })
    }
  }

  if (parsedTurns.length === 0) {
    return [
      {
        role: 'user',
        text: `Archived conversation: ${meta.title} (${meta.transcriptPath})`,
      },
      {
        role: 'assistant',
        text: `Loaded archived context for "${meta.title}". Ready to continue.`,
      },
    ]
  }

  if (parsedTurns.length > maxTurns || parts.length > 2) {
    const recent = parsedTurns.slice(-maxTurns)
    // Ensure we start on a user turn
    while (recent.length > 2 && recent[0].role !== 'user') {
      recent.shift()
    }
    if (recent[0]) {
      recent[0] = {
        ...recent[0],
        text: `> *[Synced from ${AGENT_LABELS[meta.agent]} — showing latest ${recent.length} messages; full history in \`${meta.folderPath}\`]*\n\n${recent[0].text}`,
      }
    }
    return recent
  }

  return parsedTurns
}

export function buildHandoffBrief(opts: {
  projectSlug: string
  source: ArchivedSessionMeta
  maxExcerptChars?: number
}): string {
  const maxChars = opts.maxExcerptChars ?? 9500
  const rawTranscript = readFileSync(opts.source.transcriptPath, 'utf8')
  const bodyStart = rawTranscript.indexOf('---')
  const body = bodyStart !== -1 ? rawTranscript.slice(bodyStart + 3).trim() : rawTranscript.trim()
  const tailExcerpt =
    body.length > maxChars ? `...(earlier turns omitted — see full archive file below)...\n\n${body.slice(-maxChars)}` : body

  return [
    `# Cross-Agent Session Handoff — Project \`${opts.projectSlug}\``,
    '',
    `You are continuing active engineering work on **\`${opts.projectSlug}\`** handed off from **${AGENT_LABELS[opts.source.agent]}**.`,
    '',
    '## Source Session Metadata',
    `- **Previous Agent:** ${AGENT_LABELS[opts.source.agent]}`,
    `- **Session Title:** ${opts.source.title}`,
    `- **Session ID:** \`${opts.source.id}\``,
    `- **Last Updated:** \`${opts.source.updatedAt}\``,
    `- **Full Archived Transcript:** \`${opts.source.transcriptPath}\``,
    '',
    '## Recent Conversation Context (Tail Excerpt)',
    '',
    tailExcerpt,
    '',
    '---',
    '**Handoff Instruction:** Review the context above so we can seamlessly continue working on this project from where the previous session left off. Acknowledge briefly without modifying files until I give the next instruction.',
  ].join('\n')
}

export interface HandoffSyncedItem {
  sourceId: string
  targetSessionId?: string
  title: string
  sourceAgent: AgentKind
  turnsSynced: number
}

export async function executeHandoff(opts: {
  archiveRoot: string
  projectSlug: string
  workspacePath: string
  targetAgent: AgentKind | 'markdown'
  sourceId?: string
  latestOnly?: boolean
  claudeDir?: string
  codexDir?: string
}): Promise<{
  target: string
  syncedCount: number
  sessionId?: string
  location: string
  resumeHint: string
  items: HandoffSyncedItem[]
}> {
  const allSessions = listArchivedSessions(opts.archiveRoot)
  if (allSessions.length === 0) {
    throw new Error(`No archived conversations found in ${opts.archiveRoot}. Run \`sync\` first.`)
  }

  let selected: ArchivedSessionMeta[]
  if (opts.sourceId) {
    const match = allSessions.find(
      s => s.id === opts.sourceId || s.id.startsWith(opts.sourceId!) || s.folderName.includes(opts.sourceId!),
    )
    if (!match) throw new Error(`Conversation "${opts.sourceId}" not found in archive.`)
    selected = [match]
  } else if (opts.latestOnly || opts.targetAgent === 'antigravity') {
    // Antigravity already gets full multi-chat restore via `bun run restore`; single handoff spawns 1 live chat
    selected = [allSessions[0]]
  } else {
    // Default for claude / codex / cursor / markdown: sync ALL archived conversations in chronological order!
    selected = [...allSessions].reverse()
  }

  const items: HandoffSyncedItem[] = []

  if (opts.targetAgent === 'claude') {
    let lastPath = ''
    let lastId = ''
    for (const src of selected) {
      const turns = extractTurnsFromArchivedConversation(src)
      const seeded = seedClaudeConversation({
        sourceId: src.id,
        workspacePath: opts.workspacePath,
        title: src.title,
        updatedAt: src.updatedAt,
        turns,
        claudeDir: opts.claudeDir,
      })
      lastPath = seeded.filePath
      lastId = seeded.sessionId
      items.push({
        sourceId: src.id,
        targetSessionId: seeded.sessionId,
        title: src.title,
        sourceAgent: src.agent,
        turnsSynced: turns.length,
      })
    }
    return {
      target: 'Claude Code',
      syncedCount: items.length,
      sessionId: lastId,
      location: resolve(lastPath, '..'),
      resumeHint: `cd "${opts.workspacePath}" && claude --resume  (all ${items.length} project conversation(s) available!)`,
      items,
    }
  }

  if (opts.targetAgent === 'codex') {
    let lastPath = ''
    let lastId = ''
    for (const src of selected) {
      const turns = extractTurnsFromArchivedConversation(src)
      const seeded = seedCodexConversation({
        sourceId: src.id,
        workspacePath: opts.workspacePath,
        title: src.title,
        updatedAt: src.updatedAt,
        turns,
        codexDir: opts.codexDir,
      })
      lastPath = seeded.filePath
      lastId = seeded.sessionId
      items.push({
        sourceId: src.id,
        targetSessionId: seeded.sessionId,
        title: src.title,
        sourceAgent: src.agent,
        turnsSynced: turns.length,
      })
    }
    return {
      target: 'Codex',
      syncedCount: items.length,
      sessionId: lastId,
      location: resolve(lastPath, '..', '..', '..'),
      resumeHint: `In VS Code: run "Developer: Reload Window" -> all ${items.length} project conversation(s) appear in Codex "Chats"!`,
      items,
    }
  }

  if (opts.targetAgent === 'cursor') {
    const aiChatsDir = join(opts.workspacePath, '.ai-chats')
    const rulesDir = join(opts.workspacePath, '.cursor', 'rules')
    mkdirSync(aiChatsDir, { recursive: true })
    mkdirSync(rulesDir, { recursive: true })

    for (const src of selected) {
      const brief = buildHandoffBrief({ projectSlug: opts.projectSlug, source: src, maxExcerptChars: 18000 })
      writeFileSync(join(aiChatsDir, `${src.folderName}.md`), brief + '\n', 'utf8')
      items.push({
        sourceId: src.id,
        title: src.title,
        sourceAgent: src.agent,
        turnsSynced: 1,
      })
    }

    const newest = selected[selected.length - 1]
    const indexLines = [...selected]
      .reverse()
      .map(s => `- **${s.title}** (${AGENT_LABELS[s.agent]}, \`${s.updatedAt}\`) -> \`.ai-chats/${s.folderName}.md\``)
      .join('\n')

    const mdcPath = join(rulesDir, 'chat-sync-handoff.mdc')
    const mdcContent = [
      '---',
      `description: Synced project conversation history (${items.length} chats) across Antigravity, Claude, Codex & Cursor`,
      'globs: ',
      'alwaysApply: false',
      '---',
      '',
      `# Synced Project Conversations (\`${opts.projectSlug}\` — ${items.length} Total)`,
      '',
      indexLines,
      '',
      '---',
      '',
      buildHandoffBrief({ projectSlug: opts.projectSlug, source: newest }),
      '',
    ].join('\n')
    writeFileSync(mdcPath, mdcContent, 'utf8')
    writeFileSync(join(opts.workspacePath, '.ai-handoff.md'), buildHandoffBrief({ projectSlug: opts.projectSlug, source: newest }) + '\n', 'utf8')
    ensureGitExcludeEntries(opts.workspacePath, ['.cursor/rules/chat-sync-handoff.mdc', '.ai-handoff.md', '.ai-chats/'])

    return {
      target: 'Cursor',
      syncedCount: items.length,
      location: aiChatsDir,
      resumeHint: `Open Cursor Composer in "${opts.workspacePath}" and tag @.ai-chats/ (all ${items.length} chats) or @chat-sync-handoff.mdc`,
      items,
    }
  }

  if (
    opts.targetAgent === 'windsurf' ||
    opts.targetAgent === 'cline' ||
    opts.targetAgent === 'roocode' ||
    opts.targetAgent === 'copilot' ||
    opts.targetAgent === 'gemini' ||
    opts.targetAgent === 'aider' ||
    opts.targetAgent === 'opencode' ||
    opts.targetAgent === 'universal'
  ) {
    const { writeUniversalWorkspaceContext, UNIVERSAL_AGENT_LABELS } = await import('./universal-agents')
    const sessionsPayload = selected.map(src => ({
      id: src.id,
      agentLabel: AGENT_LABELS[src.agent] || src.agent,
      title: src.title,
      updatedAt: src.updatedAt,
      turns: extractTurnsFromArchivedConversation(src),
    }))
    const uRes = writeUniversalWorkspaceContext({
      workspacePath: opts.workspacePath,
      projectSlug: opts.projectSlug,
      targetAgent: opts.targetAgent,
      sessions: sessionsPayload,
    })
    for (const sp of sessionsPayload) {
      items.push({
        sourceId: sp.id,
        title: sp.title,
        sourceAgent: opts.targetAgent,
        turnsSynced: sp.turns.length,
      })
    }
    return {
      target: UNIVERSAL_AGENT_LABELS[opts.targetAgent] || opts.targetAgent,
      syncedCount: items.length,
      location: uRes.location,
      resumeHint: uRes.resumeHint,
      items,
    }
  }

  const picked = selected[selected.length - 1]
  const brief = buildHandoffBrief({ projectSlug: opts.projectSlug, source: picked })

  if (opts.targetAgent === 'antigravity' && process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    const payload: Record<string, any> = {
      title: picked.title.slice(0, 76),
      model: 'pro',
      prompt: [{ text: brief }],
    }
    if (process.env.ANTIGRAVITY_PROJECT_ID) {
      payload.projectId = process.env.ANTIGRAVITY_PROJECT_ID
    }
    const resp = await fetch(
      `http://${process.env.ANTIGRAVITY_LS_ADDRESS}/product.v1.ConversationService/CreateConversation`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Connect-Protocol-Version': '1',
          'x-antigravity-csrf-token': process.env.ANTIGRAVITY_CSRF_TOKEN,
        },
        body: JSON.stringify(payload),
      },
    )
    if (resp.ok) {
      const data = (await resp.json()) as any
      const newId = data?.conversation?.id
      if (newId) {
        items.push({ sourceId: picked.id, targetSessionId: newId, title: picked.title, sourceAgent: picked.agent, turnsSynced: 1 })
        return {
          target: 'Antigravity',
          syncedCount: 1,
          sessionId: newId,
          location: `conversation://${newId}`,
          resumeHint: `Open directly in Antigravity: conversation://${newId} (or run \`restore\` to import full Antigravity DB archive)`,
          items,
        }
      }
    }
  }

  const outPath = join(opts.workspacePath, '.ai-handoff.md')
  writeFileSync(outPath, brief + '\n', 'utf8')
  ensureGitExcludeEntries(opts.workspacePath, ['.ai-handoff.md'])
  items.push({ sourceId: picked.id, title: picked.title, sourceAgent: picked.agent, turnsSynced: 1 })
  return {
    target: opts.targetAgent === 'antigravity' ? 'Antigravity (Markdown Brief)' : 'Markdown Brief',
    syncedCount: 1,
    location: outPath,
    resumeHint: `Tag @.ai-handoff.md in your new chat inside "${basename(opts.workspacePath)}"`,
    items,
  }
}

if (import.meta.main) {
  const dirFlag = getArgValue('--dir')
  const projFlag = getArgValue('--project')
  const wsFlag = getArgValue('--workspace')
  const toRaw = (getArgValue('--to') || 'all').toLowerCase()

  let archiveRoot = REPO_ROOT
  if (dirFlag) {
    archiveRoot = resolve(dirFlag)
  } else if (projFlag) {
    const reg = findRegisteredProject(projFlag)
    if (reg) archiveRoot = reg.archiveDir
  } else if (existsSync(join(process.cwd(), 'sync.config.json'))) {
    archiveRoot = process.cwd()
  } else {
    const regFromCwd = findRegisteredProject(wsFlag || process.cwd())
    if (regFromCwd) archiveRoot = regFromCwd.archiveDir
  }

  const hasArchive =
    existsSync(join(archiveRoot, 'sync.config.json')) &&
    existsSync(join(archiveRoot, 'conversations'))

  // Single-PC Zero-GitHub Fallback: if no archive repo exists yet, bridge directly from local AI agents!
  if (!hasArchive || toRaw === 'all') {
    const { executeLocalBridge } = await import('./local-bridge')
    const workspacePath = wsFlag ? resolve(wsFlag) : process.cwd()
    const res = executeLocalBridge({
      workspacePath,
      projectSlug: projFlag || basename(workspacePath),
      targetAgent: toRaw,
      fromAgent: getArgValue('--from'),
      sessionId: getArgValue('--id') || getArgValue('--from-id'),
      latestOnly: process.argv.includes('--latest'),
    })
    console.log(
      `\n⚡ Direct Local AI Bridge -> "${res.projectSlug}" (${res.sourceSessionsCount} session(s) bridged with zero GitHub needed!)`,
    )
    console.log('─'.repeat(78))
    for (const b of res.bridgedTargets) {
      console.log(`  ✓ ${b.targetAgent.padEnd(28, ' ')} -> ${b.resumeHint}`)
    }
    console.log('─'.repeat(78) + '\n')
    process.exit(0)
  }

  process.chdir(archiveRoot)
  const config = loadConfig()
  const validTargets = new Set([
    'antigravity',
    'claude',
    'codex',
    'cursor',
    'windsurf',
    'cline',
    'roocode',
    'copilot',
    'gemini',
    'aider',
    'opencode',
    'universal',
    'markdown',
  ])
  if (!validTargets.has(toRaw)) {
    console.error(`Invalid --to target "${toRaw}". Choose any supported agent or "all" / "universal".`)
    process.exit(1)
  }
  const regEntry = findRegisteredProject(config.projectSlug)
  const siblingWs = resolve(archiveRoot, '..', config.projectSlug)
  const workspacePath = wsFlag
    ? resolve(wsFlag)
    : regEntry?.workspacePath || (existsSync(siblingWs) ? siblingWs : process.cwd())

  const res = await executeHandoff({
    archiveRoot,
    projectSlug: config.projectSlug,
    workspacePath,
    targetAgent: toRaw as AgentKind | 'markdown',
    sourceId: getArgValue('--id') || getArgValue('--from-id'),
    latestOnly: process.argv.includes('--latest'),
  })

  console.log(`\nCross-Agent Sync Complete -> ${res.target} (${res.syncedCount} conversation(s))`)
  console.log('─'.repeat(76))
  for (const item of res.items) {
    console.log(`  • ${item.title.padEnd(46, ' ')} [${AGENT_LABELS[item.sourceAgent]} -> ${item.turnsSynced} msgs]`)
  }
  console.log('─'.repeat(76))
  console.log(`  Location : ${res.location}`)
  console.log(`  Next     : ${res.resumeHint}\n`)
}
