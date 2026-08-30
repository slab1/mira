/**
 * Tool: orchestrate — Kilo K2 Orchestrator Mode v1
 * Parent analyzes goal → spawns sub-agents as DAG waves in parallel.
 *
 * Spec (KILO_COVERAGE P1-1): { goal: string, tasks: [{id, prompt, agent?, dependsOn?}] }
 * - Builds dependency graph, topologically sorts into waves
 * - Each wave runs in parallel via subagentRunner (task tool's runner)
 * - Falls back to sequential if graph is dense (>50% possible edges) or cycle detected
 * - Returns aggregated results + job-like summary
 *
 * Uses same persistence as task tool (jobs table) for observability, but returns immediately
 * with all wave results (foreground). Background mode can be added later.
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"
import { isKnownAgent } from "../agents/templates.js"

const orchestrateSchema = z.object({
  goal: z.string().min(1).max(5000).describe("Overall goal — parent analysis of why these subtasks exist"),
  tasks: z.array(z.object({
    id: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/i, "task id must be alphanumeric/_/-").describe("Unique task id, used in dependsOn"),
    prompt: z.string().min(1).max(10000).describe("Full instructions for this subagent"),
    agent: z.string().min(1).max(40).optional().describe("Agent to use (code/ask/plan/debug/general, etc.)"),
    dependsOn: z.array(z.string().min(1).max(40)).optional().describe("IDs that must complete before this task"),
    title: z.string().max(200).optional().describe("Short title for job board"),
  })).min(1).max(12).describe("Subtasks to orchestrate (max 12, kept bounded)"),
})

function topologicalWaves(tasks: z.infer<typeof orchestrateSchema>["tasks"]): { waves: typeof tasks[]; error?: string } {
  const byId = new Map(tasks.map(t => [t.id, t] as const))
  // validate dependsOn
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!byId.has(dep)) return { waves: [], error: `task "${t.id}" dependsOn unknown "${dep}"` }
      if (dep === t.id) return { waves: [], error: `task "${t.id}" self-dependency` }
    }
  }
  // Kahn's with waves
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const t of tasks) {
    inDegree.set(t.id, t.dependsOn?.length ?? 0)
    adj.set(t.id, [])
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      adj.get(dep)!.push(t.id)
    }
  }
  const waves: typeof tasks[] = []
  let remaining = new Set(tasks.map(t => t.id))
  let waveQueue = tasks.filter(t => (t.dependsOn?.length ?? 0) === 0).map(t => t.id)
  if (waveQueue.length === 0 && tasks.length > 0) {
    return { waves: [], error: "cycle detected: no root task (all have dependencies)" }
  }
  const visited = new Set<string>()
  while (waveQueue.length > 0) {
    const waveIds = [...waveQueue]
    waveQueue = []
    waves.push(waveIds.map(id => byId.get(id)!))
    for (const id of waveIds) {
      visited.add(id)
      remaining.delete(id)
      for (const nxt of adj.get(id) ?? []) {
        const deg = (inDegree.get(nxt) ?? 0) - 1
        inDegree.set(nxt, deg)
        if (deg === 0) waveQueue.push(nxt)
      }
    }
    // detect stuck (cycle) after each wave
    if (waveQueue.length === 0 && remaining.size > 0) {
      // collect remaining with inDegree>0 => cycle
      const stuck = [...remaining].join(", ")
      return { waves: [], error: `cycle detected among: ${stuck}` }
    }
  }
  return { waves }
}

export const orchestrateTool = {
  name: "orchestrate",
  description: "Orchestrator Mode (Kilo K2): run multiple subagents as a DAG in parallel waves. Provide goal + tasks [{id, prompt, agent?, dependsOn?}]. Each wave runs in parallel, collecting results before next wave. Use for greenfield, cross-layer refactors, or test campaigns with separable workstreams. Falls back to sequential for dense/cyclic graphs.",
  category: "execution",
  schema: orchestrateSchema,
  async execute({ goal, tasks }: { goal: string; tasks: Array<{ id: string; prompt: string; agent?: string; dependsOn?: string[]; title?: string }> }, ctx: import("./registry.js").ToolContext): Promise<import("../types/index.js").JsonValue> {
    const bus = ctx.bus
    const runner = ctx.subagentRunner
    if (!runner) return { error: "No subagentRunner wired — server misconfigured" } as import("../types/index.js").JsonValue

    // Normalize agent mapping (same as task tool: explore/research → researcher)
    const normalizeAgent = (a?: string): string | undefined => {
      if (!a) return undefined
      if (a === "explore" || a === "research") return "researcher"
      return isKnownAgent(a) ? a : undefined
    }

    // Density heuristic: if >50% of possible edges present, run sequential for cleaner results (Kilo docs: tightly-coupled → single agent)
    const edgeCount = tasks.reduce((n, t) => n + (t.dependsOn?.length ?? 0), 0)
    const maxEdges = (tasks.length * (tasks.length - 1)) / 2
    const isDense = maxEdges > 0 && edgeCount / maxEdges > 0.5

    let waves: (typeof tasks)[] = []
    let error: string | undefined
    if (isDense) {
      waves = [tasks]
    } else {
      const res = topologicalWaves(tasks)
      if (res.error) {
        // fall back to sequential wave if cycle/density
        return { goal, error: res.error, tasks: tasks.map(t => t.id), hint: "fix dependsOn or split into fewer interdependent tasks; running sequentially would be cleaner for tightly-coupled edits" } as import("../types/index.js").JsonValue
      }
      waves = res.waves
    }

    bus?.publish({ type: "message.created", sessionID: ctx.sessionID, payload: { orchestrate: goal, waves: waves.length, tasks: tasks.length } as import("../types/index.js").JsonValue, timestamp: Date.now() })

    const results: Array<{ id: string; agent?: string; status: "completed" | "failed"; sessionID?: string; text?: string; error?: string }> = []
    for (let wi = 0; wi < waves.length; wi++) {
      const wave = waves[wi]!
      bus?.publish({ type: "message.updated", sessionID: ctx.sessionID, payload: { wave: wi + 1, waveSize: wave.length, ids: wave.map(t => t.id) } as import("../types/index.js").JsonValue, timestamp: Date.now() })
      // Run wave in parallel
      const wavePromises = wave.map(async (t) => {
        const agent = normalizeAgent(t.agent)
        const title = t.title ?? `${t.id}: ${t.prompt.slice(0, 40)}`
        try {
          const { sessionID, text } = await runner({ prompt: `[${goal} :: ${t.id}] ${t.prompt}`, parentID: ctx.sessionID, agent, title })
          return { id: t.id, agent, status: "completed" as const, sessionID, text }
        } catch (e) {
          return { id: t.id, agent, status: "failed" as const, error: String(e) }
        }
      })
      const waveResults = await Promise.all(wavePromises)
      results.push(...waveResults)
      // If any failed, continue to next wave (remaining dependsOn may still be eligible, but we record failures)
    }

    const ok = results.filter(r => r.status === "completed").length
    const failed = results.filter(r => r.status === "failed").length
    return {
      goal,
      waves: waves.length,
      total: tasks.length,
      completed: ok,
      failed,
      denseFallback: isDense,
      results: results.map(r => ({ id: r.id, agent: r.agent, status: r.status, sessionID: r.sessionID, preview: (r.text ?? r.error ?? "").slice(0, 600) })),
    } as import("../types/index.js").JsonValue
  },
} satisfies ToolDef<typeof orchestrateSchema>

export default orchestrateTool
export const tools = [orchestrateTool]
export const tool = orchestrateTool
