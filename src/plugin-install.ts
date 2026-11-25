import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { REPO_ROOT } from './config'
import { registerProject } from './registry'

export const PLUGIN_DIR_NAME = 'antigravity-chat-sync'

export function getGlobalPluginsDir(): string {
  return process.env.AGY_PLUGINS_DIR || join(homedir(), '.gemini', 'config', 'plugins')
}

export function installGlobalPlugin(sourceRepoRoot = REPO_ROOT): string {
  const pluginSrc = join(sourceRepoRoot, 'plugin')
  if (!existsSync(join(pluginSrc, 'plugin.json'))) {
    throw new Error(`Plugin bundle not found at ${pluginSrc}`)
  }

  const targetDir = join(getGlobalPluginsDir(), PLUGIN_DIR_NAME)
  mkdirSync(getGlobalPluginsDir(), { recursive: true })
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  cpSync(pluginSrc, targetDir, { recursive: true })

  // Also cache a clean copy of the toolkit runtime so global /chat-sync can bootstrap brand-new projects offline
  const toolkitCacheDir = join(homedir(), '.gemini', 'antigravity-chat-sync', 'toolkit')
  mkdirSync(toolkitCacheDir, { recursive: true })
  for (const item of ['src', 'templates', 'docs', 'plugin', 'package.json', 'tsconfig.json', 'sync.config.example.json', 'README.md', 'LICENSE.md']) {
    const srcItem = join(sourceRepoRoot, item)
    if (existsSync(srcItem)) {
      cpSync(srcItem, join(toolkitCacheDir, item), { recursive: true })
    }
  }

  // Auto-discover and register current or sibling archive folders (*-chats/sync.config.json)
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

  return targetDir
}

export function uninstallGlobalPlugin(): boolean {
  const targetDir = join(getGlobalPluginsDir(), PLUGIN_DIR_NAME)
  if (!existsSync(targetDir)) return false
  rmSync(targetDir, { recursive: true, force: true })
  return true
}

if (import.meta.main) {
  const remove = process.argv.includes('--uninstall') || process.argv.includes('--remove')
  if (remove) {
    const removed = uninstallGlobalPlugin()
    if (removed) {
      console.log(`Removed global Antigravity plugin: ${PLUGIN_DIR_NAME}`)
    } else {
      console.log(`Global plugin "${PLUGIN_DIR_NAME}" is not currently installed.`)
    }
    process.exit(0)
  }

  const installedPath = installGlobalPlugin(REPO_ROOT)
  console.log(`Installed global Antigravity plugin to: ${installedPath}`)
  console.log(`Manage in Antigravity UI: customization://${PLUGIN_DIR_NAME}`)
  console.log(`Available immediately in any workspace via /chat-sync or natural prompts.`)
}
