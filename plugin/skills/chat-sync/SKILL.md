---
name: chat-sync
description: >-
  Synchronize, back up, restore, inspect, search, or hand off project-scoped AI
  coding conversations across Google Antigravity, Claude Code, OpenAI Codex,
  and Cursor via a private GitHub repository. Activate whenever the user
  invokes /chat-sync or asks to push/sync chats ("ارفع المحادثات", "sync
  chats"), pull/restore chats ("نزل المحادثات", "restore chats"), continue or
  hand off work across agents ("كمل آخر جلسة", "handoff to claude/codex/cursor",
  "/chat-sync continue"), check sync status ("فحص الحالة"), search archived
  chats, split misplaced messages into a clean chat, or onboard a new project.
---

# Universal AI Chat Sync (`chat-sync` v2.0)

Synchronize, search, and hand off project-scoped engineering sessions seamlessly across **Google Antigravity**, **Claude Code**, **OpenAI Codex**, and **Cursor** via a private GitHub repository.

## Step 1: Locate the Active Workspace's Archive Directory

Determine the active workspace path (`<WORKSPACE_PATH>`) and its folder name (`<PROJECT_SLUG>`).

Check these locations in order:
1. **Local Registry:** `~/.gemini/antigravity-chat-sync/registry.json` (`projects["<project_slug_lowercase>"].archiveDir`).
2. **Sibling Convention:** `<WORKSPACE_PATH>/../<PROJECT_SLUG>-chats/sync.config.json`.

- **If found:** Use that directory as `<ARCHIVE_DIR>`.
- **If NOT found:** Follow **Workflow F (Onboard Project or Second Machine)**.

---

## Step 2: Execute the Requested Workflow

### Workflow A — Push / Sync Conversations Across All Installed Agents (`sync`)
Collects matching project sessions from Antigravity, Claude Code, Codex, and Cursor, redacts secrets, builds chronological Markdown + `ARCHIVE_INDEX.md`, verifies zero leaks, and pushes to GitHub:
```bash
cd "<ARCHIVE_DIR>" && bun run sync
```
*(Pass `--exclude <CONVERSATION_ID>` if the current chat was opened solely to trigger sync).*

### Workflow B — Pull / Restore Conversations (`restore`)
Restores missing or newer conversations into Antigravity, Claude Code, and Codex on the current machine:
```bash
cd "<ARCHIVE_DIR>" && bun run restore --workspace "<WORKSPACE_PATH>"
```
*(In Antigravity 2.x, remind the user that `bun run restore --wait` + `File -> Exit` finalizes in-memory `agyhub_summaries_proto.pb` sidebar updates).*

### Workflow C — Cross-Agent Session Handoff (`handoff` / `continue`)
When the user worked in one AI agent (e.g., Antigravity on PC 1) and wants to continue seamlessly in another AI agent (e.g., Claude Code, Codex, Cursor, or Antigravity on PC 2):
1. First pull the latest remote archive if needed:
   ```bash
   cd "<ARCHIVE_DIR>" && git pull --rebase
   ```
2. Run the handoff generator targeting the desired agent (`antigravity` | `claude` | `codex` | `cursor` | `markdown`):
   ```bash
   cd "<ARCHIVE_DIR>" && bun run handoff --to <target-agent> --workspace "<WORKSPACE_PATH>"
   ```
   *(Optionally pass `--id <conv-id>` to hand off a specific session instead of the latest one).*
3. If the user is **already inside** Claude Code, Codex, or Cursor and asks *"continue where I left off on the other machine"*, read the newest `conversations/*/conversation.md` (or latest `part-NN.md`) from `<ARCHIVE_DIR>` directly, summarize the latest state in 3–5 bullet points, and continue working immediately!

### Workflow D — Multi-Agent Status & Health Doctor (`status`)
```bash
cd "<ARCHIVE_DIR>" && bun run status --workspace "<WORKSPACE_PATH>"
```
Reports detected local agents (`Antigravity · Claude Code · Codex · Cursor`), auto-sync daemon PID, and per-session sync status across all 4 agents.

### Workflow E — Search Archived Conversations (`search`)
```bash
cd "<ARCHIVE_DIR>" && bun run search "<KEYWORD>"
```
Present matching hits with clickable `conversation://<id>` links (for Antigravity) and relative transcript paths.

### Workflow F — Onboard a New Project or Second Machine
```bash
bunx github:MahmoudELsawy0357/antigravity-chat-sync setup --project "<PROJECT_SLUG>" --repo "<gh-user>/<PROJECT_SLUG>-chats" --workspace "<WORKSPACE_PATH>" --push --autostart --install-plugin
```

---

## Guardrails
- Never commit chat archive files or `.ai-handoff.md` into the team's source code repository (keep local handoff files in `.git/info/exclude`).
- Never bypass `src/redact.ts` or `src/verify.ts` before pushing archives.
- Match the user's language (Arabic or English) concisely.
