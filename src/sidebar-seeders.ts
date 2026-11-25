import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { NormalizedTurn } from './agents'
import { getAntigravityDir } from './config'
import {
  createProjectAdapter,
  encodeLenDelim,
  encodeVarint,
  ensureLocalProjectId,
  patchAgyhubSummariesProto,
  toWorkspaceUris,
} from './protobuf'

export const SIDEBAR_MIRROR_TAG = 'chatsync-sidebar-mirror'

function deriveSidebarUuid(namespace: string, sourceId: string, timeMs = Date.now()): string {
  const hash = createHash('sha256').update(`${namespace}:${sourceId}`).digest()
  const bytes = Buffer.alloc(16)
  const ts = BigInt(Math.max(0, Math.floor(timeMs)))
  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)
  hash.copy(bytes, 6, 0, 10)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function pairTurns(turns: NormalizedTurn[]): Array<{ user: string; assistant: string }> {
  const pairs: Array<{ user: string; assistant: string }> = []
  let pendingUser = ''
  for (const t of turns) {
    const clean = t.text.trim()
    if (!clean) continue
    if (t.role === 'user') {
      pendingUser = pendingUser ? `${pendingUser}\n\n${clean}` : clean
    } else if (pendingUser) {
      pairs.push({ user: pendingUser, assistant: clean })
      pendingUser = ''
    } else if (pairs.length > 0) {
      pairs[pairs.length - 1].assistant += `\n\n${clean}`
    } else {
      pairs.push({ user: '(Continued session)', assistant: clean })
    }
  }
  if (pendingUser) {
    pairs.push({ user: pendingUser, assistant: 'Ready to continue.' })
  }
  return pairs
}

function toVsCodeFolderUri(workspacePath: string): {
  resolvedWs: string
  encodedFolderUri: string
  vscodePath: string
} {
  const resolvedWs = resolve(workspacePath)
  if (process.platform === 'win32') {
    const m = resolvedWs.match(/^([a-zA-Z]):(.*)$/)
    if (m) {
      const driveLower = m[1].toLowerCase()
      const rest = m[2].replace(/\\/g, '/')
      return {
        resolvedWs,
        encodedFolderUri: `file:///${driveLower}%3A${rest}`,
        vscodePath: `/${driveLower}:${rest}`,
      }
    }
  }
  const clean = resolvedWs.replace(/\\/g, '/')
  return {
    resolvedWs,
    encodedFolderUri: `file://${clean}`,
    vscodePath: clean,
  }
}

function ensureIdeWorkspaceStorageDir(ideUserDir: string, workspacePath: string): {
  workspaceHash: string
  wsDir: string
  stateDbPath: string
  encodedFolderUri: string
  vscodePath: string
  resolvedWs: string
} {
  const { resolvedWs, encodedFolderUri, vscodePath } = toVsCodeFolderUri(workspacePath)
  const wsStorageRoot = join(ideUserDir, 'workspaceStorage')
  mkdirSync(wsStorageRoot, { recursive: true })

  const normTarget = resolvedWs.toLowerCase().replace(/\\/g, '/')

  for (const entry of readdirSync(wsStorageRoot)) {
    const full = join(wsStorageRoot, entry)
    try {
      if (!statSync(full).isDirectory()) continue
      const wjPath = join(full, 'workspace.json')
      if (!existsSync(wjPath)) continue
      const wj = JSON.parse(readFileSync(wjPath, 'utf8'))
      const rawUri = String(wj.folder || wj.workspace || '')
      let dec = rawUri
      try {
        dec = decodeURIComponent(rawUri)
      } catch {}
      const cleanUri = dec.replace(/^file:\/\/\/?/i, '').toLowerCase().replace(/\\/g, '/')
      if (cleanUri === normTarget || cleanUri === normTarget.replace(/^\//, '')) {
        const stateDbPath = join(full, 'state.vscdb')
        initItemTableDb(stateDbPath)
        return { workspaceHash: entry, wsDir: full, stateDbPath, encodedFolderUri, vscodePath, resolvedWs }
      }
    } catch {}
  }

  // Create deterministic workspaceStorage folder if the IDE hasn't opened this folder yet
  const workspaceHash = createHash('md5').update(normTarget).digest('hex')
  const wsDir = join(wsStorageRoot, workspaceHash)
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ folder: encodedFolderUri }, null, 2) + '\n', 'utf8')
  const stateDbPath = join(wsDir, 'state.vscdb')
  initItemTableDb(stateDbPath)
  return { workspaceHash, wsDir, stateDbPath, encodedFolderUri, vscodePath, resolvedWs }
}

