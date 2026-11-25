import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { getArgValue, REPO_ROOT } from './config'
import { findRegisteredProject } from './registry'

export interface SearchMatchSnippet {
  lineNumber: number
  text: string
}

export interface SearchHit {
  conversationId: string | null
  title: string
  relativePath: string
  snippets: SearchMatchSnippet[]
}

const CONV_ID_RE = /\*\*Conversation ID:\*\*\s*`([0-9a-f-]{36})`/i
const HEADING_RE = /^#\s+(.+)$/m

function collectMarkdownFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      collectMarkdownFiles(full, acc)
    } else if (entry.endsWith('.md')) {
      acc.push(full)
    }
  }
  return acc
}

export function searchArchiveDirectory(archiveRoot: string, query: string, limit = 15): SearchHit[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const convRoot = join(archiveRoot, 'conversations')
  if (!existsSync(convRoot)) return []

  const needle = trimmed.toLowerCase()
  const files = collectMarkdownFiles(convRoot)

  // Map folder conversation IDs/titles from summaries.json as fallback for part-NN.md / artifacts
  const summaryTitleToId = new Map<string, string>()
  const summariesPath = join(archiveRoot, 'antigravity-backup', 'summaries.json')
  if (existsSync(summariesPath)) {
    try {
      const { summaries } = JSON.parse(readFileSync(summariesPath, 'utf8'))
      for (const s of summaries || []) {
        if (s.title && s.conversation_id) {
          summaryTitleToId.set(String(s.title).trim().toLowerCase(), String(s.conversation_id))
        }
      }
    } catch {}
  }

  // Cache conversation.md metadata per conversation subfolder
  const folderMeta = new Map<string, { id: string | null; title: string }>()
  for (const entry of readdirSync(convRoot)) {
    const subDir = join(convRoot, entry)
    if (!statSync(subDir).isDirectory()) continue
    const mainMd = join(subDir, 'conversation.md')
    let id: string | null = null
    let title = entry
    if (existsSync(mainMd)) {
      const head = readFileSync(mainMd, 'utf8').slice(0, 2048)
      const idMatch = head.match(CONV_ID_RE)
      if (idMatch) id = idMatch[1]
      const hMatch = head.match(HEADING_RE)
      if (hMatch) title = hMatch[1].trim()
      if (!id && summaryTitleToId.has(title.toLowerCase())) {
        id = summaryTitleToId.get(title.toLowerCase()) || null
      }
    }
    folderMeta.set(subDir, { id, title })
  }

  const hits: SearchHit[] = []
  for (const filePath of files) {
    if (hits.length >= limit) break
    const content = readFileSync(filePath, 'utf8')
    if (!content.toLowerCase().includes(needle)) continue

    const lines = content.split(/\r?\n/)
    const snippets: SearchMatchSnippet[] = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        const clean = lines[i].trim().slice(0, 180)
        snippets.push({ lineNumber: i + 1, text: clean })
        if (snippets.length >= 3) break
      }
    }

    let ownerMeta: { id: string | null; title: string } | undefined
    for (const [folder, meta] of folderMeta.entries()) {
      if (filePath.startsWith(folder)) {
        ownerMeta = meta
        break
      }
    }

    const idMatch = content.slice(0, 2048).match(CONV_ID_RE)
    const convId = idMatch?.[1] ?? ownerMeta?.id ?? null
    const title = ownerMeta?.title ?? relative(archiveRoot, filePath)

    hits.push({
      conversationId: convId,
      title,
      relativePath: relative(archiveRoot, filePath).replace(/\\/g, '/'),
      snippets,
    })
  }

  return hits
}

if (import.meta.main) {
  const dirFlag = getArgValue('--dir')
  const projectFlag = getArgValue('--project')
  const limitFlag = Number(getArgValue('--limit') || '15')

  let targetRoot = REPO_ROOT
  if (dirFlag) {
    targetRoot = resolve(dirFlag)
  } else if (projectFlag) {
    const reg = findRegisteredProject(projectFlag)
    if (reg) targetRoot = reg.archiveDir
  }

  // Extract positional query (skip flags and their values)
  const rawArgs = process.argv.slice(2)
  const positional: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (arg === '--dir' || arg === '--project' || arg === '--limit') {
      i++
      continue
    }
    if (arg === 'search') continue
    if (!arg.startsWith('--')) positional.push(arg)
  }

  const query = getArgValue('--query') || positional.join(' ').trim()
  if (!query) {
    console.log('Usage: bun run search "<keyword>" [--project <slug>] [--dir <archive-path>] [--limit 15]')
    process.exit(1)
  }

  const hits = searchArchiveDirectory(targetRoot, query, limitFlag)
  if (hits.length === 0) {
    console.log(`No archived matches found for "${query}" in ${targetRoot}.`)
    process.exit(0)
  }

  console.log(`\nFound ${hits.length} archived match(es) for "${query}":`)
  console.log('─'.repeat(76))
  for (const hit of hits) {
    const link = hit.conversationId ? `conversation://${hit.conversationId}` : '(artifact / sub-file)'
    console.log(`• ${hit.title}`)
    console.log(`  Link : ${link}`)
    console.log(`  File : ${hit.relativePath}`)
    for (const snip of hit.snippets) {
      console.log(`  L${snip.lineNumber}: ${snip.text}`)
    }
    console.log('')
  }
}
