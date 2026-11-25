import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getArgValue, loadConfig, REPO_ROOT } from './config'
import { isPidAlive } from './protobuf'

const config = loadConfig()
const isRemove = process.argv.includes('--remove') || process.argv.includes('--stop')
const explicitWs = getArgValue('--workspace')
let targetWorkspacePath: string | null = explicitWs ? resolve(explicitWs) : null
if (!targetWorkspacePath) {
  const sibling = resolve(REPO_ROOT, '..', config.projectSlug)
  if (existsSync(sibling)) targetWorkspacePath = sibling
}

const safeSlug = config.projectSlug.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'project'
const lockPath = join(REPO_ROOT, '.daemon.lock')

function getStartupFilePath(): string {
  if (process.platform === 'win32') {
    const res = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Startup')"],
      { encoding: 'utf8', windowsHide: true },
    )
    const startupDir =
      String(res.stdout || '').trim() ||
      join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    return join(startupDir, `antigravity-chatsync-${safeSlug}.vbs`)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'LaunchAgents', `com.antigravity.chatsync.${safeSlug}.plist`)
  }
  return join(homedir(), '.config', 'autostart', `antigravity-chatsync-${safeSlug}.desktop`)
}

function stopRunningDaemon() {
  if (!existsSync(lockPath)) return false
  try {
    const info = JSON.parse(readFileSync(lockPath, 'utf8'))
    const pid = Number(info?.pid)
    if (pid && isPidAlive(pid)) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      } else {
        process.kill(pid, 'SIGTERM')
      }
      rmSync(lockPath, { force: true })
      return true
    }
  } catch {}
  rmSync(lockPath, { force: true })
  return false
}

const startupFile = getStartupFilePath()

if (isRemove) {
  const stopped = stopRunningDaemon()
  if (process.platform === 'darwin' && existsSync(startupFile)) {
    spawnSync('launchctl', ['unload', startupFile])
  }
  if (existsSync(startupFile)) {
    rmSync(startupFile, { force: true })
  }
  console.log(`🛑 Removed OS autostart (${startupFile})${stopped ? ' and stopped running background daemon.' : '.'}`)
  process.exit(0)
}

if (process.platform === 'win32') {
  const wsPart = targetWorkspacePath ? ` --workspace ""${targetWorkspacePath}""` : ''
  const vbsLines = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.CurrentDirectory = "${REPO_ROOT}"`,
    `WshShell.Run """${process.execPath}"" run src/daemon.ts${wsPart}", 0, False`,
  ]
  writeFileSync(startupFile, vbsLines.join('\r\n') + '\r\n', 'utf8')
  console.log(`✅ Installed silent Windows Startup watcher: ${startupFile}`)

  stopRunningDaemon()
  // Spawn via WMI Win32_Process.Create so the daemon lives outside any parent IDE/Job Object!
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'wscript.exe "${startupFile}"' } | Out-Null`,
    ],
    { windowsHide: true },
  )
  await Bun.sleep(1000)
  if (existsSync(lockPath)) {
    const info = JSON.parse(readFileSync(lockPath, 'utf8'))
    console.log(`🟢 Background auto-sync daemon is now running silently (PID ${info.pid})!`)
  }
} else if (process.platform === 'darwin') {
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  const argsXml = [
    `<string>${process.execPath}</string>`,
    '<string>run</string>',
    `<string>${join(REPO_ROOT, 'src', 'daemon.ts')}</string>`,
    ...(targetWorkspacePath ? ['<string>--workspace</string>', `<string>${targetWorkspacePath}</string>`] : []),
  ].join('\n      ')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.antigravity.chatsync.${safeSlug}</string>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>ProgramArguments</key>
  <array>
      ${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`
  writeFileSync(startupFile, plist, 'utf8')
  spawnSync('launchctl', ['unload', startupFile])
  spawnSync('launchctl', ['load', startupFile])
  console.log(`✅ Installed and started macOS LaunchAgent: ${startupFile}`)
} else {
  mkdirSync(join(homedir(), '.config', 'autostart'), { recursive: true })
  const wsArg = targetWorkspacePath ? ` --workspace "${targetWorkspacePath}"` : ''
  const desktopEntry = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=Antigravity Chat Sync (${config.projectDisplayName})`,
    `Path=${REPO_ROOT}`,
    `Exec="${process.execPath}" run src/daemon.ts${wsArg}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
  ].join('\n')
  writeFileSync(startupFile, desktopEntry + '\n', 'utf8')
  stopRunningDaemon()
  const child = spawn(process.execPath, ['run', join(REPO_ROOT, 'src', 'daemon.ts'), ...(targetWorkspacePath ? ['--workspace', targetWorkspacePath] : [])], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  console.log(`✅ Installed Linux autostart entry and launched background daemon: ${startupFile}`)
}
