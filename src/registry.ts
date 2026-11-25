import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export interface RegisteredProject {
  projectSlug: string
  projectDisplayName: string
  archiveDir: string
  archiveRepo?: string
  workspacePath?: string
  updatedAt: string
}

export interface SyncRegistry {
  version: 1
  projects: Record<string, RegisteredProject>
}

export interface DiscoveredAgyProject {
  projectId: string
  projectSlug: string
  workspacePath: string
}

export function getRegistryPath(): string {
  return process.env.AGY_SYNC_REGISTRY || join(homedir(), '.gemini', 'antigravity-chat-sync', 'registry.json')
}

export function loadRegistry(): SyncRegistry {
  const regPath = getRegistryPath()
  if (!existsSync(regPath)) {
    return { version: 1, projects: {} }
  }
  try {
    const parsed = JSON.parse(readFileSync(regPath, 'utf8'))
    if (parsed && typeof parsed.projects === 'object') {
      return { version: 1, projects: parsed.projects }
    }
  } catch {}
  return { version: 1, projects: {} }
}

export function saveRegistry(reg: SyncRegistry): void {
  const regPath = getRegistryPath()
  mkdirSync(resolve(regPath, '..'), { recursive: true })
  writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n', 'utf8')
}

export function registerProject(entry: Omit<RegisteredProject, 'updatedAt'>): RegisteredProject {
  const reg = loadRegistry()
  const key = entry.projectSlug.toLowerCase()
  const saved: RegisteredProject = {
    ...entry,
    archiveDir: resolve(entry.archiveDir),
    workspacePath: entry.workspacePath ? resolve(entry.workspacePath) : reg.projects[key]?.workspacePath,
    updatedAt: new Date().toISOString(),
  }
  reg.projects[key] = saved
  saveRegistry(reg)
  return saved
}

export function findRegisteredProject(slugOrPath: string): RegisteredProject | undefined {
  const reg = loadRegistry()
  const norm = slugOrPath.trim().toLowerCase()
  if (reg.projects[norm]) return reg.projects[norm]

  const resolvedTarget = resolve(slugOrPath).toLowerCase()
  const targetBase = basename(resolvedTarget).toLowerCase()
  if (reg.projects[targetBase]) return reg.projects[targetBase]

  for (const item of Object.values(reg.projects)) {
    if (item.workspacePath && resolve(item.workspacePath).toLowerCase() === resolvedTarget) {
      return item
    }
    if (resolve(item.archiveDir).toLowerCase() === resolvedTarget) {
      return item
    }
  }
  return undefined
}

function fileUriToLocalPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  try {
    let decoded = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''))
    if (process.platform === 'win32') {
      decoded = decoded.replace(/\//g, '\\')
    } else if (!decoded.startsWith('/')) {
      decoded = '/' + decoded
    }
    return resolve(decoded)
  } catch {
    return null
  }
}

export function discoverLocalProjectsFromAntigravity(): DiscoveredAgyProject[] {
  const configProjectsDir = join(homedir(), '.gemini', 'config', 'projects')
  if (!existsSync(configProjectsDir)) return []

  const results: DiscoveredAgyProject[] = []
  const seenSlugs = new Set<string>()

  for (const file of readdirSync(configProjectsDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const fullPath = join(configProjectsDir, file)
      const json = JSON.parse(readFileSync(fullPath, 'utf8'))
      const projectId = json.projectId || file.replace(/\.json$/, '')
      const resources = json?.projectResources?.resources
      if (!Array.isArray(resources)) continue

      for (const res of resources) {
        const uri = res?.gitFolder?.folderUri || res?.folderUri
        if (!uri || typeof uri !== 'string') continue
        const localPath = fileUriToLocalPath(uri)
        if (!localPath || !existsSync(localPath)) continue
        const slug = basename(localPath)
        const key = slug.toLowerCase()
        if (seenSlugs.has(key)) continue
        seenSlugs.add(key)
        results.push({
          projectId,
          projectSlug: slug,
          workspacePath: localPath,
        })
      }
    } catch {}
  }

  return results.sort((a, b) => a.projectSlug.localeCompare(b.projectSlug))
}
