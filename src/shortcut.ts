import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getArgValue, loadConfig, REPO_ROOT } from './config'
import { getChatsyncHomeDir } from './registry'

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
  const cmdPath = join(REPO_ROOT, 'start-antigravity.cmd')
  const cmdContent = [
    '@echo off',
    'title ChatSync Universal Launcher - ' + safeTitle,
    `cd /d "${REPO_ROOT}"`,
    `"${process.execPath}" run src/launch.ts${wsArg}`,
    'if errorlevel 1 pause',
  ].join('\r\n')
  writeFileSync(cmdPath, cmdContent, 'utf8')

  const localIco = join(REPO_ROOT, 'plugin', 'assets', 'logo.ico')
  const globalIco = join(getChatsyncHomeDir(), 'toolkit', 'plugin', 'assets', 'logo.ico')
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const agyExe = join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe')

  const chosenIcon = existsSync(localIco)
    ? localIco
    : existsSync(globalIco)
      ? globalIco
      : existsSync(agyExe)
        ? agyExe
        : ''

  const deskQuery = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
    { encoding: 'utf8', windowsHide: true },
  )
  const desktopDir = String(deskQuery.stdout || '').trim() || join(homedir(), 'Desktop')

  // Remove legacy "(Antigravity).lnk" so only the clean branded "(ChatSync).lnk" sits on Desktop
  const legacyLnkPath = join(desktopDir, `${safeTitle} (Antigravity).lnk`)
  if (existsSync(legacyLnkPath)) {
    try {
      rmSync(legacyLnkPath, { force: true })
    } catch {}
  }

  const lnkPath = join(desktopDir, `${safeTitle} (ChatSync).lnk`)

  const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut('${lnkPath.replace(/'/g, "''")}')
$Shortcut.TargetPath = '${cmdPath.replace(/'/g, "''")}'
$Shortcut.WorkingDirectory = '${REPO_ROOT.replace(/'/g, "''")}'
$Shortcut.WindowStyle = 7
$Shortcut.Description = 'ChatSync: Auto-pull, bridge all AI sidebars, launch project & auto-push on exit'
${chosenIcon ? `$Shortcut.IconLocation = '${chosenIcon.replace(/'/g, "''")},0'` : ''}
$Shortcut.Save()

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ShellIconRefresh {
  [DllImport("shell32.dll")]
  public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
'@ -ErrorAction SilentlyContinue
[ShellIconRefresh]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)
`
  const res = spawnSync('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8', windowsHide: true })
  if (res.status !== 0) {
    console.error('❌ Failed to create Desktop shortcut:', res.stderr)
    process.exit(1)
  }
  console.log(`✅ Created launcher script : ${cmdPath}`)
  console.log(`✅ Created Desktop shortcut: ${lnkPath}`)
  if (chosenIcon) console.log(`🎨 Applied ChatSync Logo   : ${chosenIcon}`)
  console.log('👉 Just double-click that Desktop icon every day — it pulls, bridges all AI sidebars, launches & auto-pushes on exit!')
} else {
  const desktopDir = join(homedir(), 'Desktop')
  const targetDir = existsSync(desktopDir) ? desktopDir : REPO_ROOT
  const ext = process.platform === 'darwin' ? '.command' : '.sh'
  const shPath = join(targetDir, `${safeTitle}-ChatSync${ext}`)
  const shContent = [
    '#!/usr/bin/env bash',
    `cd "${REPO_ROOT}" || exit 1`,
    `"${process.execPath}" run src/launch.ts${wsArg}`,
  ].join('\n')
  writeFileSync(shPath, shContent, 'utf8')
  chmodSync(shPath, 0o755)
  console.log(`✅ Created executable launcher: ${shPath}`)
}