function initItemTableDb(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);')
  db.close()
}

function encodeProtoTimestamp(ms: number): Buffer {
  const secs = BigInt(Math.floor(ms / 1000))
  const nanos = Math.floor((ms % 1000) * 1_000_000)
  return Buffer.concat([
    Buffer.from([0x08]),
    encodeVarint(secs),
    ...(nanos > 0 ? [Buffer.from([0x10]), encodeVarint(nanos)] : []),
  ])
}

// ── 1. CURSOR NATIVE SIDEBAR INJECTOR (Composer / Agent Sidebar) ──────────────

export function seedCursorSidebarConversation(opts: {
  sourceId: string
  workspacePath: string
  title: string
  updatedAt: string
  turns: NormalizedTurn[]
  cursorUserDir?: string
}): { composerId: string; stateDbPath: string; bubbleCount: number } {
  const appData =
    process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : join(homedir(), '.config')
  const cursorUserDir = opts.cursorUserDir || process.env.CURSOR_USER_DIR || join(appData, 'Cursor', 'User')

  const parsedDate = new Date(opts.updatedAt.includes('T') ? opts.updatedAt : `${opts.updatedAt.replace(' ', 'T')}Z`)
  const updatedMs = Number.isNaN(parsedDate.getTime()) ? Date.now() : parsedDate.getTime()
  const pairs = pairTurns(opts.turns)
  const createdMs = Math.max(1_700_000_000_000, updatedMs - pairs.length * 5000)
  const composerId = deriveSidebarUuid('cursor-composer', opts.sourceId, createdMs)

  const wsInfo = ensureIdeWorkspaceStorageDir(cursorUserDir, opts.workspacePath)
  const globalDir = join(cursorUserDir, 'globalStorage')
  mkdirSync(globalDir, { recursive: true })
  const globalDbPath = join(globalDir, 'state.vscdb')

  const workspaceIdentifier = {
    id: wsInfo.workspaceHash,
    uri: {
      $mid: 1,
      fsPath: wsInfo.resolvedWs,
      ...(process.platform === 'win32' ? { _sep: 1 } : {}),
      external: wsInfo.encodedFolderUri,
      path: wsInfo.vscodePath,
      scheme: 'file',
    },
  }

  const headers: Array<{ bubbleId: string; type: 1 | 2 }> = []
  const bubbleRows: Array<{ key: string; value: string }> = []

  pairs.forEach((pair, idx) => {
    const stepMs = createdMs + idx * 2000
    const userBubbleId = deriveSidebarUuid(`cursor-b-u:${opts.sourceId}`, String(idx), stepMs)
    const aiBubbleId = deriveSidebarUuid(`cursor-b-a:${opts.sourceId}`, String(idx), stepMs + 1000)

    headers.push({ bubbleId: userBubbleId, type: 1 })
    headers.push({ bubbleId: aiBubbleId, type: 2 })

    bubbleRows.push({
      key: `bubbleId:${composerId}:${userBubbleId}`,
      value: JSON.stringify({
        _v: 3,
        type: 1,
        bubbleId: userBubbleId,
        text: pair.user,
        richText: '',
        createdAt: new Date(stepMs).toISOString(),
        isAgentic: true,
      }),
    })
    bubbleRows.push({
      key: `bubbleId:${composerId}:${aiBubbleId}`,
      value: JSON.stringify({
        _v: 3,
        type: 2,
        bubbleId: aiBubbleId,
        text: pair.assistant,
        richText: '',
        createdAt: new Date(stepMs + 1000).toISOString(),
        isAgentic: true,
      }),
    })
  })

  const chunkCount = Math.max(1, Math.ceil(headers.length / 256))
  const subtitle = pairs[pairs.length - 1]?.user.replace(/\s+/g, ' ').trim().slice(0, 90) || opts.title

  const headEntry = {
    type: 'head',
    composerId,
    name: opts.title,
    createdAt: createdMs,
    lastUpdatedAt: updatedMs,
    unifiedMode: 'agent',
    forceMode: 'edit',
    hasUnreadMessages: false,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    isArchived: false,
    isWorktree: false,
    isSpec: false,
    isDraft: false,
    isProject: false,
    hasBlockingPendingActions: false,
    hasPendingPlan: false,
    referencedPlans: [],
    numSubComposers: 0,
    trackedGitRepos: [],
    subtitle,
    workspaceIdentifier,
  }

  const composerDataJson = JSON.stringify({
    _v: 18,
    composerId,
    name: opts.title,
    subtitle,
    richText: '',
    hasLoaded: true,
    text: '',
    fullConversationHeadersOnly: headers,
    headerLog: {
      chunkSize: 256,
      chunkCount,
      count: headers.length,
      generation: composerId,
    },
    conversationMap: {},
    status: 'none',
    context: {
      notepads: [],
      composers: [],
      quotes: [],
      selectedCommits: [],
      selectedPullRequests: [],
      selectedImages: [],
      folderSelections: [],
      fileSelections: [],
      selections: [],
      terminalSelections: [],
      selectedDocs: [],
      externalLinks: [],
      cursorRules: [],
      cursorCommands: [],
      uiElementSelections: [],
      consoleLogs: [],
      mentions: {},
    },
    generatingBubbleIds: [],
    codeBlockData: {},
    originalFileStates: {},
    newlyCreatedFiles: [],
    newlyCreatedFolders: [],
    createdAt: createdMs,
    lastUpdatedAt: updatedMs,
    hasChangedContext: false,
    capabilities: [],
    isFileListExpanded: false,
    unifiedMode: 'agent',
    forceMode: 'edit',
    isAgentic: true,
    isDraft: false,
    usageData: {},
    allAttachedFileCodeChunksUris: [],
    modelConfig: { modelName: 'default', maxMode: false },
    subComposerIds: [],
    subagentComposerIds: [],
    capabilityContexts: [],
    todos: [],
    isQueueExpanded: true,
    hasUnreadMessages: false,
    gitHubPromptDismissed: true,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    workspaceIdentifier,
    chatsyncMirrorCount: headers.length,
  })

  // 1. Write to Cursor globalStorage/state.vscdb (`cursorDiskKV` + `composerHeaders`)
  const gdb = new Database(globalDbPath)
  gdb.exec('PRAGMA busy_timeout = 5000;')
  gdb.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);')
  gdb.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);')
  gdb.exec(
    'CREATE TABLE IF NOT EXISTS composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, subagentTypeName TEXT, value TEXT);',
  )

  gdb.transaction(() => {
    const putKv = gdb.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)')
    for (const b of bubbleRows) {
      putKv.run(b.key, b.value)
    }
    for (let cIdx = 0; cIdx < chunkCount; cIdx++) {
      const slice = headers.slice(cIdx * 256, (cIdx + 1) * 256)
      putKv.run(`composerConvHeaders:${composerId}:${String(cIdx).padStart(6, '0')}`, JSON.stringify(slice))
    }
    putKv.run(`composerData:${composerId}`, composerDataJson)
    putKv.finalize()

    gdb
      .query(
        `INSERT OR REPLACE INTO composerHeaders (
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, subagentTypeName, value
        ) VALUES (?, ?, ?, ?, 0, 0, ?, NULL, '', ?)`,
      )
      .run(composerId, wsInfo.workspaceHash, createdMs, updatedMs, updatedMs, JSON.stringify(headEntry))
  })()
  gdb.close()

  // 2. Write to Cursor workspaceStorage/<hash>/state.vscdb (`composer.composerData`)
  const wdb = new Database(wsInfo.stateDbPath)
  wdb.exec('PRAGMA busy_timeout = 5000;')
  const existingRow = wdb.query("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as
    | { value: string | Uint8Array }
    | null
  let wsData: any = {
    allComposers: [],
    selectedComposerIds: [],
    lastFocusedComposerIds: [],
    hasMigratedComposerData: true,
    hasMigratedMultipleComposers: true,
  }
  if (existingRow?.value) {
    try {
      const str = typeof existingRow.value === 'string' ? existingRow.value : Buffer.from(existingRow.value).toString('utf8')
      const parsed = JSON.parse(str)
      if (parsed && Array.isArray(parsed.allComposers)) wsData = parsed
    } catch {}
  }

  wsData.allComposers = (wsData.allComposers as any[]).filter(c => c?.composerId !== composerId)
  wsData.allComposers.unshift(headEntry)
  if (!Array.isArray(wsData.selectedComposerIds) || wsData.selectedComposerIds.length === 0) {
    wsData.selectedComposerIds = [composerId]
  }
  wdb
    .query("INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('composer.composerData', ?)")
    .run(JSON.stringify(wsData))
  wdb.close()

  return { composerId, stateDbPath: wsInfo.stateDbPath, bubbleCount: headers.length }
}

