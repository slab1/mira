/**
 * Orchestrator v2 planner — inferDAG (E1).
 *
 * Cheap-model DAG planner: given a goal (+ optional context), produce a
 * bounded task DAG (≤12 tasks, ≤25 steps each) with data-dependency edges.
 * Output is validated via Zod before the engine ever runs it (fail-closed).
 *
 * Agent assignment consults the live registry (getAgentTemplates(), merged
 * with mira.json custom agents) and the skill catalog (loadSkills()), the
 * same sources session/prompt.ts uses for persona + skill injection.
 */
import { z } from "zod"
import { getAgentTemplates } from "../agents/templates.js"
import type { Gateway } from "../gateway/index.js"

/** Merge contract for combining per-wave results (summaries only, never full dumps). */
export const mergeStrategySchema = z.enum(["lead-synthesis", "independent-review", "best-of-n"])
export type MergeStrategy = z.infer<typeof mergeStrategySchema>

/**
 * A single inferred task. `prompt` must be self-contained (goal + acceptance
 * criteria inline) so the child needs no parent context beyond `contextFrom`.
 * `contextFrom` must be a subset of `dependsOn` — summaries flow only along
 * declared data-dependency edges.
 */
export const inferredTaskSchema = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, "task id must match /^[a-z0-9-]+$/").describe("Unique task id (lowercase, digits, dashes)"),
  agent: z.string().min(1).max(40).optional().describe("Agent key — must exist in the agent catalog"),
  prompt: z.string().min(1).max(10000).describe("Self-contained instructions + acceptance criteria for this subagent"),
  dependsOn: z.array(z.string().min(1).max(40)).optional().describe("IDs that must complete before this task"),
  contextFrom: z.array(z.string().min(1).max(40)).optional().describe("Subset of dependsOn whose summaries are forwarded into this task's prompt"),
  budgetSteps: z.number().int().min(1).max(25).default(10).describe("Step budget for this node (1-25, default 10)"),
  title: z.string().max(200).optional().describe("Short title for job board"),
})
export type InferredTask = z.infer<typeof inferredTaskSchema>

/** Planner output contract: bounded DAG + merge strategy. */
export const inferDAGRequestSchema = z.object({
  goal: z.string().min(1).max(5000).describe("Overall goal the DAG achieves"),
  tasks: z.array(inferredTaskSchema).min(1).max(12).describe("Subtasks (max 12, cost blowup guard)"),
  mergeStrategy: mergeStrategySchema.default("lead-synthesis").describe("How to combine node summaries"),
})
export type InferDAGRequest = z.infer<typeof inferDAGRequestSchema>

/** Cheap model for explore/planning nodes (cost guard: never plan with the flagship). */
export const PLANNER_MODEL = "openrouter/deepseek/deepseek-v3.2-exp"

/**
 * Build the planner prompt. Forces data-dependency reasoning FIRST, then
 * self-contained prompts, then the ≤12 / summaries-only merge contract.
 */
export function buildPlannerPrompt(
  goal: string,
  context: string | undefined,
  agentCatalog: string,
  skillNames: string,
): string {
  return [
    "You are a DAG planner for a multi-agent orchestrator. Reason about DATA DEPENDENCIES FIRST.",
    "",
    "Step 1 — data dependencies: for each subtask, ask 'what upstream output does this need to read?'",
    "Only add a dependsOn edge when the downstream prompt genuinely consumes upstream output.",
    "Tightly-coupled edits (same files, shared types) belong in ONE task, not several.",
    "Step 2 — self-contained prompts: every task prompt must include its own goal slice + acceptance",
    "criteria, so the child succeeds with only its contextFrom summaries as extra input.",
    "Step 3 — bound the plan: at most 12 tasks, each budgetSteps 1-25 (default 10).",
    "Prefer 3-6 tasks; split further only when workstreams are truly independent.",
    "",
    `GOAL: ${goal}`,
    context ? `CONTEXT: ${context}` : "CONTEXT: (none provided)",
    "",
    `AVAILABLE AGENTS (assign each task exactly one that exists in this list):\n${agentCatalog}`,
    skillNames ? `AVAILABLE SKILLS (mention by name in prompts where relevant):\n${skillNames}` : "AVAILABLE SKILLS: (none installed)",
    "",
    "MERGE CONTRACT: the lead synthesizes node SUMMARIES only (≤600 chars each).",
    "Children return summaries; full texts stay in job rows. Never ask a node for another node's full output.",
    "mergeStrategy: 'lead-synthesis' (default, one node combines), 'independent-review' (nodes review each other),",
    "'best-of-n' (parallel attempts, keep the best).",
    "",
    "Respond with ONLY a JSON object: { \"tasks\": [{ \"id\": \"kebab-case\", \"agent\": \"<from catalog>\",",
    "\"prompt\": \"<self-contained + acceptance>\", \"dependsOn\": [], \"contextFrom\": [],",
    "\"budgetSteps\": 10, \"title\": \"<short>\" }], \"mergeStrategy\": \"lead-synthesis\" }",
    "contextFrom must be a subset of dependsOn. No prose outside the JSON.",
  ].join("\n")
}

