# Daily Multi-Agent Chat Sync Playbook (`CHATS_SYNC.md`)

> **Quick Usage (Antigravity, Claude Code, Codex & Cursor):**
> Use `/chat-sync` (installed globally via `bun run plugin:install`) or tag `@CHATS_SYNC.md` and ask:
> - **"Push / sync chats"** -> Exports & pushes new `{{PROJECT_SLUG}}` sessions from Antigravity, Claude Code, Codex & Cursor.
> - **"Pull / restore chats"** -> Downloads missing or newer sessions from GitHub into this machine.
> - **"Sync chats to claude / codex / cursor"** -> Materializes all project conversations into the target AI coding agent.
> - **"Check sync status / doctor"** -> Shows installed agents, background daemon state, and local vs. archived step counts.

---

## Execution Instructions (For AI Agents)

Synchronize project conversations strictly for **`{{PROJECT_SLUG}}`** via `https://github.com/{{ARCHIVE_REPO}}.git`.

1. **Verify GitHub Auth (`{{GITHUB_USER}}`):**
   Run `gh auth status` and switch to `{{GITHUB_USER}}` (`gh auth switch -u {{GITHUB_USER}}`) if needed.
2. **Locate Archive Directory:**
   Use `../{{REPO_NAME}}` next to `{{PROJECT_SLUG}}` (or look up `{{PROJECT_SLUG}}` in `~/.gemini/antigravity-chat-sync/registry.json`).
3. **Run Requested Action inside `{{REPO_NAME}}`:**
   - **Check Status / Doctor:** `bun run status --workspace "<Active-Workspace-Path>"`.
   - **Push / Sync:** `bun run sync` *(add `--exclude <Current-Conversation-ID>` if this chat was opened solely to run sync)*.
   - **Pull / Restore:** `bun run restore --workspace "<Active-Workspace-Path>"`.
     - *(In Antigravity 2.x, remind the user to run `cd "<ARCHIVE_DIR>" && bun run restore --wait` + `File -> Exit` to persist in-memory `agyhub_summaries_proto.pb` sidebar updates).*
   - **Cross-Agent Handoff (All Project Chats):** `bun run handoff --to <claude|codex|cursor|antigravity> --workspace "<Active-Workspace-Path>"`.
   - **Search Archive:** `bun run search "<keyword>"`.
4. **Never** commit `CHATS_SYNC.md`, `SETUP_SECOND_PC.md`, `.ai-handoff.md`, or `.ai-chats/` to the source code repository (keep them in `.git/info/exclude`).
