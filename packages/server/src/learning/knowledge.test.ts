import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { embedKeyword, cosine } from './knowledge.js'
import { createLearningSystem, mountLearningRoutes, type LearningSystem } from './index.js'
import { createDatabase, migrate } from '../storage/db.js'
import { writeFinding } from '../tools/findings.js'
import { Bus } from '../bus/index.js'
import type { JsonValue } from '../types/index.js'

describe('embedKeyword', () => {
  test('produces unit-length vector', () => {
    const v = embedKeyword('hello world hello')
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1.0, 5)
  })

  test('is deterministic', () => {
    expect(embedKeyword('agent memory retrieval')).toEqual(embedKeyword('agent memory retrieval'))
  })

  test('similar texts score higher than dissimilar', () => {
    const a = embedKeyword('agent tool execution permission guardrail')
    const similar = embedKeyword('tool permission agent guardrail execution')
    const different = embedKeyword('cooking recipe pasta tomato basil')
    expect(cosine(a, similar)).toBeGreaterThan(cosine(a, different))
  })

  test('empty text yields zero vector', () => {
    const v = embedKeyword('')
    expect(v.every((x) => x === 0)).toBe(true)
  })
})

describe('cosine', () => {
  test('identical vectors → ~1', () => {
    const v = embedKeyword('mira agent platform')
    expect(cosine(v, v)).toBeCloseTo(1.0, 5)
  })

  test('orthogonal-ish vectors → low score', () => {
    const a = embedKeyword('alpha beta gamma delta')
    const b = embedKeyword('epsilon zeta eta theta')
    expect(cosine(a, b)).toBeLessThan(0.5)
  })
})

// ── H3-E graph write paths (routes only, via mountLearningRoutes) ────

interface BusCapture {
  type: string
  payload?: unknown
}

async function testApp(): Promise<{
  system: LearningSystem
  app: Hono<{ Variables: { requestId: string } }>
  busEvents: BusCapture[]
}> {
  const db = createDatabase(':memory:')
  await migrate(db)
  const bus = new Bus()
  const busEvents: BusCapture[] = []
  bus.subscribe('job.updated', (e) => {
    busEvents.push({ type: e.type, payload: e.payload })
  })
  const system = createLearningSystem({ db, bus })
  await system.knowledge.load()
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountLearningRoutes(app, system)
  return { system, app, busEvents }
}

function actionOf(payload: unknown): string | undefined {
  return (payload as { action?: unknown })?.action as string | undefined
}

describe('H3-E knowledge graph write paths', () => {
  test('store→getGraph contains node', async () => {
    const { system } = await testApp()
    const entry = await system.knowledge.store({
      tier: 'semantic',
      source: 'user',
      title: 'Graph node probe',
      content: 'probe content',
    })
    const graph = await system.knowledge.getGraph(100)
    expect(graph.nodes.some((n) => n.id === entry.id)).toBe(true)
  })

  test('touch bumps lastAccessedAt/accessCount + publishes touched', async () => {
    const { system, app, busEvents } = await testApp()
    const entry = await system.knowledge.store({
      tier: 'semantic',
      source: 'user',
      title: 'Touch target',
      content: 'touch me',
    })
    const before = entry.lastAccessedAt
    const res = await app.request(`/knowledge/${entry.id}/touch`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; accessCount: number; lastAccessedAt: number }
    expect(body.id).toBe(entry.id)
    expect(body.accessCount).toBe(1)
    expect(body.lastAccessedAt).toBeGreaterThanOrEqual(before)
    expect(busEvents.some((e) => actionOf(e.payload) === 'touched')).toBe(true)
  })

  test('touch 404s unknown ids', async () => {
    const { app } = await testApp()
    const res = await app.request('/knowledge/nope-missing/touch', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('not found')
  })

  test('seed stores user entry → 201 + publishes seeded', async () => {
    const { app, busEvents } = await testApp()
    const res = await app.request('/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Seeded fact', content: 'seeded content', tags: ['seed'] }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      id: string
      source: string
      tier: string
      metadata: Record<string, JsonValue>
    }
    expect(body.source).toBe('user')
    expect(body.tier).toBe('semantic')
    expect(body.metadata['seededFrom']).toBe('graph')
    expect(body.metadata['sessionID']).toBeNull()
    expect(busEvents.some((e) => actionOf(e.payload) === 'seeded')).toBe(true)
  })

  test('seed Zod rejects empty/overlong/bad-tier bodies', async () => {
    const { app } = await testApp()
    const post = (body: unknown): Promise<Response> =>
      Promise.resolve(
        app.request('/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    expect((await post({})).status).toBe(400)
    expect((await post({ title: 'x'.repeat(201), content: 'ok' })).status).toBe(400)
    expect((await post({ title: 'ok', content: 'x'.repeat(4001) })).status).toBe(400)
    expect((await post({ title: 'ok', content: 'ok', tier: 'nope' })).status).toBe(400)
  })

  test('promote e2e: finding resolved + entry metadata.findingId + finding edge', async () => {
    const { system, app, busEvents } = await testApp()
    const db = system.db
    if (!db) throw new Error('test db missing')
    // Shared entity "AuthService" so getGraph links finding → entry
    const anchor = await system.knowledge.store({
      tier: 'semantic',
      source: 'user',
      title: 'AuthService cache policy',
      content: 'cache notes',
    })
    const f = await writeFinding(db, {
      title: 'AuthService retry storm',
      severity: 'major',
      evidence: 'src/auth.ts:42',
      source: 'agent',
    })
    const res = await app.request(`/finding/${f.id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      finding: { id: string; status: string }
      entry: { id: string; metadata: Record<string, JsonValue> }
    }
    expect(body.finding.status).toBe('resolved')
    expect(body.entry.metadata['findingId']).toBe(f.id)
    expect(busEvents.some((e) => actionOf(e.payload) === 'promoted')).toBe(true)
    const graph = await system.knowledge.getGraph(100)
    expect(
      graph.edges.some((e) => e.kind === 'finding' && e.from === f.id && e.to === body.entry.id),
    ).toBe(true)
    expect(anchor.id).toBeTruthy()
  })

  test('promote 404s unknown ids, 409s already-resolved', async () => {
    const { system, app } = await testApp()
    const db = system.db
    if (!db) throw new Error('test db missing')
    const missing = await app.request('/finding/nope-missing/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(missing.status).toBe(404)
    const f = await writeFinding(db, {
      title: 'Twice promoted',
      severity: 'minor',
      source: 'agent',
    })
    const first = await app.request(`/finding/${f.id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(first.status).toBe(201)
    const second = await app.request(`/finding/${f.id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error?: string }
    expect(body.error).toBe('already resolved')
  })
})
