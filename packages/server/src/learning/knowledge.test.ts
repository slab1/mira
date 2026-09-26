import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { embedKeyword, cosine } from './knowledge.js'
import { KNOWLEDGE_SEED_ENTRIES, seedDefaultKnowledge, KnowledgeBase } from './knowledge.js'
import { createLearningSystem, mountLearningRoutes, type LearningSystem } from './index.js'
import { createDatabase, migrate } from '../storage/db.js'
import { writeFinding } from '../tools/findings.js'
import { Bus } from '../bus/index.js'
import type { Insight } from './online.js'
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
  db: ReturnType<typeof createDatabase>
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
  return { system, app, busEvents, db }
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
    const { system, app, busEvents, db } = await testApp()
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
    const { system, app, db } = await testApp()
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

describe('designer des-1 docs-memory seed', () => {
  test('seed defines 8 entries with titles ≤80ch and content 200–800ch', () => {
    expect(KNOWLEDGE_SEED_ENTRIES).toHaveLength(8)
    for (const e of KNOWLEDGE_SEED_ENTRIES) {
      expect(e.title.length).toBeGreaterThan(0)
      expect(e.title.length).toBeLessThanOrEqual(80)
      expect(e.content.length).toBeGreaterThanOrEqual(200)
      expect(e.content.length).toBeLessThanOrEqual(800)
      expect(['episodic', 'semantic', 'procedural']).toContain(e.tier)
    }
  })

  test('seedDefaultKnowledge stores 8 and retrieval finds them', async () => {
    const kb = new KnowledgeBase()
    const stored = await seedDefaultKnowledge(kb)
    expect(stored).toHaveLength(8)
    expect(kb.size()).toBe(8)

    const opencode = await kb.retrieve({ query: 'opencode MCP custom tools setup', limit: 5 })
    expect(opencode.length).toBeGreaterThan(0)
    expect(opencode.some((e) => e.title.toLowerCase().includes('opencode'))).toBe(true)

    const mira = await kb.retrieve({
      query: 'Mira KnowledgeBase hybrid retrieval scoring',
      limit: 5,
    })
    expect(mira.length).toBeGreaterThan(0)
    expect(mira.some((e) => e.tags.includes('retrieval') || e.title.includes('hybrid'))).toBe(true)
  })
})

// ── Phase 2/3: merge counters + 60-day expiry sweep ─────────────────

function insight(id: string, source: string, pattern: string, tags: string[]): Insight {
  return {
    id,
    source,
    sourceTitle: `src ${id}`,
    category: 'agent-technique',
    summary: pattern,
    pattern,
    relevance: 0.9,
    tags,
    rawExcerpt: '',
    createdAt: Date.now(),
  }
}

describe('storeInsight merge counters — verifiers / hitCount / lastSeen', () => {
  test('verifiers counts distinct source URLs; hitCount + lastSeen refresh on every store', async () => {
    const kb = new KnowledgeBase()
    const base = insight('ins_verifiers', 'https://a.example/1', 'Pin tool versions via content hash.', [
      'cache',
    ])

    const first = await kb.storeInsight(base)
    expect(first.metadata.verifiers).toBe(1)
    expect(first.metadata.hitCount).toBe(1)
    const firstSeen = first.metadata.lastSeen as number
    expect(typeof firstSeen).toBe('number')

    // Same pattern backed by a second source → verifiers increments
    const second = await kb.storeInsight({ ...base, source: 'https://b.example/2' })
    expect(second.id).toBe(first.id)
    expect(second.metadata.verifiers).toBe(2)
    expect(second.metadata.hitCount).toBe(2)
    expect(second.metadata.lastSeen as number).toBeGreaterThanOrEqual(firstSeen)

    // A source we've already counted → verifiers unchanged, hitCount still bumps
    const third = await kb.storeInsight(base)
    expect(third.metadata.verifiers).toBe(2)
    expect(third.metadata.hitCount).toBe(3)
    expect(kb.list({ source: 'online' })).toHaveLength(1)
  })
})

describe('60-day expiry sweep — tombstones hidden from retrieval/list', () => {
  test('stale entries are tombstoned and excluded from retrieve() + list()', async () => {
    const kb = new KnowledgeBase()
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000

    const fresh = await kb.storeInsight(
      insight('ins_fresh', 'https://fresh.example/1', 'agent memory retrieval hygiene for sessions', [
        'agent',
        'memory',
        'retrieval',
      ]),
    )
    const stale = await kb.storeInsight(
      insight('ins_stale', 'https://stale.example/1', 'agent memory retrieval hygiene for sessions', [
        'agent',
        'memory',
        'retrieval',
      ]),
    )

    // Backdate the stale entry beyond 60 days (lastSeen + updatedAt)
    const staleEntry = kb.get(stale.id)!
    staleEntry.metadata = { ...staleEntry.metadata, lastSeen: now - 61 * day }
    staleEntry.updatedAt = now - 61 * day

    expect(kb.sweepExpired(now)).toBe(1)
    expect(kb.get(stale.id)!.metadata.tombstone).toBe(1)
    expect(kb.get(fresh.id)!.metadata.tombstone).toBeUndefined()

    // Excluded from list paths
    expect(kb.list().some((e) => e.id === stale.id)).toBe(false)
    expect(kb.list().some((e) => e.id === fresh.id)).toBe(true)

    // Excluded from retrieval
    const res = await kb.retrieve({ query: 'agent memory retrieval', limit: 10, hybrid: false })
    expect(res.some((e) => e.id === stale.id)).toBe(false)
    expect(res.some((e) => e.id === fresh.id)).toBe(true)

    // Idempotent: second sweep finds nothing new
    expect(kb.sweepExpired(now)).toBe(0)
  })
})

// ── Phase 4: /learning/status surfacing ──────────────────────────────

describe('GET /learning/status — topPerforming / worstPerforming', () => {
  test('surfaces top 3 + bottom 3 knowledge entries by utility', async () => {
    const { system, app } = await testApp()
    const specs: Array<[string, number]> = [
      ['ins_top', 5],
      ['ins_mid', 2],
      ['ins_zero', 0],
      ['ins_low', -1],
      ['ins_worst', -3],
    ]
    for (const [id, utility] of specs) {
      const e = await system.knowledge.storeInsight(
        insight(id, `https://x.local/${id}`, `pattern ${id} for status surfacing`, ['status']),
      )
      for (let i = 0; i < Math.abs(utility); i++) {
        system.knowledge.bumpUtility(e.id, utility > 0 ? 1 : -1)
      }
    }

    const res = await app.request('/learning/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      scheduler: unknown
      knowledge: { size: number }
      usage: { sessions: number }
      topPerforming: Array<{ id: string; utility: number }>
      worstPerforming: Array<{ id: string; utility: number }>
    }
    // Existing surface preserved
    expect(body.scheduler).toBeDefined()
    expect(body.knowledge.size).toBe(5)
    // Phase 4 surfacing
    expect(body.topPerforming).toHaveLength(3)
    expect(body.worstPerforming).toHaveLength(3)
    expect(body.topPerforming.map((p) => p.utility)).toEqual([5, 2, 0])
    expect(body.worstPerforming.map((p) => p.utility)).toEqual([-3, -1, 0])
  })
})
