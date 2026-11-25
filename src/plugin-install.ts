import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getClaudeDir, getCodexDir } from './agents'
import { REPO_ROOT } from './config'
import { getChatsyncHomeDir, registerProject } from './registry'
import { getGeminiCliDir, getWindsurfCodeiumDir } from './universal-agents'

export const PLUGIN_DIR_NAME = 'chatsync'
const LEGACY_PLUGIN_DIR_NAME = 'antigravity-chat-sync'
const WINDSURF_MARKER_START = '<!-- chatsync-global-skill-start -->'
const WINDSURF_MARKER_END = '<!-- chatsync-global-skill-end -->'

export function getGlobalPluginsDir(): string {
  return process.env.AGY_PLUGINS_DIR || join(homedir(), '.gemini', 'config', 'plugins')
}

export function getGlobalBinDir(): string {
  return process.env.CHATSYNC_BIN_DIR || join(homedir(), '.bun', 'bin')
}

export interface PluginInstallReport {
  cliBinPath: string
  toolkitCacheDir: string
  antigravityPluginDir: string
  claudeSkillDir?: string
  codexSkillDir?: string
  geminiCliSkillDir?: string
  windsurfRulesFile?: string
  clineRulesFile?: string
}

export function installGlobalPlugin(sourceRepoRoot = REPO_ROOT, forceAllAgents = false): PluginInstallReport {
  const pluginSrc = join(sourceRepoRoot, 'plugin')
  const skillSrcDir = join(pluginSrc, 'skills', 'chatsync')
  if (!existsSync(join(pluginSrc, 'plugin.json')) || !existsSync(join(skillSrcDir, 'SKILL.md'))) {
    throw new Error(`Plugin bundle not found at ${pluginSrc}`)
  }

  // 1. Cache toolkit runtime under ~/.chatsync/toolkit
  const toolkitCacheDir = join(getChatsyncHomeDir(), 'toolkit')
  mkdirSync(toolkitCacheDir, { recursive: true })
  for (const item of [
    'src',
    'templates',
    'docs',
    'plugin',
    'package.json',
    'tsconfig.json',
    'sync.config.example.json',
    'README.md',
    'LICENSE.md',
    'LICENSE',
  ]) {
    const srcItem = join(sourceRepoRoot, item)
    if (existsSync(srcItem)) {
      cpSync(srcItem, join(toolkitCacheDir, item), { recursive: true })
    }
  }

  // 2. Install global `chatsync` CLI shim into ~/.bun/bin (already in PATH whenever Bun is installed!)
  const binDir = getGlobalBinDir()
  mkdirSync(binDir, { recursive: true })
  const cliEntry = join(toolkitCacheDir, 'src', 'cli.ts')
  let cliBinPath: string

  if (process.platform === 'win32') {
    cliBinPath = join(binDir, 'chatsync.cmd')
    writeFileSync(cliBinPath, `@echo off\r\nbun "${cliEntry}" %*\r\n`, 'utf8')
    // Also write POSIX shim for Git Bash / WSL shells on Windows
    const shShim = join(binDir, 'chatsync')
    writeFileSync(shShim, `#!/usr/bin/env sh\nexec bun "${cliEntry.replace(/\\/g, '/')}" "$@"\n`, 'utf8')
  } else {
    cliBinPath = join(binDir, 'chatsync')
    writeFileSync(cliBinPath, `#!/usr/bin/env bash\nexec bun "${cliEntry}" "$@"\n`, 'utf8')
    chmodSync(cliBinPath, 0o755)
  }

  // 3. Install native Google Antigravity Plugin (and clean up legacy folder name)
  const pluginsRoot = getGlobalPluginsDir()
  mkdirSync(pluginsRoot, { recursive: true })
  const legacyAgyPlugin = join(pluginsRoot, LEGACY_PLUGIN_DIR_NAME)
  if (existsSync(legacyAgyPlugin)) {
    rmSync(legacyAgyPlugin, { recursive: true, force: true })
  }
  const targetDir = join(pluginsRoot, PLUGIN_DIR_NAME)
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  cpSync(pluginSrc, targetDir, { recursive: true })

  const report: PluginInstallReport = {
    cliBinPath,
    toolkitCacheDir,
    antigravityPluginDir: targetDir,
  }

  // 4. Claude Code (~/.claude/skills/chatsync)
  const claudeRoot = getClaudeDir()
  if (forceAllAgents || existsSync(claudeRoot)) {
    const legacyClaude = join(claudeRoot, 'skills', 'chat-sync')
    if (existsSync(legacyClaude)) rmSync(legacyClaude, { recursive: true, force: true })
    const claudeSkillTarget = join(claudeRoot, 'skills', 'chatsync')
    mkdirSync(join(claudeRoot, 'skills'), { recursive: true })
    if (existsSync(claudeSkillTarget)) rmSync(claudeSkillTarget, { recursive: true, force: true })
    cpSync(skillSrcDir, claudeSkillTarget, { recursive: true })
    report.claudeSkillDir = claudeSkillTarget
  }

  // 5. OpenAI Codex (~/.codex/skills/chatsync)
  const codexRoot = getCodexDir()
  if (forceAllAgents || existsSync(codexRoot)) {
    const legacyCodex = join(codexRoot, 'skills', 'chat-sync')
    if (existsSync(legacyCodex)) rmSync(legacyCodex, { recursive: true, force: true })
    const codexSkillTarget = join(codexRoot, 'skills', 'chatsync')
    mkdirSync(join(codexRoot, 'skills'), { recursive: true })
    if (existsSync(codexSkillTarget)) rmSync(codexSkillTarget, { recursive: true, force: true })
    cpSync(skillSrcDir, codexSkillTarget, { recursive: true })
    report.codexSkillDir = codexSkillTarget
  }

  // 6. Gemini CLI (~/.gemini/skills/chatsync)
  const geminiRoot = getGeminiCliDir()
  if (forceAllAgents || existsSync(geminiRoot)) {
    const geminiSkillTarget = join(geminiRoot, 'skills', 'chatsync')
    mkdirSync(join(geminiRoot, 'skills'), { recursive: true })
    if (existsSync(geminiSkillTarget)) rmSync(geminiSkillTarget, { recursive: true, force: true })
    cpSync(skillSrcDir, geminiSkillTarget, { recursive: true })
    report.geminiCliSkillDir = geminiSkillTarget
  }

  // 7. Windsurf (~/.codeium/windsurf/memories/global_rules.md)
  const windsurfDir = getWindsurfCodeiumDir()
  if (forceAllAgents || existsSync(windsurfDir)) {
    const memDir = join(windsurfDir, 'memories')
    mkdirSync(memDir, { recursive: true })
    const rulesFile = join(memDir, 'global_rules.md')
    const cur = existsSync(rulesFile) ? readFileSync(rulesFile, 'utf8') : ''
    const block = [
      WINDSURF_MARKER_START,
      '## ChatSync Universal AI Bridge (`chatsync`)',
      '- To bridge or continue sessions from another AI agent locally (zero GitHub needed): run `chatsync bridge` or `chatsync to windsurf` and read `.chatsync/latest.md`.',
      '- To push/pull multi-device backups: run `chatsync sync` or `chatsync restore`.',
      WINDSURF_MARKER_END,
    ].join('\n')
    const cleaned = cur.includes(WINDSURF_MARKER_START)
      ? cur.replace(new RegExp(`${WINDSURF_MARKER_START}[\\s\\S]*?${WINDSURF_MARKER_END}`, 'g'), block)
      : `${cur.trimEnd()}\n\n${block}\n`.trimStart()
    writeFileSync(rulesFile, cleaned, 'utf8')
    report.windsurfRulesFile = rulesFile
  }

  // 8. Cline Global Rules (~/Documents/Cline/Rules/chatsync.md)
  const clineDocsRoot = process.env.CLINE_RULES_DIR || join(homedir(), 'Documents', 'Cline', 'Rules')
  const clineParentDir = process.env.CLINE_RULES_DIR ? resolve(clineDocsRoot, '..') : join(homedir(), 'Documents', 'Cline')
  if (forceAllAgents || existsSync(clineParentDir)) {
    mkdirSync(clineDocsRoot, { recursive: true })
    const clineRuleFile = join(clineDocsRoot, 'chatsync.md')
    cpSync(join(skillSrcDir, 'SKILL.md'), clineRuleFile)
    report.clineRulesFile = clineRuleFile
  }

  // 9. Auto-discover and register current or sibling archive folders (*-chats/sync.config.json)
  const candidateDirs = new Set<string>([sourceRepoRoot, process.cwd()])
  for (const base of [sourceRepoRoot, process.cwd()]) {
    const parentDir = resolve(base, '..')
    if (existsSync(parentDir)) {
      try {
        for (const entry of readdirSync(parentDir)) {
          const sub = join(parentDir, entry)
          if (statSync(sub).isDirectory() && existsSync(join(sub, 'sync.config.json'))) {
            candidateDirs.add(sub)
          }
        }
      } catch {}
    }
  }

  for (const dir of candidateDirs) {
    const cfgFile = join(dir, 'sync.config.json')
    if (!existsSync(cfgFile)) continue
    try {
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
      if (!cfg.projectSlug) continue
      const siblingWs = resolve(dir, '..', cfg.projectSlug)
      registerProject({
        projectSlug: cfg.projectSlug,
        projectDisplayName: cfg.projectDisplayName || cfg.projectSlug,
        archiveDir: dir,
        archiveRepo: cfg.archiveRepo,
        workspacePath: existsSync(siblingWs) ? siblingWs : undefined,
      })
    } catch {}
  }

  return report
}