// ── 2. VS CODE COPILOT CHAT & WINDSURF NATIVE SIDEBAR INJECTOR ────────────────

export function seedVsCodeChatSidebarConversation(opts: {
  sourceId: string
  workspacePath: string
  title: string
  updatedAt: string
  turns: NormalizedTurn[]
  ideUserDir: string
  responderLabel?: string
}): { sessionId: string; sessionFilePath: string; requestCount: number } {
  const parsedDate = new Date(opts.updatedAt.includes('T') ? opts.updatedAt : `${opts.updatedAt.replace(' ', 'T')}Z`)
  const updatedMs = Number.isNaN(parsedDate.getTime()) ? Date.now() : parsedDate.getTime()
  const pairs = pairTurns(opts.turns)
  const createdMs = Math.max(1_700_000_000_000, updatedMs - pairs.length * 4000)
  const sessionId = deriveSidebarUuid('vscode-chat', opts.sourceId, createdMs)
  const responder = opts.responderLabel || 'GitHub Copilot'

  const wsInfo = ensureIdeWorkspaceStorageDir(opts.ideUserDir, opts.workspacePath)
  const chatSessionsDir = join(wsInfo.wsDir, 'chatSessions')
  mkdirSync(chatSessionsDir, { recursive: true })

  const requests = pairs.map((pair, idx) => {
    const reqMs = createdMs + idx * 2000
    const reqUuid = deriveSidebarUuid(`vscode-req:${opts.sourceId}`, String(idx), reqMs)
    const respUuid = deriveSidebarUuid(`vscode-resp:${opts.sourceId}`, String(idx), reqMs + 500)
    const lines = pair.user.split(/\r?\n/)
    return {
      requestId: `request_${reqUuid}`,
      timestamp: reqMs,
      agent: {
        extensionId: { value: 'GitHub.copilot-chat', _lower: 'github.copilot-chat' },
        publisherDisplayName: 'GitHub',
        extensionPublisherId: 'GitHub',
        extensionDisplayName: 'GitHub Copilot Chat',
        id: 'github.copilot.editsAgent',
        name: 'agent',
        fullName: responder,
        isDefault: true,
        locations: ['panel'],
        modes: ['agent'],
        slashCommands: [],
        disambiguation: [],
      },
      responseId: `response_${respUuid}`,
      modelState: { value: 1, completedAt: reqMs + 800 },
      contentReferences: [],
      codeCitations: [],
      timeSpentWaiting: 0,
      message: {
        text: pair.user,
        parts: [
          {
            range: { start: 0, endExclusive: pair.user.length },
            editorRange: {
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: Math.max(1, lines.length),
              endColumn: (lines[lines.length - 1]?.length || 0) + 1,
            },
            text: pair.user,
            kind: 'text',
          },
        ],
      },
      response: [
        {
          value: pair.assistant,
          supportThemeIcons: false,
          supportHtml: false,
        },
      ],
      variableData: { variables: [] },
    }
  })

  const rootObj = {
    kind: 0,
    v: {
      version: 3,
      creationDate: createdMs,
      customTitle: opts.title,
      initialLocation: 'panel',
      responderUsername: responder,
      sessionId,
      hasPendingEdits: false,
      chatsyncMirrorCount: requests.length,
      requests,
      pendingRequests: [],
      inputState: {
        attachments: [],
        mode: { id: 'agent', kind: 'agent' },
        inputText: '',
        selections: [],
      },
    },
  }

  const sessionFilePath = join(chatSessionsDir, `${sessionId}.jsonl`)
  writeFileSync(sessionFilePath, JSON.stringify(rootObj) + '\n', 'utf8')

  const sdb = new Database(wsInfo.stateDbPath)
  sdb.exec('PRAGMA busy_timeout = 5000;')
  const idxRow = sdb.query("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'").get() as
    | { value: string | Uint8Array }
    | null
  let indexObj: { version: number; entries: Record<string, any> } = { version: 1, entries: {} }
  if (idxRow?.value) {
    try {
      const rawStr = typeof idxRow.value === 'string' ? idxRow.value : Buffer.from(idxRow.value).toString('utf8')
      const parsed = JSON.parse(rawStr)
      if (parsed && typeof parsed.entries === 'object') indexObj = parsed
    } catch {}
  }

  indexObj.entries[sessionId] = {
    sessionId,
    title: opts.title,
    lastMessageDate: updatedMs,
    timing: {
      created: createdMs,
      lastRequestStarted: updatedMs,
      lastRequestEnded: updatedMs + 100,
    },
    initialLocation: 'panel',
    hasPendingEdits: false,
    isEmpty: false,
    isExternal: false,
    lastResponseState: 1,
  }

  sdb
    .query("INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('chat.ChatSessionStore.index', ?)")
    .run(JSON.stringify(indexObj))
  sdb.close()

  return { sessionId, sessionFilePath, requestCount: requests.length }
}

