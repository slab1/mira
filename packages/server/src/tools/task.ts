/**
 * Tool: task — Delegate to subagent (like Mira's Task tool)
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
import type { MiraDB } from "../storage/db.js"
import type { Bus } from "../bus/index.js"
import { isKnownAgent } from "../agents/templates.js"
import { jobs } from "../storage/schema.js"
import { buildVerificationPatch } from "../verification.js"

export type Job = typeof jobs.$inferSelect
type JobStatus = Job["status"]

/** DB may be absent in degraded/embedded contexts — handlers degrade gracefully. */
type MaybeDB = MiraDB | null | undefined

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
  // Task Verification States (design §6): parent sees *verified*, not prose.
  verification: z
    .object({
      state: z.enum(["UNVERIFIED", "PARTIALLY_VERIFIED", "VERIFIED", "FAILED_VERIFICATION"]),
      at: z.number().optional(),
    })
    .optional(),
})
export type TaskResponse = z.infer<typeof taskResponseSchema>

/** Job row → additive `verification` view for responses/payloads (§6). */
function verificationView(row: Job | undefined) {
  return row
    ? { state: row.verificationState, at: row.verificationUpdatedAt ?? undefined }
    : undefined
}

const taskSchema = z.object({
  description: z.string().describe("Short task label (3-5 words)"),
  prompt: z.string().describe("Full task instructions for subagent"),
  subagent_type: z.string().optional().describe("Agent type: explore, plan, general, etc. (default general)"),
  background: z.boolean().optional().describe("Run in background (return immediately)"),
})

// ── Job board handlers (for REST/tool layers) ──────────────────────

/**
 * Live abort controllers for in-flight background subagent jobs.
 * `cancelJob` aborts the matching controller so the subagent's runLoop stops
 * promptly (signal is threaded to gateway.stream + checked between steps),
 * instead of only flipping the DB row while the agent keeps running.
 */
const jobAborts = new Map<string, AbortController>()

/** Fetch a single job by ID (undefined if not found). */
export async function getJob(db: MaybeDB, jobID: string): Promise<Job | undefined> {
  if (!db) return undefined
  const rows = await db.select().from(jobs).where(eq(jobs.id, jobID)).limit(1)
  return rows[0]
}

/** List jobs, newest first; optionally scoped to a parent session. */
export async function listJobs(db: MaybeDB, parentSessionID?: string): Promise<Job[]> {
  if (!db) return []
  const q = db.select().from(jobs).$dynamic()
  if (parentSessionID) q.where(eq(jobs.parentSessionID, parentSessionID))
  return q.orderBy(desc(jobs.createdAt))
}

/**
 * Cancel a job. Flipping the DB row to 'cancelled' AND signalling the live
 * AbortController so the in-flight subagent actually terminates (rather than
 * running to completion). Terminal updates guard on status='running' and will
 * not overwrite 'cancelled' (cancelled-on-poll).
 */
export async function cancelJob(db: MaybeDB, jobID: string): Promise<Job | undefined> {
  // Abort the live subagent run, if any (no-op for completed/unknown jobs).
  jobAborts.get(jobID)?.abort()
  jobAborts.delete(jobID)
  if (!db) return undefined
  await db.update(jobs)
    .set({ status: "cancelled" as JobStatus, updatedAt: Date.now() })
    .where(and(eq(jobs.id, jobID), eq(jobs.status, "running")))
  return getJob(db, jobID)
}

/**
 * Terminal transition — only applies while the job is still 'running'.
 *
 * Verification settle (docs/VERIFICATION_STATES_DESIGN.md §5 chokepoint 1):
 * compute the evidence-based state from the child session's parts and merge
 * it into THIS SAME single UPDATE → status + verification land atomically and
 * settle exactly once (`WHERE status='running'`). No childSessionID (failure
 * paths) → no patch → row keeps its honest `UNVERIFIED` default.
 * Publishes the discriminated `job.updated` / `kind:'verification.state'`
 * event only when the settle produced evidence (state ≠ UNVERIFIED, §6).
 */