export function uninstallGlobalPlugin(): boolean {
  let removedAny = false
  for (const name of [PLUGIN_DIR_NAME, LEGACY_PLUGIN_DIR_NAME]) {
    const p = join(getGlobalPluginsDir(), name)
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true })
      removedAny = true
    }
  }
  for (const dir of [
    join(getClaudeDir(), 'skills', 'chatsync'),
    join(getClaudeDir(), 'skills', 'chat-sync'),
    join(getCodexDir(), 'skills', 'chatsync'),
    join(getCodexDir(), 'skills', 'chat-sync'),
    join(getGeminiCliDir(), 'skills', 'chatsync'),
  ]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      removedAny = true
    }
  }
  const binDir = getGlobalBinDir()
  for (const b of ['chatsync', 'chatsync.cmd']) {
    const bp = join(binDir, b)
    if (existsSync(bp)) {
      rmSync(bp, { force: true })
      removedAny = true
    }
  }
  const wsRules = join(getWindsurfCodeiumDir(), 'memories', 'global_rules.md')
  if (existsSync(wsRules)) {
    const cur = readFileSync(wsRules, 'utf8')
    if (cur.includes(WINDSURF_MARKER_START)) {
      const next = cur.replace(new RegExp(`\\n*${WINDSURF_MARKER_START}[\\s\\S]*?${WINDSURF_MARKER_END}\\n*`, 'g'), '\n').trim()
      writeFileSync(wsRules, next ? `${next}\n` : '', 'utf8')
      removedAny = true
    }
  }
  const clineDocsRoot = process.env.CLINE_RULES_DIR || join(homedir(), 'Documents', 'Cline', 'Rules')
  const clineRuleFile = join(clineDocsRoot, 'chatsync.md')
  if (existsSync(clineRuleFile)) {
    rmSync(clineRuleFile, { force: true })
    removedAny = true
  }
  return removedAny
}

