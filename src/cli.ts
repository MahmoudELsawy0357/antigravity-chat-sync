#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getArgValue, REPO_ROOT } from './config'
import { findRegisteredProject, loadRegistry } from './registry'

function printHelp(): void {
  console.log(`
antigravity-chat-sync — Project-scoped Google Antigravity conversation sync toolkit

Usage:
  bunx github:MahmoudELsawy0357/antigravity-chat-sync <command> [options]

Setup & Plugin Commands:
  setup | bootstrap        Interactive (or flag-driven) wizard to create & link a project archive
  install-plugin           Install the global Antigravity plugin (/chat-sync) on this machine
  uninstall-plugin         Remove the global Antigravity plugin from this machine
  projects                 List all project archives registered on this machine

Archive Commands (run inside archive dir, or pass --project <slug> / --dir <path>):
  init                     Initialize sync.config.json & local playbooks in the current directory
  sync                     Pull, export Markdown, sanitize SQLite blobs, verify, commit & push
  restore                  Pull & non-destructively restore conversations (--wait | --workspace <path>)
  status | doctor          Compare local vs. archived step counts & inspect project_id health
  search "<keyword>"       Full-text search across archived conversations with clickable links
  verify                   Audit all Markdown & compressed archives for secret leaks & size limits
  autostart                Install & start silent OS login background auto-sync daemon
  autostart:stop           Stop background daemon & remove OS login entry
  shortcut                 Create a desktop launcher icon for the target project
  launch                   Run managed restore -> launch Antigravity -> exit-sync session
`)
}

const rawArgs = process.argv.slice(2)
const command = rawArgs[0] || (existsSync(join(process.cwd(), 'sync.config.json')) ? 'status' : 'setup')
const forwardArgs = rawArgs.slice(1)

if (command === 'help' || command === '--help' || command === '-h') {
  printHelp()
  process.exit(0)
}

if (command === 'projects' || command === 'list') {
  const reg = loadRegistry()
  const entries = Object.values(reg.projects)
  if (entries.length === 0) {
    console.log('No project archives registered yet. Run `setup` or `install-plugin` inside an archive directory.')
    process.exit(0)
  }
  console.table(
    entries.map(e => ({
      Project: e.projectSlug,
      ArchiveDir: e.archiveDir,
      Repo: e.archiveRepo || '—',
      Workspace: e.workspacePath || '—',
    })),
  )
  process.exit(0)
}

if (command === 'setup' || command === 'bootstrap') {
  const { runBootstrap } = await import('./bootstrap')
  await runBootstrap()
  process.exit(0)
}

if (command === 'install-plugin' || command === 'plugin:install') {
  const { installGlobalPlugin, PLUGIN_DIR_NAME } = await import('./plugin-install')
  const cwdHasPlugin = existsSync(join(process.cwd(), 'plugin', 'plugin.json'))
  const installed = installGlobalPlugin(cwdHasPlugin ? process.cwd() : REPO_ROOT)
  console.log(`Installed global Antigravity plugin to: ${installed}`)
  console.log(`Manage in Antigravity UI: customization://${PLUGIN_DIR_NAME}`)
  process.exit(0)
}

if (command === 'uninstall-plugin' || command === 'plugin:uninstall') {
  const { uninstallGlobalPlugin, PLUGIN_DIR_NAME } = await import('./plugin-install')
  const removed = uninstallGlobalPlugin()
  console.log(removed ? `Removed global plugin: ${PLUGIN_DIR_NAME}` : `Plugin ${PLUGIN_DIR_NAME} was not installed.`)
  process.exit(0)
}

// Resolve target archive directory for project-scoped commands
let targetArchiveDir = REPO_ROOT
const explicitDir = getArgValue('--dir')
const explicitProject = getArgValue('--project')

if (explicitDir) {
  targetArchiveDir = resolve(explicitDir)
} else if (existsSync(join(process.cwd(), 'sync.config.json'))) {
  targetArchiveDir = process.cwd()
} else if (explicitProject && command !== 'init') {
  const reg = findRegisteredProject(explicitProject)
  if (reg && existsSync(reg.archiveDir)) {
    targetArchiveDir = reg.archiveDir
  }
} else if (!existsSync(join(REPO_ROOT, 'sync.config.json')) && command !== 'init') {
  // Try matching current working directory against registered workspaces
  const reg = findRegisteredProject(process.cwd())
  if (reg && existsSync(reg.archiveDir)) {
    targetArchiveDir = reg.archiveDir
  }
}

const SCRIPT_MAP: Record<string, { script: string; extraArgs?: string[] }> = {
  init: { script: 'src/init.ts' },
  sync: { script: 'src/sync.ts' },
  restore: { script: 'src/restore.ts' },
  status: { script: 'src/status.ts' },
  doctor: { script: 'src/status.ts' },
  search: { script: 'src/search.ts' },
  verify: { script: 'src/verify.ts' },
  daemon: { script: 'src/daemon.ts' },
  autostart: { script: 'src/autostart.ts' },
  'autostart:stop': { script: 'src/autostart.ts', extraArgs: ['--remove'] },
  shortcut: { script: 'src/shortcut.ts' },
  launch: { script: 'src/launch.ts' },
}

const mapped = SCRIPT_MAP[command]
if (!mapped) {
  console.error(`Unknown command: "${command}"`)
  printHelp()
  process.exit(1)
}

const scriptRoot = existsSync(join(targetArchiveDir, mapped.script)) ? targetArchiveDir : REPO_ROOT
const res = spawnSync(
  process.execPath,
  ['run', join(scriptRoot, mapped.script), ...(mapped.extraArgs || []), ...forwardArgs],
  {
    cwd: targetArchiveDir,
    stdio: 'inherit',
    windowsHide: true,
  },
)
process.exit(res.status ?? 0)