async function finishJob(
  db: MaybeDB,
  jobID: string,
  patch: { status: Exclude<JobStatus, "running">; result?: string; error?: string; childSessionID?: string },
  publish?: { bus?: Bus; sessionID?: string; taskID?: string },
): Promise<Job | undefined> {
  if (!db) return undefined
  const verification = await buildVerificationPatch(db, patch.childSessionID)
  const rows = await db.update(jobs)
    .set({ ...patch, ...verification, updatedAt: Date.now() })
    .where(and(eq(jobs.id, jobID), eq(jobs.status, "running")))
    .returning()
  const row = rows[0]
  if (row && verification && verification.verificationState !== "UNVERIFIED" && publish?.bus) {
    publish.bus.publish({
      type: "job.updated",
      sessionID: publish.sessionID,
      payload: {
        jobID,
        taskID: publish.taskID,
        kind: "verification.state",
        verification: verificationView(row),
      },
      timestamp: Date.now(),
    })
  }
  return row
}

// ── Tool ───────────────────────────────────────────────────────────

export const taskTool = {
  name: "task",
  description: "Delegate a task to a subagent (explore, plan, general, etc.). Subagent has isolated context and returns a summary. Use for parallel independent work. Background spawns are persisted and pollable via the returned jobID.",
  category: "execution",
  schema: taskSchema,
  async execute({ description, prompt, subagent_type = "general", background }, ctx): Promise<TaskResponse> {
    const taskID = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const bus = ctx.bus
    const db = ctx.db

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
    // unrecognized types run with the default persona instead of resolving to undefined.
    const agent = subagent_type === "explore" || subagent_type === "research"
      ? "researcher" as const
      : isKnownAgent(subagent_type)
        ? subagent_type
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
      // Fire-and-forget: run real subagent, persist + publish completion with full result.
      // A per-job AbortController lets cancelJob(jobID) terminate the in-flight run.
      const ac = new AbortController()
      jobAborts.set(jobID, ac)
      setImmediate(() => {
        runner({ prompt: `[${description}] ${prompt}`, parentID: ctx.sessionID, agent, signal: ac.signal })
          .then(({ sessionID, text }) => {
            const wasCancelled = ac.signal.aborted
            jobAborts.delete(jobID)
            return finishJob(db, jobID, wasCancelled
              ? { status: "cancelled", error: "Subagent cancelled", childSessionID: sessionID }
              : { status: "completed", result: text, childSessionID: sessionID },
              { bus, sessionID: ctx.sessionID, taskID })
              .then((row) => {
                bus?.publish({
                  type: "message.updated", sessionID: ctx.sessionID,
                  payload: { taskID, jobID, status: wasCancelled ? "cancelled" : "completed", childSessionID: sessionID, summary: text, verification: verificationView(row) },
                  timestamp: Date.now(),
                })
              })
          })
          .catch((err) => {
            const wasCancelled = ac.signal.aborted
            jobAborts.delete(jobID)
            return finishJob(db, jobID, wasCancelled
              ? { status: "cancelled", error: "Subagent cancelled" }
              : { status: "failed", error: String(err) },
              { bus, sessionID: ctx.sessionID, taskID })
              .then((row) => {
                bus?.publish({
                  type: "message.updated", sessionID: ctx.sessionID,
                  payload: { taskID, jobID, status: wasCancelled ? "cancelled" : "failed", error: String(err), verification: verificationView(row) },
                  timestamp: Date.now(),
                })
              })
          })
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
      const row = await finishJob(db, jobID, { status: "completed", result: text, childSessionID },
        { bus, sessionID: ctx.sessionID, taskID })
      return {
        taskID,
        jobID,
        status: "completed",
        description,
        subagent_type,
        childSessionID,
        result: text,
        verification: verificationView(row),
      }
    } catch (err) {
      await finishJob(db, jobID, { status: "failed", error: String(err) })
      throw err
    }
  },
} satisfies ToolDef<typeof taskSchema>

export default taskTool
export const tools = [taskTool]
export const tool = taskTool
