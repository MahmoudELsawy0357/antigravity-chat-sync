---
name: chat-sync
description: >-
  Synchronize, back up, restore, inspect, search, or split project-scoped
  Google Antigravity conversations across multiple machines via a private
  GitHub repository. Activate whenever the user invokes /chat-sync or asks to
  push/sync conversations ("ارفع المحادثات", "sync chats"), pull/restore
  conversations ("نزل المحادثات", "restore chats"), run a two-way sync ("اربط
  كله ببعضه"), check sync or auto-sync daemon status ("فحص الحالة", "sync
  status"), search archived chats, split/move misplaced messages into a clean
  conversation, or set up chat sync for a new project or second machine.
---

# Antigravity Chat Sync (`chat-sync`)

Manage multi-device synchronization and private GitHub archiving strictly for the active workspace's **Google Antigravity** conversations without mixing unrelated projects or leaking credentials.

## Step 1: Locate the Active Workspace's Archive Directory

Determine the active workspace path (`<WORKSPACE_PATH>`) and its folder name (`<PROJECT_SLUG>`) from `<user_information>`.

Check these locations in order:
1. **Local Registry:** `~/.gemini/antigravity-chat-sync/registry.json` (`projects["<project_slug_lowercase>"].archiveDir`).
2. **Sibling Convention:** `<WORKSPACE_PATH>/../<PROJECT_SLUG>-chats/sync.config.json` (or `<WORKSPACE_PATH>/../althabit-chats` if matching `projectSlug` inside `sync.config.json`).

- **If found:** Use that directory as `<ARCHIVE_DIR>`.
- **If NOT found (new project or new machine):** Go to **Workflow F (Onboard Project or Second Machine)** below.

---

## Step 2: Execute the Requested Workflow

### Workflow A — Push / Sync Local Conversations (`sync`)
1. Verify GitHub CLI auth (`gh auth status`) matches the owner of `archiveRepo` in `<ARCHIVE_DIR>/sync.config.json` (run `gh auth switch -u <owner>` if another account is active).
2. Decide whether to exclude the current conversation (`<CONVERSATION_ID>` from `<user_information>`):
   - If this conversation was opened **solely** to run a sync command, pass `--exclude <CONVERSATION_ID>`.
   - If this conversation contains real project engineering work the user wants archived, **omit** `--exclude`.
3. Run inside `<ARCHIVE_DIR>`:
   ```bash
   bun run sync
   ```
   *(or `bun run sync --exclude <CONVERSATION_ID>` for utility chats).*

### Workflow B — Pull / Restore Conversations (`restore`)
1. Run inside `<ARCHIVE_DIR>`:
   ```bash
   bun run restore --workspace "<WORKSPACE_PATH>"
   ```
2. Remind the user concisely: while Antigravity 2.x is open, `language_server` caches `agyhub_summaries_proto.pb` in RAM. To finalize sidebar index rebinding with zero race condition, run `cd "<ARCHIVE_DIR>" && bun run restore --wait` in an external terminal and exit Antigravity (`File -> Exit`), then reopen it.

### Workflow C — Full Two-Way Sync
1. Run `bun run restore --workspace "<WORKSPACE_PATH>"` inside `<ARCHIVE_DIR>`.
2. Run `bun run sync` (with `--exclude <CONVERSATION_ID>` if utility-only) inside `<ARCHIVE_DIR>`.

### Workflow D — Status, Health Doctor & Auto-Sync Daemon Check (`status`)
- Run inside `<ARCHIVE_DIR>`:
  ```bash
  bun run status --workspace "<WORKSPACE_PATH>"
  ```
- Summarize local vs. archived step counts, `project_id` health, and whether the background auto-sync daemon (`bun run autostart`) is active.

### Workflow E — Search Archived Conversations (`search`)
- Run inside `<ARCHIVE_DIR>`:
  ```bash
  bun run search "<KEYWORD>"
  ```
- Present matching conversations to the user using clickable Antigravity links: `[<Title>](conversation://<conversation-id>)`.

### Workflow F — Onboard a New Project or Second Machine
- **Existing remote archive on a second machine:**
  1. Clone `https://github.com/<owner>/<archive-repo>.git` into `<WORKSPACE_PATH>/../<PROJECT_SLUG>-chats`.
  2. Run `bun run plugin:install` (to register in `registry.json`) and `bun run autostart` inside that folder.
  3. Follow **Workflow B** (`restore`).
- **Brand-new project archive:**
  1. Ask the user to confirm the desired private GitHub repo name (`<gh-user>/<PROJECT_SLUG>-chats`).
  2. Run the cached toolkit bootstrapper (or via `bunx`):
     ```bash
     bunx github:MahmoudELsawy0357/antigravity-chat-sync setup --project "<PROJECT_SLUG>" --repo "<gh-user>/<PROJECT_SLUG>-chats" --workspace "<WORKSPACE_PATH>" --exclude "<CONVERSATION_ID>" --push --autostart --install-plugin
     ```

### Workflow G — Split Misplaced Project Work into a Clean Conversation
When the user accidentally wrote project tasks inside a sync-utility or unrelated conversation and asks to move them:
1. Build a structured summary of the completed work, commits, and modified files.
2. Call `POST http://$ANTIGRAVITY_LS_ADDRESS/product.v1.ConversationService/CreateConversation` (with headers `Content-Type: application/json; charset=utf-8`, `Connect-Protocol-Version: 1`, and `x-antigravity-csrf-token: $ANTIGRAVITY_CSRF_TOKEN`), passing `"projectId": "$ANTIGRAVITY_PROJECT_ID"`, a clear `"title"`, and `"prompt": [{"text": "<summary + instruction to acknowledge briefly without running tools>"}]`.
3. Wait until `GetConversation` reports `RUN_STATE_IDLE`, run `bun run sync` in `<ARCHIVE_DIR>` if desired, and return `[<Title>](conversation://<new-id>)` to the user.

---

## Guardrails
- Never commit chat archive files or sync configs into the project's source code repository.
- Never bypass `src/redact.ts` or `src/verify.ts` when pushing conversation archives.
- Match the user's language (Arabic or English) concisely in all responses.
