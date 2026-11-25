import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { getArgValue, REPO_ROOT } from './config'
import { installGlobalPlugin } from './plugin-install'
import { discoverLocalProjectsFromAntigravity, loadRegistry, registerProject } from './registry'

const COPY_ITEMS = [
  '.gitignore',
  'LICENSE.md',
  'README.md',
  'package.json',
  'sync.config.example.json',
  'tsconfig.json',
  'docs',
  'plugin',
  'src',
  'templates',
  'tests',
]

/**
 * Cross-shell interactive line prompter compatible with Windows PowerShell, CMD,
 * Windows Terminal, macOS/Linux PTYs, AND Git Bash / MINGW64 (mintty, where
 * `process.stdin.isTTY` is `undefined`).
 */
function createLinePrompter() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const buffer: string[] = []
  let pendingResolve: ((val: string | null) => void) | null = null
  let closed = false

  rl.on('line', (line) => {
    if (pendingResolve) {
      const r = pendingResolve
      pendingResolve = null
      r(line)
    } else {
      buffer.push(line)
    }
  })

  rl.on('close', () => {
    closed = true
    if (pendingResolve) {
      const r = pendingResolve
      pendingResolve = null
      r(null)
    }
  })

  return {
    async ask(promptText: string): Promise<string> {
      process.stdout.write(promptText)
      if (buffer.length > 0) {
        return buffer.shift()!
      }
      if (closed) {
        console.log('\nSetup cancelled.')
        process.exit(0)
      }
      const line = await new Promise<string | null>((resolvePromise) => {
        pendingResolve = resolvePromise
      })
      if (line === null) {
        console.log('\nSetup cancelled.')
        process.exit(0)
      }
      return line
    },
    close() {
      rl.close()
      process.stdin.pause()
    },
  }
}

function detectGitHubUsername(): string {
  const res = spawnSync('gh', ['api', 'user', '--jq', '.login'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return res.status === 0 ? String(res.stdout || '').trim() : ''
}

function runStep(cmd: string, args: string[], cwd: string): boolean {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  })
  return res.status === 0
}

export async function runBootstrap(): Promise<void> {
  let projectSlug = getArgValue('--project') || ''
  let workspacePath = getArgValue('--workspace') || ''
  let archiveRepo = getArgValue('--repo') || ''
  let targetDir = getArgValue('--target') || ''

  const forceNonInteractive =
    process.argv.includes('--yes') ||
    process.argv.includes('-y') ||
    process.argv.includes('--non-interactive') ||
    process.env.CI === 'true' ||
    Boolean(projectSlug && archiveRepo)

  const discovered = discoverLocalProjectsFromAntigravity()
  const registry = loadRegistry()
  const ghUser = detectGitHubUsername()

  if (!forceNonInteractive) {
    const prompter = createLinePrompter()
    try {
      console.log('\n┌────────────────────────────────────────────────────────────┐')
      console.log('│  antigravity-chat-sync · Interactive Project Setup Wizard  │')
      console.log('└────────────────────────────────────────────────────────────┘')

      if (!projectSlug) {
        if (discovered.length > 0) {
          console.log('\nDetected Google Antigravity projects on this machine:\n')
          discovered.forEach((p, idx) => {
            const numLabel = String(idx + 1).padStart(2, ' ')
            const existing = registry.projects[p.projectSlug.toLowerCase()]
            const badge = existing
              ? `  [synced -> ${existing.archiveRepo || existing.archiveDir}]`
              : ''
            console.log(`  [${numLabel}] ${p.projectSlug.padEnd(28, ' ')} (${p.workspacePath})${badge}`)
          })
          const answer = (
            await prompter.ask(`\nSelect project [1-${discovered.length}] or type folder name (q to quit): `)
          ).trim()
          if (!answer || answer.toLowerCase() === 'q' || answer.toLowerCase() === 'quit') {
            console.log('Setup cancelled.')
            return
          }
          const num = Number(answer)
          if (Number.isInteger(num) && num >= 1 && num <= discovered.length) {
            projectSlug = discovered[num - 1].projectSlug
            workspacePath = discovered[num - 1].workspacePath
          } else {
            projectSlug = answer
          }
        } else {
          projectSlug = (await prompter.ask('\nTarget project folder name (e.g., my-app): ')).trim()
        }
      }

      if (!projectSlug) {
        console.error('Aborted: project folder name is required.')
        process.exit(1)
      }

      if (!workspacePath) {
        const match = discovered.find(d => d.projectSlug.toLowerCase() === projectSlug.toLowerCase())
        const defaultWs = match?.workspacePath || resolve(process.cwd(), projectSlug)
        const wsAns = (await prompter.ask(`Local workspace path [${defaultWs}]: `)).trim()
        workspacePath = wsAns || defaultWs
      }

      const defaultTarget = workspacePath
        ? resolve(workspacePath, '..', `${projectSlug}-chats`)
        : resolve(process.cwd(), `${projectSlug}-chats`)
      if (!targetDir) {
        const tAns = (await prompter.ask(`Local archive directory [${defaultTarget}]: `)).trim()
        targetDir = tAns || defaultTarget
      }

      const defaultRepo = `${ghUser || 'your-github-username'}/${projectSlug}-chats`
      if (!archiveRepo) {
        const rAns = (await prompter.ask(`Private GitHub repository [${defaultRepo}]: `)).trim()
        archiveRepo = rAns || defaultRepo
      }

      const installPluginAns = (
        await prompter.ask('Install global Antigravity /chat-sync plugin? [Y/n]: ')
      ).trim().toLowerCase()
      const enableAutostartAns = (
        await prompter.ask('Enable silent background auto-sync on OS login? [Y/n]: ')
      ).trim().toLowerCase()
      const createRemoteAns = (
        await prompter.ask(`Create & push private GitHub repo (${archiveRepo}) now? [Y/n]: `)
      ).trim().toLowerCase()

      await executeProvisioning({
        projectSlug,
        workspacePath,
        targetDir: resolve(targetDir),
        archiveRepo,
        installPlugin: installPluginAns !== 'n',
        enableAutostart: enableAutostartAns !== 'n',
        pushRemote: createRemoteAns !== 'n',
      })
    } finally {
      prompter.close()
    }
    return
  }

  if (!projectSlug || !archiveRepo) {
    console.log(
      'Usage: bunx github:MahmoudELsawy0357/antigravity-chat-sync setup [--project <slug> --repo <owner/repo> --target <dir> --workspace <path> --push --autostart --install-plugin]',
    )
    process.exit(1)
  }

  if (!workspacePath) {
    const match = discovered.find(d => d.projectSlug.toLowerCase() === projectSlug.toLowerCase())
    if (match) workspacePath = match.workspacePath
  }

  const resolvedTarget = targetDir
    ? resolve(targetDir)
    : workspacePath
      ? resolve(workspacePath, '..', `${projectSlug}-chats`)
      : resolve(process.cwd(), `${projectSlug}-chats`)

  await executeProvisioning({
    projectSlug,
    workspacePath,
    targetDir: resolvedTarget,
    archiveRepo,
    installPlugin: process.argv.includes('--install-plugin') || !process.argv.includes('--no-plugin'),
    enableAutostart: process.argv.includes('--autostart'),
    pushRemote: process.argv.includes('--push'),
  })
}

