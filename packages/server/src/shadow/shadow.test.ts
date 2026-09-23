/**
 * Shadow Mira — Phase 4 smoke + routes (Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 4 + MIRA_SYSTEM_DOCUMENTATION.md:11)
 * Keeps nvidia primary + colibri opportunistic, MIRA_NO_AUTOPROVISION respected, no local hardware.
 */

import { describe, it, expect } from 'bun:test'
import { Hono } from 'hono'
import { Bus } from '../bus/index.js'
import { EngineRegistry } from '../engines/registry.js'
import { AgentEngine } from '../engines/agent.js'
import { MemoryEngine } from '../engines/memory.js'
import { RetrievalEngine } from '../engines/retrieval.js'
import { PlanningEngine } from '../engines/planning.js'
import { EvaluationEngine } from '../engines/evaluation.js'
import { LearningEngine } from '../engines/learning.js'
import { ToolEngine } from '../engines/tool.js'
import { SecurityEngine } from '../engines/security.js'
import { ModelEngine } from '../engines/model.js'
import { MetricsCollector } from '../metrics.js'
import { TelemetryCollector } from './telemetry.js'
import { ShadowBenchmark } from './benchmark.js'
import { ShadowComparison } from './comparison.js'
import { ShadowMira } from './shadow.js'
import { mountShadowRoutes } from '../routes/shadow.js'

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
  r.register(new ModelEngine({ providerKeys: () => ['nvidia', 'colibri', 'anthropic'], hasKey: (k) => k === 'nvidia', primary: 'nvidia', fallback: 'colibri' }))
  return r
}

describe('shadow telemetry (isolated, ingests Bus)', () => {
  it('TelemetryCollector subscribes to Bus (server.error, gateway.fallback, evolution.*) and snapshots', () => {
    const bus = new Bus()
    const tc = new TelemetryCollector()
    tc.subscribe(bus)
    bus.publish({ type: 'server.error' as import('../types/index.js').BusEventType, payload: { error: 'boom' } as import('../types/index.js').JsonValue, timestamp: Date.now() } as unknown as import('../types/index.js').BusEvent)
    bus.publish({ type: 'gateway.fallback' as import('../types/index.js').BusEventType, payload: {} as import('../types/index.js').JsonValue, timestamp: Date.now() } as unknown as import('../types/index.js').BusEvent)
    bus.publish({ type: 'evolution.observed' as unknown as import('../types/index.js').BusEventType, payload: {} as import('../types/index.js').JsonValue, timestamp: Date.now() } as unknown as import('../types/index.js').BusEvent)
    const snap = tc.snapshot()
    expect(snap.serverErrors).toBe(1)
    expect(snap.gatewayFallbacks).toBe(1)
    expect(snap.evolutionEvents).toBe(1)
    expect(snap.requestCounts).toBeGreaterThanOrEqual(1)
    expect(snap.recentTypes.length).toBeGreaterThanOrEqual(3)
  })
})

describe('shadow benchmark (EngineRegistry.benchmarkAll + verifier)', () => {
  it('ShadowBenchmark runs benchmarkAll on both engines + verifier suite', async () => {
    const r = buildRegistry()
    const b = new ShadowBenchmark()
    const report = await b.benchmarkAll(r, 'tool')
    expect(report.production).toBeDefined()
    expect(report.candidate).toBeDefined()
    expect(report.delta).toBeDefined()
    expect(report.aggregated.production).toBeDefined()
    expect(report.aggregated.candidate).toBeDefined()
    expect(Object.keys(report.production).length).toBe(9)
    expect(report.verifier).toBeDefined()
    expect(typeof report.verifier!.verified).toBe('boolean')
  })
})

describe('shadow comparison (§16 gates +20%/-0.5pp)', () => {
  it('verdict better / worse / neutral with reasoning', () => {
    const c = new ShadowComparison()
    const base = { successRate: 0.87, latencyMs: 12000, costPerTask: 0.18, regressionRate: 0.04, securityViolations: 0, securityPassed: true }
    // better: improved success + lower latency
    const better = c.compare(base, { ...base, successRate: 0.91, latencyMs: 9000 })
    expect(better.verdict).toBe('better')
    expect(better.reasoning).toContain('better')
    expect(better.allPass).toBe(true)
    // worse: latency +50%
    const worse = c.compare(base, { ...base, latencyMs: 20000 })
    expect(worse.verdict).toBe('worse')
    expect(worse.reasoning).toContain('worse')
    expect(worse.gates.latency).toBe(false)
    // worse: security fail
    const secWorse = c.compare(base, { ...base, securityViolations: 1, securityPassed: false })
    expect(secWorse.verdict).toBe('worse')
    expect(secWorse.gates.security).toBe(false)
    // neutral: same as baseline (allPass true but no improvement)
    const neutral = c.compare(base, { ...base })
    expect(neutral.verdict).toBe('neutral')
    expect(neutral.allPass).toBe(true)
  })
})