// ── 3. CLINE & ROO CODE NATIVE SIDEBAR INJECTOR (`History` Panel) ─────────────

export function seedClineFamilySidebarConversation(opts: {
  sourceId: string
  workspacePath: string
  title: string
  updatedAt: string
  turns: NormalizedTurn[]
  variant: 'cline' | 'roocode'
  ideUserDir: string
}): { taskId: string; taskDir: string; messageCount: number } {
  const extId = opts.variant === 'roocode' ? 'rooveterinaryinc.roo-cline' : 'saoudrizwan.claude-dev'
  const parsedDate = new Date(opts.updatedAt.includes('T') ? opts.updatedAt : `${opts.updatedAt.replace(' ', 'T')}Z`)
  const updatedMs = Number.isNaN(parsedDate.getTime()) ? Date.now() : parsedDate.getTime()
  const resolvedWs = resolve(opts.workspacePath)

  // Deterministic numeric-style taskId so Cline/Roo sorts chronologically without duplicating
  const hashNum = createHash('sha256').update(`${extId}:${opts.sourceId}`).digest().readUInt32BE(0) % 9000
  const taskId = String(Math.floor(updatedMs / 10000) * 10000 + hashNum)

  const globalDir = join(opts.ideUserDir, 'globalStorage')
  const taskDir = join(globalDir, extId, 'tasks', taskId)
  mkdirSync(taskDir, { recursive: true })

  const pairs = pairTurns(opts.turns)
  const uiMessages: any[] = []
  const apiMessages: any[] = []

  pairs.forEach((pair, idx) => {
    const ts = updatedMs - (pairs.length - idx) * 2000
    uiMessages.push({
      ts,
      type: 'say',
      say: idx === 0 ? 'task' : 'user_feedback',
      text: pair.user,
    })
    uiMessages.push({
      ts: ts + 800,
      type: 'say',
      say: 'text',
      text: pair.assistant,
      ...(idx === pairs.length - 1 ? { chatsyncMirror: true } : {}),
    })
    apiMessages.push({ role: 'user', content: [{ type: 'text', text: pair.user }] })
    apiMessages.push({ role: 'assistant', content: [{ type: 'text', text: pair.assistant }] })
  })

  writeFileSync(join(taskDir, 'ui_messages.json'), JSON.stringify(uiMessages, null, 2), 'utf8')
  writeFileSync(join(taskDir, 'api_conversation_history.json'), JSON.stringify(apiMessages, null, 2), 'utf8')

  const globalDbPath = join(globalDir, 'state.vscdb')
  initItemTableDb(globalDbPath)
  const gdb = new Database(globalDbPath)
  gdb.exec('PRAGMA busy_timeout = 5000;')
  const row = gdb.query('SELECT value FROM ItemTable WHERE key = ?').get(extId) as { value: string | Uint8Array } | null
  let extState: Record<string, any> = {}
  if (row?.value) {
    try {
      const s = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8')
      extState = JSON.parse(s) || {}
    } catch {}
  }

  const history: any[] = Array.isArray(extState.taskHistory) ? extState.taskHistory : []
  const filtered = history.filter(h => String(h?.id) !== taskId)
  filtered.push({
    id: taskId,
    number: filtered.length + 1,
    ts: updatedMs,
    task: opts.title,
    tokensIn: 0,
    tokensOut: 0,
    cacheWrites: 0,
    cacheReads: 0,
    totalCost: 0,
    cwdOnTaskInitialization: resolvedWs,
    workspace: resolvedWs,
    chatsyncMirror: true,
  })
  filtered.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
  extState.taskHistory = filtered

  gdb.query('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(extId, JSON.stringify(extState))
  gdb.close()

  return { taskId, taskDir, messageCount: uiMessages.length }
}

// ── 4. GOOGLE ANTIGRAVITY NATIVE SIDEBAR INJECTOR (External -> Antigravity) ───

export function seedAntigravitySidebarConversation(opts: {
  sourceId: string
  workspacePath: string
  title: string
  updatedAt: string
  turns: NormalizedTurn[]
  agyDir?: string
}): { conversationId: string; dbPath: string; stepCount: number } {
  const agyDir = opts.agyDir || getAntigravityDir()
  const convsDir = join(agyDir, 'conversations')
  mkdirSync(convsDir, { recursive: true })

  const parsedDate = new Date(opts.updatedAt.includes('T') ? opts.updatedAt : `${opts.updatedAt.replace(' ', 'T')}Z`)
  const updatedMs = Number.isNaN(parsedDate.getTime()) ? Date.now() : parsedDate.getTime()
  const pairs = pairTurns(opts.turns)
  const createdMs = Math.max(1_700_000_000_000, updatedMs - pairs.length * 4000)
  const updatedIso = new Date(updatedMs).toISOString()

  const conversationId = deriveSidebarUuid('antigravity-conv', opts.sourceId, createdMs)
  const trajectoryId = deriveSidebarUuid('antigravity-traj', opts.sourceId, createdMs)
  const wsUris = toWorkspaceUris(opts.workspacePath)
  const projectSlug = basename(resolve(opts.workspacePath))
  const ensured = ensureLocalProjectId(agyDir, resolve(opts.workspacePath), wsUris, projectSlug)
  const localProjectId = ensured.projectId || 'outside-of-project'

  const dbPath = join(convsDir, `${conversationId}.db`)
  const cdb = new Database(dbPath)
  cdb.exec('PRAGMA busy_timeout = 5000;')
  cdb.exec(`
    CREATE TABLE IF NOT EXISTS trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id));
    CREATE TABLE IF NOT EXISTS steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
    CREATE TABLE IF NOT EXISTS gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
    CREATE TABLE IF NOT EXISTS executor_metadata (idx integer, data blob, PRIMARY KEY (idx));
    CREATE TABLE IF NOT EXISTS parent_references (idx integer, data blob, PRIMARY KEY (idx));
    CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id));
    CREATE TABLE IF NOT EXISTS battle_mode_infos (idx integer, data blob, PRIMARY KEY (idx));
  `)

  const wsInfoProto = Buffer.concat([
    encodeLenDelim(1, Buffer.from(wsUris.plainUri, 'utf8')),
    encodeLenDelim(2, Buffer.from(wsUris.plainUri, 'utf8')),
  ])
  const trajMetaBlob = Buffer.concat([
    encodeLenDelim(1, wsInfoProto),
    encodeLenDelim(2, encodeProtoTimestamp(createdMs)),
    encodeLenDelim(3, Buffer.from(trajectoryId, 'utf8')),
    encodeLenDelim(6, Buffer.from(conversationId, 'utf8')),
    encodeLenDelim(7, Buffer.from(wsUris.encodedUri, 'utf8')),
    encodeLenDelim(18, Buffer.from(localProjectId, 'utf8')),
  ])

  const brainLogsDir = join(agyDir, 'brain', conversationId, '.system_generated', 'logs')
  mkdirSync(brainLogsDir, { recursive: true })
  const jsonlLines: string[] = []

  const userOffsets: Array<[number, number]> = []
  const agentOffsets: Array<[number, number]> = []
  let userBodyBuf = Buffer.alloc(0)
  let agentBodyBuf = Buffer.alloc(0)

  cdb.transaction(() => {
    cdb.exec('DELETE FROM steps; DELETE FROM trajectory_meta; DELETE FROM trajectory_metadata_blob;')
    cdb
      .query('INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, 4, 1)')
      .run(trajectoryId, conversationId)
    cdb.query('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', trajMetaBlob)

    const insertStep = cdb.prepare(
      'INSERT INTO steps (idx, step_type, status, has_subtrajectory, metadata, step_payload, step_format) VALUES (?, ?, 3, 0, ?, ?, 0)',
    )

    let stepIdx = 0
    for (const pair of pairs) {
      const uMs = createdMs + stepIdx * 1000
      const uIso = new Date(uMs).toISOString()
      const uStepMeta = Buffer.concat([
        encodeLenDelim(1, encodeProtoTimestamp(uMs)),
        Buffer.from([0x18, 0x04]),
        encodeLenDelim(
          20,
          Buffer.concat([
            encodeLenDelim(1, Buffer.from(trajectoryId, 'utf8')),
            ...(stepIdx > 0 ? [Buffer.from([0x10]), encodeVarint(stepIdx)] : []),
            encodeLenDelim(4, Buffer.from(conversationId, 'utf8')),
          ]),
        ),
      ])
      const uBuf = Buffer.from(pair.user, 'utf8')
      const uPayload = Buffer.concat([
        Buffer.from([0x08, 0x01, 0x20, 0x01]),
        encodeLenDelim(5, uStepMeta),
        encodeLenDelim(
          19,
          Buffer.concat([
            encodeLenDelim(2, uBuf),
            encodeLenDelim(3, encodeLenDelim(1, uBuf)),
          ]),
        ),
      ])
      insertStep.run(stepIdx, 14, uStepMeta, uPayload)
      userOffsets.push([stepIdx, userBodyBuf.byteLength])
      userBodyBuf = Buffer.concat([userBodyBuf, Buffer.from(pair.user + '\n', 'utf8')])
      jsonlLines.push(
        JSON.stringify({
          step_index: stepIdx,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: uIso,
          content: pair.user,
        }),
      )
      stepIdx++

      const aMs = uMs + 500
      const aIso = new Date(aMs).toISOString()
      const aStepMeta = Buffer.concat([
        encodeLenDelim(1, encodeProtoTimestamp(aMs)),
        Buffer.from([0x18, 0x02]),
        encodeLenDelim(
          20,
          Buffer.concat([
            encodeLenDelim(1, Buffer.from(trajectoryId, 'utf8')),
            Buffer.from([0x10]),
            encodeVarint(stepIdx),
            encodeLenDelim(4, Buffer.from(conversationId, 'utf8')),
          ]),
        ),
      ])
      const aBuf = Buffer.from(pair.assistant, 'utf8')
      const aPayload = Buffer.concat([
        Buffer.from([0x08, 0x01, 0x20, 0x01]),
        encodeLenDelim(5, aStepMeta),
        encodeLenDelim(
          20,
          Buffer.concat([
            encodeLenDelim(1, aBuf),
            encodeLenDelim(8, aBuf),
          ]),
        ),
      ])
      insertStep.run(stepIdx, 15, aStepMeta, aPayload)
      agentOffsets.push([stepIdx, agentBodyBuf.byteLength])
      agentBodyBuf = Buffer.concat([agentBodyBuf, Buffer.from(pair.assistant + '\n', 'utf8')])
      jsonlLines.push(
        JSON.stringify({
          step_index: stepIdx,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: aIso,
          content: pair.assistant,
        }),
      )
      stepIdx++
    }
    insertStep.finalize()
  })()
  cdb.close()

  const transcriptContent = jsonlLines.join('\n') + '\n'
  writeFileSync(join(brainLogsDir, 'transcript.jsonl'), transcriptContent, 'utf8')
  writeFileSync(join(brainLogsDir, 'transcript_full.jsonl'), transcriptContent, 'utf8')

  const totalSteps = pairs.length * 2
  const rawSummary = Buffer.concat([
    encodeLenDelim(1, Buffer.from(opts.title, 'utf8')),
    Buffer.from([0x10]),
    encodeVarint(totalSteps),
    encodeLenDelim(3, encodeProtoTimestamp(updatedMs)),
    encodeLenDelim(4, Buffer.from(trajectoryId, 'utf8')),
    Buffer.from([0x28, 0x01]),
    encodeLenDelim(7, encodeProtoTimestamp(createdMs)),
    encodeLenDelim(9, wsInfoProto),
    encodeLenDelim(10, encodeProtoTimestamp(updatedMs)),
    Buffer.from([0x80, 0x01, 0x08]),
    encodeLenDelim(
      17,
      Buffer.concat([
        encodeLenDelim(1, wsInfoProto),
        encodeLenDelim(2, encodeProtoTimestamp(createdMs)),
        encodeLenDelim(3, Buffer.from(trajectoryId, 'utf8')),
        encodeLenDelim(6, Buffer.from(conversationId, 'utf8')),
        encodeLenDelim(7, Buffer.from(wsUris.encodedUri, 'utf8')),
        encodeLenDelim(18, Buffer.from(localProjectId, 'utf8')),
      ]),
    ),
    Buffer.from([0xb0, 0x01, 0x04, 0xe0, 0x01, 0x04]),
  ])

  const sumDbPath = join(agyDir, 'conversation_summaries.db')
  const sdb = new Database(sumDbPath)
  sdb.exec('PRAGMA busy_timeout = 5000;')
  sdb.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id text, title text NOT NULL DEFAULT "", preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL,
      status text NOT NULL DEFAULT "", source text NOT NULL DEFAULT "", project_id text NOT NULL DEFAULT "",
      agent_name text NOT NULL DEFAULT "", parent_conversation_id text NOT NULL DEFAULT "",
      nesting_depth integer NOT NULL DEFAULT 0, battle_id text NOT NULL DEFAULT "",
      winning_conversation_id text NOT NULL DEFAULT "", not_fully_idle numeric NOT NULL DEFAULT false,
      killed numeric NOT NULL DEFAULT false, last_user_input_time datetime NOT NULL,
      last_user_input_step_index integer NOT NULL DEFAULT -1, app_data_dir text NOT NULL DEFAULT "",
      raw_summary blob, group_id text NOT NULL DEFAULT "", PRIMARY KEY (conversation_id)
    );
  `)
  const preview = pairs[0]?.user.replace(/\s+/g, ' ').trim().slice(0, 140) || opts.title
  sdb
    .query(
      `INSERT OR REPLACE INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
        status, source, project_id, agent_name, parent_conversation_id, nesting_depth,
        last_user_input_time, last_user_input_step_index, raw_summary
      ) VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, '', '', 0, ?, ?, ?)`,
    )
    .run(
      conversationId,
      opts.title,
      preview,
      totalSteps,
      updatedIso,
      JSON.stringify([wsUris.encodedUri]),
      `chatsync-mirror:${totalSteps}`,
      localProjectId,
      updatedIso,
      Math.max(0, totalSteps - 2),
      rawSummary,
    )

  try {
    sdb.query('DELETE FROM conversations_fts WHERE conversation_id = ?').run(conversationId)
    sdb
      .query(
        `INSERT INTO conversations_fts (
          conversation_id, chunk_index, chunk_first_step, chunk_last_step, last_modified_time,
          step_count, last_step_created_at, archived, user_step_byte_offsets, agent_step_byte_offsets,
          title, workspace, project, user_body, agent_body
        ) VALUES (?, 0, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversationId,
        Math.max(0, totalSteps - 1),
        updatedIso,
        totalSteps,
        updatedIso,
        JSON.stringify(userOffsets),
        JSON.stringify(agentOffsets),
        opts.title,
        wsUris.encodedUri,
        localProjectId,
        userBodyBuf.toString('utf8'),
        agentBodyBuf.toString('utf8'),
      )
  } catch {}
  sdb.close()

  const adapter = createProjectAdapter({
    projectSlug,
    legacyProjectSlugs: [],
    targetUris: wsUris,
    localProjectId,
  })
  patchAgyhubSummariesProto({
    agyDir,
    adaptedRawById: new Map([[conversationId, rawSummary]]),
    remoteStepsById: new Map([[conversationId, totalSteps]]),
    adapter,
  })

  return { conversationId, dbPath, stepCount: totalSteps }
}

