import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate } from '../storage/db.js'
import { AuditLogger } from './index.js'

// P3.5 — the audit writer is the single chokepoint for evidence storage, so
// redaction happens here: nothing raw should reach the file mirror or the DB.

let dir: string
let logPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mira-audit-redact-'))
  logPath = join(dir, 'audit.log')
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

async function loggerWithDb() {
  const db = createDatabase(':memory:')
  await migrate(db)
  const logger = new AuditLogger(logPath, db)
  return { db, logger }
}

const row = (db: ReturnType<typeof createDatabase>) =>
  db.sqlite.prepare('SELECT args, result FROM audit_entries ORDER BY created_at DESC').get() as
    { args: string | null; result: string | null } | undefined

describe('AuditLogger redaction (P3.5)', () => {
  test('masks secrets in args before the DB mirror', async () => {
    const { db, logger } = await loggerWithDb()
    await logger.log({
      sessionID: 's1',
      tool: 'bash',
      decision: 'allow',
      args: { command: 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG' },
      result: { code: 0 },
    })
    const stored = row(db)
    expect(stored?.args).toBeTruthy()
    expect(stored!.args!).not.toContain('wJalrXUtnFEMIK7MDENG')
    expect(stored!.args!).toContain('[REDACTED]')
    // non-secret siblings survive
    expect(stored!.args!).toContain('export')
  })

  test('masks secrets in results before the DB mirror', async () => {
    const { db, logger } = await loggerWithDb()
    await logger.log({
      sessionID: 's1',
      tool: 'read',
      decision: 'allow',
      args: {},
      result: { contents: 'AKIAIOSFODNN7EXAMPLE' },
    })
    const stored = row(db)
    expect(stored!.result!).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  test('replaces secret-named keys wholesale even for unknown formats', async () => {
    const { db, logger } = await loggerWithDb()
    await logger.log({
      sessionID: 's1',
      tool: 'mcp__x',
      decision: 'allow',
      args: { connectionString: 'x', clientSecret: 'totally-opaque-value' },
    })
    const stored = row(db)
    expect(stored!.args!).not.toContain('totally-opaque-value')
    expect(stored!.args!).toContain('connectionString')
  })

  test('file mirror is redacted too', async () => {
    const { logger } = await loggerWithDb()
    await logger.log({
      sessionID: 's1',
      tool: 'bash',
      decision: 'deny',
      reason: 'blocked secret sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      args: { command: 'cat /etc/passwd' },
    })
    const line = readFileSync(logPath, 'utf-8')
    expect(line).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')
    expect(line).toContain('[REDACTED]')
  })

  test('structural fields are preserved verbatim', async () => {
    const { db, logger } = await loggerWithDb()
    await logger.log({
      sessionID: 'sess-keep',
      tool: 'bash',
      decision: 'deny',
      reason: 'bash command in blocked list',
      args: null,
    })
    const full = db.sqlite
      .prepare('SELECT session_id, tool, decision, reason FROM audit_entries')
      .get() as { session_id: string; tool: string; decision: string; reason: string }
    expect(full.session_id).toBe('sess-keep')
    expect(full.tool).toBe('bash')
    expect(full.decision).toBe('deny')
    expect(full.reason).toBe('bash command in blocked list')
  })

  test('caps oversized payloads', async () => {
    const { db, logger } = await loggerWithDb()
    await logger.log({
      sessionID: 's1',
      tool: 'read',
      decision: 'allow',
      args: {},
      result: { blob: 'x'.repeat(50_000) },
    })
    const stored = row(db)
    expect(stored!.result!.length).toBeLessThan(10_000)
    expect(stored!.result!).toContain('truncated')
  })

  test('benign entries are stored unchanged', async () => {
    const { db, logger } = await loggerWithDb()
    await logger.log({
      sessionID: 's1',
      tool: 'read',
      decision: 'allow',
      args: { path: 'src/index.ts' },
    })
    const stored = row(db)
    expect(JSON.parse(stored!.args!)).toEqual({ path: 'src/index.ts' })
  })
})
