import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../src/config'
import { executeLocalBridge } from '../src/local-bridge'
import { installGlobalPlugin, uninstallGlobalPlugin } from '../src/plugin-install'
import { findRegisteredProject, registerProject } from '../src/registry'
import { searchArchiveDirectory } from '../src/search'

const ALLOWED_PLUGIN_KEYS = new Set([
  'name',
  'description',
  'logo',
  'suggestedPrompts',
  'displayName',
  'version',
  'author',
  'homepage',
  'repository',
  'disabled',
])

describe('archive full-text search, project registry, universal installer & single-PC local bridge', () => {
  test('searchArchiveDirectory finds matching conversations and extracts conversation:// UUIDs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'chatsync-search-test-'))
    try {
      const convDir = join(tmp, 'conversations', '01-2026-11-25-auth-refactor')
      mkdirSync(convDir, { recursive: true })
      const uuid = '11111111-2222-4333-8444-555555555555'
      writeFileSync(
        join(convDir, 'conversation.md'),
        [
          '# Auth Token Refresh Refactor',
          '',
          `> - **Conversation ID:** \`${uuid}\``,
          '',
          '### User',
          'Fix attachment_tokens validation when uploading more than 10 files.',
        ].join('\n'),
        'utf8',
      )

      const hits = searchArchiveDirectory(tmp, 'attachment_tokens')
      expect(hits.length).toBe(1)
      expect(hits[0].conversationId).toBe(uuid)
      expect(hits[0].title).toBe('Auth Token Refresh Refactor')
      expect(hits[0].snippets[0].text).toContain('attachment_tokens')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('registerProject and findRegisteredProject resolve by slug and workspace path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'chatsync-reg-test-'))
    const prevEnv = process.env.CHATSYNC_REGISTRY
    process.env.CHATSYNC_REGISTRY = join(tmp, 'registry.json')
    try {
      const wsDir = join(tmp, 'demo-app')
      const arcDir = join(tmp, 'demo-app-chats')
      mkdirSync(wsDir, { recursive: true })
      mkdirSync(arcDir, { recursive: true })

      registerProject({
        projectSlug: 'demo-app',
        projectDisplayName: 'Demo App',
        archiveDir: arcDir,
        archiveRepo: 'octocat/demo-app-chats',
        workspacePath: wsDir,
      })

      expect(findRegisteredProject('demo-app')?.archiveRepo).toBe('octocat/demo-app-chats')
      expect(findRegisteredProject(wsDir)?.projectSlug).toBe('demo-app')
    } finally {
      if (prevEnv === undefined) delete process.env.CHATSYNC_REGISTRY
      else process.env.CHATSYNC_REGISTRY = prevEnv
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('one-line installer conforms strictly to Antigravity plugin.json & installs CLI + universal skills', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'chatsync-plugin-test-'))
    const envKeys = [
      'CHATSYNC_HOME',
      'CHATSYNC_BIN_DIR',
      'CHATSYNC_REGISTRY',
      'AGY_PLUGINS_DIR',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'GEMINI_CLI_HOME',
      'WINDSURF_CODEIUM_DIR',
      'CLINE_RULES_DIR',
    ] as const
    const prevEnv: Record<string, string | undefined> = {}
    for (const k of envKeys) prevEnv[k] = process.env[k]

    process.env.CHATSYNC_HOME = join(tmp, 'chatsync-home')
    process.env.CHATSYNC_BIN_DIR = join(tmp, 'bin')
    process.env.CHATSYNC_REGISTRY = join(tmp, 'chatsync-home', 'registry.json')
    process.env.AGY_PLUGINS_DIR = join(tmp, 'plugins')
    process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
    process.env.CODEX_HOME = join(tmp, 'codex')
    process.env.GEMINI_CLI_HOME = join(tmp, 'gemini')
    process.env.WINDSURF_CODEIUM_DIR = join(tmp, 'windsurf')
    process.env.CLINE_RULES_DIR = join(tmp, 'cline', 'Rules')

    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
    mkdirSync(process.env.CODEX_HOME, { recursive: true })
    mkdirSync(process.env.GEMINI_CLI_HOME, { recursive: true })
    mkdirSync(process.env.WINDSURF_CODEIUM_DIR, { recursive: true })
    mkdirSync(join(tmp, 'cline'), { recursive: true })

    try {
      const report = installGlobalPlugin(REPO_ROOT)
      const installedDir = report.antigravityPluginDir
      expect(existsSync(report.cliBinPath)).toBe(true)
      expect(existsSync(join(installedDir, 'plugin.json'))).toBe(true)
      expect(report.claudeSkillDir && existsSync(join(report.claudeSkillDir, 'SKILL.md'))).toBe(true)
      expect(report.codexSkillDir && existsSync(join(report.codexSkillDir, 'SKILL.md'))).toBe(true)
      expect(report.geminiCliSkillDir && existsSync(join(report.geminiCliSkillDir, 'SKILL.md'))).toBe(true)
      expect(report.windsurfRulesFile && existsSync(report.windsurfRulesFile)).toBe(true)
      expect(report.clineRulesFile && existsSync(report.clineRulesFile)).toBe(true)

      const manifest = JSON.parse(readFileSync(join(installedDir, 'plugin.json'), 'utf8'))
      for (const key of Object.keys(manifest)) {
        expect(ALLOWED_PLUGIN_KEYS.has(key)).toBe(true)
      }
      expect(manifest.name).toBe('chatsync')
      expect(Array.isArray(manifest.suggestedPrompts)).toBe(true)
      expect(manifest.suggestedPrompts.length).toBeLessThanOrEqual(3)
      expect(existsSync(join(installedDir, manifest.logo))).toBe(true)

      const skillMdPath = join(installedDir, 'skills', 'chatsync', 'SKILL.md')
      expect(existsSync(skillMdPath)).toBe(true)
      const skillContent = readFileSync(skillMdPath, 'utf8').replace(/\r\n/g, '\n')
      expect(skillContent.startsWith('---\nname: chatsync\n')).toBe(true)

      expect(uninstallGlobalPlugin()).toBe(true)
      expect(existsSync(installedDir)).toBe(false)
      expect(existsSync(report.cliBinPath)).toBe(false)
    } finally {
      for (const k of envKeys) {
        if (prevEnv[k] === undefined) delete process.env[k]
        else process.env[k] = prevEnv[k]
      }
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('single-PC zero-GitHub executeLocalBridge injects Copilot, Cline & Aider chats directly into Native Sidebars (Cursor, Copilot, Windsurf, Cline, Antigravity & Claude) with ZERO repo handoff files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'chatsync-bridge-test-'))
    try {
      const wsDir = join(tmp, 'orbit-api')
      mkdirSync(join(wsDir, '.git', 'info'), { recursive: true })
      writeFileSync(join(wsDir, '.git', 'info', 'exclude'), '# git exclude\n', 'utf8')

      // 1. Seed a VS Code GitHub Copilot Chat v3 JSONL session + Cline task
      const vsCodeUserDir = join(tmp, 'vscode-user')
      const wsHashDir = join(vsCodeUserDir, 'workspaceStorage', 'hash-orbit-1')
      mkdirSync(join(wsHashDir, 'chatSessions'), { recursive: true })
      writeFileSync(
        join(wsHashDir, 'workspace.json'),
        JSON.stringify({ folder: `file:///${wsDir.replace(/\\/g, '/')}` }),
        'utf8',
      )
      writeFileSync(
        join(wsHashDir, 'chatSessions', 'copilot-sess-1.jsonl'),
        JSON.stringify({
          kind: 0,
          v: {
            version: 3,
            sessionId: 'copilot-sess-1',
            customTitle: 'JWT Middleware Setup',
            creationDate: 1764093000000,
            requests: [
              {
                message: { text: 'Implement rate limiting on /auth/refresh' },
                response: [{ value: 'Added sliding-window rate limiter middleware.' }],
              },
            ],
          },
        }) + '\n',
        'utf8',
      )

      const clineTaskDir = join(vsCodeUserDir, 'globalStorage', 'saoudrizwan.claude-dev', 'tasks', 'cline-task-99')
      mkdirSync(clineTaskDir, { recursive: true })
      writeFileSync(
        join(clineTaskDir, 'ui_messages.json'),
        JSON.stringify([
          { type: 'say', say: 'task', text: 'Audit orbit-api Redis cache TTLs', ts: 1764094000000 },
          { type: 'say', say: 'text', text: 'Updated orbit-api Redis TTL to 300s.', ts: 1764094010000 },
        ]),
        'utf8',
      )

      // 2. Seed an Aider session inside workspace
      writeFileSync(
        join(wsDir, '.aider.chat.history.md'),
        [
          '# aider chat started at 2026-11-25 19:00:00',
          '#### Add healthz endpoint',
          '',
          'Created GET /healthz returning 200 OK.',
        ].join('\n'),
        'utf8',
      )

      const agyDir = join(tmp, 'agy-home')
      const claudeDir = join(tmp, 'claude-home')
      const codexDir = join(tmp, 'codex-home')
      const cursorUserDir = join(tmp, 'cursor-user')
      const windsurfUserDir = join(tmp, 'windsurf-user')
      mkdirSync(agyDir, { recursive: true })
      mkdirSync(claudeDir, { recursive: true })
      mkdirSync(codexDir, { recursive: true })
      mkdirSync(cursorUserDir, { recursive: true })
      mkdirSync(windsurfUserDir, { recursive: true })

      // 3. Bridge across ALL installed AI Sidebars on 1 PC with ZERO GitHub & ZERO handoff files!
      const bridgeAll = executeLocalBridge({
        workspacePath: wsDir,
        targetAgent: 'all',
        agyDir,
        claudeDir,
        codexDir,
        cursorUserDir,
        vsCodeUserDir,
        windsurfUserDir,
        geminiDir: join(tmp, 'empty-gemini'),
      })

      expect(bridgeAll.sourceSessionsCount).toBe(3)
      // Verify ZERO .ai-handoff.md or .chatsync/ clutter written to workspace!
      expect(existsSync(join(wsDir, '.ai-handoff.md'))).toBe(false)
      expect(existsSync(join(wsDir, '.chatsync'))).toBe(false)

      // Verify Native Sidebar DBs were populated across Cursor, Antigravity, Copilot, Windsurf, Cline, Claude & Codex!
      expect(existsSync(join(cursorUserDir, 'globalStorage', 'state.vscdb'))).toBe(true)
      expect(existsSync(join(agyDir, 'conversation_summaries.db'))).toBe(true)
      expect(existsSync(join(windsurfUserDir, 'workspaceStorage'))).toBe(true)
      expect(existsSync(join(vsCodeUserDir, 'globalStorage', 'state.vscdb'))).toBe(true)

      // Verify idempotency: running bridge a second time does NOT multiply sessions (still 3, not 6!)
      const bridgeAgain = executeLocalBridge({
        workspacePath: wsDir,
        targetAgent: 'all',
        agyDir,
        claudeDir,
        codexDir,
        cursorUserDir,
        vsCodeUserDir,
        windsurfUserDir,
        geminiDir: join(tmp, 'empty-gemini'),
      })
      expect(bridgeAgain.sourceSessionsCount).toBe(3)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
