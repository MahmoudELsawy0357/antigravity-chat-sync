# One-Shot Second Machine Bootstrapper (`SETUP_SECOND_PC.md`)

> **Immediate Execution Instructions for Any AI Agent:**
> The user opened **`{{PROJECT_SLUG}}`** on an additional machine. Execute all steps below automatically without asking the user to run manual commands.

---

## Step-by-Step Playbook

1. **Install Global `chatsync` CLI & Skills + Verify `gh` Auth (`{{GITHUB_USER}}`):**
   - Run `bunx github:MahmoudELsawy0357/chatsync install`
   - Ensure `{{GITHUB_USER}}` is active in GitHub CLI (`gh auth status` / `gh auth switch -u {{GITHUB_USER}}`).
2. **Clone `{{ARCHIVE_REPO}}`:**
   - Clone `https://github.com/{{ARCHIVE_REPO}}.git` into `../{{REPO_NAME}}` next to `<WORKSPACE_PATH>`.
   - Copy `CHATS_SYNC.md` into `<WORKSPACE_PATH>/CHATS_SYNC.md` and ensure `CHATS_SYNC.md`, `SETUP_SECOND_PC.md`, and `.chatsync/` are listed in `<WORKSPACE_PATH>/.git/info/exclude`.
3. **Two-Way Merge (`restore` -> `sync`) & Universal Agent Bridge:**
   - Inside `../{{REPO_NAME}}`, run:
     ```bash
     bun run restore --workspace "<WORKSPACE_PATH>"
     bun run sync --workspace "<WORKSPACE_PATH>"
     bun run autostart --workspace "<WORKSPACE_PATH>"
     chatsync bridge --workspace "<WORKSPACE_PATH>"
     chatsync status --workspace "<WORKSPACE_PATH>"
     ```
4. **Confirm & Finalize:**
   - Report total conversations synced and which AI agents were bridged.
   - If Antigravity 2.x is open, remind the user they can use `bun run shortcut` (Desktop launcher) or `bun run restore --wait` + `File -> Exit` once to refresh sidebar index cache.
