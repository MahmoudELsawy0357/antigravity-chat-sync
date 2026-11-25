# ChatSync (`chatsync` v3.0) — Universal AI Session Bridge

Global plugin & CLI providing the `/chatsync` skill across every workspace on your machine — connecting **any AI coding agent** locally on 1 PC (zero GitHub needed) or across multiple PCs via a private GitHub archive.

## Capabilities

- **Instant Single-PC Agent Bridge (`chatsync bridge` / `chatsync to <agent>`):** Switch or link live conversations between Antigravity, Claude Code, Codex, Cursor, Windsurf, Cline, Roo Code, GitHub Copilot, Gemini CLI, Aider, or any AI tool via `.chatsync/latest.md` in < 1 second with zero GitHub setup.
- **Multi-PC Push / Sync (`chatsync sync`):** Export readable Markdown transcripts across all installed AI agents, sanitize binary Protobuf & JSONL payloads, verify zero secret leaks, and push to your private GitHub archive.
- **Multi-PC Pull / Restore (`chatsync restore`):** Non-destructively download newer conversations from other machines and remap `workspace_uris` and Antigravity 2.x `project_id` bindings automatically.
- **Health Diagnostics (`chatsync status`):** Inspect installed AI agents, local live sessions, background daemon state, and local vs. archived step counts (works with or without a GitHub repo).
- **Archive Search (`chatsync search`):** Full-text search across historical conversations and plans with clickable `conversation://<id>` links.
