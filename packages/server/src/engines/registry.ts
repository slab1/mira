/**
 * Engine Registry — Phase 3 per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 3 + MIRA_ENGINE_REGISTRY.md
 *
 * Status: Target→Implemented — 9 modular engines behind a single registry (§7). Each engine:
 *   id, version, capabilities[], health(), benchmark(), upgrade(), rollback() per §7 interface.
 * Keeps nvidia primary + colibri opportunistic, respects MIRA_NO_AUTOPROVISION, no local hardware.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence (path / interface) |
 * |---|------|--------|------------------------------|
 * | 1 | Implementation path | Implemented | packages/server/src/engines/registry.ts + 9 engine files + routes/engines.ts |
 * | 2 | Public interfaces | Implemented | EngineRegistry.register/get/list/healthAll/benchmarkAll/upgrade/rollback; MiraEngine{id,version,capabilities,health,benchmark,upgrade,rollback}; GET /engines, GET /engines/:id/health, POST /engines/:id/benchmark, POST /engines/:id/rollback |
 * | 3 | Events | Implemented | engines.ready (log), engine.health/benchmark via Bus (opportunistic) |
 * | 4 | Configuration | Implemented | registry is config-free; per-engine reads MiraConfig but never overrides nvidia primary |
 * | 5 | Tests | Implemented | packages/server/src/engines/registry.test.ts (smoke) + Hono fetch GET /engines 200 |
 * | 6 | Security boundaries | Implemented | no secret leak; MIRA_NO_AUTOPROVISION respected; health never requires colibri |
 * | 7 | Operational procedures | Implemented | instantiate in src/index.ts, register 9 engines, log engines ready — 9 registered, mountEngineRoutes |
 * | 8 | Migration strategy | Implemented | additive; engines/* is new, routes additive, zero-downtime |
 * | 9 | Rollback strategy | Implemented | EngineRegistry.rollback(id) + per-engine rollback(); POST /engines/:id/rollback |
 * | 10 | Known limitations | Implemented | colibri opportunistic 800ms probe; mock upgrade/rollback (version bump) until Phase 4 shadow |
 */

import type { JsonValue } from '../types/index.js'

export interface HealthReport {
  id: string
  version: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  latencyMs?: number
  message?: string
  details?: JsonValue
  timestamp: number
  capabilities: string[]
}

export interface BenchmarkReport {
  id: string
  version: string
  latencyMs: number
  successRate: number
  costDelta: number
  timestamp: number
  details?: JsonValue
}

export interface UpgradeResult {
  id: string
  fromVersion: string
  toVersion: string
  upgraded: boolean
  reason?: string
  timestamp: number
}

export interface MiraEngine {
  id: string
  version: string
  capabilities: string[]
  health(): Promise<HealthReport>
  benchmark(): Promise<BenchmarkReport>
  upgrade(): Promise<UpgradeResult>
  rollback(): Promise<void>
}

export class EngineRegistry {
  private engines = new Map<string, MiraEngine>()
  private priorVersion = new Map<string, string>()

  register(engine: MiraEngine): void {
    if (this.engines.has(engine.id)) {
      throw new Error(`Engine ${engine.id} already registered`)
    }
    this.engines.set(engine.id, engine)
  }

  get(id: string): MiraEngine | undefined {
    return this.engines.get(id)
  }

  list(): MiraEngine[] {
    return [...this.engines.values()]
  }

  ids(): string[] {
    return [...this.engines.keys()]
  }

  count(): number {
    return this.engines.size
  }

  async healthAll(): Promise<Record<string, HealthReport>> {
    const out: Record<string, HealthReport> = {}
    for (const [id, eng] of this.engines) {
      try {
        out[id] = await eng.health()
      } catch (e) {
        out[id] = {
          id,
          version: eng.version,
          status: 'unhealthy',
          message: String(e).slice(0, 500),
          timestamp: Date.now(),
          capabilities: eng.capabilities,
        }
      }
    }
    return out
  }

  async benchmarkAll(): Promise<Record<string, BenchmarkReport>> {
    const out: Record<string, BenchmarkReport> = {}
    for (const [id, eng] of this.engines) {
      try {
        out[id] = await eng.benchmark()
      } catch (e) {
        out[id] = {
          id,
          version: eng.version,
          latencyMs: 0,
          successRate: 0,
          costDelta: 0,
          timestamp: Date.now(),
          details: { error: String(e).slice(0, 500) } as unknown as JsonValue,
        }
      }
    }
    return out
  }

  async upgrade(id: string): Promise<UpgradeResult> {
    const eng = this.engines.get(id)
    if (!eng) throw new Error(`Engine ${id} not found`)
    this.priorVersion.set(id, eng.version)
    const result = await eng.upgrade()
    return result
  }

  async rollback(id: string): Promise<void> {
    const eng = this.engines.get(id)
    if (!eng) throw new Error(`Engine ${id} not found`)
    await eng.rollback()
    // keep priorVersion for audit; next upgrade will overwrite
  }

  /** For routes/tests: snapshot of prior version per engine, if any */
  priorOf(id: string): string | undefined {
    return this.priorVersion.get(id)
  }
}
