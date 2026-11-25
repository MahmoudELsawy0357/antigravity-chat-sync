import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  AGENT_LABELS,
  type AgentKind,
  createSeededClaudeSession,
  createSeededCodexSession,
} from './agents'
import { getArgValue, loadConfig, REPO_ROOT } from './config'
import { findRegisteredProject } from './registry'

export interface ArchivedSessionMeta {
  id: string
  agent: AgentKind
  title: string
  updatedAt: string
  folderName: string
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

    const head = readFileSync(mainMd, 'utf8').slice(0, 2500)
    const titleMatch = head.match(/^#\s+(?:\d+\.\s+)?(.+)$/m)
    const idMatch = head.match(/\*\*Conversation ID:\*\*\s*`([^`]+)`/i)
    const agentMatch = head.match(/\*\*Agent:\*\*\s*`([^`]+)`/i)
    const updatedMatch = head.match(/\*\*Last (?:Modified|Updated):\*\*\s*`([^`]+)`/i)

    let agent: AgentKind = 'antigravity'
    const rawAgent = (agentMatch?.[1] || '').toLowerCase()
    if (rawAgent.includes('claude')) agent = 'claude'
    else if (rawAgent.includes('codex')) agent = 'codex'
    else if (rawAgent.includes('cursor')) agent = 'cursor'

    // If paginated, locate the last part-NN.md for most recent context
    const parts = readdirSync(fullFolder)
      .filter(f => /^part-\d+\.md$/.test(f))
      .sort()
    const latestTranscriptPath = parts.length > 0 ? join(fullFolder, parts[parts.length - 1]) : mainMd

    items.push({
      id: idMatch?.[1] || folder,
      agent,
      title: titleMatch?.[1]?.trim() || folder,
      updatedAt: updatedMatch?.[1] || folder.slice(3, 13),
      folderName: folder,
      transcriptPath: latestTranscriptPath,
    })
  }

  // Folder names are prefixed 01-, 02-, ... in chronological order; reverse so newest is first
  return items.sort((a, b) => b.folderName.localeCompare(a.folderName))
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

export async function executeHandoff(opts: {
  archiveRoot: string
  projectSlug: string
  workspacePath: string
  targetAgent: AgentKind | 'markdown'
  sourceId?: string
  claudeDir?: string
  codexDir?: string
}): Promise<{ target: string; sessionId?: string; location: string; resumeHint: string }> {
  const sessions = listArchivedSessions(opts.archiveRoot)
  if (sessions.length === 0) {
    throw new Error(`No archived conversations found in ${opts.archiveRoot}. Run \`sync\` first.`)
  }

  const picked = opts.sourceId
    ? sessions.find(s => s.id === opts.sourceId || s.id.startsWith(opts.sourceId!) || s.folderName.includes(opts.sourceId!))
    : sessions[0]

  if (!picked) {
    throw new Error(`Conversation "${opts.sourceId}" not found in archive.`)
  }

  const brief = buildHandoffBrief({
    projectSlug: opts.projectSlug,
    source: picked,
  })
  const handoffTitle = `[Handoff] ${picked.title}`.slice(0, 76)
  const ackText = `Context loaded from ${AGENT_LABELS[picked.agent]} session "${picked.title}" (${picked.id.slice(0, 8)}). Ready to continue work on \`${opts.projectSlug}\`.`

  if (opts.targetAgent === 'claude') {
    const seeded = createSeededClaudeSession({
      workspacePath: opts.workspacePath,
      title: handoffTitle,
      handoffBrief: brief,
      ackText,
      claudeDir: opts.claudeDir,
    })
    return {
      target: 'Claude Code',
      sessionId: seeded.sessionId,
      location: seeded.filePath,
      resumeHint: `cd "${opts.workspacePath}" && claude --resume ${seeded.sessionId}`,
    }
  }

  if (opts.targetAgent === 'codex') {
    const seeded = createSeededCodexSession({
      workspacePath: opts.workspacePath,
      title: handoffTitle,
      handoffBrief: brief,
      ackText,
      codexDir: opts.codexDir,
    })
    return {
      target: 'Codex',
      sessionId: seeded.sessionId,
      location: seeded.filePath,
      resumeHint: `Open Codex in "${opts.workspacePath}" (thread "${handoffTitle}") or run: codex resume ${seeded.sessionId}`,
    }
  }

  if (opts.targetAgent === 'cursor') {
    const rulesDir = join(opts.workspacePath, '.cursor', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    const mdcPath = join(rulesDir, 'chat-sync-handoff.mdc')
    const mdcContent = [
      '---',
      `description: Recent cross-agent session handoff context from ${AGENT_LABELS[picked.agent]} (${picked.title})`,
      'globs: ',
      'alwaysApply: false',
      '---',
      '',
      brief,
      '',
    ].join('\n')
    writeFileSync(mdcPath, mdcContent, 'utf8')
    const mdPath = join(opts.workspacePath, '.ai-handoff.md')
    writeFileSync(mdPath, brief + '\n', 'utf8')
    ensureGitExcludeEntries(opts.workspacePath, ['.cursor/rules/chat-sync-handoff.mdc', '.ai-handoff.md'])

    return {
      target: 'Cursor',
      location: mdcPath,
      resumeHint: `Open Cursor Composer in "${opts.workspacePath}" and reference @chat-sync-handoff.mdc or @.ai-handoff.md`,
    }
  }

  if (opts.targetAgent === 'antigravity' && process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    const payload: Record<string, any> = {
      title: handoffTitle,
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
        return {
          target: 'Antigravity',
          sessionId: newId,
          location: `conversation://${newId}`,
          resumeHint: `Open directly in Antigravity: conversation://${newId}`,
        }
      }
    }
  }

  // Fallback / markdown export (excluded via .git/info/exclude)
  const outPath = join(opts.workspacePath, '.ai-handoff.md')
  writeFileSync(outPath, brief + '\n', 'utf8')
  ensureGitExcludeEntries(opts.workspacePath, ['.ai-handoff.md'])
  return {
    target: opts.targetAgent === 'antigravity' ? 'Antigravity (Markdown Brief)' : 'Markdown Brief',
    location: outPath,
    resumeHint: `Tag @.ai-handoff.md in your new chat inside "${basename(opts.workspacePath)}"`,
  }
}

if (import.meta.main) {
  const dirFlag = getArgValue('--dir')
  const projFlag = getArgValue('--project')
  let archiveRoot = REPO_ROOT
  if (dirFlag) {
    archiveRoot = resolve(dirFlag)
  } else if (projFlag) {
    const reg = findRegisteredProject(projFlag)
    if (reg) archiveRoot = reg.archiveDir
  }

  process.chdir(archiveRoot)
  const config = loadConfig()
  const toRaw = (getArgValue('--to') || 'markdown').toLowerCase()
  const validTargets = new Set(['antigravity', 'claude', 'codex', 'cursor', 'markdown'])
  if (!validTargets.has(toRaw)) {
    console.error(`Invalid --to target "${toRaw}". Choose one of: antigravity, claude, codex, cursor, markdown`)
    process.exit(1)
  }

  const wsFlag = getArgValue('--workspace')
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
  })

  console.log(`\nCross-Agent Handoff Ready -> ${res.target}`)
  console.log('─'.repeat(64))
  if (res.sessionId) console.log(`  Session ID : ${res.sessionId}`)
  console.log(`  Location   : ${res.location}`)
  console.log(`  Resume     : ${res.resumeHint}\n`)
}
