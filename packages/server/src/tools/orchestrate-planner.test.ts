import { describe, test, expect } from "bun:test"
import { z } from "zod"
import { orchestrateTool } from "./orchestrate.js"
import { planDAG, isReplanable, formatIssues } from "./orchestrate-planner.js"
import type { ToolContext } from "./registry.js"
import type { MiraDB } from "../storage/db.js"

type RunnerOpts = { prompt: string; parentID: string; agent?: string; title?: string; signal?: AbortSignal }
type Runner = (opts: RunnerOpts) => Promise<{ sessionID: string; text: string }>

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionID: "sess-planner-test", messageID: "msg-1", ...overrides } as ToolContext
}

const VALID_PLAN = {
  tasks: [
    { id: "t1", prompt: "first", budgetSteps: 5 },
    { id: "t2", prompt: "second", budgetSteps: 10, dependsOn: ["t1"], contextFrom: ["t1"] },
  ],
  mergeStrategy: "lead-synthesis",
}

const INVALID_PLAN_UNKNOWN_DEP = {
  tasks: [
    { id: "t1", prompt: "first", budgetSteps: 5 },
    { id: "t2", prompt: "second", budgetSteps: 10, dependsOn: ["ghost"] },
  ],
  mergeStrategy: "lead-synthesis",
}

/** Mock gateway with scripted complete() outputs; records every prompt. */
function mockGateway(texts: string[]): { gateway: { complete(opts: { model: string; prompt: string; maxTokens?: number }): Promise<{ text: string }> }; prompts: string[]; calls: () => number } {
  const prompts: string[] = []
  let n = 0
  return {
    prompts,
    calls: () => n,
    gateway: {
      complete: async (opts: { model: string; prompt: string; maxTokens?: number }): Promise<{ text: string }> => {
        prompts.push(opts.prompt)
        const text = texts[Math.min(n, texts.length - 1)] as string
        n++
        return { text }
      },
    },
  }
}

describe("planDAG (fail-closed planner)", () => {
  test("OK: parses + validates planner JSON", async () => {
    const { gateway } = mockGateway([JSON.stringify(VALID_PLAN)])
    const out = await planDAG("goal", undefined, gateway)
    expect("plan" in out).toBe(true)
    if ("plan" in out) {
      expect(out.plan.tasks.map(t => t.id)).toEqual(["t1", "t2"])
      expect(out.plan.mergeStrategy).toBe("lead-synthesis")
    }
  })

  test("non-JSON planner output fails closed with structured issue", async () => {
    const { gateway } = mockGateway(["here is my plan: do stuff, no json at all"])
    const out = await planDAG("goal", undefined, gateway)
    expect("error" in out).toBe(true)
    if ("error" in out) {
      expect(out.error).toContain("non-JSON")
      expect(out.issues[0]?.rule).toBe("non-json")
      expect(isReplanable(out.issues)).toBe(true)
    }
  })

  test("missing gateway fails closed (not replanable)", async () => {
    const out = await planDAG("goal", undefined, null)
    expect("error" in out).toBe(true)
    if ("error" in out) {
      expect(out.error).toContain("No gateway")
      expect(out.issues[0]?.rule).toBe("gateway")
      expect(isReplanable(out.issues)).toBe(false)
    }
  })

  test("unknown dep yields structured issue (rule + task id)", async () => {
    const { gateway } = mockGateway([JSON.stringify(INVALID_PLAN_UNKNOWN_DEP)])
    const out = await planDAG("goal", undefined, gateway)
    expect("error" in out).toBe(true)
    if ("error" in out) {
      expect(out.issues).toHaveLength(1)
      expect(out.issues[0]?.rule).toBe("unknown-dep")
      expect(out.issues[0]?.taskID).toBe("t2")
      expect(formatIssues(out.issues)).toContain('"unknown-dep"')
      expect(formatIssues(out.issues)).toContain('"t2"')
    }
  })
})

describe("inferDAG replan-once (H3-B)", () => {
  test("invalid first plan → retry with error feedback → valid plan executes", async () => {
    const { gateway, prompts, calls } = mockGateway([
      JSON.stringify(INVALID_PLAN_UNKNOWN_DEP),
      JSON.stringify(VALID_PLAN),
    ])
    const runner: Runner = async (opts) => ({ sessionID: "s", text: `done:${opts.prompt.slice(0, 30)}` })
    const ctx = baseCtx({ subagentRunner: runner }) as ToolContext & { gateway: typeof gateway; db?: MiraDB }
    ctx.gateway = gateway
    const raw = await orchestrateTool.execute(
      { goal: "replan goal", inferDAG: true, mergeStrategy: "lead-synthesis" },
      ctx,
    )
    const out = z.object({ completed: z.number().optional(), failed: z.number().optional(), error: z.string().optional() }).parse(raw)
    expect(out.error).toBeUndefined()
    expect(out.completed).toBe(2)
    // Exactly one replan: two planner calls, second prompt carries the feedback
    expect(calls()).toBe(2)
    expect(prompts[1] as string).toContain("failed validation")
    expect(prompts[1] as string).toContain("unknown-dep")
    expect(prompts[1] as string).toContain("t2")
  }, 10_000)

  test("two consecutive invalid plans → fail-closed naming rule + task", async () => {
    const { gateway, calls } = mockGateway([
      JSON.stringify(INVALID_PLAN_UNKNOWN_DEP),
      JSON.stringify(INVALID_PLAN_UNKNOWN_DEP),
    ])
    const runner: Runner = async () => ({ sessionID: "s", text: "unreached" })
    const ctx = baseCtx({ subagentRunner: runner }) as ToolContext & { gateway: typeof gateway; db?: MiraDB }
    ctx.gateway = gateway
    const raw = await orchestrateTool.execute(
      { goal: "doomed goal", inferDAG: true, mergeStrategy: "lead-synthesis" },
      ctx,
    )
    const out = z.object({ error: z.string().optional() }).parse(raw)
    expect(out.error).toBeDefined()
    expect(out.error as string).toContain("unknown-dep")
    expect(out.error as string).toContain("t2")
    // Doom-loop guard: no third planner call
    expect(calls()).toBe(2)
  }, 10_000)
})
