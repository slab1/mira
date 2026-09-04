import { describe, test, expect } from "bun:test"
import { z } from "zod"
import { orchestrateTool, topologicalWaves } from "./orchestrate.js"
import { validateDAG, planDAG } from "./orchestrate-planner.js"
import type { ToolContext } from "./registry.js"
import type { Bus } from "../bus/index.js"
import type { JsonValue } from "../types/index.js"

const taskResultSchema = z.object({
  goal: z.string().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
  waves: z.number().optional(),
  total: z.number().optional(),
  completed: z.number().optional(),
  failed: z.number().optional(),
  skipped: z.number().optional(),
  denseFallback: z.boolean().optional(),
  merged: z.string().optional(),
  jobIDs: z.array(z.object({ taskID: z.string(), jobID: z.string() })).optional(),
  results: z.array(z.object({ id: z.string(), status: z.string(), preview: z.string().optional() })).optional(),
})

type RunnerOpts = { prompt: string; parentID: string; agent?: string; title?: string; signal?: AbortSignal }
type Runner = (opts: RunnerOpts) => Promise<{ sessionID: string; text: string }>

interface CapturedEvent { type: string; sessionID?: string; payload?: unknown }

function makeBus(captured: CapturedEvent[]): Bus {
  return {
    publish: (event: { type: string; sessionID?: string; payload?: JsonValue }): void => {
      captured.push({ type: event.type, sessionID: event.sessionID, payload: event.payload })
    },
  } as unknown as Bus
}

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionID: "sess-orch-test", messageID: "msg-1", ...overrides } as ToolContext
}

// ── validateDAG ──────────────────────────────────────────────────────

describe("validateDAG", () => {
  test("ok for a simple linear DAG", () => {
    const res = validateDAG([
      { id: "a", prompt: "do a", budgetSteps: 10 },
      { id: "b", prompt: "do b", budgetSteps: 10, dependsOn: ["a"], contextFrom: ["a"] },
    ])
    expect(res).toEqual({ ok: true })
  })

  test("rejects unknown dependsOn", () => {
    const res = validateDAG([{ id: "a", prompt: "do a", budgetSteps: 10, dependsOn: ["ghost"] }])
    expect(res.ok).toBe(false)
    if (res.ok === false) expect(res.error).toContain('unknown "ghost"')
  })

  test("rejects contextFrom outside dependsOn", () => {
    const res = validateDAG([
      { id: "a", prompt: "do a", budgetSteps: 10 },
      { id: "b", prompt: "do b", budgetSteps: 10, dependsOn: ["a"], contextFrom: ["zzz"] },
    ])
    expect(res.ok).toBe(false)
    if (res.ok === false) expect(res.error).toContain("must be a subset of dependsOn")
  })

  test("rejects cycles", () => {
    const res = validateDAG([
      { id: "a", prompt: "do a", budgetSteps: 10, dependsOn: ["b"] },
      { id: "b", prompt: "do b", budgetSteps: 10, dependsOn: ["a"] },
    ])
    expect(res.ok).toBe(false)
    if (res.ok === false) expect(res.error).toContain("cycle")
  })
})

// ── planDAG ──────────────────────────────────────────────────────────

describe("planDAG (fail-closed planner)", () => {
  test("OK: parses + validates planner JSON", async () => {
    const gateway = {
      complete: async (): Promise<{ text: string }> => ({
        text: JSON.stringify({
          tasks: [
            { id: "t1", prompt: "first", budgetSteps: 5 },
            { id: "t2", prompt: "second", budgetSteps: 10, dependsOn: ["t1"], contextFrom: ["t1"] },
          ],
          mergeStrategy: "lead-synthesis",
        }),
      }),
    }
    const out = await planDAG("goal", undefined, gateway)
    expect("plan" in out).toBe(true)
    if ("plan" in out) {
      expect(out.plan.tasks.map(t => t.id)).toEqual(["t1", "t2"])
      expect(out.plan.mergeStrategy).toBe("lead-synthesis")
    }
  })

  test("non-JSON planner output fails closed", async () => {
    const gateway = {
      complete: async (): Promise<{ text: string }> => ({ text: "here is my plan: do stuff, no json at all" }),
    }
    const out = await planDAG("goal", undefined, gateway)
    expect("error" in out).toBe(true)
    if ("error" in out) expect(out.error).toContain("non-JSON")
  })

  test("missing gateway fails closed", async () => {
    const out = await planDAG("goal", undefined, null)
    expect("error" in out).toBe(true)
    if ("error" in out) expect(out.error).toContain("No gateway")
  })
})

// ── execute ──────────────────────────────────────────────────────────

