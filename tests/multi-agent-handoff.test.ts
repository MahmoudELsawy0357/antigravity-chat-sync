import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectClaudeSessions,
  collectCodexSessions,
  collectCursorSessions,
  encodeClaudeProjectDirName,
  restoreClaudeSession,
  restoreCodexSession,
} from '../src/agents'
import { executeHandoff } from '../src/handoff'

describe('multi-agent adapters (Claude Code, Codex, Cursor) & cross-agent handoff', () => {
  test('Claude Code adapter collects project sessions, redacts secrets, and restores with remapped cwd', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-claude-test-'))
    try {
      const claudeSrc = join(tmp, 'claude-pc1')
      const wsPc1 = 'D:\\work\\althabit-dashboard'
      const projDir = join(claudeSrc, 'projects', encodeClaudeProjectDirName(wsPc1))
      mkdirSync(projDir, { recursive: true })

      const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      const fakeGhToken = `ghp_${'A'.repeat(36)}`
      const jsonl = [
        JSON.stringify({ type: 'summary', summary: 'Fix GRN upload spinner' }),
        JSON.stringify({
          type: 'user',
          sessionId: sid,
          cwd: wsPc1,
          timestamp: '2026-11-25T10:00:00.000Z',
          message: { role: 'user', content: `Use token ${fakeGhToken} to test upload` },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: sid,
          cwd: wsPc1,
          timestamp: '2026-11-25T10:01:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'Edit' },
              { type: 'text', text: 'Updated GrnFormSection.vue submit button spinner.' },
            ],
          },
        }),
      ].join('\n')
      writeFileSync(join(projDir, `${sid}.jsonl`), jsonl + '\n', 'utf8')

      const collected = collectClaudeSessions({
        projectSlug: 'althabit-dashboard',
        claudeDir: claudeSrc,
      })
      expect(collected.length).toBe(1)
      expect(collected[0].title).toBe('Fix GRN upload spinner')
      expect(collected[0].turns.length).toBe(2)
      expect(collected[0].turns[0].text).not.toContain(fakeGhToken)
      expect(collected[0].rawPayload).not.toContain(fakeGhToken)

      // Restore onto Machine 2 with a different workspace path
      const claudeDest = join(tmp, 'claude-pc2')
      const wsPc2 = join(tmp, 'mac-projects', 'althabit-dashboard')
      const restored = restoreClaudeSession(collected[0], wsPc2, claudeDest)
      expect(restored).toBe(true)

      const restoredFile = join(claudeDest, 'projects', encodeClaudeProjectDirName(wsPc2), `${sid}.jsonl`)
      expect(existsSync(restoredFile)).toBe(true)
      const restoredLines = readFileSync(restoredFile, 'utf8').trim().split('\n')
      expect(JSON.parse(restoredLines[1]).cwd).toBe(wsPc2)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('Codex adapter parses rollout JSONL + session_index.jsonl, skips system boilerplate, and restores cleanly', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-codex-test-'))
    try {
      const codexSrc = join(tmp, 'codex-pc1')
      const dayDir = join(codexSrc, 'sessions', '2026', '11', '25')
      mkdirSync(dayDir, { recursive: true })

      const sid = '019c9432-2a4d-79f3-a737-31b546174783'
      writeFileSync(
        join(codexSrc, 'session_index.jsonl'),
        JSON.stringify({ id: sid, thread_name: 'Compatibility Matrix Pagination', updated_at: '2026-11-25T11:35:00Z' }) + '\n',
        'utf8',
      )

      const rollout = [
        JSON.stringify({
          timestamp: '2026-11-25T11:30:00Z',
          ordinal: 0,
          type: 'session_meta',
          payload: { session_id: sid, id: sid, cwd: 'd:\\all-projects\\althabit-dashboard' },
        }),
        JSON.stringify({
          timestamp: '2026-11-25T11:30:01Z',
          ordinal: 1,
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>d:\\all-projects\\althabit-dashboard</cwd>\n</environment_context>' }] },
        }),
        JSON.stringify({
          timestamp: '2026-11-25T11:30:05Z',
          ordinal: 2,
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Prevent DataTable pagination buttons from submitting parent form' }] },
        }),
        JSON.stringify({
          timestamp: '2026-11-25T11:31:00Z',
          ordinal: 3,
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added explicit type="button" to pagination controls.' }] },
        }),
      ].join('\n')
      writeFileSync(join(dayDir, `rollout-2026-11-25T11-30-00-${sid}.jsonl`), rollout + '\n', 'utf8')

      const collected = collectCodexSessions({
        projectSlug: 'althabit-dashboard',
        codexDir: codexSrc,
      })
      expect(collected.length).toBe(1)
      expect(collected[0].title).toBe('Compatibility Matrix Pagination')
      expect(collected[0].turns.length).toBe(2) // Boilerplate skipped!

      const codexDest = join(tmp, 'codex-pc2')
      const wsPc2 = join(tmp, 'dev', 'althabit-dashboard')
      expect(restoreCodexSession(collected[0], wsPc2, codexDest)).toBe(true)
      expect(existsSync(join(codexDest, 'session_index.jsonl'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('Cursor SQLite adapter extracts matching workspace composer threads and redacts secrets', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-cursor-test-'))
    try {
      const cursorUser = join(tmp, 'Cursor', 'User')
      const wsHashDir = join(cursorUser, 'workspaceStorage', 'hash123')
      mkdirSync(wsHashDir, { recursive: true })

      writeFileSync(
        join(wsHashDir, 'workspace.json'),
        JSON.stringify({ folder: 'file:///d%3A/all-projects/althabit-dashboard' }),
        'utf8',
      )

      const db = new Database(join(wsHashDir, 'state.vscdb'))
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);')
      const composerPayload = {
        allComposers: [
          {
            composerId: 'comp-001',
            name: 'Media Lightbox Slider',
            lastUpdatedAt: 1764070000000,
            conversation: [
              { type: 1, text: 'Build in-page zoomable slider for uploaded files' },
              { type: 2, text: 'Created MediaLightboxDialog.vue with zoom, pan, and rotation.' },
            ],
          },
        ],
      }
      db.query('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('composer.composerData', JSON.stringify(composerPayload))
      db.close()

      const collected = collectCursorSessions({
        projectSlug: 'althabit-dashboard',
        cursorUserDir: cursorUser,
      })
      expect(collected.length).toBe(1)
      expect(collected[0].agent).toBe('cursor')
      expect(collected[0].title).toBe('Media Lightbox Slider')
      expect(collected[0].turns.length).toBe(2)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('executeHandoff bridges an archived Antigravity session into Claude Code, Codex, and Cursor', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-handoff-test-'))
    try {
      const archiveDir = join(tmp, 'althabit-chats')
      const convDir = join(archiveDir, 'conversations', '08-2026-11-25-grns-lightbox')
      mkdirSync(convDir, { recursive: true })
      writeFileSync(
        join(convDir, 'conversation.md'),
        [
          '# 08. GRNs Lightbox & Pagination Fix',
          '',
          '> - **Agent:** `Antigravity`',
          '> - **Conversation ID:** `ef7b3bf5-07ec-48de-919b-d237e61ba28b`',
          '> - **Last Modified:** `2026-11-25T12:47:00Z`',
          '',
          '---',
          '',
          '### 1. User',
          'Enforce max 10 attachments on GRN upload and add zoom slider.',
          '',
          '### 2. Assistant',
          'Implemented MediaLightboxDialog.vue and enforced max 10 attachments.',
        ].join('\n'),
        'utf8',
      )

      const wsDir = join(tmp, 'althabit-dashboard')
      mkdirSync(join(wsDir, '.git', 'info'), { recursive: true })
      const claudeHome = join(tmp, 'claude-home')
      const codexHome = join(tmp, 'codex-home')

      // 1. Handoff -> Claude Code
      const claudeRes = await executeHandoff({
        archiveRoot: archiveDir,
        projectSlug: 'althabit-dashboard',
        workspacePath: wsDir,
        targetAgent: 'claude',
        claudeDir: claudeHome,
      })
      expect(claudeRes.sessionId).toBeDefined()
      expect(existsSync(join(claudeRes.location, `${claudeRes.sessionId}.jsonl`))).toBe(true)
      expect(readFileSync(join(claudeRes.location, `${claudeRes.sessionId}.jsonl`), 'utf8')).toContain('GRNs Lightbox & Pagination Fix')

      // 2. Handoff -> Codex (syncs ALL archived conversations idempotently!)
      const convDir2 = join(archiveDir, 'conversations', '01-2026-10-25-base-plan')
      mkdirSync(convDir2, { recursive: true })
      writeFileSync(
        join(convDir2, 'conversation.md'),
        [
          '# 01. Creating Base Version Plan',
          '',
          '- **معرّف المحادثة (Conversation ID):** `d966dbb4-5635-4a33-8bce-78209e3abd30`',
          '- **آخر تحديث:** `2026-10-25 13:04:45`',
          '',
          '---',
          '',
          '### 👤 محمود (رسالة #1)',
          'عاوز بلان لمشروع الثابت',
          '',
          '### 🤖 المساعد (رد #2)',
          'تم تجهيز الخطة الأساسية للمشروع.',
        ].join('\n'),
        'utf8',
      )

      const codexRes = await executeHandoff({
        archiveRoot: archiveDir,
        projectSlug: 'althabit-dashboard',
        workspacePath: wsDir,
        targetAgent: 'codex',
        codexDir: codexHome,
      })
      expect(codexRes.syncedCount).toBe(2)
      const codexIndex = readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8')
      expect(codexIndex).toContain('Creating Base Version Plan')
      expect(codexIndex).toContain('GRNs Lightbox & Pagination Fix')

      // Running handoff a second time is 100% idempotent (still 2 entries, zero duplicates!)
      const codexResAgain = await executeHandoff({
        archiveRoot: archiveDir,
        projectSlug: 'althabit-dashboard',
        workspacePath: wsDir,
        targetAgent: 'codex',
        codexDir: codexHome,
      })
      expect(codexResAgain.syncedCount).toBe(2)
      expect(readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8').trim().split('\n').length).toBe(2)

      // 3. Handoff -> Cursor (verifying .git/info/exclude protection!)
      const cursorRes = await executeHandoff({
        archiveRoot: archiveDir,
        projectSlug: 'althabit-dashboard',
        workspacePath: wsDir,
        targetAgent: 'cursor',
      })
      expect(existsSync(cursorRes.location)).toBe(true)
      const excludeText = readFileSync(join(wsDir, '.git', 'info', 'exclude'), 'utf8')
      expect(excludeText).toContain('.cursor/rules/chat-sync-handoff.mdc')
      expect(excludeText).toContain('.ai-handoff.md')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
