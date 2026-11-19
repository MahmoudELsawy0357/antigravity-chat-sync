# 🤖 Daily Antigravity Chat Sync Playbook (`CHATS_SYNC.md`)

> **Quick Usage:**
> Tag `@CHATS_SYNC.md` in Google Antigravity chat and tell the agent one of:
> - **"Push / sync chats"** -> Uploads new or updated `{{PROJECT_SLUG}}` chats to GitHub.
> - **"Pull / restore chats"** -> Downloads missing or newer chats from GitHub into this PC's Antigravity.
> - **"Full two-way sync"** -> Pulls remote updates first, then pushes local updates.
> - **"Check sync status / doctor"** -> Shows local vs archive step counts and checks Antigravity 2.x `project_id` health.

---

## 🛠️ Execution Instructions (For Antigravity AI)

Synchronize Google Antigravity conversations strictly for **`{{PROJECT_SLUG}}`** via the private GitHub repository `https://github.com/{{ARCHIVE_REPO}}.git`.

1. **Verify GitHub Auth (`{{GITHUB_USER}}`):**
   Run `gh auth status` and switch to `{{GITHUB_USER}}` (`gh auth switch -u {{GITHUB_USER}}`) if needed.
2. **Locate or Clone Archive Repo:**
   Use `../{{REPO_NAME}}` next to `{{PROJECT_SLUG}}` if present; otherwise clone `https://github.com/{{ARCHIVE_REPO}}.git` into `<Artifact Directory Path>/scratch/{{REPO_NAME}}`.
3. **Run Requested Action inside `{{REPO_NAME}}`:**
   - **Check Status / Doctor:** `bun run status --workspace "<Active-Workspace-Path-of-{{PROJECT_SLUG}}>"`.
   - **Push / Sync:** `bun run sync --exclude <Current-Conversation-ID>` *(omit `--exclude` if real project coding work happened in this current chat)*, optionally followed by `bun run verify`.
   - **Pull / Restore:** `bun run restore --workspace "<Active-Workspace-Path-of-{{PROJECT_SLUG}}>"`.
     - **Important (Antigravity 2.x):** While Antigravity is open, `language_server` holds its summary index (`agyhub_summaries_proto.pb`) in RAM and may overwrite index updates on turn end/exit. After `restore` downloads `.db` and `brain/` files, remind the user to run `cd "<CHATS_REPO_PATH>" && bun run restore --wait` in an external terminal and fully quit Antigravity (`File -> Exit`) — it auto-finalizes in <1 second, then they can reopen Antigravity.
   - **Two-Way Sync:** Run `restore` first, then `sync` (and remind the user to run `bun run restore --wait` + close/reopen Antigravity if remote conversations were imported).
4. **Never** commit `CHATS_SYNC.md` or `SETUP_SECOND_PC.md` to the team code repository (keep them in `.git/info/exclude`).
