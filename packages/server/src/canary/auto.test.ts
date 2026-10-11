import { describe, it, expect } from 'bun:test'
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
import { createDatabase } from '../storage/db.js'
import { ImprovementLedger } from '../evolution/ledger.js'
import { CanaryManager } from './canary.js'

// Canary auto mode (MIRA_CANARY_AUTO=1 / startCanary opts.auto) — at duration
// expiry the manager ACTS on the promoter's evaluate decision instead of
// leaving promote/rollback to a manual HTTP call. Opt-in; manual
// promote/rollback clears the timer so auto cannot double-act.

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
  return r
}

const harness = () => {
  const bus = new Bus()
  const events: Array<{ type: string; payload: unknown }> = []
  bus.subscribe('canary.promoted' as never, (e) =>
    events.push({ type: 'promoted', payload: e.payload }),
  )
  bus.subscribe('canary.rollback' as never, (e) =>
    events.push({ type: 'rollback', payload: e.payload }),
  )
  const registry = buildRegistry()
  const metrics = new MetricsCollector()
  const db = createDatabase(':memory:')
  const ledger = new ImprovementLedger(db as unknown as import('../storage/db.js').MiraDB, bus)
  const manager = new CanaryManager({ registry, bus, ledger, metrics })
  return { manager, events }
}

describe('canary auto mode', () => {
  it('auto-promotes at expiry when the canary is healthy and better', async () => {
    const { manager, events } = harness()
    const out = manager.startCanary('tool', 5, 120, { auto: true })
    // healthier than baseline → evaluate() → promote
    manager.monitor.record(out.canaryId, {
      success: 0.91,
      errors: 0,
      regression: 0.02,
      latency: 9000,
      cost: 0.14,
      timestamp: Date.now(),
    })

    // wait past the 120ms duration + a beat for the async promote
    await Bun.sleep(500)
    const rec = manager.get(out.canaryId)
    expect(rec?.status).toBe('promoted')
    expect(events.some((e) => e.type === 'promoted')).toBe(true)
  })

  it('no auto (default): expiry leaves the decision manual', async () => {
    const { manager, events } = harness()
    const out = manager.startCanary('memory', 5, 120)
    manager.monitor.record(out.canaryId, {
      success: 0.91,
      errors: 0,
      regression: 0.02,
      latency: 9000,
      cost: 0.14,
      timestamp: Date.now(),
    })
    await Bun.sleep(400)
    const rec = manager.get(out.canaryId)
    // completed by the expiry check, but NOT auto-promoted/rolled back
    expect(rec?.status).toBe('completed')
    expect(events.length).toBe(0)
  })

  it('manual promote clears the expiry timer — auto never double-acts', async () => {
    const { manager, events } = harness()
    const out = manager.startCanary('tool', 5, 120, { auto: true })
    manager.monitor.record(out.canaryId, {
      success: 0.91,
      errors: 0,
      regression: 0.02,
      latency: 9000,
      cost: 0.14,
      timestamp: Date.now(),
    })
    await manager.promote(out.canaryId)
    await Bun.sleep(400)
    // exactly one promoted event — the expiry timer was cleared
    expect(events.filter((e) => e.type === 'promoted').length).toBe(1)
    expect(manager.get(out.canaryId)?.status).toBe('promoted')
  })
})
