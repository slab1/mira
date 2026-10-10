import { describe, test, expect, beforeEach } from 'bun:test'
import {
  createWorkspaceIntelligence,
  setSharedWorkspace,
  type WorkspaceIntelligence,
} from './intelligence.js'
import { writeFinding, resolveFinding } from '../tools/findings.js'
import { createLearningSystem } from '../learning/index.js'
import { Bus } from '../bus/index.js'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'

// Hermetic: the test preload (tests/preload.ts via bunfig.toml) redirects the
// decision ledger to a temp file, so the governance-transition tests below can
// exercise the full wiring without touching the repo's shared/context.json.

async function makeDB(): Promise<MiraDB> {
  const db = createDatabase(':memory:')
  await migrate(db)
  return db
}

async function makeWS(): Promise<{ ws: WorkspaceIntelligence; db: MiraDB }> {
  const db = await makeDB()
  const ws = createWorkspaceIntelligence({ db })
  return { ws, db }
}

describe('WorkspaceIntelligence', () => {
  let ws: WorkspaceIntelligence

  beforeEach(async () => {
    ;({ ws } = await makeWS())
    setSharedWorkspace(ws)
  })

  test('upsert deduplicates by kind+title and reuses stable id', () => {
    const a = ws.upsert({ kind: 'issue', title: 'bug one' })
    const b = ws.upsert({ kind: 'issue', title: 'bug one' })
    expect(b.id).toBe(a.id)
    expect(ws.query({ kind: 'issue' }).length).toBe(1)
  })

  test('query filters by kind and status', () => {
    ws.upsert({ kind: 'issue', title: 'open bug' })
    ws.upsert({ kind: 'decision', title: 'gov decision', status: 'resolved' })
    expect(ws.query({ kind: 'issue' }).length).toBe(1)
    expect(ws.query({ status: 'resolved' }).length).toBe(1)
    expect(ws.query({ kind: 'issue', status: 'open' }).length).toBe(1)
    expect(ws.query({ kind: 'issue', status: 'resolved' }).length).toBe(0)
  })

  test('setStatus updates an item', () => {
    const item = ws.upsert({ kind: 'tech-debt', title: 'refactor X' })
    ws.setStatus(item.id, 'resolved')
    expect(ws.get(item.id)?.status).toBe('resolved')
  })

  test('summary returns counts by kind:status', () => {
    ws.upsert({ kind: 'roadmap', title: 'ship P0' })
    ws.upsert({ kind: 'issue', title: 'bug a' })
    ws.upsert({ kind: 'issue', title: 'bug b', status: 'resolved' })
    const s = ws.summary()
    expect(s['roadmap:open']).toBe(1)
    expect(s['issue:open']).toBe(1)
    expect(s['issue:resolved']).toBe(1)
  })
})

describe('findings → workspace intelligence wiring', () => {
  let ws: WorkspaceIntelligence
  let db: MiraDB

  beforeEach(async () => {
    ;({ ws, db } = await makeWS())
    setSharedWorkspace(ws)
  })

  test('writeFinding creates an open issue workspace item', async () => {
    const f = await writeFinding(db, {
      title: 'critical bug in auth',
      severity: 'critical',
      evidence: 'stack trace at auth.ts:42',
      source: 'agent',
    })
    const issues = ws.query({ kind: 'issue' })
    expect(issues.length).toBe(1)
    expect(issues[0]!.title).toBe('critical bug in auth')
    expect(issues[0]!.status).toBe('open')
    expect(issues[0]!.priority).toBe('high')
    expect(issues[0]!.metadata.findingId).toBe(f.id)
  })

  test('resolveFinding resolves the matching workspace item', async () => {
    const f = await writeFinding(db, { title: 'minor issue', severity: 'minor' })
    await resolveFinding(db, f.id)
    const item = ws.query({ kind: 'issue' })[0]!
    expect(item.status).toBe('resolved')
  })

  test('severity maps to priority', async () => {
    await writeFinding(db, { title: 'info note', severity: 'info' })
    await writeFinding(db, { title: 'major problem', severity: 'major' })
    const byTitle = new Map(ws.query({ kind: 'issue' }).map((i) => [i.title, i.priority]))
    expect(byTitle.get('info note')).toBe('low')
    expect(byTitle.get('major problem')).toBe('high')
  })
})

describe('governance transitions → workspace items', () => {
  test('createLearningSystem sets shared workspace and stage passes create decision items', async () => {
    const bus = new Bus()
    const db = await makeDB()
    const system = createLearningSystem({ db, bus })

    // Shared workspace is set by createLearningSystem
    const shared = system.workspace
    expect(shared).toBeDefined()

    // Simulate a governance stage pass via the onStagePass callback path:
    // create a proposal through the governance gate's internal flow is complex;
    // instead verify the bus subscription mirrors transitions.
    bus.publish({
      type: 'learning.updated',
      payload: {
        kind: 'governance.transition',
        proposalId: 'prop_test_1',
        stage: 'benchmark',
        from: 'PROPOSED',
        to: 'BENCHMARK_PASSED',
        passed: true,
        reason: 'ok',
      },
      timestamp: Date.now(),
    })

    const decisions = system.workspace.query({ kind: 'decision' })
    expect(decisions.length).toBe(1)
    expect(decisions[0]!.title).toBe('Governance: prop_test_1')
    expect(decisions[0]!.status).toBe('in-progress')
  })

  test('PROMOTED transition marks decision resolved; REJECTED marks wontfix', async () => {
    const bus = new Bus()
    const db = await makeDB()
    const system = createLearningSystem({ db, bus })

    bus.publish({
      type: 'learning.updated',
      payload: {
        kind: 'governance.transition',
        proposalId: 'p1',
        from: 'CANARY_PASSED',
        to: 'PROMOTED',
        passed: true,
      },
      timestamp: Date.now(),
    })
    bus.publish({
      type: 'learning.updated',
      payload: {
        kind: 'governance.transition',
        proposalId: 'p2',
        from: 'PROPOSED',
        to: 'REJECTED',
        passed: false,
        reason: 'security',
      },
      timestamp: Date.now(),
    })

    const decisions = system.workspace.query({ kind: 'decision' })
    const byTitle = new Map(decisions.map((d) => [d.title, d.status]))
    expect(byTitle.get('Governance: p1')).toBe('resolved')
    expect(byTitle.get('Governance: p2')).toBe('wontfix')
  })
})
