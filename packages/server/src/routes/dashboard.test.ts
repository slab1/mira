import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { mountDashboardRoutes } from './dashboard.js'
import { createGovernanceGate } from '../patching/governance/index.js'

type DB = ReturnType<typeof createDatabase>

let db: DB
let app: Hono<{ Variables: { requestId: string } }>

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  app = new Hono()
  const governance = createGovernanceGate({ db, rootDir: process.cwd() })
  mountDashboardRoutes(app, { db, governance })
})

afterEach(() => {
  try { db.sqlite.close() } catch {}
})

describe('GET /dashboard — real runtime', () => {
  test('returns 200 with all dashboard sections', async () => {
    const res = await app.request('/dashboard')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('agents')
    expect(body).toHaveProperty('governance')
    expect(body).toHaveProperty('learning')
    expect(body).toHaveProperty('workspace')
    expect(body).toHaveProperty('repo')
    expect(body).toHaveProperty('cost')
  })

  test('returns empty but valid data on fresh DB', async () => {
    const res = await app.request('/dashboard')
    const body = await res.json() as {
      agents: { total: number }
      governance: { totalProposals: number }
      learning: { totalMemories: number }
      workspace: { openItems: number }
      repo: { nodes: number }
      cost: { totalTokens: number }
    }
    expect(body.agents.total).toBe(0)
    expect(body.governance.totalProposals).toBe(0)
    expect(body.learning.totalMemories).toBe(0)
    expect(body.workspace.openItems).toBe(0)
    expect(body.repo.nodes).toBe(0)
    expect(body.cost.totalTokens).toBe(0)
  })

  test('reflects governance proposals in dashboard data', async () => {
    const governance = createGovernanceGate({ db, rootDir: process.cwd() })
    await governance.createProposal(
      { id: 'p1', painPointId: 'latency', kind: 'latency', targetFile: 'src/a.ts', reason: 'slow', change: 'fix', verification: 'test', severity: 'medium', score: 0.5, createdAt: Date.now() },
      { verified: true, reason: 'ok' },
    )
    const res = await app.request('/dashboard')
    const body = await res.json() as { governance: { totalProposals: number; byState: Record<string, number> } }
    expect(body.governance.totalProposals).toBe(1)
    expect(body.governance.byState.PROPOSED).toBe(1)
  })
})
