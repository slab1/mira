import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createDatabase, migrate } from '../storage/db.js'
import {
  applyRetention,
  buildViolationReport,
  classifyViolation,
  DEFAULT_RETENTION_DAYS,
  resolveRetentionDays,
} from './index.js'

// P3.5 compliance — retention sweep + policy-violation report over audit rows.

let db!: ReturnType<typeof createDatabase>
const DAY = 24 * 60 * 60 * 1000

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
})

afterEach(() => {
  delete process.env.MIRA_COMPLIANCE_RETENTION_DAYS
})

let seedCounter = 0
function seedAudit(
  rows: Array<{
    tool: string
    decision: string
    reason?: string
    ageDays?: number
    session?: string
  }>,
) {
  const ins = db.sqlite.prepare(
    'INSERT INTO audit_entries (id, session_id, tool, decision, reason, args, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  for (const r of rows) {
    ins.run(
      `evt_${seedCounter++}_${r.tool}`,
      r.session ?? null,
      r.tool,
      r.decision,
      r.reason ?? null,
      null,
      null,
      Date.now() - (r.ageDays ?? 0) * DAY,
    )
  }
}

const count = () =>
  (db.sqlite.prepare('SELECT COUNT(*) AS c FROM audit_entries').get() as { c: number }).c

describe('retention window resolution', () => {
  test('defaults to 90 days', () => {
    expect(resolveRetentionDays()).toBe(DEFAULT_RETENTION_DAYS)
  })

  test('explicit option wins', () => {
    expect(resolveRetentionDays({ retentionDays: 7 })).toBe(7)
  })

  test('env override applies when no option', () => {
    process.env.MIRA_COMPLIANCE_RETENTION_DAYS = '30'
    expect(resolveRetentionDays()).toBe(30)
    expect(resolveRetentionDays({ retentionDays: 5 })).toBe(5)
  })

  test('negative/garbage values fall back safely', () => {
    expect(resolveRetentionDays({ retentionDays: -3 })).toBe(0)
    process.env.MIRA_COMPLIANCE_RETENTION_DAYS = 'nonsense'
    expect(resolveRetentionDays()).toBe(DEFAULT_RETENTION_DAYS)
  })
})

describe('applyRetention', () => {
  test('deletes rows older than the window, keeps recent ones', async () => {
    seedAudit([
      { tool: 'bash', decision: 'allow', ageDays: 200 },
      { tool: 'bash', decision: 'deny', ageDays: 120 },
      { tool: 'read', decision: 'allow', ageDays: 10 },
      { tool: 'read', decision: 'allow', ageDays: 0 },
    ])
    const res = await applyRetention(db, { retentionDays: 90 })
    expect(res.deletedByAge).toBe(2)
    expect(res.remaining).toBe(2)
    expect(res.cutoff).toBeGreaterThan(0)
  })

  test('retentionDays=0 disables age deletion', async () => {
    seedAudit([{ tool: 'bash', decision: 'allow', ageDays: 999 }])
    const res = await applyRetention(db, { retentionDays: 0 })
    expect(res.deletedByAge).toBe(0)
    expect(res.cutoff).toBeNull()
    expect(count()).toBe(1)
  })

  test('maxRows trims the oldest overflow', async () => {
    for (let i = 0; i < 10; i++)
      seedAudit([{ tool: 'read', decision: 'allow', ageDays: 10 - i * 0.5 }])
    expect(count()).toBe(10)
    const res = await applyRetention(db, { retentionDays: 0, maxRows: 4 })
    expect(res.deletedByCap).toBe(6)
    expect(res.remaining).toBe(4)
    // the survivors are the newest four
    const oldest = db.sqlite.prepare('SELECT MIN(created_at) AS m FROM audit_entries').get() as {
      m: number
    }
    expect(oldest.m).toBeGreaterThan(Date.now() - 9 * DAY)
  })

  test('under the cap nothing is trimmed', async () => {
    seedAudit([{ tool: 'read', decision: 'allow', ageDays: 1 }])
    const res = await applyRetention(db, { retentionDays: 90, maxRows: 100 })
    expect(res.deletedByCap).toBe(0)
    expect(res.remaining).toBe(1)
  })

  test('never throws on a missing table', async () => {
    db.sqlite.exec('DROP TABLE audit_entries;')
    const res = await applyRetention(db, { retentionDays: 1 })
    expect(res.deletedByAge).toBe(0)
  })
})

describe('violation classification', () => {
  test('maps producer prefixes to categories', () => {
    expect(classifyViolation('bash command accesses blocked path /etc/passwd')).toBe('command')
    expect(classifyViolation('patch target outside allowed roots (src/x.ts)')).toBe('patch')
    expect(classifyViolation('task prompt injection detected (foo)')).toBe('task')
    expect(classifyViolation('mcp: sensitive env access in arg apiKey')).toBe('mcp')
    expect(classifyViolation('webfetch SSRF: localhost')).toBe('webfetch')
    expect(classifyViolation('guardrail error: boom')).toBe('guardrail-error')
    expect(classifyViolation('path outside allowed roots')).toBe('path')
    expect(classifyViolation('something else')).toBe('other')
    expect(classifyViolation(null)).toBe('other')
  })
})

describe('buildViolationReport', () => {
  test('counts deny+warn rows, ignores allow', async () => {
    seedAudit([
      {
        tool: 'bash',
        decision: 'deny',
        reason: 'bash command accesses /etc/passwd',
        session: 's1',
      },
      {
        tool: 'bash',
        decision: 'warn',
        reason: 'bash command accesses /etc/passwd',
        session: 's1',
      },
      { tool: 'read', decision: 'allow', session: 's1' },
      {
        tool: 'edit',
        decision: 'deny',
        reason: 'patch target outside allowed roots (etc/passwd)',
        session: 's2',
      },
    ])
    const rep = await buildViolationReport(db)
    expect(rep.totalRows).toBe(3)
    expect(rep.byCategory[0].category).toBe('command')
    expect(rep.byCategory[0].rows).toBe(2)
    // same session+tool+reason collapses to one event
    expect(rep.byCategory[0].events).toBe(1)
    expect(rep.byTool[0]).toEqual({ tool: 'bash', rows: 2 })
  })

  test('honours the time window', async () => {
    seedAudit([
      { tool: 'bash', decision: 'deny', reason: 'bash blocked', ageDays: 1 },
      { tool: 'bash', decision: 'deny', reason: 'bash blocked', ageDays: 100 },
    ])
    const rep = await buildViolationReport(db, { sinceDays: 7 })
    expect(rep.totalRows).toBe(1)
  })

  test('org scoping keeps only that org and counts unscoped rows', async () => {
    seedAudit([
      { tool: 'bash', decision: 'deny', reason: 'bash blocked', session: 's1' },
      { tool: 'bash', decision: 'deny', reason: 'bash blocked', session: 's2' },
      { tool: 'bash', decision: 'deny', reason: 'bash blocked' }, // no session
    ])
    const orgOf: Record<string, string> = { s1: 'org-1', s2: 'org-2' }
    const rep = await buildViolationReport(db, {
      sessionOrg: (id) => orgOf[id],
      orgID: 'org-1',
    })
    expect(rep.totalRows).toBe(1)
    // only the session-less row is "unscoped"; s2 is scoped to another org
    expect(rep.unscopedRows).toBe(1)
  })

  test('empty trail yields an empty report, not an error', async () => {
    const rep = await buildViolationReport(db)
    expect(rep.totalRows).toBe(0)
    expect(rep.byCategory).toEqual([])
    expect(rep.byTool).toEqual([])
  })
})
