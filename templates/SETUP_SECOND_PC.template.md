# 🚀 One-Shot Second Machine Bootstrapper (`SETUP_SECOND_PC.md`)

> **Immediate Execution Instructions for Antigravity AI:**
> The user opened **`{{PROJECT_SLUG}}`** on a new machine. Execute all steps below immediately without asking the user to run manual commands.

---

## 🤖 Step-by-Step Playbook

1. **Verify `bun` & `gh` Auth (`{{GITHUB_USER}}`):**
   - Run `bun --version; gh auth status`.
   - Ensure `{{GITHUB_USER}}` is active (`gh auth switch -u {{GITHUB_USER}}`). If not logged in, ask the user to run `gh auth login`.
2. **Clone `{{ARCHIVE_REPO}}`:**
   - Clone `https://github.com/{{ARCHIVE_REPO}}.git` into `../{{REPO_NAME}}` (sibling to `<DASHBOARD_PATH>`) or `<Artifact Directory Path>/scratch/{{REPO_NAME}}`.
3. **Install Local Playbooks Cleanly:**
   - Copy `CHATS_SYNC.md` from the cloned repo into `<DASHBOARD_PATH>/CHATS_SYNC.md`.
   - Append `CHATS_SYNC.md` and `SETUP_SECOND_PC.md` to `<DASHBOARD_PATH>/.git/info/exclude` (never edit shared `.gitignore`).
4. **Restore & Two-Way Merge:**
   - Inside `<CHATS_REPO_PATH>`, run:
     ```powershell
     bun run restore --workspace "<DASHBOARD_PATH>"
     bun run sync --exclude "<Current-Conversation-ID>"
     ```
5. **Confirm & Reload:**
   - Report how many conversations were imported and ask the user to trigger **`Developer: Reload Window`** (`Ctrl+Shift+P`) so Antigravity refreshes its sidebar list immediately.
