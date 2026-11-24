import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getArgValue, loadConfig, REPO_ROOT } from './config'
import { isLanguageServerRunning } from './protobuf'

const config = loadConfig()
const explicitWs = getArgValue('--workspace')
let targetWorkspacePath: string | null = explicitWs ? resolve(explicitWs) : null
if (!targetWorkspacePath) {
  const sibling = resolve(REPO_ROOT, '..', config.projectSlug)
  if (existsSync(sibling)) targetWorkspacePath = sibling
}

function findAntigravityExecutable(): string | null {
  if (process.env.ANTIGRAVITY_BIN && existsSync(process.env.ANTIGRAVITY_BIN)) {
    return process.env.ANTIGRAVITY_BIN
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const candidates = [
      join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      'C:\\Program Files\\Antigravity\\Antigravity.exe',
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
  } else if (process.platform === 'darwin') {
    const macApp = '/Applications/Antigravity.app/Contents/MacOS/Electron'
    if (existsSync(macApp)) return macApp
  } else {
    const which = spawnSync('which', ['antigravity'], { encoding: 'utf8' })
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim()
  }
  return null
}

const agyExe = findAntigravityExecutable()
if (!agyExe) {
  console.error('❌ Could not locate Antigravity executable. Set ANTIGRAVITY_BIN env var to its path.')
  process.exit(1)
}

const restoreArgs = ['run', join(import.meta.dir, 'restore.ts')]
if (targetWorkspacePath) restoreArgs.push('--workspace', targetWorkspacePath)

// 1. Pull & restore latest conversations while Antigravity is closed
if (!isLanguageServerRunning()) {
  console.log(`\n⬇️ [1/3] Pulling & restoring latest "${config.projectDisplayName}" conversations...`)
  spawnSync(process.execPath, restoreArgs, { cwd: REPO_ROOT, stdio: 'inherit' })
} else {
  console.log('\nℹ️ Antigravity is already running — skipping pre-launch restore.')
}

// 2. Launch Antigravity on the project folder
console.log(`\n🚀 [2/3] Launching Antigravity${targetWorkspacePath ? ` -> ${targetWorkspacePath}` : ''}...`)
const launchArgs = targetWorkspacePath ? [targetWorkspacePath] : []
const child = spawn(agyExe, launchArgs, {
  detached: true,
  stdio: 'ignore',
})
child.unref()

// Wait up to 25 seconds for language_server to spin up
for (let i = 0; i < 50; i++) {
  if (isLanguageServerRunning()) break
  await Bun.sleep(500)
}

if (!isLanguageServerRunning()) {
  console.warn('⚠️ Could not detect language_server startup; exiting launcher without auto-sync.')
  process.exit(0)
}

console.log('🟢 Antigravity is open! Keep working normally — as soon as you close Antigravity, your chats will auto-sync to GitHub.')

// Poll lightly every 2 seconds until Antigravity (language_server) closes completely
while (isLanguageServerRunning()) {
  await Bun.sleep(2000)
}

// Wait briefly for SQLite WAL & final summary flush to settle
await Bun.sleep(1000)

// 3. Auto-sync conversations back to GitHub
console.log(`\n⬆️ [3/3] Antigravity closed! Auto-syncing "${config.projectDisplayName}" conversations to GitHub...`)
const syncRes = spawnSync(process.execPath, ['run', join(import.meta.dir, 'sync.ts')], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
})
if (syncRes.status === 0) {
  spawnSync(process.execPath, ['run', join(import.meta.dir, 'verify.ts')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
}
console.log('✅ All done! Have a great day.')