/** Strip code fences / leading prose so JSON.parse sees the object. */
export function extractPlannerJSON(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start >= 0 && end > start) return candidate.slice(start, end + 1)
  return candidate
}

/**
 * Structured validation failure: which rule failed, on which task.
 * Returned alongside the human-readable error so the caller can feed it
 * back to the planner for exactly one replan (H3-B), then fail closed.
 */
export const plannerRuleSchema = z.enum([
  "unknown-agent",
  "unknown-dep",
  "self-dependency",
  "contextFrom-subset",
  "cycle",
  "schema",
  "non-json",
  "gateway",
  "model-call",
])
export type PlannerRule = z.infer<typeof plannerRuleSchema>

export const plannerIssueSchema = z.object({
  rule: plannerRuleSchema,
  taskID: z.string().optional(),
  detail: z.string(),
})
export type PlannerIssue = z.infer<typeof plannerIssueSchema>

/** Validate raw planner output (unknown agent/dep, cycle, contextFrom ⊆ dependsOn). */
export function validateDAG(tasks: InferredTask[]): { ok: true } | { ok: false; error: string; issue: PlannerIssue } {
  const byId = new Map(tasks.map(t => [t.id, t]))
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!byId.has(dep)) {
        return { ok: false, error: `task "${t.id}" dependsOn unknown "${dep}"`, issue: { rule: "unknown-dep", taskID: t.id, detail: `dependsOn "${dep}" matches no task id` } }
      }
      if (dep === t.id) {
        return { ok: false, error: `task "${t.id}" self-dependency`, issue: { rule: "self-dependency", taskID: t.id, detail: "a task cannot depend on itself" } }
      }
    }
    for (const src of t.contextFrom ?? []) {
      if (!(t.dependsOn ?? []).includes(src)) {
        return {
          ok: false,
          error: `task "${t.id}" contextFrom "${src}" must be a subset of dependsOn`,
          issue: { rule: "contextFrom-subset", taskID: t.id, detail: `contextFrom "${src}" is not in dependsOn` },
        }
      }
    }
  }
  // Cycle check (Kahn reachability)
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const t of tasks) {
    inDegree.set(t.id, t.dependsOn?.length ?? 0)
    adj.set(t.id, [])
  }
  for (const t of tasks) for (const dep of t.dependsOn ?? []) adj.get(dep)?.push(t.id)
  const queue = tasks.filter(t => (t.dependsOn?.length ?? 0) === 0).map(t => t.id)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.pop() as string
    visited++
    for (const nxt of adj.get(id) ?? []) {
      const deg = (inDegree.get(nxt) ?? 0) - 1
      inDegree.set(nxt, deg)
      if (deg === 0) queue.push(nxt)
    }
  }
  if (visited !== tasks.length) {
    return {
      ok: false,
      error: "cycle detected in planned DAG",
      issue: { rule: "cycle", detail: "dependsOn edges form a cycle (no root task or stuck nodes)" },
    }
  }
  return { ok: true }
}

/** planDAG failure: human-readable error + structured issues for replan feedback. */
export type PlanDAGError = { error: string; issues: PlannerIssue[] }

/** Rules worth exactly one replan (model output bugs, not infra failures). */
const REPLANABLE_RULES: ReadonlySet<PlannerRule> = new Set([
  "unknown-agent",
  "unknown-dep",
  "self-dependency",
  "contextFrom-subset",
  "cycle",
  "schema",
  "non-json",
])

/** True when every issue is a model-output bug the planner itself could fix. */
export function isReplanable(issues: PlannerIssue[]): boolean {
  return issues.length > 0 && issues.every(i => REPLANABLE_RULES.has(i.rule))
}

/** Render issues as one feedback line for the replan prompt (rule + task id). */
export function formatIssues(issues: PlannerIssue[]): string {
  return issues
    .map(i => (i.taskID ? `rule "${i.rule}" on task "${i.taskID}": ${i.detail}` : `rule "${i.rule}": ${i.detail}`))
    .join("; ")
}

