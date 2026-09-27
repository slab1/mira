/**
 * Governance proposal routes:
 *   GET  /evolution/proposals?state=<s>       → { proposals: PatchProposal[] }
 *   POST /evolution/proposals/:id/advance     → { proposal }
 *   POST /evolution/proposals/:id/promote     → { applied, prUrl?, regressionBlocked?, reason? }
 *   POST /evolution/proposals/:id/rollback    → { ok: true }   body { reason }
 *
 * Wired the same way evolution.ts gets its other deps: the GovernanceGate
 * instance from learning/index.ts is passed in as `deps.governance`
 * (mountEvolutionRoutes) / mountEvolutionProposalRoutes (mountLearningRoutes).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { Bus } from '../bus/index.js'
import { createDatabase, migrate } from '../storage/db.js'
import { mountEvolutionRoutes, mountEvolutionProposalRoutes } from './evolution.js'
import { createGovernanceGate, type GovernanceGate } from '../patching/governance/index.js'
import type { Patch } from '../patching/patcher.js'
import type { VerifyResult } from '../patching/verifier.js'
import type { JsonValue } from '../types/index.js'
import { createLearningSystem, mountLearningRoutes } from '../learning/index.js'

type DB = ReturnType<typeof createDatabase>
type App = Hono<{ Variables: { requestId: string } }>

const PATCH: Patch = {
  id: 'patch_route',
  painPointId: 'latency',
  kind: 'latency',
  targetFile: 'src/a.ts',
  reason: 'slow route',
  change: 'export const y = 2',
  verification: 'bun test',
  severity: 'medium',
  score: 0.4,
  createdAt: Date.now(),
}

// shared VerifyResult fixture (reason is required by the verifier contract)
const VERIFY: VerifyResult = { verified: true, reason: 'shadow ok' }

let db: DB
let bus: Bus
let gate: GovernanceGate
let app: App

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await app.request(path, init)
  return { status: res.status, body: await res.json() }
}

function post(body: Record<string, JsonValue>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  bus = new Bus()
  gate = createGovernanceGate({
    db,
    bus,
    rootDir: process.cwd(),
    // deterministic promote — no git/gh in tests
    promoter: { promote: async () => ({ applied: true, prUrl: 'https://github.com/slab1/mira/pull/1' }) },
    // instrumented stage fakes — promote() auto-derives regression evidence
    // (baseline=metadata.benchmark.before, candidate=metadata.canary.metrics)
    // from what advance() stores; p95Ms 100 → 100 = no regression
    benchmark: { run: async () => ({ passed: true, reason: 'ok', before: { p95Ms: 100 } }) },
    canary: { start: async () => ({ passed: true, reason: 'ok', metrics: { p95Ms: 100 } }) },
  })
  app = new Hono<{ Variables: { requestId: string } }>()
  mountEvolutionRoutes(app, { db, bus, governance: gate })
})

afterEach(() => {
  try {
    db.sqlite.close()
  } catch {}
})

describe('GET /evolution/proposals', () => {
  test('returns { proposals } and filters by ?state=', async () => {
    const empty = await json('/evolution/proposals')
    expect(empty.status).toBe(200)
    expect(empty.body.proposals).toEqual([])

    const p = await gate.createProposal(PATCH, VERIFY)

    const all = await json('/evolution/proposals')
    expect(all.status).toBe(200)
    expect(all.body.proposals.length).toBe(1)
    expect(all.body.proposals[0]).toMatchObject({
      id: p.id,
      state: 'PROPOSED',
      reason: 'slow route',
      change: 'export const y = 2',
    })

    const filtered = await json('/evolution/proposals?state=PROPOSED')
    expect(filtered.body.proposals.length).toBe(1)

    const none = await json('/evolution/proposals?state=PROMOTED')
    expect(none.body.proposals).toEqual([])
  })

  test('rejects an unknown state with 400', async () => {
    const bad = await json('/evolution/proposals?state=NOT_A_STATE')
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('invalid state')
  })
})

describe('POST /evolution/proposals/:id/advance', () => {
  test('runs one stage per call across the full happy path', async () => {
    const p = await gate.createProposal(PATCH, VERIFY)

    const s1 = await json(`/evolution/proposals/${p.id}/advance`, post({}))
    expect(s1.status).toBe(200)
    expect(s1.body.proposal.state).toBe('BENCHMARK_PASSED')

    const s2 = await json(`/evolution/proposals/${p.id}/advance`, post({}))
    expect(s2.body.proposal.state).toBe('SECURITY_PASSED')

    const s3 = await json(`/evolution/proposals/${p.id}/advance`, post({}))
    expect(s3.body.proposal.state).toBe('CANARY_PASSED')

    // persisted — visible through the list route
    const list = await json('/evolution/proposals?state=CANARY_PASSED')
    expect(list.body.proposals.map((x: { id: string }) => x.id)).toEqual([p.id])
  })

  test('404 for an unknown proposal id', async () => {
    const res = await json('/evolution/proposals/proposal_missing/advance', post({}))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not found')
  })
})

describe('POST /evolution/proposals/:id/promote', () => {
  test('returns { applied, prUrl } and persists PROMOTED (after full pipeline)', async () => {
    const p = await gate.createProposal(PATCH, VERIFY)
    // only CANARY_PASSED may promote — advance through every stage first
    await json(`/evolution/proposals/${p.id}/advance`, post({}))
    await json(`/evolution/proposals/${p.id}/advance`, post({}))
    const s3 = await json(`/evolution/proposals/${p.id}/advance`, post({}))
    expect(s3.body.proposal.state).toBe('CANARY_PASSED')

    const res = await json(`/evolution/proposals/${p.id}/promote`, post({}))
    expect(res.status).toBe(200)
    expect(res.body.applied).toBe(true)
    expect(res.body.prUrl).toBe('https://github.com/slab1/mira/pull/1')

    const list = await json('/evolution/proposals?state=PROMOTED')
    expect(list.body.proposals.length).toBe(1)
    expect(list.body.proposals[0].prUrl).toBe('https://github.com/slab1/mira/pull/1')
  })

  test('state guard: promote before CANARY_PASSED → { applied:false, reason: invalid_state:* }', async () => {
    const p = await gate.createProposal(PATCH, VERIFY) // PROPOSED — no skip to PROMOTED
    const res = await json(`/evolution/proposals/${p.id}/promote`, post({}))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ applied: false, reason: 'invalid_state:PROPOSED' })
    expect((await gate.get(p.id))?.state).toBe('PROPOSED')
  })

  test('failure reasons reach the client: metrics missing → reason: metrics_missing', async () => {
    const p = await gate.createProposal(PATCH, VERIFY)
    // park at CANARY_PASSED with NO stage metrics (legacy/unevidenced row)
    gate.store.update(p.id, { state: 'CANARY_PASSED', metadata: { verifyResult: VERIFY }, updatedAt: Date.now() })

    const res = await json(`/evolution/proposals/${p.id}/promote`, post({}))
    expect(res.status).toBe(200)
    expect(res.body.applied).toBe(false)
    expect(res.body.reason).toBe('metrics_missing')
    expect(res.body.regressionBlocked).toBeUndefined()
    expect((await gate.get(p.id))?.state).toBe('CANARY_PASSED')
  })

  test('regression gate: { applied:false, regressionBlocked:true, reason } + rollback', async () => {
    const p = await gate.createProposal(PATCH, VERIFY)
    // canary p95Ms 250 vs baseline 100 = +150% > latency tolerance (5%)
    gate.store.update(p.id, {
      state: 'CANARY_PASSED',
      metadata: {
        verifyResult: VERIFY,
        benchmark: { passed: true, reason: 'ok', before: { p95Ms: 100 } },
        canary: { passed: true, reason: 'ok', metrics: { p95Ms: 250 } },
      },
      updatedAt: Date.now(),
    })

    const res = await json(`/evolution/proposals/${p.id}/promote`, post({}))
    expect(res.status).toBe(200)
    expect(res.body.applied).toBe(false)
    expect(res.body.regressionBlocked).toBe(true)
    expect(String(res.body.reason)).toContain('regression: latency/p95Ms')

    const list = await json('/evolution/proposals?state=ROLLED_BACK')
    expect(list.body.proposals.map((x: { id: string }) => x.id)).toEqual([p.id])
  })

  test('404 for an unknown proposal id', async () => {
    const res = await json('/evolution/proposals/proposal_missing/promote', post({}))
    expect(res.status).toBe(404)
    expect(res.body.applied).toBeUndefined()
  })
})

describe('POST /evolution/proposals/:id/rollback', () => {
  test('400 when body.reason is missing', async () => {
    const p = await gate.createProposal(PATCH, VERIFY)
    const noBody = await json(`/evolution/proposals/${p.id}/rollback`, post({}))
    expect(noBody.status).toBe(400)
    const empty = await json(`/evolution/proposals/${p.id}/rollback`, post({ reason: '  ' }))
    expect(empty.status).toBe(400)
  })

  test('404 for an unknown proposal id', async () => {
    const res = await json('/evolution/proposals/proposal_missing/rollback', post({ reason: 'bad' }))
    expect(res.status).toBe(404)
  })

  test('valid rollback → { ok: true } and state ROLLED_BACK', async () => {
    const p = await gate.createProposal(PATCH, VERIFY)
    const res = await json(`/evolution/proposals/${p.id}/rollback`, post({ reason: 'latency regression' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const list = await json('/evolution/proposals?state=ROLLED_BACK')
    expect(list.body.proposals.map((x: { id: string }) => x.id)).toEqual([p.id])
  })
})

describe('route wiring', () => {
  test('mountEvolutionProposalRoutes registers the same routes on a bare app', async () => {
    const bare = new Hono<{ Variables: { requestId: string } }>()
    mountEvolutionProposalRoutes(bare, { governance: gate })
    const res = await bare.request('/evolution/proposals')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { proposals: unknown[] }
    expect(Array.isArray(body.proposals)).toBe(true)
  })

  test('mountLearningRoutes mounts proposal routes with learning’s gate instance', async () => {
    const system = createLearningSystem({ db, bus })
    const learningApp = new Hono<{ Variables: { requestId: string } }>()
    mountLearningRoutes(learningApp, system)

    const res = await learningApp.request('/evolution/proposals')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { proposals: unknown[] }
    expect(Array.isArray(body.proposals)).toBe(true)

    // the gate wired in is learning's own instance (shares the same store)
    const p = await system.governance.createProposal(PATCH, VERIFY)
    const res2 = await learningApp.request(`/evolution/proposals/${p.id}/advance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as { proposal: { state: string } }
    expect(body2.proposal.state).toBe('BENCHMARK_PASSED')
    expect((await system.governance.get(p.id))?.state).toBe('BENCHMARK_PASSED')
  })
})