export function printInstallReport(report: PluginInstallReport): void {
  console.log('\n⚡ ChatSync Installed Globally in One Shot!')
  console.log('─'.repeat(72))
  console.log(`  ✓ Global CLI Command    : chatsync (${report.cliBinPath})`)
  console.log(`  ✓ Antigravity Plugin    : ${report.antigravityPluginDir}`)
  if (report.claudeSkillDir) console.log(`  ✓ Claude Code Skill     : ${report.claudeSkillDir}`)
  if (report.codexSkillDir) console.log(`  ✓ OpenAI Codex Skill    : ${report.codexSkillDir}`)
  if (report.geminiCliSkillDir) console.log(`  ✓ Gemini CLI Skill      : ${report.geminiCliSkillDir}`)
  if (report.windsurfRulesFile) console.log(`  ✓ Windsurf Global Rules : ${report.windsurfRulesFile}`)
  if (report.clineRulesFile) console.log(`  ✓ Cline Global Rules    : ${report.clineRulesFile}`)
  console.log('─'.repeat(72))
  console.log('🚀 Ready! Open ANY project folder and run:')
  console.log('   chatsync bridge          (link all AI agents on this PC — zero GitHub needed!)')
  console.log('   chatsync to claude       (or codex / cursor / windsurf / cline / copilot)')
  console.log('   chatsync setup           (optional: link a private GitHub repo for 2+ PCs)\n')
}

if (import.meta.main) {
  const remove = process.argv.includes('--uninstall') || process.argv.includes('--remove')
  if (remove) {
    const removed = uninstallGlobalPlugin()
    console.log(removed ? 'Removed global chatsync CLI, plugin & agent skills.' : 'chatsync was not currently installed.')
    process.exit(0)
  }

  const forceAll = process.argv.includes('--all-agents')
  const report = installGlobalPlugin(REPO_ROOT, forceAll)
  printInstallReport(report)
}