describe("orchestrate execute", () => {
  test("2 completed / 1 failed-retried / 1 skipped with context forwarding", async () => {
    const calls: string[] = []
    const prompts: string[] = []
    const attempts = new Map<string, number>()
    const runner: Runner = async (opts) => {
      prompts.push(opts.prompt)
      const m = opts.prompt.match(/:: ([a-z0-9_-]+)\]/i)
      const id = m?.[1] ?? "unknown"
      calls.push(id)
      attempts.set(id, (attempts.get(id) ?? 0) + 1)
      if (id === "f") throw new Error("boom-f")
      if (id === "a") return { sessionID: "s-a", text: "ALPHA-RESULT" }
      if (id === "c") return { sessionID: "s-c", text: "CHARLIE-RESULT" }
      return { sessionID: `s-${id}`, text: `text-${id}` }
    }
    const events: CapturedEvent[] = []
    const raw = await orchestrateTool.execute(
      {
        goal: "test goal",
        tasks: [
          { id: "a", prompt: "work a", budgetSteps: 10 },
          { id: "f", prompt: "work f", budgetSteps: 10 },
          { id: "c", prompt: "work c", budgetSteps: 10, dependsOn: ["a"], contextFrom: ["a"] },
          { id: "s", prompt: "work s", budgetSteps: 10, dependsOn: ["f"] },
        ],
        mergeStrategy: "lead-synthesis",
      },
      baseCtx({ subagentRunner: runner, bus: makeBus(events) }),
    )
    const out = taskResultSchema.parse(raw)
    expect(out.completed).toBe(2)
    expect(out.failed).toBe(1)
    expect(out.skipped).toBe(1)
    // Failed node retried exactly once (2 attempts), then downstream skipped
    expect(attempts.get("f")).toBe(2)
    const byId = new Map((out.results ?? []).map(r => [r.id, r.status]))
    expect(byId.get("a")).toBe("completed")
    expect(byId.get("c")).toBe("completed")
    expect(byId.get("f")).toBe("failed")
    expect(byId.get("s")).toBe("skipped")
    // Context forwarding: c's prompt carries a's summary
    const cPrompt = prompts.find(p => p.includes(":: c]"))
    expect(cPrompt).toBeDefined()
    expect(cPrompt as string).toContain("[a summary]")
    expect(cPrompt as string).toContain("ALPHA-RESULT")
    // Bus completion events per node
    const updated = events.filter(e => e.type === "job.updated")
    expect(updated.length).toBeGreaterThanOrEqual(3)
  }, 10_000)

  test("rejects unknown agent (fail-closed)", async () => {
    const runner: Runner = async () => ({ sessionID: "s", text: "x" })
    const raw = await orchestrateTool.execute(
      { goal: "g", tasks: [{ id: "a", prompt: "p", budgetSteps: 10, agent: "nope-not-real" }], mergeStrategy: "lead-synthesis" },
      baseCtx({ subagentRunner: runner }),
    ) as Record<string, JsonValue>
    expect(raw["error"]).toBeDefined()
    expect(String(raw["error"])).toContain("unknown agent")
  })

  test("rejects cycles (fail-closed, no silent sequential)", async () => {
    const runner: Runner = async () => ({ sessionID: "s", text: "x" })
    const raw = await orchestrateTool.execute(
      {
        goal: "g",
        tasks: [
          { id: "a", prompt: "p", budgetSteps: 10, dependsOn: ["b"] },
          { id: "b", prompt: "p", budgetSteps: 10, dependsOn: ["a"] },
        ],
        mergeStrategy: "lead-synthesis",
      },
      baseCtx({ subagentRunner: runner }),
    ) as Record<string, JsonValue>
    expect(raw["error"]).toBeDefined()
    expect(String(raw["error"])).toContain("cycle")
  })

  test("dense non-cyclic graph collapses to a single wave", async () => {
    const runner: Runner = async (opts) => ({ sessionID: "s", text: `done:${opts.prompt.slice(0, 20)}` })
    const raw = await orchestrateTool.execute(
      {
        goal: "dense goal",
        tasks: [
          { id: "t1", prompt: "one", budgetSteps: 10 },
          { id: "t2", prompt: "two", budgetSteps: 10, dependsOn: ["t1"] },
          { id: "t3", prompt: "three", budgetSteps: 10, dependsOn: ["t1", "t2"] },
          { id: "t4", prompt: "four", budgetSteps: 10, dependsOn: ["t1", "t2", "t3"] },
        ],
        mergeStrategy: "lead-synthesis",
      },
      baseCtx({ subagentRunner: runner }),
    )
    const out = taskResultSchema.parse(raw)
    expect(out.waves).toBe(1)
    expect(out.denseFallback).toBe(true)
    expect(out.completed).toBe(4)
    // topologicalWaves itself still resolves the DAG (no cycle)
    const topo = topologicalWaves([
      { id: "t1", prompt: "one", budgetSteps: 10 },
      { id: "t2", prompt: "two", budgetSteps: 10, dependsOn: ["t1"] },
      { id: "t3", prompt: "three", budgetSteps: 10, dependsOn: ["t1", "t2"] },
      { id: "t4", prompt: "four", budgetSteps: 10, dependsOn: ["t1", "t2", "t3"] },
    ])
    expect(topo.error).toBeUndefined()
    expect(topo.waves.length).toBe(4)
  }, 10_000)

  test("background mode acknowledges immediately and runs waves deferred", async () => {
    const runner: Runner = async (opts) => {
      const m = opts.prompt.match(/:: ([a-z0-9_-]+)\]/i)
      return { sessionID: `s-${m?.[1] ?? "x"}`, text: `text-${m?.[1] ?? "x"}` }
    }
    const events: CapturedEvent[] = []
    const raw = await orchestrateTool.execute(
      {
        goal: "bg goal",
        tasks: [
          { id: "a", prompt: "work a", budgetSteps: 10 },
          { id: "b", prompt: "work b", budgetSteps: 10 },
        ],
        mergeStrategy: "lead-synthesis",
        background: true,
      },
      baseCtx({ subagentRunner: runner, bus: makeBus(events) }),
    )
    const out = taskResultSchema.parse(raw)
    expect(out.status).toBe("background")
    expect(out.jobIDs?.length).toBe(2)
    // Deferred runner: wait for the final orchestrateComplete Bus event
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (events.some(e => e.type === "message.updated" && JSON.stringify(e.payload).includes("orchestrateComplete"))) break
      await new Promise(r => setTimeout(r, 25))
    }
    expect(events.some(e => e.type === "message.updated" && JSON.stringify(e.payload).includes("orchestrateComplete"))).toBe(true)
    expect(events.filter(e => e.type === "job.updated").length).toBe(2)
  }, 10_000)
})
