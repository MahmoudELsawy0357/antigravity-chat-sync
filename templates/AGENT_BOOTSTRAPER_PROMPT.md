# Universal One-Shot AI Setup Prompt (`chatsync` v3.0)

> **Want Single-PC Agent Bridging ONLY (no GitHub)?** You don't even need this prompt! Just run:
> `bunx github:MahmoudELsawy0357/chatsync install` and then `chatsync bridge` inside any project!

If you want **Multi-PC Private GitHub Backup + Universal Agent Bridging**, paste the prompt below into **any AI coding agent** (**Antigravity**, **Claude Code**, **Codex**, **Cursor**, **Windsurf**, **Cline**, etc.):

```markdown
Set up universal AI conversation bridging & private multi-PC sync using `chatsync` (v3.0+):

- Personal GitHub Username: <YOUR_GITHUB_USERNAME>
- Projects to Sync (local project full path -> private archive repo name):
  1. <PROJECT_FULL_PATH> -> <PRIVATE_ARCHIVE_REPO_NAME>
- Target AI Agent(s) to Bridge Into: <all | antigravity | claude | codex | cursor | windsurf | cline | universal>

Execute all steps automatically without asking me to run manual commands:

1. Install Global `chatsync` CLI & Universal Skills in One Line:
   - Run `bunx github:MahmoudELsawy0357/chatsync install`
   - Verify `gh auth status` (`gh auth switch -u <YOUR_GITHUB_USERNAME>` if needed).

2. For EACH project (`<PROJECT_SLUG>` = folder name of `<PROJECT_FULL_PATH>`, `<ARCHIVE_DIR>` = `<PROJECT_FULL_PATH>/../<PRIVATE_ARCHIVE_REPO_NAME>`):
   - Check if `<YOUR_GITHUB_USERNAME>/<PRIVATE_ARCHIVE_REPO_NAME>` already exists on GitHub (`gh repo view <YOUR_GITHUB_USERNAME>/<PRIVATE_ARCHIVE_REPO_NAME> --json name`):
   - If NEW (Machine 1):
     `chatsync setup --project "<PROJECT_SLUG>" --repo "<YOUR_GITHUB_USERNAME>/<PRIVATE_ARCHIVE_REPO_NAME>" --target "<ARCHIVE_DIR>" --workspace "<PROJECT_FULL_PATH>" --push --autostart --yes`
   - If EXISTING (Machine 2+ — Two-Way Merge):
     Clone `https://github.com/<YOUR_GITHUB_USERNAME>/<PRIVATE_ARCHIVE_REPO_NAME>.git` into `<ARCHIVE_DIR>`, then inside `<ARCHIVE_DIR>` run:
     `bun run restore --workspace "<PROJECT_FULL_PATH>"`
     `bun run sync --workspace "<PROJECT_FULL_PATH>"`
     `bun run autostart --workspace "<PROJECT_FULL_PATH>"`

3. Bridge Sessions Across Local AI Agents:
   - Run `chatsync bridge --workspace "<PROJECT_FULL_PATH>"` (or `chatsync to <target-agent> --workspace "<PROJECT_FULL_PATH>"`).
   - Run `chatsync status --workspace "<PROJECT_FULL_PATH>"` and confirm `<PROJECT_FULL_PATH>` has a clean `git status -s`.
```
