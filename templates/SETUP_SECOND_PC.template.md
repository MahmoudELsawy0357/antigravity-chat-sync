# One-Shot Second Machine Bootstrapper (`SETUP_SECOND_PC.md`)

> **Immediate Execution Instructions for AI Agents (Antigravity, Claude Code, Codex & Cursor):**
> The user opened **`{{PROJECT_SLUG}}`** on an additional machine. Execute all steps below automatically without asking the user to run manual commands.

---

## Step-by-Step Playbook

1. **Verify `bun` & `gh` Auth (`{{GITHUB_USER}}`):**
   - Run `bun --version` and `gh auth status`.
   - Ensure `{{GITHUB_USER}}` is active (`gh auth switch -u {{GITHUB_USER}}`).
2. **Clone `{{ARCHIVE_REPO}}`:**
   - Clone `https://github.com/{{ARCHIVE_REPO}}.git` into `../{{REPO_NAME}}` next to `<WORKSPACE_PATH>`.
3. **Install Global `/chat-sync` Skill & Local Excludes:**
   - Inside `../{{REPO_NAME}}`, run `bun run plugin:install` (installs `/chat-sync` across Antigravity, Claude Code & Codex and registers `{{PROJECT_SLUG}}` in `registry.json`).
   - Copy `CHATS_SYNC.md` into `<WORKSPACE_PATH>/CHATS_SYNC.md` and ensure `CHATS_SYNC.md` and `SETUP_SECOND_PC.md` are listed in `<WORKSPACE_PATH>/.git/info/exclude`.
4. **Two-Way Merge (`restore` -> `sync`) & Multi-Agent Materialization:**
   - Inside `../{{REPO_NAME}}`, run:
     ```bash
     bun run restore --workspace "<WORKSPACE_PATH>"
     bun run sync
     bun run autostart --workspace "<WORKSPACE_PATH>"
     ```
   - For any external AI coding agents installed on this machine (`~/.claude`, `~/.codex`, or `Cursor/User`), materialize all project conversations into them:
     ```bash
     bun run handoff --to codex --workspace "<WORKSPACE_PATH>"
     bun run handoff --to claude --workspace "<WORKSPACE_PATH>"
     bun run handoff --to cursor --workspace "<WORKSPACE_PATH>"
     ```
   - Run `bun run status --workspace "<WORKSPACE_PATH>"`.
5. **Confirm & Finalize:**
   - Report total conversations synced and which agents were populated.
   - If Antigravity 2.x is open, remind the user to run `cd "<ARCHIVE_DIR>" && bun run restore --wait` + `File -> Exit` once to persist `agyhub_summaries_proto.pb`, or `Developer: Reload Window` in VS Code to refresh Codex `Chats`.
