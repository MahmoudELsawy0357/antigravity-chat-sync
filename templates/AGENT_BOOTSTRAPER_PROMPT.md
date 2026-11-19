# ⚡ One-Shot Agent Prompt (Drop into Antigravity on Any Project)

Copy the prompt below, replace `<YOUR_GITHUB_USERNAME>` and `<NEW_PRIVATE_REPO_NAME>`, and send it to **Google Antigravity** inside the project whose conversations you want to archive & sync:

```markdown
Set up a dedicated private conversation archive & multi-device sync repository for this project using the `antigravity-chat-sync` toolkit (Antigravity 2.x compatible):
- Personal GitHub Username: <YOUR_GITHUB_USERNAME>
- New Private Archive Repo Name: <NEW_PRIVATE_REPO_NAME>
- Optional Previous/Legacy Folder Names (if this repo was ever renamed, otherwise ignore): <LEGACY_SLUGS_OR_NONE>

Steps to execute automatically:
1. Verify `bun --version` and `gh auth status` (switch to `<YOUR_GITHUB_USERNAME>` via `gh auth switch -u <YOUR_GITHUB_USERNAME>` if another account is active).
2. Clone the template repo `https://github.com/MahmoudELsawy0357/antigravity-chat-sync.git` into a new folder `<NEW_PRIVATE_REPO_NAME>` (prefer sibling folder `../<NEW_PRIVATE_REPO_NAME>` next to the current workspace, otherwise `<Artifact Directory Path>/scratch/<NEW_PRIVATE_REPO_NAME>`), remove its `.git` folder, and run `git init -b main`.
3. Run:
   `bun run init --project "<current-workspace-folder-name>" --repo "<YOUR_GITHUB_USERNAME>/<NEW_PRIVATE_REPO_NAME>" --workspace "<current-workspace-full-path>" --exclude "<current-conversation-id>"`
   *(If any legacy/previous folder names were provided above, add them to `legacyProjectSlugs` in `sync.config.json`.)*
4. Run the export, audit, and health check sequence:
   - `bun run sync --no-push --exclude "<current-conversation-id>"` (captures SQLite WAL frames, `annotations/`, `chapter_titles/`, redacts secrets in Markdown + binary Protobuf blobs, and generates paginated Markdown)
   - `bun run verify` (audits single `.gz` and multi-part `.gz.partNN` archives for zero secret leaks & file-size limits)
   - `bun test` (verifies Protobuf remapping, secret redaction, and multi-part verification)
   - `bun run status` (confirms local Antigravity 2.x `project_id` health and synced conversation counts)
5. Commit everything and create + push the private GitHub repository via:
   `gh repo create <YOUR_GITHUB_USERNAME>/<NEW_PRIVATE_REPO_NAME> --private --source=. --remote=origin --push`
6. Confirm concisely to the user:
   - How many conversations were archived and pushed to `https://github.com/<YOUR_GITHUB_USERNAME>/<NEW_PRIVATE_REPO_NAME>`.
   - That `CHATS_SYNC.md` and `SETUP_SECOND_PC.md` are installed inside the project root and hidden via `.git/info/exclude` (verify `git status -s` stays clean).
   - How to use `@CHATS_SYNC.md` daily (`sync`, `status`, or `restore --wait`) and how to bootstrap a second PC by dropping `SETUP_SECOND_PC.md` into Antigravity there.
```
