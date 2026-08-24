/**
 * Tool: task — Delegate to subagent (like OpenCode's Task tool)
 * Spawns a focused subagent with its own context, returns aggregated result.
 * Supports background mode for parallel delegation.
 *
 * Every spawn is persisted as a row in the `jobs` table (status: running),
 * updated to completed/failed when the subagent settles. Background jobs can
 * be polled by jobID via getJob()/listJobs()/cancelJob() below.
 */
import { z } from "zod"
import { and, desc, eq } from "drizzle-orm"
import type { ToolDef } from "./registry.js"
import { AGENT_TEMPLATES } from "../agents/templates.js"
import { jobs } from "../storage/schema.js"

export type Job = typeof jobs.$inferSelect
type JobStatus = Job["status"]

/** Response shape of the task tool (spawn acknowledgement or final result). */
export const taskResponseSchema = z.object({
  taskID: z.string(),
  jobID: z.string().optional(),
  status: z.enum(["background", "completed", "failed", "error"]),
  description: z.string().optional(),
  subagent_type: z.string().optional(),
  childSessionID: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
})
export type TaskResponse = z.infer<typeof taskResponseSchema>

// ── Job board handlers (for REST/tool layers) ──────────────────────

/** Fetch a single job by ID (undefined if not found). */
export async function getJob(db: any, jobID: string): Promise<Job | undefined> {
  if (!db) return undefined
  const rows = await db.select().from(jobs).where(eq(jobs.id, jobID)).limit(1)
  return rows[0]
}

/** List jobs, newest first; optionally scoped to a parent session. */
export async function listJobs(db: any, parentSessionID?: string): Promise<Job[]> {
  if (!db) return []
  const q = db.select().from(jobs).$dynamic()
  if (parentSessionID) q.where(eq(jobs.parentSessionID, parentSessionID))
  return q.orderBy(desc(jobs.createdAt))
}

/**
 * Cancel a job. Best-effort stop: neither subagentRunner nor forkRunner expose
 * an abort handle today, so cancellation is cooperative — in-flight terminal
 * updates guard on status='running' and will not overwrite 'cancelled'
 * (cancelled-on-poll).
 */
export async function cancelJob(db: any, jobID: string): Promise<Job | undefined> {
  if (!db) return undefined
  await db.update(jobs)
    .set({ status: "cancelled" as JobStatus, updatedAt: Date.now() })
    .where(and(eq(jobs.id, jobID), eq(jobs.status, "running")))
  return getJob(db, jobID)
}

/** Terminal transition — only applies while the job is still 'running'. */
async function finishJob(
  db: any,
  jobID: string,
  patch: { status: Exclude<JobStatus, "running">; result?: string; error?: string; childSessionID?: string },
) {
  if (!db) return
  await db.update(jobs)
    .set({ ...patch, updatedAt: Date.now() })
    .where(and(eq(jobs.id, jobID), eq(jobs.status, "running")))
}

// ── Tool ───────────────────────────────────────────────────────────

export const taskTool = {
  name: "task",
  description: "Delegate a task to a subagent (explore, plan, general, etc.). Subagent has isolated context and returns a summary. Use for parallel independent work. Background spawns are persisted and pollable via the returned jobID.",
  category: "execution",
  schema: z.object({
    description: z.string().describe("Short task label (3-5 words)"),
    prompt: z.string().describe("Full task instructions for subagent"),
    subagent_type: z.string().optional().describe("Agent type: explore, plan, general, etc. (default general)"),
    background: z.boolean().optional().describe("Run in background (return immediately)"),
  }),
  async execute({ description, prompt, subagent_type = "general", background }, ctx): Promise<TaskResponse> {
    const taskID = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const bus = (ctx as any).bus
    const db = (ctx as any).db ?? (ctx as any).deps?.db

    bus?.publish({
      type: "message.created",
      sessionID: ctx.sessionID,
      payload: { taskID, description, subagent_type, background: !!background, prompt },
      timestamp: Date.now(),
    })

    const runner = ctx.subagentRunner
    if (!runner) {
      return { taskID, status: "error", error: "No subagentRunner wired into ToolRegistry" }
    }

    // Map requested subagent types onto Mira agent templates where they align;
    // unknown types run with the default persona instead of resolving to undefined.
    const agent = subagent_type === "explore" || subagent_type === "research"
      ? "researcher" as const
      : subagent_type in AGENT_TEMPLATES
        ? (subagent_type as keyof typeof AGENT_TEMPLATES)
        : undefined

    // Persist the job BEFORE spawning so it is pollable immediately
    const jobID = crypto.randomUUID()
    const now = Date.now()
    if (db) {
      await db.insert(jobs).values({
        id: jobID,
        parentSessionID: ctx.sessionID,
        agent,
        prompt,
        status: "running",
        createdAt: now,
        updatedAt: now,
      })
    }

    if (background) {
      // Fire-and-forget: run real subagent, persist + publish completion with full result
      setImmediate(() => {
        runner({ prompt: `[${description}] ${prompt}`, parentID: ctx.sessionID, agent })
          .then(({ sessionID, text }) =>
            finishJob(db, jobID, { status: "completed", result: text, childSessionID: sessionID })
              .then(() => {
                bus?.publish({
                  type: "message.updated", sessionID: ctx.sessionID,
                  payload: { taskID, jobID, status: "completed", childSessionID: sessionID, summary: text },
                  timestamp: Date.now(),
                })
              }))
          .catch((err) =>
            finishJob(db, jobID, { status: "failed", error: String(err) })
              .then(() => {
                bus?.publish({
                  type: "message.updated", sessionID: ctx.sessionID,
                  payload: { taskID, jobID, status: "failed", error: String(err) },
                  timestamp: Date.now(),
                })
              }))
      })
      return {
        taskID,
        jobID,
        status: "background",
        description,
        message: "Subagent running in background — completion arrives via BusEvent; poll getJob(jobID) for status/result.",
      }
    }

    // Foreground: await real isolated subagent session
    try {
      const { sessionID: childSessionID, text } = await runner({
        prompt: `[${description}] ${prompt}`,
        parentID: ctx.sessionID,
        agent,
      })
      await finishJob(db, jobID, { status: "completed", result: text, childSessionID })
      return {
        taskID,
        jobID,
        status: "completed",
        description,
        subagent_type,
        childSessionID,
        result: text,
      }
    } catch (err) {
      await finishJob(db, jobID, { status: "failed", error: String(err) })
      throw err
    }
  },
}

export default taskTool
export const tools = [taskTool]
export const tool = taskTool
