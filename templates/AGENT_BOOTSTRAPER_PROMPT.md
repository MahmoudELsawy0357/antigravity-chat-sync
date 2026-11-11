# ⚡ One-Shot Agent Prompt (Drop into Antigravity on Any Project)

Copy the prompt below, replace `<YOUR_GITHUB_USERNAME>` and `<NEW_PRIVATE_REPO_NAME>`, and send it to **Google Antigravity** inside the project whose conversations you want to archive & sync:

```markdown
Set up a dedicated private conversation archive & multi-device sync repository for this project using the `antigravity-chat-sync` toolkit:
- Personal GitHub Username: <YOUR_GITHUB_USERNAME>
- New Private Archive Repo Name: <NEW_PRIVATE_REPO_NAME>

Steps to execute automatically:
1. Verify `bun --version` and `gh auth status` (switch to `<YOUR_GITHUB_USERNAME>` if needed).
2. Clone the template repo `https://github.com/MahmoudELsawy0357/antigravity-chat-sync.git` into a new folder `<NEW_PRIVATE_REPO_NAME>` (either as a sibling folder `../<NEW_PRIVATE_REPO_NAME>` or in scratch), remove its `.git` folder, and run `git init -b main`.
3. Run:
   `bun run init --project "<current-workspace-folder-name>" --repo "<YOUR_GITHUB_USERNAME>/<NEW_PRIVATE_REPO_NAME>" --workspace "<current-workspace-full-path>" --exclude "<current-conversation-id>"`
4. Run `bun run sync --no-push --exclude "<current-conversation-id>"` followed by `bun run verify` to export Markdown + sanitized compressed SQLite backups and confirm zero secret leaks.
5. Commit everything and create + push the private GitHub repository via:
   `gh repo create <YOUR_GITHUB_USERNAME>/<NEW_PRIVATE_REPO_NAME> --private --source=. --remote=origin --push`
6. Confirm that `CHATS_SYNC.md` and `SETUP_SECOND_PC.md` are installed inside the current project and hidden via `.git/info/exclude` (`git status -s` must remain clean).
```
