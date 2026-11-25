# Security & Binary Protobuf Secret Redaction

Archiving real engineering conversations to GitHub introduces two critical security challenges:
1. **Credential Exposure:** Prompts, `.env` reads, or CLI commands recorded in chat steps may contain live API tokens (Jira `ATATT3x...`, Postman `PMAK-...`, GitHub `ghp_...` / `github_pat_...`, Google `AIza...`, Slack `xox...`, Stripe `sk_live_...`/`rk_live_...`, OpenAI/Anthropic `sk-...`, AWS `AKIA...`, Private Key PEM blocks, Database URLs with embedded passwords, and JWTs).
2. **GitHub Push Protection & Protobuf Wire Integrity:** GitHub scans pushed commits and blocks pushes containing known secret formats. However, inside `conversations/<id>.db`, chat steps are stored as **serialized binary Protocol Buffers (`BLOB`)** inside SQLite pages.

---

## Why Naive String Replacement Corrupts `.db` Files

In Protocol Buffers (wire type `2`, length-delimited strings/messages), every string or nested message is prefixed by a **base-128 varint byte length**.

If a 192-byte Jira token inside `steps.step_payload` were replaced with a 12-byte string `<REDACTED>`, every outer Protobuf message's varint length prefix would become invalid, causing Antigravity to fail when deserializing that conversation!

---

## How `src/redact.ts` Solves Both Problems Safely

1. **Isolated Copy (WAL-Aware):** Original files inside `~/.gemini/antigravity` are **never modified**. Each `<id>.db` (along with any active `-wal`/`-shm` sidecar files) is copied to `.tmp-sanitize/<id>.db` first and checkpointed cleanly.
2. **Same-Byte-Length Binary Replacement:**
   `redactBufferSameLength()` scans binary `Uint8Array` blobs in `latin1` byte space (preserving 1:1 byte indexing) and overwrites matched ASCII tokens with a deterministic placeholder (`REDACTED_JIRA_TOKEN_XXXX...`) of the **exact same byte length** (`match[0].length`).
   - Byte offsets never shift.
   - Embedded Protobuf varint length prefixes remain 100% valid.
3. **Purging SQLite Free-List Pages (`VACUUM`):**
   When SQLite updates a large `BLOB` row, older B-tree overflow pages can remain unreferenced inside the database file's free-page list — still visible to raw binary/gzip scanners! Running `VACUUM` rebuilds the SQLite file from scratch, eliminating every trace of unreferenced pages (and often shrinking compressed `.db.gz` size by 30%+).
4. **Integrity & Zero-Leak Verification:**
   - Every sanitized database must return `ok` on `PRAGMA integrity_check`.
   - `bun run verify` gunzips every `.gz` archive — **and reassembles multi-part `.gz.part01`/`.part02` archives** — in memory and scans raw bytes against all secret rules before pushing.
