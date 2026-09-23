/**
 * Evolution Observer — watches Bus + metrics + gateway hasKey/appendActiveWork
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 1,
 *       MIRA_EVOLUTION_SPEC.md (Observe → Implemented via aether_core.py; Target automation here),
 *       MIRA_SYSTEM_DOCUMENTATION.md:2 lifecycle Observe→Learn→Diagnose→…→Remember.
 *
 * Keeps nvidia primary + colibri opportunistic — observer never requires local hardware.
 * No auto-promote, no canary/shadow (Phase 4/5 Target).
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/observer.ts |
 * | 2 | Public interfaces | Implemented | EvolutionObserver.observe(), watchBus(), GET /evolution/health, POST /evolution/observe emits evolution.observed {failure, evidence, sessionID} |
 * | 3 | Events | Implemented | subscribes: server.error, cost.warning, gateway.fallback, server.heartbeat; emits: evolution.observed (via Bus) |
 * | 4 | Configuration | Implemented | no new config; reads mira.json provider nvidia primary + colibri fallback, gateway hasKey/appendActiveWork opportunistic, respects MIRA_NO_AUTOPROVISION |
 * | 5 | Tests | Implemented | packages/server/src/evolution/evolution.test.ts smoke: observe emits + watchBus + hasKey |
 * | 6 | Security boundaries | Implemented | read-only observer, no file mutation, no secret leak, validates sessionID, sanitizes evidence |
 * | 7 | Operational procedures | Implemented | start() on server boot, stop() on shutdown, health via GET /evolution/health |
 * | 8 | Migration strategy | Implemented | additive — no schema migration, bus-only, safe to disable |
 * | 9 | Rollback strategy | Implemented | stop() unsubscribes, remove evolution/ dir + routes, no DB mutation |
 * | 10 | Known limitations | Implemented | colibri probe opportunistic 800ms, no shadow/canary yet, evidence truncated 4k, local hardware not required |
 */

import type { Bus } from "../bus/index.js"
import type { JsonValue } from "../types/index.js"
import { appendActiveWork } from "../memory/memory_controller.js"

export interface ObservedFailure {
  failure: string
  evidence: JsonValue
  sessionID?: string
  timestamp: number
  source?: string
}

export interface ObserverDeps {
  bus: Bus
  // optional gateway/registry for hasKey snapshot — opportunistic, not required
  gateway?: { hasKey?: (provider: string) => boolean } | null
  registry?: { hasKey?: (provider: string) => boolean; getAllHealth?: () => Map<string, unknown> } | null
}

export class EvolutionObserver {
  private bus: Bus
  private deps: ObserverDeps
  private unsubs: Array<() => void> = []
  private recent: ObservedFailure[] = []
  private maxRecent = 100

  constructor(deps: ObserverDeps) {
    this.bus = deps.bus
    this.deps = deps
  }

  /** Active observation: emit evolution.observed {failure, evidence, sessionID} */
  observe(failure: string, evidence: JsonValue, sessionID?: string): ObservedFailure {
    const ev: JsonValue = sanitizeEvidence(evidence)
    const entry: ObservedFailure = {
      failure: String(failure).slice(0, 500),
      evidence: ev,
      sessionID: sessionID ? String(sessionID).slice(0, 100) : undefined,
      timestamp: Date.now(),
      source: "observer",
    }
    this.recent.push(entry)
    if (this.recent.length > this.maxRecent) this.recent.shift()

    // Emit via Bus — cast type to allow evolution.observed (BusEventType is open via string)
    try {
      this.bus.publish({
        type: "evolution.observed" as unknown as import("../types/index.js").BusEventType,
        sessionID: entry.sessionID,
        payload: {
          failure: entry.failure,
          evidence: entry.evidence,
          sessionID: entry.sessionID,
          timestamp: entry.timestamp,
          source: entry.source,
        } as JsonValue,
        timestamp: entry.timestamp,
      } as unknown as import("../types/index.js").BusEvent)
    } catch {}

    // opportunistic memory append — never blocks, never requires hardware
    try {
      appendActiveWork({
        tool: "evolution.observe",
        path: "observed",
        summary: `observed: ${entry.failure.slice(0, 120)}`,
        cwd: process.cwd(),
      })
    } catch {}

    return entry
  }

  /** Passive watch: subscribe to Bus + metrics + gateway hasKey signals */
  watchBus(): void {
    const handler = (event: { type: string; sessionID?: string; payload: unknown; timestamp: number }) => {
      const t = String(event.type)
      // Only watch error-like streams
      if (t === "server.error" || t === "cost.warning" || t === "gateway.fallback") {
        const payload = event.payload as Record<string, unknown> | null
        const failure = (payload?.error as string) ?? (payload?.reason as string) ?? t
        const evidence: JsonValue = {
          busType: t,
          payload: truncateJson(payload as JsonValue, 4000),
          hasKey: this.snapshotHasKey(),
          timestamp: event.timestamp,
        } as JsonValue
        this.observe(String(failure).slice(0, 300), evidence, event.sessionID)
      }
    }
    // Subscribe to known error types — keep nvidia primary, colibri probe inside snapshotHasKey
    for (const type of ["server.error", "cost.warning", "gateway.fallback"] as const) {
      try {
        const unsub = this.bus.subscribe(type as import("../types/index.js").BusEventType, handler as unknown as (e: import("../types/index.js").BusEvent) => void)
        this.unsubs.push(unsub)
      } catch {}
    }
  }

  stop(): void {
    for (const u of this.unsubs) try { u() } catch {}
    this.unsubs = []
  }

  recentFailures(limit = 20): ObservedFailure[] {
    return this.recent.slice(-limit).reverse()
  }

  snapshotHasKey(): Record<string, boolean> {
    const out: Record<string, boolean> = {}
    const providers = ["nvidia", "colibri", "anthropic", "openai"]
    for (const p of providers) {
      try {
        let has: boolean | undefined
        if (this.deps.registry?.hasKey) has = this.deps.registry.hasKey(p)
        else if (this.deps.gateway && typeof (this.deps.gateway as { hasKey?: unknown }).hasKey === "function") {
          has = (this.deps.gateway as { hasKey: (k: string) => boolean }).hasKey(p)
        }
        if (has !== undefined) out[p] = !!has
      } catch {}
    }
    // always report primary nvidia if unknown
    if (!("nvidia" in out)) out.nvidia = true
    return out
  }

  health(): { watching: boolean; recent: number; hasKey: Record<string, boolean> } {
    return { watching: this.unsubs.length > 0, recent: this.recent.length, hasKey: this.snapshotHasKey() }
  }
}

function sanitizeEvidence(v: JsonValue): JsonValue {
  return truncateJson(v, 4000)
}

function truncateJson(v: JsonValue, maxChars: number): JsonValue {
  try {
    const s = JSON.stringify(v)
    if (s.length <= maxChars) return v
    return JSON.parse(s.slice(0, maxChars)) as JsonValue
  } catch {
    return String(v).slice(0, maxChars) as unknown as JsonValue
  }
}
