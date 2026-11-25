---
name: chatsync
description: >-
  Universal AI coding session bridge and multi-device archiver. Connects ANY AI
  agents (Antigravity, Claude Code, Codex, Cursor, Windsurf, GitHub Copilot,
  Cline, Roo Code, Gemini CLI, Aider, OpenCode, or any tool via .chatsync/) —
  instantly on a single PC with ZERO GitHub setup, or across multiple PCs via a
  private GitHub repo. Activate whenever the user invokes /chatsync or asks to
  bridge/link/switch AI agents ("اربط الايجنتس", "انقل الشات لـ claude/cursor/codex",
  "كمل آخر شغل كنت بعمله", "switch agent", "bridge chats"), push/sync chats
  ("ارفع المحادثات", "sync chats"), pull/restore chats ("نزل المحادثات",
  "restore chats"), check status ("فحص الحالة"), or search past chats.
---

# ChatSync (`chatsync` v3.0) — Universal AI Session Bridge

Bridge conversations across **any AI coding agents** locally on **1 PC in < 1 second (zero GitHub needed)**, or synchronize & back them up across **multiple PCs** via a private GitHub repository.

## Locate `chatsync` Runtime

Use `chatsync` directly if on `PATH` (`~/.bun/bin/chatsync`), otherwise `bun ~/.chatsync/toolkit/src/cli.ts`.

---

## Mode 1: Single-PC Instant Agent-to-Agent Bridge (NO GitHub Repo Required!)

Use this whenever the user is on **one machine** and wants to move/link sessions between AI agents (e.g., quota ran out in one agent, switching from Antigravity to Claude Code / Cursor / Codex / Windsurf / Cline / Copilot, or asking *"continue where I left off in another agent"*):

- **Bridge across ALL installed AI agents on this PC at once:**
  ```bash
  chatsync bridge --workspace "<WORKSPACE_PATH>"
  ```
- **Send session directly to a specific target agent (`claude` | `codex` | `cursor` | `windsurf` | `cline` | `roocode` | `copilot` | `gemini` | `universal`):**
  ```bash
  chatsync to <target-agent> --workspace "<WORKSPACE_PATH>"
  ```
  *(Optional flags: `--from <source-agent>`, `--latest`, `--id <session-id>`).*
- **If the user asks "continue where I left off":**
  Run `chatsync to universal --workspace "<WORKSPACE_PATH>"` (if `.chatsync/latest.md` isn't fresh yet), read `<WORKSPACE_PATH>/.chatsync/latest.md`, summarize the current state in 3–5 concise bullets, and continue working immediately!

---

## Mode 2: Multi-PC Private GitHub Sync & Backup (Optional)

Use this when the user wants cloud backup or multi-device sync (`ارفع المحادثات` / `نزل المحادثات`):

1. **Check if project has a GitHub archive configured** (`chatsync status --workspace "<WORKSPACE_PATH>"`):
   - **Push / Sync to GitHub (`ارفع المحادثات`):**
     ```bash
     chatsync sync --workspace "<WORKSPACE_PATH>" --exclude "<CURRENT_CONVERSATION_ID>"
     ```
     *(Omit `--exclude` if real project coding work happened in the current chat).*
   - **Pull / Restore from GitHub (`نزل المحادثات`):**
     ```bash
     chatsync restore --workspace "<WORKSPACE_PATH>"
     ```
     *(For Antigravity 2.x sidebar updates while open, remind the user they can run `chatsync restore --wait` and close/reopen Antigravity, or use the Desktop launcher `chatsync shortcut`).*
   - **First-time GitHub Archive Setup (only if requested):**
     ```bash
     chatsync setup --project "<PROJECT_SLUG>" --repo "<gh-user>/<PROJECT_SLUG>-chats" --workspace "<WORKSPACE_PATH>" --push --install-plugin
     ```

---

## Mode 3: Status, Doctor & Search

- **Status / Doctor (`فحص الحالة`):** `chatsync status --workspace "<WORKSPACE_PATH>"` (works both with or without a GitHub repo!).
- **Search History:** `chatsync search "<KEYWORD>"`

---

## Guardrails
- Never commit `.chatsync/`, `.ai-handoff.md`, or `CHATS_SYNC.md` into the team's code repository (they are automatically added to `.git/info/exclude`).
- Never bypass secret redaction (`src/redact.ts`) or `verify` when pushing to GitHub.
- Reply concisely in the user's language (Arabic or English).
