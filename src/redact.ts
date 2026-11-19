import { Database } from 'bun:sqlite'

export interface SecretRule {
  label: string
  prefix: string
  regex: RegExp
}

export const SECRET_RULES: SecretRule[] = [
  { label: 'JIRA_API_TOKEN', prefix: 'REDACTED_JIRA_TOKEN_', regex: /ATATT3x[A-Za-z0-9_\-=]{20,}/g },
  { label: 'POSTMAN_API_KEY', prefix: 'REDACTED_PMAK_KEY_', regex: /\bPMAK-[A-Za-z0-9\-]{20,}\b/g },
  { label: 'GITHUB_TOKEN', prefix: 'REDACTED_GH_TOKEN_', regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { label: 'GOOGLE_API_KEY', prefix: 'REDACTED_GAPI_KEY_', regex: /\bAIza[0-9A-Za-z\-_]{30,}\b/g },
  { label: 'SLACK_TOKEN', prefix: 'REDACTED_SLACK_TOK_', regex: /\bxox[baprs]-[0-9A-Za-z\-]{15,}\b/g },
  { label: 'STRIPE_KEY', prefix: 'REDACTED_STRIPE_KEY_', regex: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{20,}\b/g },
  { label: 'OPENAI_OR_ANTHROPIC_KEY', prefix: 'REDACTED_SK_TOKEN_', regex: /\bsk-[A-Za-z0-9\-_]{25,}\b/g },
  { label: 'AWS_ACCESS_KEY', prefix: 'REDACTED_AWS_KEY_', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    label: 'PRIVATE_KEY_BLOCK',
    prefix: 'REDACTED_PRIV_KEY_',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    label: 'DATABASE_URL_CREDENTIALS',
    prefix: 'REDACTED_DB_URL_',
    regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^:\s"'`<>@\/]+:[^@\s"'`<>\/]{4,}@[^\s"'`<>]+/gi,
  },
  {
    label: 'JWT_TOKEN',
    prefix: 'REDACTED_JWT_TOKEN_',
    regex: /\beyJ[A-Za-z0-9_\-]{15,}\.eyJ[A-Za-z0-9_\-]{15,}\.[A-Za-z0-9_\-]{20,}\b/g,
  },
]

/**
 * Redacts known secret tokens from plain-text Markdown, JSON, and JSONL strings.
 */
export function redactText(input: string): string {
  let out = input
  for (const rule of SECRET_RULES) {
    rule.regex.lastIndex = 0
    out = out.replace(rule.regex, () => `<${rule.label}_REDACTED>`)
  }
  return out
}

/**
 * Replaces ASCII tokens inside binary Protobuf blobs with an exact same-byte-length
 * placeholder so embedded Protobuf varint length-prefixes remain 100% valid.
 */
export function redactBufferSameLength(buf: Uint8Array): { buf: Uint8Array; count: number } {
  const latin1 = Buffer.from(buf).toString('latin1')
  let count = 0
  let outBuf: Buffer | null = null

  for (const rule of SECRET_RULES) {
    rule.regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = rule.regex.exec(latin1)) !== null) {
      if (!outBuf) outBuf = Buffer.from(buf)
      const len = match[0].length
      const replacement = (rule.prefix + 'X'.repeat(len)).slice(0, len)
      outBuf.write(replacement, match.index, len, 'latin1')
      count++
    }
  }

  return { buf: outBuf ?? buf, count }
}

/**
 * Deep-sanitizes all tables & binary blobs inside a copied SQLite trajectory DB,
 * runs VACUUM to purge old free-list pages, and verifies PRAGMA integrity_check.
 */
export function sanitizeSqliteCopy(sqliteFilePath: string): number {
  const db = new Database(sqliteFilePath)
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  let totalRedacted = 0

  for (const t of tables) {
    const rows = db.query(`SELECT rowid as _rid, * FROM "${t.name}"`).all() as any[]
    if (rows.length === 0) continue
    const cols = Object.keys(rows[0]).filter(k => k !== '_rid')

    db.transaction(() => {
      for (const r of rows) {
        const updates: Record<string, any> = {}
        for (const c of cols) {
          if (r[c] instanceof Uint8Array) {
            const res = redactBufferSameLength(r[c])
            if (res.count > 0) {
              totalRedacted += res.count
              updates[c] = res.buf
            }
          } else if (typeof r[c] === 'string') {
            const asBuf = Buffer.from(r[c], 'utf8')
            const res = redactBufferSameLength(asBuf)
            if (res.count > 0) {
              totalRedacted += res.count
              updates[c] = Buffer.from(res.buf).toString('utf8')
            }
          }
        }
        const uCols = Object.keys(updates)
        if (uCols.length > 0) {
          const stmt = db.prepare(`UPDATE "${t.name}" SET ${uCols.map(c => `"${c}" = ?`).join(', ')} WHERE rowid = ?`)
          stmt.run(...uCols.map(c => updates[c]), r._rid)
          stmt.finalize()
        }
      }
    })()
  }

  if (totalRedacted > 0) {
    db.exec('VACUUM')
  } else {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {}
  }

  const check = db.query('PRAGMA integrity_check').get() as any
  db.close()

  if (check?.integrity_check !== 'ok') {
    throw new Error(`SQLite integrity_check failed on ${sqliteFilePath}: ${JSON.stringify(check)}`)
  }

  return totalRedacted
}