interface ProvisionOptions {
  projectSlug: string
  workspacePath?: string
  targetDir: string
  archiveRepo: string
  installPlugin: boolean
  enableAutostart: boolean
  pushRemote: boolean
}

async function executeProvisioning(opts: ProvisionOptions): Promise<void> {
  const { projectSlug, workspacePath, targetDir, archiveRepo, installPlugin, enableAutostart, pushRemote } = opts

  mkdirSync(targetDir, { recursive: true })
  if (resolve(targetDir) !== resolve(REPO_ROOT)) {
    for (const item of COPY_ITEMS) {
      const srcPath = join(REPO_ROOT, item)
      if (existsSync(srcPath)) {
        cpSync(srcPath, join(targetDir, item), { recursive: true })
      }
    }
  }

  if (!existsSync(join(targetDir, '.git'))) {
    runStep('git', ['init', '-b', 'main'], targetDir)
    if (process.platform === 'win32') {
      runStep('git', ['config', '--local', 'http.sslBackend', 'schannel'], targetDir)
    }
  }

  const initArgs = ['run', 'src/init.ts', '--project', projectSlug, '--repo', archiveRepo]
  if (workspacePath && existsSync(resolve(workspacePath))) {
    initArgs.push('--workspace', resolve(workspacePath))
  }
  const excludeId = getArgValue('--exclude')
  if (excludeId) {
    initArgs.push('--exclude', excludeId)
  }
  runStep(process.execPath, initArgs, targetDir)

  registerProject({
    projectSlug,
    projectDisplayName: basename(projectSlug),
    archiveDir: targetDir,
    archiveRepo,
    workspacePath: workspacePath && existsSync(resolve(workspacePath)) ? resolve(workspacePath) : undefined,
  })

  if (installPlugin) {
    const pluginPath = installGlobalPlugin(targetDir)
    console.log(`Installed global Antigravity plugin: ${pluginPath}`)
  }

  if (!existsSync(join(targetDir, 'ARCHIVE_INDEX.md'))) {
    writeFileSync(join(targetDir, 'ARCHIVE_INDEX.md'), `# ${projectSlug} Conversation Archive\n`, 'utf8')
  }

  runStep(process.execPath, ['run', 'src/sync.ts', '--no-push'], targetDir)
  const verified = runStep(process.execPath, ['run', 'src/verify.ts'], targetDir)
  if (!verified) {
    console.error('Verification failed — aborting remote push.')
    process.exit(1)
  }

  if (pushRemote) {
    runStep('git', ['add', '-A'], targetDir)
    runStep('git', ['commit', '-m', `feat: initialize ${projectSlug} conversation archive`], targetDir)

    const repoCheck = spawnSync('gh', ['repo', 'view', archiveRepo, '--json', 'name'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (repoCheck.status === 0) {
      runStep('git', ['remote', 'remove', 'origin'], targetDir)
      runStep('git', ['remote', 'add', 'origin', `https://github.com/${archiveRepo}.git`], targetDir)
      runStep('git', ['push', '-u', 'origin', 'main'], targetDir)
    } else {
      runStep(
        'gh',
        ['repo', 'create', archiveRepo, '--private', '--source=.', '--remote=origin', '--push'],
        targetDir,
      )
    }
  }

  if (enableAutostart) {
    runStep(process.execPath, ['run', 'src/autostart.ts'], targetDir)
  }

  console.log('\nSetup complete!')
  console.log(`  Archive Folder : ${targetDir}`)
  console.log(`  GitHub Repo    : https://github.com/${archiveRepo}`)
}

if (import.meta.main) {
  await runBootstrap()
}
