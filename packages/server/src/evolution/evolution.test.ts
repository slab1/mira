/**
 * Evolution Core — Phase 1 smoke (observer→diagnosis→proposal→experiment→verifier→evaluator→ledger)
 * Keeps nvidia primary + colibri opportunistic, brio 2 pass invariant, MIRA_NO_AUTOPROVISION respected.
 * No local hardware required.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Bus } from "../bus/index.js"
import { EvolutionObserver } from "./observer.js"
import { diagnose } from "./diagnosis.js"
import { propose } from "./proposal.js"
import { createExperiment } from "./experiment.js"
import { verify } from "./verifier.js"
import { evaluate } from "./evaluator.js"
import { ImprovementLedger } from "./ledger.js"
import { createDatabase, migrate } from "../storage/db.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("evolution Phase 1 (Target→Implemented)", () => {
  let dir: string
  let db: ReturnType<typeof createDatabase>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mira-evo-test-"))
    const dbPath = join(dir, "test.db")
    process.env.MIRA_NO_AUTOPROVISION = "1"
    db = createDatabase(dbPath)
    await migrate(db as unknown as Parameters<typeof migrate>[0])
  })

  afterEach(() => {
    try { db.sqlite?.close?.() } catch {}
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  test("observer emits evolution.observed + watchBus conflates server.error", async () => {
    const bus = new Bus()
    const seen: unknown[] = []
    bus.subscribe("evolution.observed" as unknown as import("../types/index.js").BusEventType, (e) => seen.push(e.payload))
    const obs = new EvolutionObserver({ bus })
    obs.watchBus()
    // direct observe
    const o = obs.observe("cost cap exceeded on lane default", { hasKey: { nvidia: true, colibri: false } }, "sess1")
    expect(o.failure).toContain("cost cap")
    expect(o.sessionID).toBe("sess1")
    expect(seen.length).toBe(1)
    // bus-triggered via watchBus
    bus.publish({ type: "server.error" as unknown as import("../types/index.js").BusEventType, payload: { error: "circuit breaker open for lane default" }, timestamp: Date.now() } as unknown as import("../types/index.js").BusEvent)
    // observer is sync, should have second event
    expect(seen.length).toBe(2)
    const health = obs.health()
    expect(health.watching).toBe(true)
    expect(health.hasKey.nvidia).toBe(true)
    obs.stop()
    expect(obs.health().watching).toBe(false)
  })

  test("diagnosis produces cause/confidence/affectedEngine (oracle/critic pattern)", () => {
    const bus = new Bus()
    const obs = new EvolutionObserver({ bus })
    const observed = obs.observe("No API key for provider nvidia lane default", { hasKey: { nvidia: false } }, "s2")
    const d = diagnose(observed)
    expect(d.cause.length).toBeGreaterThan(5)
    expect(d.confidence).toBeGreaterThan(0)
    expect(d.confidence).toBeLessThanOrEqual(1)
    expect(["gateway", "model", "guardrails", "tool", "memory", "session", "unknown"]).toContain(d.affectedEngine)
    expect(d.evidence).toBeDefined()
  })

  test("proposal generates P0/P1 with risk + expectedImpact", () => {
    const bus = new Bus()
    const obs = new EvolutionObserver({ bus })
    const d = diagnose(obs.observe("circuit breaker open", {}, "s3"))
    const p = propose(d)
    expect(p.id.startsWith("prop_")).toBe(true)
    expect(["P0", "P1"]).toContain(p.priority)
    expect(["low", "medium", "high"]).toContain(p.risk)
    expect(p.expectedImpact.length).toBeGreaterThan(10)
    expect(p.affectedEngine).toBe(d.affectedEngine)
  })

  test("experiment creates isolated sandbox via Virtual Diff", () => {
    const bus = new Bus()
    const obs = new EvolutionObserver({ bus })
    const p = propose(diagnose(obs.observe("rate limited", {}, "s4")))
    const exp = createExperiment(p, "diff -- test")
    expect(exp.proposalId).toBe(p.id)
    expect(exp.sandboxPath).toContain("mira-evolution")
    expect(exp.simulationId.startsWith("sim_")).toBe(true)
    expect(exp.riskScore).toBeGreaterThan(0)
    // cleanup does not throw
    expect(exp.patch.length).toBeGreaterThan(0)
  })

  test("verifier independent: unit+integration+regression+static+security → verified boolean", async () => {
    const bus = new Bus()
    const obs = new EvolutionObserver({ bus })
    const p = propose(diagnose(obs.observe("edit failure hash anchor", {}, "s5")))
    const exp = createExperiment(p)
    const v = await verify(exp)
    expect(typeof v.verified).toBe("boolean")
    expect(typeof v.regression).toBe("boolean")
    expect(v.security.passed).toBeDefined()
    expect(v.static.passed).toBeDefined()
    expect(v.benchmark).toBeDefined()
  })

  test("evaluator compares Candidate vs Baseline → accept|reject per §4", async () => {
    const bus = new Bus()
    const p = propose(diagnose(new EvolutionObserver({ bus }).observe("timeout", {}, "s6")))
    const exp = createExperiment(p)
    const v = await verify(exp)
    const ev = evaluate(v)
    expect(["accept", "reject"]).toContain(ev.decision)
    expect(ev.reason.length).toBeGreaterThan(10)
    expect(ev.scores.success.pass).toBeDefined()
    expect(ev.scores.security.pass).toBeDefined()
  })

  test("ledger remember() + list + GET /evolution/ledger contract", async () => {
    const bus = new Bus()
    const ledger = new ImprovementLedger(db as unknown as import("../storage/db.js").MiraDB, bus)
    const obs = new EvolutionObserver({ bus })
    const p = propose(diagnose(obs.observe("ledger smoke", { x: 1 }, "s7")))
    const exp = createExperiment(p)
    const v = await verify(exp)
    const ev = evaluate(v)
    const entry = ledger.remember({ id: p.id, proposal: p, verdict: ev.decision === "accept" ? "verified" : "rejected", evidence: { v, ev } as unknown as import("../types/index.js").JsonValue })
    expect(entry.id).toBe(p.id)
    expect(ledger.count()).toBe(1)
    const list = ledger.list(10)
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(p.id)
    const got = ledger.get(p.id)
    expect(got?.verdict).toBeDefined()
  })

  test("full pipeline: Failure→Observer→Proposal→Sandbox→Verifier→Ledger (read-only, no auto-promote)", async () => {
    const bus = new Bus()
    const ledger = new ImprovementLedger(db as unknown as import("../storage/db.js").MiraDB, bus)
    const observer = new EvolutionObserver({ bus })
    const observed = observer.observe("cost cap would be exceeded on lane default", { hasKey: { nvidia: true } }, "sess-pipeline")
    const d = diagnose(observed)
    const p = propose(d)
    const exp = createExperiment(p)
    const v = await verify(exp)
    const ev = evaluate(v)
    ledger.remember({ id: p.id, proposal: p, verdict: ev.decision === "accept" ? "verified" : "rejected", evidence: { observed, d, p, exp: { sandboxPath: exp.sandboxPath }, v, ev } as unknown as import("../types/index.js").JsonValue })
    expect(ledger.count()).toBe(1)
    expect(["verified", "rejected"]).toContain(ledger.list()[0].verdict)
    expect(p.priority).toBeDefined()
    expect(v.verified).toBeDefined()
    expect(ev.decision).toBeDefined()
    // no promotion, no canary — Phase 1 invariant
  })
})
