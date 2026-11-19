import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface SyncConfig {
  projectSlug: string
  projectDisplayName: string
  legacyProjectSlugs: string[]
  archiveRepo?: string
  maxChunkMB: number
  maxMarkdownPartKB: number
  extraConversationIds: string[]
  excludedConversationIds: string[]
}

export const REPO_ROOT = resolve(import.meta.dir, '..')

export function getAntigravityDir(): string {
  return process.env.AGY_DIR || join(homedir(), '.gemini', 'antigravity')
}

export function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1].trim()
  }
  return undefined
}

export function getAllArgValues(flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) {
      out.push(process.argv[i + 1].trim())
    }
  }
  return out
}

export function loadConfig(): SyncConfig {
  const cfgPath = join(REPO_ROOT, 'sync.config.json')
  let fileCfg: Partial<SyncConfig> = {}
  if (existsSync(cfgPath)) {
    fileCfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  }

  const cliProject = getArgValue('--project')
  const projectSlug = cliProject || fileCfg.projectSlug || ''

  if (!projectSlug) {
    console.error('❌ Missing projectSlug! Create sync.config.json (from sync.config.example.json) or pass --project <folder-name>.')
    process.exit(1)
  }

  const cliExcluded = getAllArgValues('--exclude')

  return {
    projectSlug,
    projectDisplayName: fileCfg.projectDisplayName || projectSlug,
    legacyProjectSlugs: fileCfg.legacyProjectSlugs ?? [],
    archiveRepo: getArgValue('--repo') || fileCfg.archiveRepo,
    maxChunkMB: fileCfg.maxChunkMB ?? 40,
    maxMarkdownPartKB: fileCfg.maxMarkdownPartKB ?? 380,
    extraConversationIds: fileCfg.extraConversationIds ?? [],
    excludedConversationIds: [...new Set([...(fileCfg.excludedConversationIds ?? []), ...cliExcluded])],
  }
}
