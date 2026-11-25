import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../src/config'
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

describe('archive full-text search, project registry & native Antigravity plugin', () => {
  test('searchArchiveDirectory finds matching conversations and extracts conversation:// UUIDs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-search-test-'))
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
    const tmp = mkdtempSync(join(tmpdir(), 'agy-reg-test-'))
    const prevEnv = process.env.AGY_SYNC_REGISTRY
    process.env.AGY_SYNC_REGISTRY = join(tmp, 'registry.json')
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
      if (prevEnv === undefined) delete process.env.AGY_SYNC_REGISTRY
      else process.env.AGY_SYNC_REGISTRY = prevEnv
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('plugin bundle conforms strictly to Antigravity plugin.json & SKILL.md specifications', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-plugin-test-'))
    const prevPlugins = process.env.AGY_PLUGINS_DIR
    const prevReg = process.env.AGY_SYNC_REGISTRY
    const prevClaude = process.env.CLAUDE_CONFIG_DIR
    const prevCodex = process.env.CODEX_HOME
    process.env.AGY_PLUGINS_DIR = join(tmp, 'plugins')
    process.env.AGY_SYNC_REGISTRY = join(tmp, 'registry.json')
    process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
    process.env.CODEX_HOME = join(tmp, 'codex')
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
    mkdirSync(process.env.CODEX_HOME, { recursive: true })

    try {
      const report = installGlobalPlugin(REPO_ROOT)
      const installedDir = report.antigravityPluginDir
      expect(existsSync(join(installedDir, 'plugin.json'))).toBe(true)
      expect(report.claudeSkillDir && existsSync(join(report.claudeSkillDir, 'SKILL.md'))).toBe(true)
      expect(report.codexSkillDir && existsSync(join(report.codexSkillDir, 'SKILL.md'))).toBe(true)

      const manifest = JSON.parse(readFileSync(join(installedDir, 'plugin.json'), 'utf8'))
      for (const key of Object.keys(manifest)) {
        expect(ALLOWED_PLUGIN_KEYS.has(key)).toBe(true)
      }
      expect(manifest.name).toBe('antigravity-chat-sync')
      expect(Array.isArray(manifest.suggestedPrompts)).toBe(true)
      expect(manifest.suggestedPrompts.length).toBeLessThanOrEqual(3)
      expect(existsSync(join(installedDir, manifest.logo))).toBe(true)

      const skillMdPath = join(installedDir, 'skills', 'chat-sync', 'SKILL.md')
      expect(existsSync(skillMdPath)).toBe(true)
      const skillContent = readFileSync(skillMdPath, 'utf8')
      expect(skillContent.startsWith('---\nname: chat-sync\n')).toBe(true)

      expect(uninstallGlobalPlugin()).toBe(true)
      expect(existsSync(installedDir)).toBe(false)
    } finally {
      if (prevPlugins === undefined) delete process.env.AGY_PLUGINS_DIR
      else process.env.AGY_PLUGINS_DIR = prevPlugins
      if (prevReg === undefined) delete process.env.AGY_SYNC_REGISTRY
      else process.env.AGY_SYNC_REGISTRY = prevReg
      if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prevClaude
      if (prevCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prevCodex
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
