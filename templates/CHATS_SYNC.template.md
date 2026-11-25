# Daily Universal ChatSync Playbook (`CHATS_SYNC.md`)

> **Quick Usage (Works in ANY AI Agent via `/chatsync` or `chatsync` CLI):**
> - **Bridge all AI agents on this PC (Zero GitHub needed):** `chatsync bridge` or `chatsync to <claude|codex|cursor|windsurf|cline|copilot|universal>`
> - **Push / Sync to GitHub:** `chatsync sync`
> - **Pull / Restore from GitHub:** `chatsync restore`
> - **Check Status / Doctor:** `chatsync status`

---

## Execution Instructions (For AI Agents)

Synchronize or bridge project conversations strictly for **`{{PROJECT_SLUG}}`** (`https://github.com/{{ARCHIVE_REPO}}.git`).

1. **Single-PC Local Agent Bridge (Fastest — No GitHub Needed):**
   - Run `chatsync bridge --workspace "<Active-Workspace-Path>"` (or `chatsync to <target-agent> --workspace "<Active-Workspace-Path>"`).
2. **Multi-PC GitHub Archive Actions (`../{{REPO_NAME}}`):**
   - Verify `gh auth status` (`{{GITHUB_USER}}`).
   - **Check Status:** `chatsync status --workspace "<Active-Workspace-Path>"`
   - **Push / Sync:** `chatsync sync --workspace "<Active-Workspace-Path>"` *(add `--exclude <Current-Conversation-ID>` if opened solely to run sync)*.
   - **Pull / Restore:** `chatsync restore --workspace "<Active-Workspace-Path>"` *(use `--wait` + close/reopen Antigravity 2.x to refresh in-memory sidebar cache)*.
   - **Search Archive:** `chatsync search "<keyword>"`
3. **Never** commit `CHATS_SYNC.md`, `SETUP_SECOND_PC.md`, `.chatsync/`, `.ai-handoff.md`, or `.ai-chats/` to the source code repository (keep them in `.git/info/exclude`).
