# 🏗️ Internal Architecture & Antigravity Storage Schema

Understanding how **Google Antigravity** stores conversations locally explains why naive file copying fails across machines and how `antigravity-chat-sync` achieves lossless two-way synchronization.

---

## 1. Local Storage Layout (`~/.gemini/antigravity`)

Antigravity splits conversation state across three locations inside `%USERPROFILE%\.gemini\antigravity` (Windows) or `~/.gemini/antigravity` (macOS/Linux):

1. **`conversation_summaries.db` (SQLite Index + FTS5 Search):**
   - `conversation_summaries` table: Powers the sidebar list. Stores `conversation_id`, `title`, `preview`, `step_count`, `last_modified_time`, `workspace_uris` (JSON array of URL-encoded `file://` paths), `parent_conversation_id` (links subagents to parent chats), and `raw_summary` (Protobuf summary blob).
   - `conversations_fts` (FTS5 virtual table backed by `conversations_fts_content`): Powers full-text search across conversations AND stores UTF-8 `user_body` (`c13`), `agent_body` (`c14`), and exact step byte-offset JSON arrays `user_step_byte_offsets` (`c8`) and `agent_step_byte_offsets` (`c9`).
2. **`conversations/<conversation-id>.db` (Per-Conversation SQLite Trajectory):**
   - Contains `steps` (`idx`, `step_type`, `step_payload` Protobuf binary blob, `metadata`, `task_details`, `render_info`), `gen_metadata`, `executor_metadata`, and `trajectory_meta`.
   - Loaded when you click a conversation in the Antigravity UI.
3. **`brain/<conversation-id>/` (Artifacts, Uploads & JSONL Logs):**
   - Top-level `.md` artifacts (`implementation_plan.md`, `walkthrough.md`, etc.) + `.metadata.json`.
   - `.user_uploaded/`: Images and files attached by the user.
   - `.system_generated/logs/transcript.jsonl` & `transcript_full.jsonl`: Structured step-by-step JSONL logs read by agents when referencing earlier conversations.

---

## 2. Project Isolation Strategy

Developers typically work on multiple repositories on the same machine. `src/sync.ts` queries:

```sql
SELECT * FROM conversation_summaries
WHERE parent_conversation_id = ''
ORDER BY last_modified_time ASC
```

It filters top-level conversations whose `workspace_uris` contains `projectSlug` (case-insensitive), then fetches all child subagent rows (`WHERE parent_conversation_id IN (...)`) so subagent links inside parent trajectories remain intact upon restore.

---

## 3. Dual-Engine Markdown Reconstruction

- **Modern Conversations (with `transcript_full.jsonl`):** Parses `USER_INPUT` and `PLANNER_RESPONSE` steps directly, stripping system XML wrappers (`<USER_REQUEST>`, `<ADDITIONAL_METADATA>`) and grouping intermediate tool invocations into collapsible `<details>` summaries.
- **Legacy Conversations (without `brain/` logs):** Reconstructs chronological user/assistant turns directly from `conversations_fts_content` by slicing `Buffer.from(c13, 'utf8')` and `Buffer.from(c14, 'utf8')` using the `[stepIndex, byteOffset]` pairs stored in `c8` and `c9`.
- **GitHub Web UI Pagination:** GitHub truncates Markdown files larger than ~512 KB. Any conversation exceeding `380 KB` (`maxMarkdownPartKB`) is automatically split into `part-01.md`, `part-02.md`, etc., with `Previous / Index / Next` navigation headers.

---

## 4. Cross-Drive Workspace Path Remapping

If Machine A stores the project at `D:\all-projects\my-app` (`file:///d%3A/all-projects/my-app`) and Machine B stores it at `C:\dev\my-app`, restoring raw `workspace_uris` unmodified would prevent Antigravity on Machine B from associating those conversations with `C:\dev\my-app`.

During `bun run restore --workspace <path>` (or via automatic `../<projectSlug>` sibling detection), `adaptWorkspaceUris()` rewrites matching entries in `workspace_uris` to Machine B's exact URL-encoded `file://` URI.
