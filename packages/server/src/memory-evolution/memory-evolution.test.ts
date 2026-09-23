/**
 * Memory Evolution — Phase 6 tests per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_SYSTEM_DOCUMENTATION.md:6 + MIRA_EVOLUTION_SPEC.md Phase 6
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 6 + MIRA_SYSTEM_DOCUMENTATION.md:6 Failure Memory + MIRA_EVOLUTION_SPEC.md Phase 6
 * Keeps nvidia primary + colibri opportunistic, respects MIRA_NO_AUTOPROVISION, no local hardware.
 * 4 tests: remember successful/failed/rejected/rollback + provenance explain/forget/promote + retrieval + routes 200
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|------------------------------|
 * | 1 | Implementation path | Implemented | packages/server/src/memory-evolution/memory-evolution.test.ts |
 * | 2 | Public interfaces | Implemented | 4 tests via Hono fetch + direct EvolutionMemory/Provenance/Retrieval |
 * | 3 | Events | Implemented | evolution.memory + evolution.provenance emitted (via bus) |
 * | 4 | Configuration | Implemented | MIRA_NO_AUTOPROVISION=1, tmp DB per test, no hardware |
 * | 5 | Tests | Implemented | 4 pass: remember types + provenance explain/forget/promote + retrieval combined + routes 200 |
 * | 6 | Security boundaries | Implemented | isolated tmp DB, no secret leak |
 * | 7 | Operational procedures | Implemented | bun test packages/server/src/memory-evolution/*.test.ts |
 * | 8 | Migration strategy | Implemented | CREATE TABLE IF NOT EXISTS evolution_memory additive |
 * | 9 | Rollback strategy | Implemented | rm -rf tmp dir per test, no global state |
 * | 10 | Known limitations | Implemented | LIKE fallback, no vector; colibri opportunistic not required |
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Hono } from "hono"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bus } from "../bus/index.js"
import { createDatabase, migrate } from "../storage/db.js"
import { EvolutionMemory } from "./evolution-memory.js"
import { MemoryProvenance } from "./provenance.js"
import { EvolutionRetrieval } from "./retrieval-evolution.js"
import { mountMemoryEvolutionRoutes } from "../routes/memory-evolution.js"

describe("memory-evolution Phase 6 (Target→Implemented)", () => {
  let dir: string
  let db: ReturnType<typeof createDatabase>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mira-mem-evo-test-"))
    const dbPath = join(dir, "test.db")
    process.env.MIRA_NO_AUTOPROVISION = "1"
    db = createDatabase(dbPath)
    await migrate(db as unknown as Parameters<typeof migrate>[0])
  })

  afterEach(() => {
    try { db.sqlite?.close?.() } catch {}
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  test("remember successful/failed/rejected/rollback — Failure Memory is key (failed improvements are knowledge)", () => {
    const bus = new Bus()
    const seen: unknown[] = []
    bus.subscribe("evolution.memory" as unknown as import("../types/index.js").BusEventType, (e) => seen.push(e.payload))
    const mem = new EvolutionMemory(db as unknown as import("../storage/db.js").MiraDB, bus)

    const s = mem.rememberSuccessful({ title: "fix gateway", cause: "rate limit" }, { latency: "12s→9s" })
    expect(s.type).toBe("successful")
    expect(s.confidence).toBeGreaterThan(0.9)
    expect(s.proposal).toBeDefined()

    const f = mem.rememberFailed({ title: "try new model", cause: "timeout" }, "benchmark regression +20%")
    expect(f.type).toBe("failed")
    expect(String((f.result as Record<string, unknown>)?.["reason"] ?? "")).toContain("benchmark")

    const rj = mem.rememberRejected({ title: "risky patch", risk: "high" }, "security blocked: secret leak")
    expect(rj.type).toBe("rejected")
    expect(rj.confidence).toBeLessThan(s.confidence)

    const rb = mem.rememberRollback("prop_abc123", "circuit breaker open")
    expect(rb.type).toBe("rollback")
    expect(String(((rb.proposal as Record<string, unknown>)?.["ledgerId"] as string) ?? "")).toBe("prop_abc123")

    const reg = mem.rememberRegression("latency regression after promote")
    expect(reg.type).toBe("regression")
    expect(mem.count()).toBe(5)
    expect(mem.list(10).length).toBe(5)
    expect(mem.health().failureMemory).toContain("failed improvements are knowledge")
    // evolution.memory emitted per remember
    expect((seen as unknown[]).length).toBe(5)
    // useful research returns failed improvements too
    const research = mem.getUsefulResearch("gateway")
    expect(research.length).toBeGreaterThan(0)
    // list ordering
    expect(mem.list(2).length).toBe(2)
  })

  test("provenance explain/forget/promote (+ correct) per §8/§9", () => {
    const bus = new Bus()
    const mem = new EvolutionMemory(db as unknown as import("../storage/db.js").MiraDB, bus)
    const prov = new MemoryProvenance(db as unknown as import("../storage/db.js").MiraDB, bus, mem)

    const entry = mem.rememberFailed({ title: "flaky verifier", cause: "timeout" }, "verifier timeout 30s")
    const explained = prov.explain(entry.id)
    expect(explained).not.toBeNull()
    expect(explained!.why).toContain(entry.id)
    expect(explained!.confidence).toBeGreaterThan(0)
    expect(explained!.lastVerified).toBeGreaterThan(0)
    expect(explained!.evidence).toBeDefined()
    const p = prov.getProvenance(entry.id)!
    expect(p.Source).toBeDefined()
    expect(p.Confidence).toBeGreaterThan(0)
    expect(p.Timestamp).toBeGreaterThan(0)
    expect(p.Scope).toBeDefined()
    expect(p.Evidence).toBeDefined()
    expect(typeof p.Importance).toBe("number")
    expect(p.Validity).toBeDefined()
    expect(p.Provenance).toContain(entry.id)
    expect(p.LastVerified).toBeGreaterThan(0)

    // promote bumps confidence + validity
    const beforeConf = p.Confidence
    const promoted = prov.promote(entry.id)
    expect(promoted).toBe(true)
    const after = prov.getProvenance(entry.id)!
    expect(after.Confidence).toBeGreaterThan(beforeConf)
    expect(after.Validity).toBe("promoted")
    expect(after.LastVerified).toBeGreaterThanOrEqual(p.LastVerified)

    // correct patches proposal
    const corrected = prov.correct(entry.id, { cause: "verifier timeout fixed", patch: "increase timeout to 60s" })
    expect(corrected).toBe(true)
    const afterCorrect = prov.explain(entry.id)!
    expect(String(((mem.get(entry.id)?.proposal as Record<string, unknown>)?.["cause"] as string) ?? "")).toContain("verifier timeout fixed")

    // forget removes it
    const forgotten = prov.forget(entry.id)
    expect(forgotten).toBe(true)
    expect(mem.get(entry.id)).toBeNull()
    expect(prov.explain(entry.id)).toBeNull()
    expect(prov.forget("nonexistent_" + Date.now())).toBe(false)
    expect(prov.promote("nonexistent_" + Date.now())).toBe(false)
    expect(prov.explain("nonexistent_" + Date.now())).toBeNull()
  })

  test("retrieval augments project + evolution memories — retrieveRelevant returns combined", () => {
    const bus = new Bus()
    const mem = new EvolutionMemory(db as unknown as import("../storage/db.js").MiraDB, bus)
    // seed evolution memories: one failure, one success, one research-ish
    mem.rememberFailed({ title: "failed improvement colibri fallback", cause: "olmoe timeout" }, "olmoe 4k limit")
    mem.rememberSuccessful({ title: "benchmark brio entropy", cause: "entropy 0.12" }, { success: "87%→91%" })
    mem.rememberRejected({ title: "risky secret leak", cause: "secret" }, "blocked")
    mem.rememberRegression("regression after canary")
    // seed a knowledge_entries row to simulate project memory (fallback path when MemoryController absent)
    try {
      const sqlite = (db as unknown as { sqlite: { prepare: (s: string) => { run: (...a: unknown[]) => unknown }; exec: (s: string) => void } }).sqlite
      sqlite.exec(`INSERT INTO knowledge_entries (id, kind, content, created_at) VALUES ('k1','semantic','colibri fallback benchmark 87%','` + Date.now() + `')`)
    } catch {}
    const retrieval = new EvolutionRetrieval({ db: db as unknown as import("../storage/db.js").MiraDB })
    const res = retrieval.retrieveRelevant("colibri benchmark", 6)
    expect(res.evolutionMemories.length).toBeGreaterThan(0)
    expect(res.combined.length).toBeGreaterThan(0)
    expect(res.combined.length).toBeLessThanOrEqual(6)
    // failure-oriented query prioritizes failure memories when available
    const failRes = retrieval.retrieveRelevant("failed regression", 5)
    expect(failRes.evolutionMemories.length).toBeGreaterThan(0)
    expect(failRes.combined[0]?.kind).toBe("evolution")
    // limit honored
    const limited = retrieval.retrieveRelevant("colibri", 2)
    expect(limited.combined.length).toBeLessThanOrEqual(2)
  })

  test("routes 200: POST /memory/evolution/remember + GET /memory/evolution + explain/forget/promote", async () => {
    const bus = new Bus()
    const app = new Hono<{ Variables: { requestId: string } }>()
    const mem = new EvolutionMemory(db as unknown as import("../storage/db.js").MiraDB, bus)
    const prov = new MemoryProvenance(db as unknown as import("../storage/db.js").MiraDB, bus, mem)
    const retrieval = new EvolutionRetrieval({ db: db as unknown as import("../storage/db.js").MiraDB })
    mountMemoryEvolutionRoutes(app, { db: db as unknown as import("../storage/db.js").MiraDB, bus, memory: mem, provenance: prov, retrieval })

    // POST remember successful
    const r1 = await app.request("/memory/evolution/remember", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "successful", proposal: { title: "route test", cause: "e2e" }, result: { ok: true } }) })
    expect(r1.status).toBe(200)
    const j1 = (await r1.json() as Record<string, unknown>)
    expect((j1 as Record<string, unknown>)["ok"]).toBe(true)
    const id = String(((j1 as Record<string, unknown>)["entry"] as Record<string, unknown>)["id"])
    expect(id.length).toBeGreaterThan(5)

    // POST remember failed
    const rFail = await app.request("/memory/evolution/remember", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "failed", proposal: { title: "failed route" }, reason: "timeout" }) })
    expect(rFail.status).toBe(200)

    // GET list
    const rList = await app.request("/memory/evolution?limit=10")
    expect(rList.status).toBe(200)
    const jList = (await rList.json() as Record<string, unknown>)
    expect(Number((jList as Record<string, unknown>)["count"])).toBeGreaterThanOrEqual(2)
    expect(Array.isArray((jList as Record<string, unknown>)["entries"])).toBe(true)

    // GET query-augmented retrieval
    const rQuery = await app.request("/memory/evolution?query=route&limit=5")
    expect(rQuery.status).toBe(200)
    const jQuery = (await rQuery.json() as Record<string, unknown>)
    expect(Array.isArray((jQuery as Record<string, unknown>)["evolutionMemories"]) || Array.isArray((jQuery as Record<string, unknown>)["entries"])).toBe(true)

    // GET explain
    const rExplain = await app.request(`/memory/evolution/${id}/explain`)
    expect(rExplain.status).toBe(200)
    const jExplain = (await rExplain.json() as Record<string, unknown>)
    expect((jExplain as Record<string, unknown>)["why"]).toBeDefined()
    expect((jExplain as Record<string, unknown>)["confidence"]).toBeDefined()
    expect((jExplain as Record<string, unknown>)["lastVerified"]).toBeDefined()
    expect((jExplain as Record<string, unknown>)["evidence"] !== undefined).toBe(true)

    // POST promote
    const rPromote = await app.request(`/memory/evolution/${id}/promote`, { method: "POST" })
    expect(rPromote.status).toBe(200)
    const jPromote = (await rPromote.json() as Record<string, unknown>)
    expect((jPromote as Record<string, unknown>)["promoted"]).toBe(true)

    // POST forget
    const rForget = await app.request(`/memory/evolution/${id}/forget`, { method: "POST" })
    expect(rForget.status).toBe(200)
    const jForget = (await rForget.json() as Record<string, unknown>)
    expect((jForget as Record<string, unknown>)["forgotten"]).toBe(true)

    // after forget, explain 404
    const rAfter = await app.request(`/memory/evolution/${id}/explain`)
    expect(rAfter.status).toBe(404)

    // invalid type 400
    const rBad = await app.request("/memory/evolution/remember", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "invalid", proposal: {} }) })
    expect(rBad.status).toBe(400)
    // missing proposal 400
    const rNoProp = await app.request("/memory/evolution/remember", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "successful" }) })
    expect(rNoProp.status).toBe(400)
  })
})
