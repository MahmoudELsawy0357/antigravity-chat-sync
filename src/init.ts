import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { getArgValue, REPO_ROOT, type SyncConfig } from './config'

const projectSlug = getArgValue('--project')
const archiveRepo = getArgValue('--repo')
const workspacePath = getArgValue('--workspace')
const excludeId = getArgValue('--exclude')

if (!projectSlug || !archiveRepo) {
  console.log('Usage: bun run init --project <project-folder-slug> --repo <github-user/private-repo-name> [--workspace <path>] [--exclude <conv-id>]')
  process.exit(1)
}

const config: SyncConfig = {
  projectSlug,
  projectDisplayName: getArgValue('--name') || projectSlug,
  legacyProjectSlugs: [],
  archiveRepo,
  maxChunkMB: 40,
  maxMarkdownPartKB: 380,
  extraConversationIds: [],
  excludedConversationIds: excludeId ? [excludeId] : [],
}

writeFileSync(join(REPO_ROOT, 'sync.config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8')
console.log(`✅ Created sync.config.json for project "${projectSlug}" -> https://github.com/${archiveRepo}`)

function renderTemplate(templateName: string): string {
  const raw = readFileSync(join(REPO_ROOT, 'templates', templateName), 'utf8')
  const ghUser = archiveRepo!.split('/')[0] || 'your-github-username'
  const repoName = archiveRepo!.split('/')[1] || `${projectSlug}-chats`
  return raw
    .replaceAll('{{PROJECT_SLUG}}', projectSlug!)
    .replaceAll('{{ARCHIVE_REPO}}', archiveRepo!)
    .replaceAll('{{GITHUB_USER}}', ghUser)
    .replaceAll('{{REPO_NAME}}', repoName)
}

const syncMd = renderTemplate('CHATS_SYNC.template.md')
const setupSecondPcMd = renderTemplate('SETUP_SECOND_PC.template.md')

writeFileSync(join(REPO_ROOT, 'CHATS_SYNC.md'), syncMd, 'utf8')
writeFileSync(join(REPO_ROOT, 'SETUP_SECOND_PC.md'), setupSecondPcMd, 'utf8')
console.log('✅ Generated tailored CHATS_SYNC.md and SETUP_SECOND_PC.md playbooks.')

if (workspacePath && existsSync(resolve(workspacePath))) {
  const ws = resolve(workspacePath)
  writeFileSync(join(ws, 'CHATS_SYNC.md'), syncMd, 'utf8')
  writeFileSync(join(ws, 'SETUP_SECOND_PC.md'), setupSecondPcMd, 'utf8')

  const excludeFile = join(ws, '.git', 'info', 'exclude')
  if (existsSync(join(ws, '.git', 'info'))) {
    const cur = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
    if (!cur.includes('CHATS_SYNC.md')) {
      writeFileSync(
        excludeFile,
        cur.trimEnd() + '\n\n# Local Antigravity chat sync playbooks\nCHATS_SYNC.md\nSETUP_SECOND_PC.md\n',
        'utf8',
      )
    }
  }
  console.log(`✅ Installed CHATS_SYNC.md & SETUP_SECOND_PC.md into ${basename(ws)} (hidden via .git/info/exclude).`)
}
