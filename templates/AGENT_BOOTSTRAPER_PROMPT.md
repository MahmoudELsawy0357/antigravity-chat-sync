# Universal One-Shot AI Setup Prompt (Works in Antigravity, Claude Code, Codex & Cursor)

Copy the prompt below, fill in the 3 fields at the top (`GitHub Username`, `Projects`, and `Target AI Agents`), and paste it into **any AI coding agent** (**Google Antigravity**, **Claude Code**, **OpenAI Codex**, or **Cursor**) — on **Machine 1, Machine 2, or Machine 3**:

```markdown
Set up private multi-device, multi-agent conversation archiving & cross-agent sync using `antigravity-chat-sync` (v2.1+):

- Personal GitHub Username: <YOUR_GITHUB_USERNAME>
- Projects to Sync (local project full path -> private archive repo name):
  1. <PROJECT_FULL_PATH> -> <PRIVATE_ARCHIVE_REPO_NAME>
- Target AI Agent(s) to Open/Sync All Chats Into: <antigravity | claude | codex | cursor | all-installed>
- Optional Legacy Folder Names (if renamed previously, otherwise "none"): <LEGACY_SLUGS_OR_NONE>

Execute all steps below automatically without asking me to run manual commands:

1. Preflight & GitHub Auth:
   - Verify `bun --version` and `gh auth status` (if another GitHub account is active, run `gh auth switch -u <YOUR_GITHUB_USERNAME>`).
   - On Windows, if Git HTTPS encounters SSL certificate issues, set `git config --local http.sslBackend schannel` (or `--global`).

2. For EACH project listed above, resolve `<PROJECT_SLUG>` (the folder name of `<PROJECT_FULL_PATH>`) and `<ARCHIVE_DIR>` (sibling folder `<PROJECT_FULL_PATH>/../<PRIVATE_ARCHIVE_REPO_NAME>`):
   - Check whether `<YOUR_GITHUB_USERNAME>/<PRIVATE_ARCHIVE_REPO_NAME>` already exists on GitHub via `gh repo view <YOUR_GITHUB_USERNAME>/<PRIVATE_ARCHIVE_REPO_NAME> --json name`:

   - CASE A — Remote Archive Repo Does NOT Exist Yet (First Machine):
     a. Clone `https://github.com/MahmoudELsawy0357/antigravity-chat-sync.git` into `<ARCHIVE_DIR>`, remove `<ARCHIVE_DIR>/.git`, and run `git init -b main` inside `<ARCHIVE_DIR>`.
     b. Run inside `<ARCHIVE_DIR>`:
        `bun run init --project "<PROJECT_SLUG>" --repo "<YOUR_GITHUB_USERNAME>/<PRIVATE_ARCHIVE_REPO_NAME>" --workspace "<PROJECT_FULL_PATH>"`
        *(Pass `--exclude "<current-conversation-id>"` if running inside a utility setup chat, and add any legacy folder names to `legacyProjectSlugs` in `sync.config.json`.)*
     c. Run `bun run plugin:install` (installs the global `/chat-sync` skill across Antigravity, Claude Code & Codex and registers `<PROJECT_SLUG>` in `registry.json`).
     d. Run `bun run sync --no-push` followed by `bun run verify` (exports & sanitizes sessions across Antigravity, Claude Code, Codex & Cursor and audits for zero secret leaks).
     e. Commit all files and create + push the private repo:
        `git add -A && git commit -m "feat: initialize <PROJECT_SLUG> conversation archive"`
        `gh repo create <YOUR_GITHUB_USERNAME>/<PRIVATE_ARCHIVE_REPO_NAME> --private --source=. --remote=origin --push`

   - CASE B — Remote Archive Repo ALREADY Exists on GitHub (Second / Additional Machine — Two-Way Merge):
     a. Clone `https://github.com/<YOUR_GITHUB_USERNAME>/<PRIVATE_ARCHIVE_REPO_NAME>.git` into `<ARCHIVE_DIR>` (if not already cloned), and pull latest toolkit updates if needed.
     b. Run `bun run plugin:install` inside `<ARCHIVE_DIR>`.
     c. Run `bun run restore --workspace "<PROJECT_FULL_PATH>"` FIRST (restores remote conversations non-destructively without deleting any pre-existing local chats on this machine).
     d. Run `bun run sync` SECOND (collects pre-existing local chats from Antigravity, Claude Code, Codex & Cursor on this machine, merges them with the remote archive, verifies zero secret leaks, and pushes back to GitHub).

3. Materialize All Project Conversations into Target AI Agent(s):
   - Inside `<ARCHIVE_DIR>`, for each requested target agent (`claude`, `codex`, `cursor`), run:
     `bun run handoff --to <agent> --workspace "<PROJECT_FULL_PATH>"`
     *(If `all-installed` was requested, run `handoff` for each of `claude` (`~/.claude`), `codex` (`~/.codex`), and `cursor` (`Cursor/User`) present on this machine. Antigravity is already populated natively via `restore`.)*

4. Enable Background Auto-Sync & Health Check:
   - Run `bun run autostart --workspace "<PROJECT_FULL_PATH>"` (starts the silent 3m-idle / 15m-checkpoint / exit background watcher across all 4 agents).
   - Run `bun run status --workspace "<PROJECT_FULL_PATH>"` and confirm `<PROJECT_FULL_PATH>` has a clean `git status -s`.

5. Report a concise summary:
   - Total conversations synced & pushed to `https://github.com/<YOUR_GITHUB_USERNAME>/<PRIVATE_ARCHIVE_REPO_NAME>`.
   - Which AI agents (`Antigravity`, `Claude Code`, `Codex`, `Cursor`) now have `/chat-sync` and all project conversations ready to open.
   - Note: if Antigravity 2.x was open during `restore`, remind me to run `cd "<ARCHIVE_DIR>" && bun run restore --wait` + `File -> Exit` once to persist sidebar index updates, or `Developer: Reload Window` in VS Code to refresh the Codex `Chats` list.
```
