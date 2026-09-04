/**
 * Tool: orchestrate — Kilo K2 Orchestrator Mode v2 (H2-3)
 * Parent analyzes goal → spawns sub-agents as DAG waves in parallel.
 *
 * Spec (KILO_COVERAGE P1-1): { goal: string, tasks: [{id, prompt, agent?, dependsOn?}] }
 * v2 adds (H2-3):
 *   E1 — inferDAG planner: { inferDAG: true, context? } asks the cheap model
 *        (tools/orchestrate-planner.ts planDAG) for a bounded DAG, validated
 *        before execution. Fail-closed on planner errors.
 *   E2 — wave-context + jobs persistence: one jobs row per task (same pattern
 *        as task.ts), job.created/updated/cancelled Bus events per node, and
 *        upstream summaries forwarded along contextFrom (⊆ dependsOn) edges.
 *        Full texts stay in job rows; the parent sees 600-char previews.
 *   E3 — skill-synthesis hook: on wave failure, ImprovementEngine.synthesize()
 *        runs (hook only), the candidate is persisted to the findings table
 *        (source:tool), and a message.updated { waveFailed, skillCandidate }
 *        event is published on the Bus.
 *
 * Guards: tasks ≤12, budgetSteps ≤25 (cost blowup); unknown agent/dep →
 * reject; cycle → reject once then fail-closed; dense graph (>50% edges) →
 * single wave (tightly-coupled → single agent); failed nodes retry once,
 * then downstream dependents are skipped (targeted recovery).
 */
import { z } from "zod"
import { and, eq } from "drizzle-orm"
import type { ToolDef } from "./registry.js"
import type { MiraDB } from "../storage/db.js"
import { isKnownAgent } from "../agents/templates.js"
import { jobs, findings } from "../storage/schema.js"
import type { JsonValue } from "../types/index.js"
import { mergeStrategySchema, type MergeStrategy } from "./orchestrate-planner.js"

// Re-export the job board from task.ts so callers have one surface for
// polling/cancelling orchestrate-spawned jobs.
export { getJob, listJobs, cancelJob } from "./task.js"

export const orchestrateTaskSchema = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/i, "task id must be alphanumeric/_/-").describe("Unique task id, used in dependsOn"),
  prompt: z.string().min(1).max(10000).describe("Full instructions for this subagent"),
  agent: z.string().min(1).max(40).optional().describe("Agent to use (code/ask/plan/debug/general, etc.)"),
  dependsOn: z.array(z.string().min(1).max(40)).optional().describe("IDs that must complete before this task"),
  contextFrom: z.array(z.string().min(1).max(40)).optional().describe("Subset of dependsOn whose summaries are forwarded into this task's prompt"),
  budgetSteps: z.number().int().min(1).max(25).default(10).describe("Step budget for this node (1-25, default 10)"),
  title: z.string().max(200).optional().describe("Short title for job board"),
})
export type OrchestrateTask = z.infer<typeof orchestrateTaskSchema>

export const orchestrateSchema = z.object({
  goal: z.string().min(1).max(5000).describe("Overall goal — parent analysis of why these subtasks exist"),
  tasks: z.array(orchestrateTaskSchema).min(1).max(12).describe("Subtasks to orchestrate (max 12, kept bounded)").optional(),
  inferDAG: z.boolean().optional().describe("Ask the cheap planner model to infer the task DAG from goal+context (E1)"),
  context: z.string().max(5000).optional().describe("Extra context for the inferDAG planner"),
  mergeStrategy: mergeStrategySchema.default("lead-synthesis").describe("How to combine node summaries"),
  background: z.boolean().optional().describe("Return immediately with jobIDs; wave results arrive via Bus job.updated events"),
})
export type OrchestrateArgs = z.infer<typeof orchestrateSchema>

/** Max parallel subagents per wave (doom-loop / cost guard; default wave runs Promise.all capped here). */
export const ORCHESTRATE_CONCURRENCY_CAP = 8

/** Live abort controllers for in-flight orchestrate nodes (per-wave cancel). */
export const orchestrateJobAborts = new Map<string, AbortController>()

type MaybeDB = MiraDB | null | undefined

