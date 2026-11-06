/**
 * Engine Registry — smoke test per Phase 3 spec and Vision engineering initiatives
 * Verifies: 15 engines listed (including 7 flagship engineering initiatives), healthAll, benchmark, upgrade/rollback, Hono GET /engines 200
 * Keeps nvidia primary + colibri opportunistic, MIRA_NO_AUTOPROVISION respected
 */

import { describe, it, expect } from 'bun:test'
import { Hono } from 'hono'
import { EngineRegistry } from './registry.js'
import { AgentEngine } from './agent.js'
import { MemoryEngine } from './memory.js'
import { RetrievalEngine } from './retrieval.js'
import { PlanningEngine } from './planning.js'
import { EvaluationEngine } from './evaluation.js'
import { LearningEngine } from './learning.js'
import { ToolEngine } from './tool.js'
import { SecurityEngine } from './security.js'
import { ModelEngine } from './model.js'
import { EvolutionEngine } from './evolution.js'
import { ShadowEngine } from './shadow.js'
import { LedgerEngine } from './ledger.js'
import { ResearchEngine } from './research.js'
import { PatchEngine } from './patch.js'
import { SelfHealingEngine } from './self-healing.js'
import { mountEngineRoutes } from '../routes/engines.js'

function buildRegistry(): EngineRegistry {
  const r = new EngineRegistry()
  r.register(new AgentEngine())
  r.register(new MemoryEngine())
  r.register(new RetrievalEngine())
  r.register(new PlanningEngine())
  r.register(new EvaluationEngine())
  r.register(new LearningEngine())
  r.register(new ToolEngine({ count: () => 22 }))
  r.register(new SecurityEngine())
  r.register(
    new ModelEngine({
      providerKeys: () => ['nvidia', 'colibri', 'anthropic'],
      hasKey: (k) => k === 'nvidia',
      primary: 'nvidia',
      fallback: 'colibri',
    }),
  )
  r.register(new EvolutionEngine())
  r.register(new ShadowEngine())
  r.register(new LedgerEngine())
  r.register(new ResearchEngine())
  r.register(new PatchEngine())
  r.register(new SelfHealingEngine())
  return r
}

describe('engines registry', () => {
  it('lists 15 engines including flagship initiatives', () => {
    const r = buildRegistry()
    expect(r.count()).toBe(15)
    const ids = r.ids().sort()
    expect(ids).toEqual(
      [
        'agent',
        'evaluation',
        'evolution',
        'learning',
        'ledger',
        'memory',
        'model',
        'patch',
        'planning',
        'research',
        'retrieval',
        'security',
        'self-healing',
        'shadow',
        'tool',
      ].sort(),
    )
  })

  it('healthAll returns 15 reports', async () => {
    const r = buildRegistry()
    const health = await r.healthAll()
    expect(Object.keys(health).length).toBe(15)
    for (const id of r.ids()) {
      expect(health[id]).toBeDefined()
      expect(['healthy', 'degraded', 'unhealthy']).toContain(health[id].status)
      expect(health[id].id).toBe(id)
    }
    // model primary is nvidia
    expect(health['model'].details).toBeDefined()
    const det = health['model'].details as Record<string, unknown>
    expect(det.primary).toBe('nvidia')
    expect(det.fallback).toBe('colibri')

    // evolution, shadow, patch, self-healing engines are healthy
    expect(health['evolution'].status).toBe('healthy')
    expect(health['shadow'].status).toBe('healthy')
    expect(health['patch'].status).toBe('healthy')
    expect(health['self-healing'].status).toBe('healthy')
  })

  it('benchmarkAll + upgrade/rollback', async () => {
    const r = buildRegistry()
    const bench = await r.benchmarkAll()
    expect(Object.keys(bench).length).toBe(15)
    const before = r.get('agent')!.version
    const up = await r.upgrade('agent')
    expect(up.upgraded).toBe(true)
    expect(up.fromVersion).toBe(before)
    expect(r.get('agent')!.version).toBe(up.toVersion)
    await r.rollback('agent')
    expect(r.get('agent')!.version).toBe(before)
  })

  it('GET /engines 200 via Hono fetch', async () => {
    const r = buildRegistry()
    const app = new Hono()
    mountEngineRoutes(app as unknown as Hono<{ Variables: { requestId: string } }>, { registry: r })
    let res = await app.fetch(new Request('http://x/engines'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as {
      ok: boolean
      count: number
      engines: Array<{ id: string }>
      primary: string
    }
    expect(j.ok).toBe(true)
    expect(j.count).toBe(15)
    expect(j.engines.length).toBe(15)
    expect(j.primary).toBe('nvidia')
    // GET /engines/:id/health
    res = await app.fetch(new Request('http://x/engines/agent/health'))
    expect(res.status).toBe(200)
    const hj = (await res.json()) as { ok: boolean; health: { id: string } }
    expect(hj.ok).toBe(true)
    expect(hj.health.id).toBe('agent')
    // POST /engines/:id/benchmark
    res = await app.fetch(new Request('http://x/engines/model/benchmark', { method: 'POST' }))
    expect(res.status).toBe(200)
    // POST /engines/:id/rollback
    const verBefore = r.get('tool')!.version
    await r.upgrade('tool')
    res = await app.fetch(new Request('http://x/engines/tool/rollback', { method: 'POST' }))
    expect(res.status).toBe(200)
    expect(r.get('tool')!.version).toBe(verBefore)
  })
})