// ── 5. GEMINI CLI NATIVE `/chat resume` INJECTOR ──────────────────────────────

export function seedGeminiCliSidebarConversation(opts: {
  sourceId: string
  workspacePath: string
  title: string
  updatedAt: string
  turns: NormalizedTurn[]
  geminiDir?: string
}): { filePath: string; messageCount: number } {
  const geminiRoot = opts.geminiDir || process.env.GEMINI_CLI_HOME || join(homedir(), '.gemini')
  const resolvedWs = resolve(opts.workspacePath)
  const projHash = createHash('sha256').update(resolvedWs).digest('hex')
  const chatsDir = join(geminiRoot, 'tmp', projHash, 'chats')
  mkdirSync(chatsDir, { recursive: true })

  const safeTag = opts.title
    .toLowerCase()
    .replace(/[^\w\u0600-\u06FF-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || opts.sourceId.slice(0, 8)
  const filePath = join(chatsDir, `session-${safeTag}-${opts.sourceId.slice(0, 8)}.json`)

  const messages = opts.turns.map(t => ({
    role: t.role === 'user' ? 'user' : 'model',
    parts: [{ text: t.text }],
    timestamp: t.timestamp || opts.updatedAt,
  }))

  writeFileSync(
    filePath,
    JSON.stringify(
      {
        sessionId: deriveSidebarUuid('gemini-cli', opts.sourceId),
        projectPath: resolvedWs,
        title: opts.title,
        updatedAt: opts.updatedAt,
        chatsyncMirrorCount: messages.length,
        messages,
      },
      null,
      2,
    ),
    'utf8',
  )
  return { filePath, messageCount: messages.length }
}
