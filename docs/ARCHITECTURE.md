# Internal Architecture & Antigravity Storage Schema

Understanding how **Google Antigravity** stores conversations locally explains why naive file copying fails across machines and how `antigravity-chat-sync` achieves lossless two-way synchronization.

---

## 1. Local Storage Layout (`~/.gemini/antigravity` & `~/.gemini/config/projects`)

Antigravity 2.x splits conversation & project state across **five** locations:

1. **`~/.gemini/config/projects/<project-id>.json` (Machine-Local Project Registry):**
   - Each machine assigns its own local UUID (`project_id`) to every workspace folder (`projectResources.resources[].gitFolder.folderUri`).
   - Restored conversations carrying another machine's `project_id` cannot be opened cleanly or used to start new chats under the local project unless their `project_id` is remapped to this machine's local UUID.
2. **`agyhub_summaries_proto.pb` (Primary Antigravity 2.x Sidebar Index):**
   - Protobuf `map<string, TrajectorySummary>` (`field 1` repeated entries of `{ f1: conversation_id, f2: raw_summary }`) loaded into RAM by `language_server` on startup and flushed on conversation updates.
   - `src/protobuf.ts` parses and re-encodes this file losslessly without touching unrelated projects.
3. **`conversation_summaries.db` (SQLite Index + FTS5 Search):**
   - `conversation_summaries` table: Stores `conversation_id`, `title`, `preview`, `step_count`, `last_modified_time`, `workspace_uris` (JSON array of URL-encoded `file://` paths), `project_id`, `parent_conversation_id`, and `raw_summary` (Protobuf summary blob).
   - `conversations_fts` (FTS5 virtual table backed by `conversations_fts_content`): Powers full-text search across conversations AND stores UTF-8 `user_body` (`c13`), `agent_body` (`c14`), and exact step byte-offset JSON arrays `user_step_byte_offsets` (`c8`) and `agent_step_byte_offsets` (`c9`).
4. **`conversations/<conversation-id>.db` (Per-Conversation SQLite Trajectory):**
   - Contains `steps` (`idx`, `step_type`, `step_payload` Protobuf binary blob, `metadata`, `task_details`, `render_info`), `gen_metadata`, `executor_metadata`, `trajectory_meta`, and **`trajectory_metadata_blob`** (`id = 'main'`, Protobuf `TrajectoryMetadata` storing `f1` `WorkspaceInfo`, `f7` encoded URIs, and `f18` `project_id`).
   - Loaded when you click a conversation in the Antigravity UI; if `trajectory_metadata_blob` still holds a foreign path or `project_id`, opening the chat reverts the summary back to the foreign project.
5. **`brain/<conversation-id>/` (Artifacts, Uploads & JSONL Logs):**
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

## 4. Cross-Drive Workspace & Antigravity 2.x Project ID Remapping

If Machine A stores the project at `D:\all-projects\my-app` (`file:///d%3A/all-projects/my-app`, `project_id = AAAA...`) and Machine B stores it at `C:\dev\my-app` (`file:///c%3A/dev/my-app`, `project_id = BBBB...`), restoring raw files unmodified causes workspace incompatibility errors and prevents creating new chats under the project.

During `bun run restore --workspace <path>` (or via automatic `../<projectSlug>` sibling detection), `src/restore.ts` + `src/protobuf.ts`:
1. Auto-detects Machine B's local `project_id` from `~/.gemini/config/projects/*.json`.
2. Rewrites `workspace_uris`, `raw_summary` (`f9` WorkspaceInfo, `f17.f1` WorkspaceInfo, `f17.f7` encoded URIs, `f17.f18` `project_id`), and every restored conversation DB's `trajectory_metadata_blob` losslessly with valid Protobuf varint length prefixes.
3. Drops secondary foreign workspace URIs whose paths do not exist on Machine B (e.g., a co-opened backend repo not cloned on Machine B).
4. Atomically merges updates into `agyhub_summaries_proto.pb` and `conversation_summaries.db` (plus in-place rebinding of any newer local chats without downgrading their step count).
5. Warns if `language_server` is still running — since Antigravity 2.x caches `agyhub_summaries_proto.pb` in RAM, running `bun run restore` after fully exiting Antigravity guarantees clean persistence.

---

## 5. Multi-Agent Storage Schemas & Cross-Agent Handoff (`v2.1`)

In addition to Google Antigravity, `src/agents.ts` and `src/handoff.ts` implement native collectors, workspace-remapped restorers, and idempotent multi-turn session materializers for **Claude Code**, **OpenAI Codex**, and **Cursor**:

| Agent | Local Storage Format | Multi-Conversation Materialization (`handoff --to`) |
| :--- | :--- | :--- |
| **Claude Code** | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (`summary`, `user`, `assistant` JSONL chain) | Writes deterministic UUIDv7 `.jsonl` threads per archived conversation so `claude --resume` lists the entire project history without duplicates. |
| **OpenAI Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `session_index.jsonl` + VS Code SQLite `state_*.sqlite` (`threads`) & `thread_history_*.sqlite` (`thread_turns`, `thread_items`) | Generates RFC 9562 UUIDv7 `SessionMeta` rollouts and upserts multi-turn user/assistant bubbles directly into `state_*.sqlite` and `thread_history_*.sqlite` so all project conversations appear natively in the VS Code Codex `Chats` sidebar. |
| **Cursor** | `Cursor/User/workspaceStorage/<hash>/workspace.json` + `state.vscdb` (`ItemTable`: `aichat.chatdata` & `composer.composerData`) | Exports `.ai-chats/*.md` per conversation plus `.cursor/rules/chat-sync-handoff.mdc` index, automatically hidden via `.git/info/exclude`. |

To prevent mirror feedback loops (`8 chats -> 16 -> 32`), seeded mirror sessions embed a `[antigravity-chat-sync-mirror:<lineCount>]` marker: unmodified mirrors are skipped during `sync`, whereas any conversation where the user continues chatting inside Claude Code or Codex (`lines.length > seededLineCount`) is automatically captured and archived on the next sync pass.
