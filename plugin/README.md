# Antigravity Chat Sync Plugin

Global Google Antigravity plugin providing the `/chat-sync` skill across every workspace on your machine — no per-project Markdown playbook files required.

## Capabilities

- **Push / Sync Conversations:** Export readable Markdown transcripts, sanitize SQLite binary Protobuf payloads, verify zero credential leaks, and push to your project's private GitHub archive.
- **Pull / Restore Conversations:** Non-destructively download newer conversations from other machines and remap `workspace_uris` and Antigravity 2.x `project_id` bindings automatically.
- **Health Diagnostics:** Compare local vs. archived step counts, inspect background daemon status, and detect foreign `project_id` entries.
- **Archive Search:** Search historical conversations and plans across your archive and jump directly via clickable `conversation://<id>` links.
- **Conversation Split / Hand-off:** Extract misplaced project work into a clean project-scoped conversation via `ConversationService`.
