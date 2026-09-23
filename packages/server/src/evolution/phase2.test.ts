/**
 * Phase 2 Safety — Risk + Autonomy + Approval + Resources + Security + Rollback
 * Keeps nvidia primary + colibri opportunistic, MIRA_NO_AUTOPROVISION respected, no local hardware.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Bus } from "../bus/index.js"
import { RiskEngine } from "./risk.js"
import { AutonomyLevels, selectLevel, requiresApproval } from "./autonomy.js"
import { ApprovalGate } from "./approval.js"
import { ResourceLimits } from "./resources.js"
import { SecurityValidator } from "./security.js"
import { RollbackManager } from "./rollback.js"
import { ImprovementLedger } from "./ledger.js"
import { EvolutionObserver } from "./observer.js"
import { diagnose } from "./diagnosis.js"
import { propose } from "./proposal.js"
import { createExperiment } from "./experiment.js"
import { createDatabase, migrate } from "../storage/db.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { mountEvolutionRoutes } from "../routes/evolution.js"

describe("Phase 2 Safety — RiskEngine", () => {
  test("assess high-risk: guardrails + many files + large patch + P0 + cost", () => {
    const engine = new RiskEngine()
    const r = engine.assess({
      priority: "P0",
      affectedEngine: "guardrails",
      changedFiles: ["packages/server/src/guardrails/index.ts", "packages/server/src/config/store.ts", "mira.json", "auth.ts", "secrets.ts", "perm.ts"],
      patch: "x".repeat(6000),
      permissionScope: "guardrails",
      cost: 1.5,
      risk: "high",
    } as unknown as Parameters<typeof engine.assess>[0])
    expect(r.level).toBe("high")
    expect(r.score).toBeGreaterThan(0.6)
    expect(r.reasons.length).toBeGreaterThan(2)
  })

  test("assess low-risk: single file small patch P1", () => {
    const engine = new RiskEngine()
    const r = engine.assess({
      priority: "P1",
      affectedEngine: "tool",
      changedFiles: ["packages/server/src/tools/read.ts"],
      patch: "small fix",
      permissionScope: "read",
      cost: 0.02,
    } as unknown as Parameters<typeof engine.assess>[0])
    expect(r.level).toBe("low")
    expect(r.score).toBeLessThan(0.35)
  })

  test("assess medium-risk: gateway medium files", () => {
    const engine = new RiskEngine()
    const r = engine.assess({
      priority: "P1",
      affectedEngine: "gateway",
      changedFiles: ["packages/server/src/gateway/subgateway.ts", "packages/server/src/gateway/registry.ts", "packages/server/src/gateway/router.ts"],
      patch: "x".repeat(1200),
      permissionScope: "write",
      cost: 0.3,
    } as unknown as Parameters<typeof engine.assess>[0])
    expect(["medium", "high"]).toContain(r.level)
  })
})

describe("Phase 2 Safety — AutonomyLevels", () => {
  test("selectLevel 0-5 and requiresApproval high-risk → human per §18", () => {
    expect(selectLevel("low", { priority: "P1", affectedEngine: "tool" })).toBe(AutonomyLevels.Autonomous)
    expect(selectLevel("high", { priority: "P1", affectedEngine: "tool" })).toBe(AutonomyLevels.Suggest)
    expect(selectLevel("medium", { priority: "P1", affectedEngine: "gateway" })).toBe(AutonomyLevels.Execute)
    // high-risk always requires approval regardless of level
    expect(requiresApproval(AutonomyLevels.Suggest, "high")).toBe(true)
    expect(requiresApproval(AutonomyLevels.Autonomous, "high")).toBe(true)
    expect(requiresApproval(AutonomyLevels.Autonomous, "low")).toBe(false)
    expect(requiresApproval(AutonomyLevels.Canary, "medium")).toBe(true)
    expect(requiresApproval(AutonomyLevels.Execute, "medium")).toBe(false)
  })

  test("P0 caps autonomy one level lower, guardrails caps to Suggest", () => {
    const lowP1 = selectLevel("low", { priority: "P1", affectedEngine: "tool" })
    const lowP0 = selectLevel("low", { priority: "P0", affectedEngine: "tool" })
    expect(lowP0).toBeLessThan(lowP1)
    expect(selectLevel("medium", { priority: "P1", affectedEngine: "guardrails" })).toBe(AutonomyLevels.Suggest)
  })
})

describe("Phase 2 Safety — ApprovalGate", () => {
  test("requestApproval low-risk auto-approved, high-risk pending, emits evolution.approval", () => {
    const bus = new Bus()
    const seen: unknown[] = []
    bus.subscribe("evolution.approval" as unknown as import("../types/index.js").BusEventType, (e) => seen.push(e.payload))
    const gate = new ApprovalGate({ bus })
    const lowProp = { id: "prop_low", risk: "low", priority: "P1", affectedEngine: "tool" } as unknown as import("./proposal.js").ImprovementProposal
    const low = gate.requestApproval(lowProp, AutonomyLevels.Autonomous, { level: "low", score: 0.1, reasons: ["low"] })
    expect(low.approved).toBe(true)
    // high-risk at Canary → pending
    const highProp = { id: "prop_high", risk: "high", priority: "P0", affectedEngine: "guardrails" } as unknown as import("./proposal.js").ImprovementProposal
    const high = gate.requestApproval(highProp, AutonomyLevels.Canary, { level: "high", score: 0.9, reasons: ["guardrails"] })
    expect(high.approved).toBe(false)
    expect(high.pending).toBe(true)
    expect(gate.isPending("prop_high")).toBe(true)
    expect(seen.length).toBeGreaterThanOrEqual(2)
    // approve via POST equivalent
    const ok = gate.approve("prop_high", "human-test")
    expect(ok.approved).toBe(true)
    expect(gate.isPending("prop_high")).toBe(false)
  })
})

describe("Phase 2 Safety — ResourceLimits (§13)", () => {
  test("checkBudget per-task/per-agent/per-mission/daily", () => {
    const limits = new ResourceLimits({ caps: { perTask: 0.5, perAgent: 1, perMission: 2, daily: 3 } })
    const p = { id: "prop1", affectedEngine: "tool", priority: "P1" } as unknown as import("./proposal.js").ImprovementProposal
    expect(limits.checkBudget(p as unknown as Parameters<typeof limits.checkBudget>[0], 0.1).allowed).toBe(true)
    expect(limits.checkBudget(p as unknown as Parameters<typeof limits.checkBudget>[0], 0.6).allowed).toBe(false) // perTask 0.5
    // per-agent: spend 0.6 + 0.6 >1
    const lim2 = new ResourceLimits({ caps: { perTask: 5, perAgent: 1, perMission: 10, daily: 10 } })
    expect(lim2.checkBudget({ ...p, affectedEngine: "gateway" } as unknown as Parameters<typeof lim2.checkBudget>[0], 0.6).allowed).toBe(true)
    expect(lim2.checkBudget({ ...p, affectedEngine: "gateway" } as unknown as Parameters<typeof lim2.checkBudget>[0], 0.6).allowed).toBe(false)
  })

  test("daily budget breach emits evolution.budget", () => {
    const bus = new Bus()
    const seen: unknown[] = []
    bus.subscribe("evolution.budget" as unknown as import("../types/index.js").BusEventType, (e) => seen.push(e.payload))
    const lim = new ResourceLimits({ caps: { perTask: 10, perAgent: 100, perMission: 100, daily: 0.3 }, bus })
    const p = { id: "p2", affectedEngine: "tool" } as unknown as import("./proposal.js").ImprovementProposal
    expect(lim.checkBudget(p as unknown as Parameters<typeof lim.checkBudget>[0], 0.2).allowed).toBe(true)
    const blocked = lim.checkBudget(p as unknown as Parameters<typeof lim.checkBudget>[0], 0.2)
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toContain("daily budget")
    expect(seen.length).toBe(1)
  })
})

describe("Phase 2 Safety — SecurityValidator (§8)", () => {
  test("validate detects secrets, permission escalation, static checks", () => {
    const v = new SecurityValidator()
    expect(v.validate("fix: read tool small diff").passed).toBe(true)
    const secret = v.validate("patch touches MIRA_TOKEN and api_key=xxx")
    expect(secret.passed).toBe(false)
    expect(secret.findings.join(" ")).toContain("MIRA_TOKEN")
    const esc = v.validate("guardrails.enforce = false and chmod 777 + sudo")
    expect(esc.passed).toBe(false)
    expect(esc.findings.some((f) => /permission escalation/i.test(f))).toBe(true)
    const inj = v.validate("eval(something) + child_process execSync")
    expect(inj.passed).toBe(false)
  })
})

describe("Phase 2 Safety — RollbackManager (§6)", () => {
  let dir: string
  let db: ReturnType<typeof createDatabase>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mira-rollback-test-"))
    const dbPath = join(dir, "test.db")
    process.env.MIRA_NO_AUTOPROVISION = "1"
    db = createDatabase(dbPath)
    await migrate(db as unknown as Parameters<typeof migrate>[0])
  })
  afterEach(() => {
    try { db.sqlite?.close?.() } catch {}
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  test("createRollbackPoint + rollback (file revert + DB + config per §6)", () => {
    const bus = new Bus()
    const ledger = new ImprovementLedger(db as unknown as import("../storage/db.js").MiraDB, bus)
    const mgr = new RollbackManager({ db: db as unknown as import("../storage/db.js").MiraDB, bus, ledger })
    const p = { id: "prop_rb1", title: "test", type: "fix", risk: "low", priority: "P1", affectedEngine: "tool", evidence: null, expectedImpact: "", cause: "", confidence: 0.9, createdAt: Date.now() } as unknown as import("./proposal.js").ImprovementProposal
    ledger.remember({ id: p.id, proposal: p, verdict: "verified" as unknown as import("./ledger.js").LedgerVerdict, evidence: { ok: true } as unknown as import("../types/index.js").JsonValue })
    const point = mgr.createRollbackPoint(p.id)
    expect(point.version).toContain(p.id)
    expect(Array.isArray(point.snapshotIds)).toBe(true)
    // rollback marks ledger as rolledback and emits
    const seen: unknown[] = []
    bus.subscribe("evolution.rollback" as unknown as import("../types/index.js").BusEventType, (e) => seen.push(e.payload))
    mgr.rollback(p.id)
    const after = ledger.get(p.id)
    expect(after?.verdict).toBe("rolledback")
    expect(seen.length).toBeGreaterThanOrEqual(1)
  })
})

describe("Phase 2 Safety — wired routes (Risk→Autonomy→Approval→Resources→Security before Verifier)", () => {
  let dir: string
  let db: ReturnType<typeof createDatabase>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mira-evo-phase2-routes-"))
    const dbPath = join(dir, "test.db")
    process.env.MIRA_NO_AUTOPROVISION = "1"
    db = createDatabase(dbPath)
    await migrate(db as unknown as Parameters<typeof migrate>[0])
  })
  afterEach(() => {
    try { db.sqlite?.close?.() } catch {}
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  test("GET /evolution/health shows phase:\"Phase 2 Safety\" when wired", async () => {
    const bus = new Bus()
    const app = new Hono()
    mountEvolutionRoutes(app as unknown as Hono<{ Variables: { requestId: string } }>, { db: db as unknown as import("../storage/db.js").MiraDB, bus })
    const res = await app.request("/evolution/health")
    expect(res.status).toBe(200)
    const body = await res.json() as { phase: string }
    expect(body.phase).toBe("Phase 2 Safety")
  })

  test("POST /evolution/observe gated: low-risk passes to verifier, high-risk+secret blocked", async () => {
    const bus = new Bus()
    const app = new Hono()
    mountEvolutionRoutes(app as unknown as Hono<{ Variables: { requestId: string } }>, { db: db as unknown as import("../storage/db.js").MiraDB, bus })

    // low-risk observe should go through to verifier (no patch → small)
    const lowRes = await app.request("/evolution/observe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ failure: "timeout on lane default", evidence: { x: 1 } }),
    })
    expect(lowRes.status).toBe(200)
    const lowBody = await lowRes.json() as { risk: { level: string }; approval: { approved: boolean }; budget: { allowed: boolean }; security: { passed: boolean } }
    expect(lowBody.risk.level).toBeDefined()
    expect(lowBody.budget.allowed).toBe(true)
    expect(lowBody.security.passed).toBe(true)

    // high-risk: patch with secret should be blocked by security
    const secRes = await app.request("/evolution/observe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ failure: "guardrail failure", evidence: {}, patch: "MIRA_TOKEN=xxx and guardrails.enforce = false", changedFiles: ["packages/server/src/guardrails/index.ts", "mira.json", "auth.ts", "a.ts", "b.ts", "c.ts"], cost: 0.05 }),
    })
    expect(secRes.status).toBe(200)
    const secBody = await secRes.json() as { verification: { blocked: boolean }; ledger: { verdict: string } }
    expect(secBody.verification.blocked).toBe(true)
    expect(["security_blocked", "pending_approval", "budget_blocked"]).toContain(secBody.ledger.verdict)
  })

  test("POST /evolution/approve/:id + POST /evolution/rollback/:id + GET /evolution/risk/:id", async () => {
    const bus = new Bus()
    const ledger = new ImprovementLedger(db as unknown as import("../storage/db.js").MiraDB, bus)
    const approvalGate = new ApprovalGate({ bus })
    // seed a high-risk pending entry manually to exercise approve flow
    // Use observe to create a high-risk pending entry: guardrails with many files will stay pending
    const app = new Hono()
    mountEvolutionRoutes(app as unknown as Hono<{ Variables: { requestId: string } }>, { db: db as unknown as import("../storage/db.js").MiraDB, bus, ledger, approvalGate })
    // Create an observe that is NOT blocked by security but pending approval (high-risk without secret)
    // Use large changedFiles + P0 + guardrails → high risk → pending at Canary? But our low default level is Autonomous.
    // To force pending, we will use resource limits with normal caps but high-risk will be pending due to guardrails engine.
    // Actually selectLevel for high is Suggest, but Suggest not pending (only Canary+medium or high). For high at Suggest, our gate still marks high as pending regardless of level.
    const obsRes = await app.request("/evolution/observe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ failure: "guardrail permission denied on auth", evidence: { permission: "guardrails" }, changedFiles: ["packages/server/src/guardrails/index.ts", "a.ts", "b.ts", "c.ts", "d.ts", "e.ts"], permissionScope: "guardrails", cost: 0.05 }),
    })
    expect(obsRes.status).toBe(200)
    const obsBody = await obsRes.json() as { ledger: { id: string }; approval: { pending?: boolean } }
    const id = obsBody.ledger.id
    // risk get
    const riskRes = await app.request(`/evolution/risk/${id}`)
    expect(riskRes.status).toBe(200)
    const riskBody = await riskRes.json() as { risk: { level: string } }
    expect(riskBody.risk.level).toBeDefined()

    // approve (idempotent — if not pending, still returns approved)
    const appRes = await app.request(`/evolution/approve/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approver: "test-human" }) })
    expect(appRes.status).toBe(200)
    const appBody = await appRes.json() as { approved: boolean }
    expect(appBody.approved).toBe(true)

    // rollback
    const rbRes = await app.request(`/evolution/rollback/${id}`, { method: "POST" })
    expect(rbRes.status).toBe(200)
    const rbBody = await rbRes.json() as { rolledBack: boolean; verdict: string }
    expect(rbBody.rolledBack).toBe(true)
    expect(rbBody.verdict).toBe("rolledback")
  })
})
