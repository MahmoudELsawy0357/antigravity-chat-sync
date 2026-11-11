import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { redactText } from './redact'

export interface Turn {
  role: 'user' | 'assistant'
  stepIndex: number
  timestamp?: string
  text: string
  tools?: string[]
}

export function cleanUserPrompt(raw: string): string {
  let s = raw
  const reqMatch = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)
  if (reqMatch) {
    s = reqMatch[1]
  } else {
    s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    s = s.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
  }
  return redactText(s.trim())
}

export function slugify(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[^\w\u0600-\u06FF\- ]+/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60) || 'conversation'
  )
}

export function extractTurns(agyDir: string, summaryDb: Database, convId: string): Turn[] {
  const fullPath = join(agyDir, 'brain', convId, '.system_generated', 'logs', 'transcript_full.jsonl')
  const compactPath = join(agyDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl')
  const tPath = existsSync(fullPath) ? fullPath : existsSync(compactPath) ? compactPath : null

  if (tPath) {
    const lines = readFileSync(tPath, 'utf8').split('\n').filter(Boolean)
    const turns: Turn[] = []
    let pendingTools: string[] = []

    for (const line of lines) {
      try {
        const step = JSON.parse(line)
        if (step.type === 'USER_INPUT' && step.content) {
          if (pendingTools.length > 0 && turns.length > 0 && turns[turns.length - 1].role === 'assistant') {
            turns[turns.length - 1].tools = [...(turns[turns.length - 1].tools || []), ...pendingTools]
            pendingTools = []
          }
          const cleaned = cleanUserPrompt(String(step.content))
          if (cleaned) {
            turns.push({ role: 'user', stepIndex: step.step_index ?? 0, timestamp: step.created_at, text: cleaned })
          }
        } else if (step.type === 'PLANNER_RESPONSE') {
          const toolNames: string[] = []
          if (Array.isArray(step.tool_calls)) {
            for (const tc of step.tool_calls) {
              const name = tc.name || tc.tool_name || 'tool'
              const args = tc.arguments || tc.args || {}
              const detail = args.Path
                ? ` \`${basename(String(args.Path))}\``
                : args.toolSummary
                  ? ` (${args.toolSummary})`
                  : ''
              toolNames.push(`${name}${detail}`)
            }
          }
          const msg = redactText(String(step.content || '').trim())
          if (msg) {
            turns.push({
              role: 'assistant',
              stepIndex: step.step_index ?? 0,
              timestamp: step.created_at,
              text: msg,
              tools: [...pendingTools, ...toolNames],
            })
            pendingTools = []
          } else if (toolNames.length > 0) {
            pendingTools.push(...toolNames)
          }
        }
      } catch {}
    }

    if (pendingTools.length > 0 && turns.length > 0 && turns[turns.length - 1].role === 'assistant') {
      turns[turns.length - 1].tools = [...(turns[turns.length - 1].tools || []), ...pendingTools]
    }
    return turns
  }

  // Fallback for older conversations: reconstruct exact turns from FTS c8 & c9 UTF-8 byte offsets
  const ftsChunks = summaryDb
    .query(`SELECT c1, c8, c9, c13, c14 FROM conversations_fts_content WHERE c0 = '${convId}' AND c1 >= 0 ORDER BY c1 ASC`)
    .all() as any[]

  const items: Turn[] = []
  for (const ch of ftsChunks) {
    const uBuf = Buffer.from(String(ch.c13 || ''), 'utf8')
    const aBuf = Buffer.from(String(ch.c14 || ''), 'utf8')
    const uOffsets: [number, number][] = ch.c8 ? JSON.parse(Buffer.from(ch.c8).toString('utf8')) : []
    const aOffsets: [number, number][] = ch.c9 ? JSON.parse(Buffer.from(ch.c9).toString('utf8')) : []

    for (let i = 0; i < uOffsets.length; i++) {
      const [stepIdx, startByte] = uOffsets[i]
      const endByte = i + 1 < uOffsets.length ? uOffsets[i + 1][1] : uBuf.length
      const txt = cleanUserPrompt(uBuf.subarray(startByte, endByte).toString('utf8'))
      if (txt) items.push({ role: 'user', stepIndex: stepIdx, text: txt })
    }
    for (let i = 0; i < aOffsets.length; i++) {
      const [stepIdx, startByte] = aOffsets[i]
      const endByte = i + 1 < aOffsets.length ? aOffsets[i + 1][1] : aBuf.length
      const txt = redactText(aBuf.subarray(startByte, endByte).toString('utf8').trim())
      if (txt) items.push({ role: 'assistant', stepIndex: stepIdx, text: txt })
    }
  }

  items.sort((a, b) => a.stepIndex - b.stepIndex)
  const merged: Turn[] = []
  for (const item of items) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === 'assistant' && item.role === 'assistant') {
      prev.text += '\n\n' + item.text
    } else {
      merged.push({ ...item })
    }
  }
  return merged
}

