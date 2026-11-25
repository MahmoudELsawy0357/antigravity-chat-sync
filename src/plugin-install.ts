import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getClaudeDir, getCodexDir } from './agents'
import { REPO_ROOT } from './config'
import { registerProject } from './registry'

export const PLUGIN_DIR_NAME = 'antigravity-chat-sync'

export function getGlobalPluginsDir(): string {
  return process.env.AGY_PLUGINS_DIR || join(homedir(), '.gemini', 'config', 'plugins')
}

export interface PluginInstallReport {
  antigravityPluginDir: string
  claudeSkillDir?: string
  codexSkillDir?: string
}

export function installGlobalPlugin(sourceRepoRoot = REPO_ROOT, forceAllAgents = false): PluginInstallReport {
  const pluginSrc = join(sourceRepoRoot, 'plugin')
  const skillSrcDir = join(pluginSrc, 'skills', 'chat-sync')
  if (!existsSync(join(pluginSrc, 'plugin.json'))) {
    throw new Error(`Plugin bundle not found at ${pluginSrc}`)
  }

  // 1. Install native Google Antigravity Plugin
  const targetDir = join(getGlobalPluginsDir(), PLUGIN_DIR_NAME)
  mkdirSync(getGlobalPluginsDir(), { recursive: true })
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  cpSync(pluginSrc, targetDir, { recursive: true })

  const report: PluginInstallReport = { antigravityPluginDir: targetDir }

  // 2. Install matching SKILL.md into Claude Code (~/.claude/skills/chat-sync) when present
  const claudeRoot = getClaudeDir()
  if ((forceAllAgents || existsSync(claudeRoot)) && existsSync(skillSrcDir)) {
    const claudeSkillTarget = join(claudeRoot, 'skills', 'chat-sync')
    mkdirSync(join(claudeRoot, 'skills'), { recursive: true })
    if (existsSync(claudeSkillTarget)) rmSync(claudeSkillTarget, { recursive: true, force: true })
    cpSync(skillSrcDir, claudeSkillTarget, { recursive: true })
    report.claudeSkillDir = claudeSkillTarget
  }

  // 3. Install matching SKILL.md into OpenAI Codex (~/.codex/skills/chat-sync) when present
  const codexRoot = getCodexDir()
  if ((forceAllAgents || existsSync(codexRoot)) && existsSync(skillSrcDir)) {
    const codexSkillTarget = join(codexRoot, 'skills', 'chat-sync')
    mkdirSync(join(codexRoot, 'skills'), { recursive: true })
    if (existsSync(codexSkillTarget)) rmSync(codexSkillTarget, { recursive: true, force: true })
    cpSync(skillSrcDir, codexSkillTarget, { recursive: true })
    report.codexSkillDir = codexSkillTarget
  }

  // 4. Cache toolkit runtime under ~/.gemini/antigravity-chat-sync/toolkit
  const toolkitCacheDir = join(homedir(), '.gemini', 'antigravity-chat-sync', 'toolkit')
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
  ]) {
    const srcItem = join(sourceRepoRoot, item)
    if (existsSync(srcItem)) {
      cpSync(srcItem, join(toolkitCacheDir, item), { recursive: true })
    }
  }

  // 5. Auto-discover and register current or sibling archive folders (*-chats/sync.config.json)
  const candidateDirs = new Set<string>([sourceRepoRoot])
  const parentDir = resolve(sourceRepoRoot, '..')
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
  const targetDir = join(getGlobalPluginsDir(), PLUGIN_DIR_NAME)
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
    removedAny = true
  }
  const claudeSkill = join(getClaudeDir(), 'skills', 'chat-sync')
  if (existsSync(claudeSkill)) {
    rmSync(claudeSkill, { recursive: true, force: true })
    removedAny = true
  }
  const codexSkill = join(getCodexDir(), 'skills', 'chat-sync')
  if (existsSync(codexSkill)) {
    rmSync(codexSkill, { recursive: true, force: true })
    removedAny = true
  }
  return removedAny
}

if (import.meta.main) {
  const remove = process.argv.includes('--uninstall') || process.argv.includes('--remove')
  if (remove) {
    const removed = uninstallGlobalPlugin()
    if (removed) {
      console.log(`Removed global /chat-sync plugin & skills (${PLUGIN_DIR_NAME}).`)
    } else {
      console.log(`Global plugin "${PLUGIN_DIR_NAME}" is not currently installed.`)
    }
    process.exit(0)
  }

  const forceAll = process.argv.includes('--all-agents')
  const report = installGlobalPlugin(REPO_ROOT, forceAll)
  console.log(`Installed Antigravity plugin : ${report.antigravityPluginDir}`)
  if (report.claudeSkillDir) console.log(`Installed Claude Code skill  : ${report.claudeSkillDir}`)
  if (report.codexSkillDir) console.log(`Installed Codex skill        : ${report.codexSkillDir}`)
  console.log(`Manage in Antigravity UI     : customization://${PLUGIN_DIR_NAME}`)
}
