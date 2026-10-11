import { describe, test, expect, beforeEach } from 'bun:test'
import { createDatabase, migrate } from '../storage/db.js'
import { SessionPrompt } from '../session/prompt.js'
import { Bus } from '../bus/index.js'
import { PermissionManager } from '../permission/index.js'
import { ToolRegistry } from '../tools/registry.js'
import type { Gateway } from '../gateway/index.js'
import { buildViolationReport } from './index.js'

// P3.5 — deleting a session must not erase compliance evidence, and the
// surviving rows must stay org-attributable.

const stubGateway: Gateway = {
  stream: () => Promise.resolve((async function* () {})()),
  complete: async () => ({ text: '' }),
  summarize: async () => '',
  listModels: async () => [],
  stats: () => ({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    avgLatencyMs: 0,
    byModel: {},
  }),
}

let db!: ReturnType<typeof createDatabase>
let prompt!: SessionPrompt

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  const bus = new Bus()
  const permissions = new PermissionManager({})
  const tools = new ToolRegistry({ db, bus: new Bus(), permissions, gateway: stubGateway })
  prompt = new SessionPrompt({ db, bus, gateway: stubGateway, tools, permissions })
})

function seedAudit(sessionID: string | null, org: string | null, reason = 'bash blocked') {
  db.sqlite
    .prepare(
      'INSERT INTO audit_entries (id, session_id, tool, decision, reason, args, result, created_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(
      `a_${Math.random().toString(36).slice(2)}`,
      sessionID,
      'bash',
      'deny',
      reason,
      '{}',
      '{}',
      Date.now(),
    )
  if (org !== null) {
    db.sqlite
      .prepare('UPDATE audit_entries SET org_id = ? WHERE session_id = ?')
      .run(org, sessionID)
  }
}

describe('session deletion preserves audit evidence', () => {
  test('audit rows survive and carry owner/org attribution', async () => {
    const session = await prompt.createSession({
      title: 'evidence',
      ownerID: 'alice',
      orgID: 'org-1',
    })
    seedAudit(session.id, null)

    expect(await prompt.getSession(session.id)).toBeDefined()
    await prompt.deleteSession(session.id)

    // session gone
    expect(await prompt.getSession(session.id)).toBeUndefined()

    // evidence still there, now attributed
    const row = db.sqlite
      .prepare('SELECT session_id, owner_id, org_id FROM audit_entries WHERE session_id = ?')
      .get(session.id) as { session_id: string; owner_id: string | null; org_id: string | null }
    expect(row).toBeDefined()
    expect(row.owner_id).toBe('alice')
    expect(row.org_id).toBe('org-1')
  })

  test('violation report scopes deleted-session rows via attribution', async () => {
    const session = await prompt.createSession({
      title: 'evidence',
      ownerID: 'alice',
      orgID: 'org-1',
    })
    seedAudit(session.id, null)
    await prompt.deleteSession(session.id)

    // The session no longer resolves to an org (it is gone) …
    const report = await buildViolationReport(db, {
      sessionOrg: async () => null,
      orgID: 'org-1',
    })
    // … yet the row is still attributed and counted, not dropped as unscoped.
    expect(report.totalRows).toBe(1)
    expect(report.unscopedRows).toBe(0)
    expect(report.tombstonedRows).toBe(1)
  })

  test('rows for sessions that never existed stay unscoped', async () => {
    seedAudit(null, null)
    const report = await buildViolationReport(db, { sessionOrg: async () => null, orgID: 'org-1' })
    expect(report.totalRows).toBe(0)
    expect(report.unscopedRows).toBe(1)
  })

  test('deleting one session does not disturb another session evidence', async () => {
    const a = await prompt.createSession({ title: 'a', ownerID: 'alice', orgID: 'org-1' })
    const b = await prompt.createSession({ title: 'b', ownerID: 'bob', orgID: 'org-1' })
    seedAudit(a.id, null)
    seedAudit(b.id, null)
    await prompt.deleteSession(a.id)
    const left = db.sqlite.prepare('SELECT COUNT(*) AS c FROM audit_entries').get() as { c: number }
    expect(left.c).toBe(2)
    const bRow = db.sqlite
      .prepare('SELECT owner_id FROM audit_entries WHERE session_id = ?')
      .get(b.id) as { owner_id: string | null }
    // b's row is untouched (not stamped — its session still exists)
    expect(bRow.owner_id).toBeNull()
  })
})