describe('shadow routes (Hono fetch 3 endpoints 200)', () => {
  it('GET /shadow/health + POST /shadow/start + GET /shadow + GET /shadow/:id + POST /shadow/:id/compare all 200', async () => {
    process.env.MIRA_NO_AUTOPROVISION = '1'
    const bus = new Bus()
    const registry = buildRegistry()
    const metrics = new MetricsCollector()
    const shadow = new ShadowMira({ registry, bus, metrics })
    const app = new Hono()
    mountShadowRoutes(app as unknown as Hono<{ Variables: { requestId: string } }>, { shadow })

    // GET /shadow/health — 200
    let res = await app.request('/shadow/health')
    expect(res.status).toBe(200)
    let j = (await res.json()) as { ok: boolean; phase: string; primary: string; fallback: string }
    expect(j.ok).toBe(true)
    expect(j.phase).toBe('Phase 4 Shadow Mira')
    expect(j.primary).toBe('nvidia')
    expect(j.fallback).toBe('colibri')

    // GET /shadow — 200 (empty)
    res = await app.request('/shadow')
    expect(res.status).toBe(200)
    j = (await res.json()) as unknown as typeof j & { count: number }
    expect((j as unknown as { count: number }).count).toBe(0)

    // POST /shadow/start — 200 with shadowId,candidateVersion,parentVersion + ShadowResult
    res = await app.request('/shadow/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateEngineId: 'tool' }),
    })
    expect(res.status).toBe(200)
    const start = (await res.json()) as { ok: boolean; shadowId: string; candidateVersion: string; parentVersion: string; result: { production: unknown; candidate: unknown; comparison: unknown; verdict: string }; benchmark: unknown }
    expect(start.ok).toBe(true)
    expect(start.shadowId).toMatch(/^shdw_/)
    expect(start.candidateVersion).toBeDefined()
    expect(start.parentVersion).toBeDefined()
    expect(start.result).toBeDefined()
    expect(start.result.production).toBeDefined()
    expect(start.result.candidate).toBeDefined()
    expect(start.result.comparison).toBeDefined()
    // comparison must have success/latency/cost/regression/security
    const comp = (start.result.comparison as Record<string, unknown>)
    expect(comp.success).toBeDefined()
    expect(comp.latency).toBeDefined()
    expect(comp.cost).toBeDefined()
    expect(comp.regression).toBeDefined()
    expect(comp.security).toBeDefined()
    const shadowId = start.shadowId

    // GET /shadow — now 1
    res = await app.request('/shadow')
    expect(res.status).toBe(200)
    const list = (await res.json()) as { count: number; shadows: Array<{ shadowId: string }> }
    expect(list.count).toBe(1)
    expect(list.shadows[0].shadowId).toBe(shadowId)

    // GET /shadow/:id — 200
    res = await app.request(`/shadow/${shadowId}`)
    expect(res.status).toBe(200)
    const one = (await res.json()) as { ok: boolean; shadow: { shadowId: string; result: unknown } }
    expect(one.ok).toBe(true)
    expect(one.shadow.shadowId).toBe(shadowId)

    // POST /shadow/:id/compare — 200 with verdict better|worse|neutral
    res = await app.request(`/shadow/${shadowId}/compare`, { method: 'POST' })
    expect(res.status).toBe(200)
    const cmpRes = (await res.json()) as { ok: boolean; verdict: string; reasoning: string; scores: unknown; gates: unknown }
    expect(cmpRes.ok).toBe(true)
    expect(['better', 'worse', 'neutral']).toContain(cmpRes.verdict)
    expect(cmpRes.reasoning.length).toBeGreaterThan(10)
    expect(cmpRes.scores).toBeDefined()
    expect(cmpRes.gates).toBeDefined()

    // 400 on missing candidateEngineId
    res = await app.request('/shadow/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
    expect(res.status).toBe(400)
    // 404 on unknown engine
    res = await app.request('/shadow/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidateEngineId: 'unknown_engine' }) })
    expect(res.status).toBe(404)
    // 404 on unknown shadow
    res = await app.request('/shadow/not_exist')
    expect(res.status).toBe(404)
  })
})