export function topologicalWaves(tasks: OrchestrateTask[]): { waves: OrchestrateTask[][]; error?: string } {
  const byId = new Map(tasks.map(t => [t.id, t] as const))
  // validate dependsOn + contextFrom ⊆ dependsOn
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!byId.has(dep)) return { waves: [], error: `task "${t.id}" dependsOn unknown "${dep}"` }
      if (dep === t.id) return { waves: [], error: `task "${t.id}" self-dependency` }
    }
    for (const src of t.contextFrom ?? []) {
      if (!(t.dependsOn ?? []).includes(src)) {
        return { waves: [], error: `task "${t.id}" contextFrom "${src}" must be a subset of dependsOn` }
      }
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
      adj.get(dep)?.push(t.id)
    }
  }
  const waves: OrchestrateTask[][] = []
  const remaining = new Set(tasks.map(t => t.id))
  let waveQueue = tasks.filter(t => (t.dependsOn?.length ?? 0) === 0).map(t => t.id)
  if (waveQueue.length === 0 && tasks.length > 0) {
    return { waves: [], error: "cycle detected: no root task (all have dependencies)" }
  }
  const visited = new Set<string>()
  while (waveQueue.length > 0) {
    const waveIds = [...waveQueue]
    waveQueue = []
    waves.push(waveIds.map(id => byId.get(id) as OrchestrateTask))
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

/** Run mapper with at most `limit` in flight (wave-level concurrency cap). */
async function runWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  })
  await Promise.all(workers)
  return out
}

type NodeResult = {
  id: string
  agent?: string
  jobID?: string
  status: "completed" | "failed" | "skipped"
  sessionID?: string
  text?: string
  error?: string
}

function mergeResults(goal: string, strategy: MergeStrategy, results: NodeResult[]): string {
  const done = results.filter(r => r.status === "completed")
  const previews = done.map(r => `[${r.id}]: ${(r.text ?? "").slice(0, 600)}`)
  if (strategy === "best-of-n") {
    // Keep the longest completed output as the winner (deterministic, cheap).
    const best = [...done].sort((a, b) => (b.text?.length ?? 0) - (a.text?.length ?? 0))[0]
    return best ? `Best of ${done.length} for "${goal}": [${best.id}] ${(best.text ?? "").slice(0, 1200)}` : `No completed nodes for "${goal}"`
  }
  if (strategy === "independent-review") {
    return `Independent review for "${goal}" (${done.length}/${results.length} completed):\n${previews.join("\n")}`
  }
  // lead-synthesis (default): single combined summary from node summaries
  return `Synthesis for "${goal}" (${done.length}/${results.length} completed):\n${previews.join("\n")}`
}

/** Full skill-synthesis lane result (hook only — never auto-applies). */
export interface SkillLaneResult {
  skillCandidate: string | null
  skillName: string
  scaffold: string
  miraPatch: JsonValue
  evalGate: { required: boolean; status: string; command: string; detail?: string }
}

/**
 * E3 lane (hook only, fail-closed): on wave failure, run the improvement
 * engine's synthesize(), draft an UNVERIFIED skill scaffold
 * (draftSkillScaffold), stage a mira.json patch object (NEVER auto-applied),
 * run the shadow-eval gate hook (verify() — fail-closed), persist the draft
 * to the findings table (source:tool), and publish message.updated
 * { waveFailed, skillCandidate, skillName, scaffold, miraPatch, evalGate }.
 * Never throws the tool; never writes files or config.
 */