/**
 * Ask the cheap model for a task DAG, then validate it.
 * Fail-closed: any parse/validation failure is returned as { error, issues }
 * and the caller must NOT run a fallback plan silently (one replan allowed by
 * caller with the issues fed back, then fail-closed per doom-loop guard).
 * Pass `retryFeedback` (from formatIssues) for the single replan attempt —
 * it is appended to the planner prompt verbatim.
 */
export async function planDAG(
  goal: string,
  context: string | undefined,
  gateway: Pick<Gateway, "complete"> | null | undefined,
  model: string = PLANNER_MODEL,
  retryFeedback?: string,
): Promise<{ plan: InferDAGRequest } | PlanDAGError> {
  if (!gateway) {
    return {
      error: "No gateway wired — pass tasks explicitly instead of inferDAG",
      issues: [{ rule: "gateway", detail: "no gateway wired for planner complete()" }],
    }
  }
  let agentCatalog: string
  try {
    const templates = getAgentTemplates()
    agentCatalog = Object.entries(templates)
      .map(([name, tpl]) => `- ${name}: ${tpl.description.slice(0, 160)}`)
      .join("\n")
  } catch {
    agentCatalog = "- general: Default delegate for mixed tasks"
  }
  let skillNames = ""
  try {
    const { loadSkills } = await import("../skills/loader.js")
    const skills = await loadSkills()
    skillNames = Object.values(skills)
      .map(s => `- ${s.name}: ${s.description.slice(0, 120)}`)
      .join("\n")
  } catch {
    skillNames = ""
  }
  const basePrompt = buildPlannerPrompt(goal, context, agentCatalog, skillNames)
  const prompt = retryFeedback
    ? `${basePrompt}\n\nYour previous plan failed validation: ${retryFeedback}\nFix the issues above and return the FULL corrected JSON again (no prose outside the JSON).`
    : basePrompt
  let text: string
  try {
    const res = await gateway.complete({ model, prompt, maxTokens: 4000 })
    text = res.text
  } catch (e) {
    return {
      error: `planner model call failed: ${String(e).slice(0, 300)}`,
      issues: [{ rule: "model-call", detail: String(e).slice(0, 200) }],
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(extractPlannerJSON(text)) as unknown
  } catch {
    return {
      error: `planner returned non-JSON: ${text.slice(0, 300)}`,
      issues: [{ rule: "non-json", detail: text.slice(0, 200) }],
    }
  }
  const parsed = inferDAGRequestSchema.safeParse(
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && !("goal" in raw)
      ? { goal, ...(raw as Record<string, unknown>) }
      : raw,
  )
  if (!parsed.success) {
    return {
      error: `planner output failed validation: ${parsed.error.message.slice(0, 500)}`,
      issues: zodToIssues(parsed.error, raw),
    }
  }
  // Unknown-agent check against the live catalog (same source as execute;
  // explore/research are accepted — execute normalizes them to researcher).
  const knownAgents = new Set(Object.keys(getAgentTemplates()))
  for (const t of parsed.data.tasks) {
    if (t.agent && t.agent !== "explore" && t.agent !== "research" && !knownAgents.has(t.agent)) {
      return {
        error: `planner DAG invalid: task "${t.id}" requests unknown agent "${t.agent}"`,
        issues: [{ rule: "unknown-agent", taskID: t.id, detail: `agent "${t.agent}" not in the agent catalog` }],
      }
    }
  }
  const dagCheck = validateDAG(parsed.data.tasks)
  if (dagCheck.ok === false) {
    const err: string = dagCheck.error
    return { error: `planner DAG invalid: ${err}`, issues: [dagCheck.issue] }
  }
  return { plan: parsed.data }
}

/** Best-effort Zod → PlannerIssue mapping (rule + task id where derivable). */
function zodToIssues(err: z.ZodError, raw: unknown): PlannerIssue[] {
  const rawTasks = (typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)["tasks"]
    : undefined) as Array<{ id?: unknown }> | undefined
  const out: PlannerIssue[] = []
  for (const zIssue of err.issues.slice(0, 3)) {
    const path = zIssue.path as Array<string | number | symbol>
    let taskID: string | undefined
    if (path[0] === "tasks" && typeof path[1] === "number" && Array.isArray(rawTasks)) {
      const id = rawTasks[path[1]]?.id
      if (typeof id === "string") taskID = id
    }
    out.push({
      rule: "schema",
      ...(taskID ? { taskID } : {}),
      detail: `${path.map(String).join(".") || "(root)"}: ${zIssue.message}`.slice(0, 300),
    })
  }
  return out.length > 0 ? out : [{ rule: "schema", detail: err.message.slice(0, 300) }]
}