export function writeConversationMarkdown(opts: {
  agyDir: string
  summaryDb: Database
  convRootDir: string
  num: string
  row: any
  folderName: string
  maxPartBytes: number
}): { turnsCount: number; artifacts: string[] } {
  const { agyDir, summaryDb, convRootDir, num, row, folderName, maxPartBytes } = opts
  const id = row.conversation_id
  const title = row.title || row.preview || `Conversation ${num}`
  const convDir = join(convRootDir, folderName)

  rmSync(convDir, { recursive: true, force: true })
  mkdirSync(convDir, { recursive: true })

  const turns = extractTurns(agyDir, summaryDb, id)
  const copiedArtifacts: string[] = []

  const brainSrc = join(agyDir, 'brain', id)
  if (existsSync(brainSrc)) {
    for (const entry of readdirSync(brainSrc, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'scratch') continue
      if (entry.isFile() && !entry.name.endsWith('.metadata.json')) {
        const artDir = join(convDir, 'artifacts')
        mkdirSync(artDir, { recursive: true })
        writeFileSync(join(artDir, entry.name), redactText(readFileSync(join(brainSrc, entry.name), 'utf8')), 'utf8')
        copiedArtifacts.push(entry.name)
      }
    }
  }

  const headerMd = [
    `# ${num}. ${title}`,
    '',
    `- **Conversation ID:** \`${id}\``,
    `- **Last Updated:** \`${String(row.last_modified_time).slice(0, 19)}\``,
    `- **Total Steps:** \`${row.step_count}\``,
    `- **Exchanged Messages:** \`${turns.length}\``,
    copiedArtifacts.length > 0
      ? `- **Artifacts:** ${copiedArtifacts.map(a => `[${a}](./artifacts/${encodeURIComponent(a)})`).join(', ')}`
      : '',
    '',
    '---',
    '',
  ]
    .filter(Boolean)
    .join('\n')

  const turnBlocks = turns.map((t, i) => {
    const roleHeader =
      t.role === 'user'
        ? `### 👤 User (Message #${i + 1}${t.timestamp ? ` — ${t.timestamp.slice(0, 16).replace('T', ' ')}` : ''})`
        : `### 🤖 Assistant (Reply #${i + 1}${t.timestamp ? ` — ${t.timestamp.slice(0, 16).replace('T', ' ')}` : ''})`
    const tools =
      t.tools && t.tools.length > 0
        ? `\n\n<details>\n<summary>🛠️ Tools Invoked (${t.tools.length})</summary>\n\n${t.tools
            .slice(0, 30)
            .map(x => `- ${redactText(x)}`)
            .join('\n')}\n\n</details>`
        : ''
    return `${roleHeader}\n\n${t.text}${tools}\n\n---\n`
  })

  const fullMd = headerMd + '\n\n' + turnBlocks.join('\n')
  if (Buffer.byteLength(fullMd, 'utf8') <= maxPartBytes) {
    writeFileSync(join(convDir, 'conversation.md'), fullMd, 'utf8')
  } else {
    const parts: string[][] = []
    let cur: string[] = []
    let sz = 0
    for (const blk of turnBlocks) {
      const bSz = Buffer.byteLength(blk, 'utf8')
      if (cur.length > 0 && sz + bSz > maxPartBytes) {
        parts.push(cur)
        cur = []
        sz = 0
      }
      cur.push(blk)
      sz += bSz
    }
    if (cur.length > 0) parts.push(cur)

    const links: string[] = []
    for (let p = 0; p < parts.length; p++) {
      const pName = `part-${String(p + 1).padStart(2, '0')}.md`
      const navPrev = p > 0 ? `[⬅️ Previous Part](./part-${String(p).padStart(2, '0')}.md) | ` : ''
      const navNext = p + 1 < parts.length ? ` | [Next Part ➡️](./part-${String(p + 2).padStart(2, '0')}.md)` : ''
      writeFileSync(
        join(convDir, pName),
        `# ${num}. ${title} — Part ${p + 1} of ${parts.length}\n\n${navPrev}[📑 Conversation Index](./conversation.md)${navNext}\n\n---\n\n` +
          parts[p].join('\n'),
        'utf8',
      )
      links.push(`- [📖 Part ${p + 1} of ${parts.length}](./${pName})`)
    }

    writeFileSync(
      join(convDir, 'conversation.md'),
      `${headerMd}\n\n> 💡 Split into sequential parts so GitHub renders every page in full without truncation:\n\n${links.join('\n')}\n`,
      'utf8',
    )
  }

  return { turnsCount: turns.length, artifacts: copiedArtifacts }
}