async function skillSynthesisHook(opts: {
  db: MaybeDB
  bus: import("../bus/index.js").Bus | undefined
  sessionID: string
  goal: string
  failed: NodeResult[]
}): Promise<SkillLaneResult> {
  const { db, bus, sessionID, goal, failed } = opts
  const summary = failed.map(f => `${f.id}: ${(f.error ?? "unknown error").slice(0, 200)}`).join("; ")
  let skillCandidate: string | null = null
  try {
    const { ImprovementEngine } = await import("../learning/improvement.js")
    const engine = new ImprovementEngine({ bus, db: db ?? undefined })
    const improvements = engine.synthesize(
      [{
        id: `orch_wave_${Date.now().toString(36)}`,
        source: "orchestrate",
        sourceTitle: "orchestrate wave failure",
        category: "tool",
        summary: `orchestrate wave failed for goal "${goal.slice(0, 120)}"`,
        pattern: `Failing nodes — ${summary}`.slice(0, 500),
        relevance: 0.8,
        tags: ["orchestrate", "wave-failure"],
        rawExcerpt: summary.slice(0, 500),
        createdAt: Date.now(),
      }],
      null,
    )
    skillCandidate = improvements[0]?.proposedChange.slice(0, 500) ?? `orchestrate wave failure: ${summary}`.slice(0, 500)
  } catch {
    skillCandidate = failed.map(f => `${f.id}: ${(f.error ?? "unknown").slice(0, 160)}`).join("; ").slice(0, 500) || "orchestrate wave failure"
  }
  // Draft UNVERIFIED scaffold + staged mira.json patch (never auto-applied).
  let lane: SkillLaneResult
  try {
    const { draftSkillScaffold, ImprovementEngine } = await import("../learning/improvement.js")
    const draft = draftSkillScaffold(summary || "orchestrate wave failure", goal)
    // Shadow-eval gate hook (fail-closed): verify a skill-kind improvement.
    // targetFile is null for skills → verify() returns verified:false, which
    // keeps the gate pending/rejected (never promotes without human review).
    let gateStatus: SkillLaneResult["evalGate"] = { ...draft.evalGate, status: "pending-shadow-eval" }
    try {
      const engine = new ImprovementEngine({ bus, db: db ?? undefined })
      const vr = await engine.verify({
        id: `skill_orch_${Date.now().toString(36)}`,
        targetFile: null,
        reason: `orchestrate wave failure → skill draft ${draft.name}`,
        proposedChange: draft.scaffold.slice(0, 500),
        kind: "skill",
        source: "online",
        verification: "shadow eval gate (MIRA_EVAL_GATE=1)",
        createdAt: Date.now(),
      })
      gateStatus = {
        required: true,
        status: vr.verified ? "verified" : "pending-shadow-eval",
        command: draft.evalGate.command,
        detail: vr.reason.slice(0, 300),
      }
    } catch (e) {
      gateStatus = { required: true, status: "pending-shadow-eval", command: draft.evalGate.command, detail: `gate error (fail-closed): ${String(e).slice(0, 200)}` }
    }
    lane = {
      skillCandidate,
      skillName: draft.name,
      scaffold: draft.scaffold,
      miraPatch: draft.miraPatch,
      evalGate: gateStatus,
    }
  } catch {
    lane = {
      skillCandidate,
      skillName: "orchestrate-recovery",
      scaffold: `UNVERIFIED-DO-NOT-USE: ${skillCandidate ?? summary}`.slice(0, 1000),
      miraPatch: { skills: {}, _note: "STAGED ONLY — never auto-applied." } as JsonValue,
      evalGate: { required: true, status: "pending-shadow-eval", command: "bun test + eval gate (MIRA_EVAL_GATE=1)", detail: "draft fallback (fail-closed)" },
    }
  }
  // Persist draft via findings table (source:tool) — never throws the tool.
  try {
    if (db) {
      const now = Date.now()
      await db.insert(findings).values({
        id: crypto.randomUUID(),
        sessionID,
        source: "tool",
        severity: "minor",
        title: `orchestrate wave failure → skill candidate (${goal.slice(0, 80)})`,
        evidence: `UNVERIFIED-DO-NOT-USE [${lane.skillName}]\n${lane.skillCandidate ?? ""}\n--- scaffold ---\n${lane.scaffold.slice(0, 1500)}\n--- miraPatch (STAGED ONLY, never applied) ---\n${JSON.stringify(lane.miraPatch).slice(0, 800)}\n--- evalGate ---\n${lane.evalGate.status}: ${lane.evalGate.detail ?? lane.evalGate.command}`.slice(0, 4000),
        status: "open",
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      })
    }
  } catch {}
  try {
    bus?.publish({
      type: "message.updated",
      sessionID,
      payload: {
        waveFailed: failed.map(f => f.id),
        skillCandidate: lane.skillCandidate,
        skillName: lane.skillName,
        scaffold: lane.scaffold.slice(0, 2000),
        miraPatch: lane.miraPatch,
        evalGate: lane.evalGate,
        note: "Human Review Required — candidate is UNVERIFIED-DO-NOT-USE until shadow eval + promotion. Staged patch NEVER auto-applied.",
      } as JsonValue,
      timestamp: Date.now(),
    })
  } catch {}
  return lane
}

