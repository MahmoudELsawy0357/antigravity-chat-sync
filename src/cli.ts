#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getArgValue, REPO_ROOT } from './config'
import { findRegisteredProject, loadRegistry } from './registry'

function printHelp(): void {
  console.log(`
chatsync v3.0 — Universal AI Session Bridge & Multi-Device Archiver
Supports ANY AI Agent: Antigravity · Claude Code · Codex · Cursor · Windsurf · Copilot · Cline · Roo Code · Gemini CLI · Aider · OpenCode · Universal (.chatsync/)

1-Line Global Install (CLI + Skills across all AI agents):
  bunx github:MahmoudELsawy0357/chatsync install

Single-PC Instant Agent Bridge (Zero GitHub Repo Needed!):
  chatsync bridge                  Link all sessions across every installed AI agent in current folder
  chatsync to <agent>              Send sessions directly to claude | codex | cursor | windsurf | cline | copilot | universal
  chatsync status                  Inspect detected AI agents & local/archived sessions for current folder

Multi-PC Cloud Sync & Backup Commands (Optional Private GitHub Repo):
  chatsync setup                   Wizard (or flags) to link a private GitHub archive for 2+ PCs
  chatsync sync | push             Export Markdown (all agents), sanitize secrets & push to GitHub
  chatsync restore | pull          Pull & restore sessions across Antigravity, Claude Code & Codex
  chatsync handoff | continue      Resume archived or local sessions (--to <agent>)
  chatsync search "<keyword>"      Full-text search across archived conversations with clickable links
  chatsync verify                  Audit Markdown & binary archives for secret leaks & size limits
  chatsync autostart               Install & start silent OS login background auto-sync daemon
  chatsync autostart:stop          Stop background daemon & remove OS login entry
  chatsync shortcut                Create a smart Desktop launcher icon for the target project
  chatsync projects                List all multi-PC GitHub archives registered on this machine
  chatsync uninstall               Remove global chatsync CLI, plugin & skills from this machine
`)
}

const rawArgs = process.argv.slice(2)
const command = rawArgs[0] || 'status'
const forwardArgs = rawArgs.slice(1)

if (command === 'help' || command === '--help' || command === '-h') {
  printHelp()
  process.exit(0)
}

if (command === 'version' || command === '--version' || command === '-v') {
  console.log('chatsync v3.0.0')
  process.exit(0)
}

if (command === 'projects' || command === 'list') {
  const reg = loadRegistry()
  const entries = Object.values(reg.projects)
  if (entries.length === 0) {
    console.log('No multi-PC GitHub archives registered yet. Single-PC `chatsync bridge` works immediately without setup, or run `chatsync setup` to add GitHub backup.')
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

if (command === 'install' || command === 'install-plugin' || command === 'plugin:install') {
  const { installGlobalPlugin, printInstallReport } = await import('./plugin-install')
  const cwdHasPlugin = existsSync(join(process.cwd(), 'plugin', 'plugin.json'))
  const report = installGlobalPlugin(cwdHasPlugin ? process.cwd() : REPO_ROOT, process.argv.includes('--all-agents'))
  printInstallReport(report)
  process.exit(0)
}

if (command === 'uninstall' || command === 'uninstall-plugin' || command === 'plugin:uninstall') {
  const { uninstallGlobalPlugin, PLUGIN_DIR_NAME } = await import('./plugin-install')
  const removed = uninstallGlobalPlugin()
  console.log(removed ? `Removed global CLI, plugin & skills: ${PLUGIN_DIR_NAME}` : `${PLUGIN_DIR_NAME} was not currently installed.`)
  process.exit(0)
}

if (command === 'bridge' || command === 'link' || command === 'to' || command === 'switch') {
  const bridgeScript = join(REPO_ROOT, 'src', 'local-bridge.ts')
  const bridgeArgs =
    (command === 'to' || command === 'switch') && forwardArgs[0] && !forwardArgs[0].startsWith('--')
      ? ['--to', forwardArgs[0], ...forwardArgs.slice(1)]
      : forwardArgs
  const res = spawnSync(process.execPath, ['run', bridgeScript, ...bridgeArgs], {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
  })
  process.exit(res.status ?? 0)
}

let targetArchiveDir = REPO_ROOT
let hasResolvedArchive = false
const explicitDir = getArgValue('--dir')
const explicitProject = getArgValue('--project')

if (explicitDir) {
  targetArchiveDir = resolve(explicitDir)
  hasResolvedArchive = existsSync(join(targetArchiveDir, 'sync.config.json'))
} else if (existsSync(join(process.cwd(), 'sync.config.json'))) {
  targetArchiveDir = process.cwd()
  hasResolvedArchive = true
} else if (explicitProject && command !== 'init') {
  const reg = findRegisteredProject(explicitProject)
  if (reg && existsSync(reg.archiveDir)) {
    targetArchiveDir = reg.archiveDir
    hasResolvedArchive = existsSync(join(targetArchiveDir, 'sync.config.json'))
  }
} else if (existsSync(join(REPO_ROOT, 'sync.config.json'))) {
  targetArchiveDir = REPO_ROOT
  hasResolvedArchive = true
} else if (command !== 'init') {
  const reg = findRegisteredProject(process.cwd())
  if (reg && existsSync(reg.archiveDir)) {
    targetArchiveDir = reg.archiveDir
    hasResolvedArchive = existsSync(join(targetArchiveDir, 'sync.config.json'))
  }
}

const SCRIPT_MAP: Record<string, { script: string; extraArgs?: string[] }> = {
  init: { script: 'src/init.ts' },
  sync: { script: 'src/sync.ts' },
  push: { script: 'src/sync.ts' },
  restore: { script: 'src/restore.ts' },
  pull: { script: 'src/restore.ts' },
  handoff: { script: 'src/handoff.ts' },
  continue: { script: 'src/handoff.ts' },
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
const runCwd = hasResolvedArchive ? targetArchiveDir : process.cwd()
const extraWorkspaceArgs =
  !hasResolvedArchive && !getArgValue('--workspace') && (command === 'status' || command === 'doctor' || command === 'handoff' || command === 'continue')
    ? ['--workspace', process.cwd()]
    : []

const res = spawnSync(
  process.execPath,
  ['run', join(scriptRoot, mapped.script), ...(mapped.extraArgs || []), ...extraWorkspaceArgs, ...forwardArgs],
  {
    cwd: runCwd,
    stdio: 'inherit',
    windowsHide: true,
  },
)
process.exit(res.status ?? 0)
