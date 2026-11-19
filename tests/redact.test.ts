import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeLenDelim, parseProtoFields } from '../src/protobuf'
import { redactBufferSameLength, redactText, sanitizeSqliteCopy } from '../src/redact'

const tempDirs: string[] = []
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'agy-sync-redact-'))
  tempDirs.push(d)
  return d
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

const FAKE_SECRETS = {
  jira: 'ATATT3xFakeTokenValue1234567890abcdefghij=ABCD1234',
  postman: 'PMAK-000000000000000000000000-fakePostmanSecretKey123456',
  github: 'ghp_1234567890abcdefghijklmnopqrstuvwx',
  google: 'AIzaSyFakeGoogleApiKey1234567890abcdefg',
  slack: 'xoxb-123456789012-1234567890123-fakeSlackTokenValue',
  stripe: 'sk_live_FakeStripeSecretKey1234567890abcd',
  openai: 'sk-projFakeOpenAiSecretKey1234567890abcdef',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  dbUrl: 'postgres://admin:superSecretPass99@db.example.com:5432/prod',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlRlc3QifQ.FakeSignatureValue1234567890abcdef',
  privKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakekeydata1234567890\n-----END RSA PRIVATE KEY-----',
}

describe('secret redaction & Protobuf wire safety', () => {
  test('redactText scrubs every supported secret type', () => {
    for (const [name, secret] of Object.entries(FAKE_SECRETS)) {
      const out = redactText(`prefix ${secret} suffix`)
      expect(out, `failed to redact ${name}`).not.toContain(secret)
      expect(out).toContain('_REDACTED>')
    }
  })

  test('redactBufferSameLength preserves exact byte length & Protobuf framing', () => {
    const protoMsg = Buffer.concat([
      encodeLenDelim(1, Buffer.from(`JIRA=${FAKE_SECRETS.jira}`, 'utf8')),
      encodeLenDelim(2, Buffer.from(`POSTMAN=${FAKE_SECRETS.postman}`, 'utf8')),
      encodeLenDelim(3, Buffer.from(`DB=${FAKE_SECRETS.dbUrl}`, 'utf8')),
      encodeLenDelim(4, Buffer.from(`JWT=${FAKE_SECRETS.jwt}`, 'utf8')),
    ])

    const { buf: redacted, count } = redactBufferSameLength(protoMsg)
    expect(count).toBe(4)
    expect(redacted.byteLength).toBe(protoMsg.byteLength)

    // Verify Protobuf frame structure still parses cleanly!
    const fields = parseProtoFields(redacted)
    expect(fields.length).toBe(4)
    const asText = Buffer.from(redacted).toString('utf8')
    expect(asText).not.toContain(FAKE_SECRETS.jira)
    expect(asText).not.toContain(FAKE_SECRETS.postman)
    expect(asText).not.toContain(FAKE_SECRETS.dbUrl)
    expect(asText).not.toContain(FAKE_SECRETS.jwt)
  })

  test('sanitizeSqliteCopy redacts blobs, runs VACUUM, and leaves zero raw bytes on disk', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'test-conv.db')
    const db = new Database(dbPath)
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB, note TEXT)')
    const blob = encodeLenDelim(1, Buffer.from(`key=${FAKE_SECRETS.postman}`, 'utf8'))
    db.query('INSERT INTO steps (idx, step_payload, note) VALUES (1, ?, ?)').run(blob, `token=${FAKE_SECRETS.stripe}`)
    db.close()

    const total = sanitizeSqliteCopy(dbPath)
    expect(total).toBe(2)

    // Verify raw file bytes contain neither secret even in unreferenced pages
    const rawDisk = readFileSync(dbPath, 'latin1')
    expect(rawDisk).not.toContain(FAKE_SECRETS.postman)
    expect(rawDisk).not.toContain(FAKE_SECRETS.stripe)
  })
})