export const orchestrateTool = {
  name: "orchestrate",
  description: "Orchestrator Mode (Kilo K2) v2: run multiple subagents as a DAG in parallel waves. Provide goal + tasks [{id, prompt, agent?, dependsOn?, contextFrom?, budgetSteps?, title?}] or {inferDAG: true, context?} to plan the DAG with the cheap model. Each wave runs in parallel (cap 8), forwarding upstream summaries along contextFrom edges. Falls back to sequential for dense/cyclic graphs.",
  category: "execution",
  schema: orchestrateSchema,
  async execute(
    { goal, tasks: rawTasks, inferDAG, context, mergeStrategy, background }: OrchestrateArgs,
    ctx: import("./registry.js").ToolContext,
  ): Promise<JsonValue> {
    const bus = ctx.bus
    const db = (ctx as { db?: MaybeDB }).db ?? null
    const runner = ctx.subagentRunner
    if (!runner) return { error: "No subagentRunner wired — server misconfigured" } as JsonValue

    // ── E1: inferDAG planner ──────────────────────────────────────────
    let tasks: OrchestrateTask[] | undefined = rawTasks
    if ((!tasks || tasks.length === 0) && inferDAG) {
      const gateway = (ctx as { gateway?: Pick<import("../gateway/index.js").Gateway, "complete"> }).gateway ?? null
      const { planDAG } = await import("./orchestrate-planner.js")
      const planned = await planDAG(goal, context, gateway)
      if ("error" in planned) {
        // Fail-closed: planner errors never silently run a guessed plan.
        return { goal, error: planned.error, hint: "planner failed (fail-closed) — pass tasks explicitly or retry once with more context" } as JsonValue
      }
      tasks = planned.plan.tasks.map(t => ({ ...t }))
      mergeStrategy = planned.plan.mergeStrategy
    }
    if (!tasks || tasks.length === 0) {
      return { goal, error: "no tasks: pass tasks[] or set inferDAG:true with a wired gateway", hint: "provide 1-12 tasks with [{id, prompt, agent?, dependsOn?}]" } as JsonValue
    }

    // Normalize agent mapping (same as task tool: explore/research → researcher)
    const normalizeAgent = (a?: string): string | undefined => {
      if (!a) return undefined
      if (a === "explore" || a === "research") return "researcher"
      return isKnownAgent(a) ? a : undefined
    }

    // Reject unknown agents up front (fail-closed, one clear error)
    for (const t of tasks) {
      if (t.agent && t.agent !== "explore" && t.agent !== "research" && !isKnownAgent(t.agent)) {
        return { goal, error: `task "${t.id}" requests unknown agent "${t.agent}"`, hint: "use an agent from the catalog (code/ask/plan/debug/general/…) or omit agent" } as JsonValue
      }
    }

    // Density heuristic: if >50% of possible edges present, run sequential for cleaner results (Kilo docs: tightly-coupled → single agent)
    const edgeCount = tasks.reduce((n, t) => n + (t.dependsOn?.length ?? 0), 0)
    const maxEdges = (tasks.length * (tasks.length - 1)) / 2
    const isDense = maxEdges > 0 && edgeCount / maxEdges > 0.5

    // Cycle check FIRST (fail-closed): a cyclic DAG is rejected even when dense.
    const topo = topologicalWaves(tasks)
    if (topo.error) {
      // Fail-closed on cycle: reject once, do NOT silently run sequentially.
      return { goal, error: topo.error, tasks: tasks.map(t => t.id), hint: "fix dependsOn or split into fewer interdependent tasks; running sequentially would be cleaner for tightly-coupled edits" } as JsonValue
    }
    let waves: OrchestrateTask[][] = []
    if (isDense) {
      waves = [tasks]
    } else {
      waves = topo.waves
    }

    bus?.publish({ type: "message.created", sessionID: ctx.sessionID, payload: { orchestrate: goal, waves: waves.length, tasks: tasks.length } as JsonValue, timestamp: Date.now() })

    // ── E2a: jobs persistence — one row per task before any spawn ─────
    const jobIDs = new Map<string, string>()
    const now = Date.now()
    for (const t of tasks) {
      const jobID = crypto.randomUUID()
      jobIDs.set(t.id, jobID)
      if (db) {
        try {
          await db.insert(jobs).values({
            id: jobID,
            parentSessionID: ctx.sessionID,
            agent: normalizeAgent(t.agent),
            prompt: `[${goal} :: ${t.id}] ${t.prompt}`,
            status: "running",
            createdAt: now,
            updatedAt: now,
          })
        } catch {}
      }
      bus?.publish({ type: "job.created", sessionID: ctx.sessionID, payload: { jobID, taskID: t.id, agent: normalizeAgent(t.agent), title: t.title ?? t.id } as JsonValue, timestamp: Date.now() })
    }

    // ── E2b: wave execution with context forwarding + targeted recovery ──
    // Shared by foreground (await) and background (fire-and-forget via
    // setImmediate, mirroring tools/task.ts + orchestrateJobAborts pattern).
    const strategy: MergeStrategy = mergeStrategy ?? "lead-synthesis"
    const sessionID = ctx.sessionID
    const runWaves = async (): Promise<NodeResult[]> => {
      const results: NodeResult[] = []
      const priorResults = new Map<string, string>() // id → full text (summaries forwarded, full kept in job rows)
      const failedIDs = new Set<string>()
      for (let wi = 0; wi < waves.length; wi++) {
        const wave = waves[wi] as OrchestrateTask[]
        // Skip nodes whose dependencies failed (targeted recovery: don't run doomed work)
        const runnable = wave.filter(t => !(t.dependsOn ?? []).some(d => failedIDs.has(d)))
        const skipped = wave.filter(t => (t.dependsOn ?? []).some(d => failedIDs.has(d)))
        for (const t of skipped) {
          results.push({ id: t.id, agent: normalizeAgent(t.agent), jobID: jobIDs.get(t.id), status: "skipped", error: `skipped: upstream failed (${(t.dependsOn ?? []).filter(d => failedIDs.has(d)).join(", ")})` })
        }
        bus?.publish({ type: "message.updated", sessionID, payload: { wave: wi + 1, waveSize: wave.length, runnable: runnable.length, skipped: skipped.length, ids: wave.map(t => t.id) } as JsonValue, timestamp: Date.now() })
        // Run wave in parallel (capped)
        const waveResults = await runWithLimit(runnable, ORCHESTRATE_CONCURRENCY_CAP, async (t): Promise<NodeResult> => {
          const agent = normalizeAgent(t.agent)
          const title = t.title ?? `${t.id}: ${t.prompt.slice(0, 40)}`
          const jobID = jobIDs.get(t.id)
          // Forward upstream summaries along contextFrom (⊆ dependsOn), else dependsOn edges.
          const edgeIDs = (t.contextFrom ?? t.dependsOn ?? []).filter(id => priorResults.has(id))
          const depContext = edgeIDs.map(id => `[${id} summary]: ${(priorResults.get(id) ?? "").slice(0, 1200)}`).join("\n")
          const fullPrompt = depContext
            ? `[${goal} :: ${t.id}] ${t.prompt}\n\nUpstream context (summaries only):\n${depContext}`
            : `[${goal} :: ${t.id}] ${t.prompt}`
          const ac = new AbortController()
          if (jobID) orchestrateJobAborts.set(jobID, ac)
          const attempt = async (): Promise<NodeResult> => {
            try {
              const { sessionID: childID, text } = await runner({ prompt: fullPrompt, parentID: sessionID, agent, title, signal: ac.signal })
              return { id: t.id, agent, jobID, status: "completed", sessionID: childID, text }
            } catch (e) {
              return { id: t.id, agent, jobID, status: "failed", error: String(e) }
            }
          }
          let res = await attempt()
          if (res.status === "failed" && !ac.signal.aborted) {
            // Retry once (doom-loop guard: exactly one retry, no replanning here)
            res = await attempt()
          }
          if (jobID) orchestrateJobAborts.delete(jobID)
          // Stash full text in the job row; parent sees only the 600-char preview.
          if (db && jobID) {
            try {
              if (res.status === "completed") {
                await db.update(jobs)
                  .set({ status: "completed", result: res.text, childSessionID: res.sessionID, updatedAt: Date.now() })
                  .where(and(eq(jobs.id, jobID), eq(jobs.status, "running")))
              } else if (res.status === "failed") {
                await db.update(jobs)
                  .set({ status: ac.signal.aborted ? "cancelled" : "failed", error: res.error, updatedAt: Date.now() })
                  .where(and(eq(jobs.id, jobID), eq(jobs.status, "running")))
              }
            } catch {}
          }
          bus?.publish({
            type: res.status === "completed" ? "job.updated" : ac.signal.aborted ? "job.cancelled" : "job.updated",
            sessionID,
            payload: { jobID, taskID: t.id, status: res.status, childSessionID: res.sessionID, preview: (res.text ?? res.error ?? "").slice(0, 600) } as JsonValue,
            timestamp: Date.now(),
          })
          return res
        })
        results.push(...waveResults)
        for (const r of waveResults) {
          if (r.status === "completed") priorResults.set(r.id, r.text ?? "")
          else if (r.status === "failed") failedIDs.add(r.id)
        }
        // E3: skill-synthesis lane on wave failure (hook only, fail-closed)
        const waveFailed = waveResults.filter(r => r.status === "failed")
        if (waveFailed.length > 0) {
          await skillSynthesisHook({ db, bus, sessionID, goal, failed: waveFailed })
        }
      }
      return results
    }

    const summarize = (results: NodeResult[]): JsonValue => {
      const ok = results.filter(r => r.status === "completed").length
      const failed = results.filter(r => r.status === "failed").length
      const skippedCount = results.filter(r => r.status === "skipped").length
      const merged = mergeResults(goal, strategy, results)
      return {
        goal,
        waves: waves.length,
        total: tasks.length,
        completed: ok,
        failed,
        skipped: skippedCount,
        denseFallback: isDense,
        mergeStrategy: strategy,
        merged,
        jobIDs: [...jobIDs.entries()].map(([taskID, jobID]) => ({ taskID, jobID })),
        results: results.map(r => ({ id: r.id, agent: r.agent, jobID: r.jobID, status: r.status, sessionID: r.sessionID, preview: (r.text ?? r.error ?? "").slice(0, 600) })),
      } as JsonValue
    }

    if (background) {
      // Fire-and-forget deferred wave runner (mirrors task.ts background):
      // acknowledge immediately; per-node job.updated/job.cancelled events +
      // a final message.updated { orchestrateComplete } arrive via Bus.
      // A per-job AbortController per node lets cancelJob terminate in-flight
      // work (orchestrateJobAborts map, same pattern as task.ts jobAborts).
      const ackJobIDs = [...jobIDs.entries()].map(([taskID, jobID]) => ({ taskID, jobID }))
      setImmediate(() => {
        runWaves()
          .then((results) => {
            const final = summarize(results) as { completed?: number; failed?: number; skipped?: number; merged?: string }
            bus?.publish({
              type: "message.updated",
              sessionID,
              payload: { orchestrateComplete: true, goal, completed: final.completed, failed: final.failed, skipped: final.skipped, merged: final.merged } as JsonValue,
              timestamp: Date.now(),
            })
          })
          .catch((e) => {
            bus?.publish({
              type: "message.updated",
              sessionID,
              payload: { orchestrateComplete: true, goal, error: String(e).slice(0, 500) } as JsonValue,
              timestamp: Date.now(),
            })
          })
      })
      return {
        goal,
        status: "background",
        waves: waves.length,
        total: tasks.length,
        jobIDs: ackJobIDs,
        message: "Orchestrate DAG running in background — per-node completion arrives via Bus job.updated/job.cancelled events plus a final message.updated { orchestrateComplete }; poll getJob(jobID) for status/result.",
      } as JsonValue
    }

    const results = await runWaves()
    return summarize(results)
  },
} satisfies ToolDef<typeof orchestrateSchema>

export default orchestrateTool
export const tools = [orchestrateTool]
export const tool = orchestrateTool
