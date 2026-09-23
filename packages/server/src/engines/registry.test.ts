/**
 * Engine Registry — smoke test per Phase 3 spec
 * Verifies: 9 engines listed, healthAll, benchmark, upgrade/rollback, Hono GET /engines 200
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
  r.register(new ModelEngine({ providerKeys: () => ['nvidia','colibri','anthropic'], hasKey: (k)=> k==='nvidia', primary:'nvidia', fallback:'colibri' }))
  return r
}

describe('engines registry', () => {
  it('lists 9 engines', () => {
    const r = buildRegistry()
    expect(r.count()).toBe(9)
    const ids = r.ids().sort()
    expect(ids).toEqual(['agent','evaluation','learning','memory','model','planning','retrieval','security','tool'].sort())
  })

  it('healthAll returns 9 reports', async () => {
    const r = buildRegistry()
    const health = await r.healthAll()
    expect(Object.keys(health).length).toBe(9)
    for (const id of r.ids()) {
      expect(health[id]).toBeDefined()
      expect(['healthy','degraded','unhealthy']).toContain(health[id].status)
      expect(health[id].id).toBe(id)
    }
    // model primary is nvidia
    expect(health['model'].details).toBeDefined()
    const det = health['model'].details as Record<string, unknown>
    expect(det.primary).toBe('nvidia')
    expect(det.fallback).toBe('colibri')
  })

  it('benchmarkAll + upgrade/rollback', async () => {
    const r = buildRegistry()
    const bench = await r.benchmarkAll()
    expect(Object.keys(bench).length).toBe(9)
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
    const j = await res.json() as { ok:boolean; count:number; engines:Array<{id:string}>; primary:string }
    expect(j.ok).toBe(true)
    expect(j.count).toBe(9)
    expect(j.engines.length).toBe(9)
    expect(j.primary).toBe('nvidia')
    // GET /engines/:id/health
    res = await app.fetch(new Request('http://x/engines/agent/health'))
    expect(res.status).toBe(200)
    const hj = await res.json() as { ok:boolean; health:{ id:string } }
    expect(hj.ok).toBe(true)
    expect(hj.health.id).toBe('agent')
    // POST /engines/:id/benchmark
    res = await app.fetch(new Request('http://x/engines/model/benchmark', { method:'POST' }))
    expect(res.status).toBe(200)
    // POST /engines/:id/rollback
    const verBefore = r.get('tool')!.version
    await r.upgrade('tool')
    res = await app.fetch(new Request('http://x/engines/tool/rollback', { method:'POST' }))
    expect(res.status).toBe(200)
    expect(r.get('tool')!.version).toBe(verBefore)
  })
})
