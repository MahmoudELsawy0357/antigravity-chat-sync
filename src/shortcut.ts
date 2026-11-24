import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getArgValue, loadConfig, REPO_ROOT } from './config'

const config = loadConfig()
const explicitWs = getArgValue('--workspace')
let targetWorkspacePath: string | null = explicitWs ? resolve(explicitWs) : null
if (!targetWorkspacePath) {
  const sibling = resolve(REPO_ROOT, '..', config.projectSlug)
  if (existsSync(sibling)) targetWorkspacePath = sibling
}

const wsArg = targetWorkspacePath ? ` --workspace "${targetWorkspacePath}"` : ''
const safeTitle = config.projectDisplayName.replace(/[<>:"/\\|?*]+/g, '').trim() || config.projectSlug

if (process.platform === 'win32') {
  // Create a clean launcher .cmd inside the archive repo + a real Desktop .lnk shortcut with Antigravity's icon!
  const cmdPath = join(REPO_ROOT, 'start-antigravity.cmd')
  const cmdContent = [
    '@echo off',
    'title Antigravity Chat Sync Launcher - ' + safeTitle,
    `cd /d "${REPO_ROOT}"`,
    `"${process.execPath}" run src/launch.ts${wsArg}`,
    'if errorlevel 1 pause',
  ].join('\r\n')
  writeFileSync(cmdPath, cmdContent, 'utf8')

  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const agyExe = join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe')

  // Resolve real Windows Desktop folder (supports OneDrive redirected Desktop too!)
  const deskQuery = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
    { encoding: 'utf8' },
  )
  const desktopDir = String(deskQuery.stdout || '').trim() || join(homedir(), 'Desktop')
  const lnkPath = join(desktopDir, `${safeTitle} (Antigravity).lnk`)

  const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut('${lnkPath.replace(/'/g, "''")}')
$Shortcut.TargetPath = '${cmdPath.replace(/'/g, "''")}'
$Shortcut.WorkingDirectory = '${REPO_ROOT.replace(/'/g, "''")}'
$Shortcut.WindowStyle = 7
$Shortcut.Description = 'Auto-restore chats, launch Antigravity, and auto-sync on exit'
if (Test-Path '${agyExe.replace(/'/g, "''")}') {
  $Shortcut.IconLocation = '${agyExe.replace(/'/g, "''")},0'
}
$Shortcut.Save()
`
  const res = spawnSync('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' })
  if (res.status !== 0) {
    console.error('❌ Failed to create Desktop shortcut:', res.stderr)
    process.exit(1)
  }
  console.log(`✅ Created launcher script : ${cmdPath}`)
  console.log(`✅ Created Desktop shortcut: ${lnkPath}`)
  console.log('👉 Just double-click that Desktop icon every day — it auto-restores on open and auto-syncs when you close Antigravity!')
} else {
  const desktopDir = join(homedir(), 'Desktop')
  const targetDir = existsSync(desktopDir) ? desktopDir : REPO_ROOT
  const ext = process.platform === 'darwin' ? '.command' : '.sh'
  const shPath = join(targetDir, `${safeTitle}-Antigravity${ext}`)
  const shContent = [
    '#!/usr/bin/env bash',
    `cd "${REPO_ROOT}" || exit 1`,
    `"${process.execPath}" run src/launch.ts${wsArg}`,
  ].join('\n')
  writeFileSync(shPath, shContent, 'utf8')
  chmodSync(shPath, 0o755)
  console.log(`✅ Created executable launcher: ${shPath}`)
}
