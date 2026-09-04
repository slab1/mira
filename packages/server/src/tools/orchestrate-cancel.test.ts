import { describe, test, expect } from "bun:test"
import { orchestrateTool, orchestrateJobAborts, cancelOrchestrateJob, getJob, listJobs } from "./orchestrate.js"
import { createDatabase, migrate, type MiraDB } from "../storage/db.js"
import { sessions, jobs } from "../storage/schema.js"
import { Bus } from "../bus/index.js"
import type { ToolContext } from "./registry.js"
import type { JsonValue } from "../types/index.js"

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
  return { sessionID: "sess-cancel-test", messageID: "msg-1", ...overrides } as ToolContext
}

async function testDB(sessionID: string): Promise<MiraDB> {
  const db = createDatabase(":memory:")
  await migrate(db)
  const now = Date.now()
  await db.insert(sessions).values({ id: sessionID, title: "t", createdAt: now, updatedAt: now })
  return db
}

describe("cancelOrchestrateJob (H3-A)", () => {
  test("cancel flips running→cancelled + publishes job.cancelled", async () => {
    const db = await testDB("sess-cancel-1")
    const events: CapturedEvent[] = []
    const bus = makeBus(events)
    const now = Date.now()
    await db.insert(jobs).values({
      id: "job-1", parentSessionID: "sess-cancel-1", prompt: "p", status: "running", createdAt: now, updatedAt: now,
    })
    const cancelled = await cancelOrchestrateJob(db, "job-1", { bus, sessionID: "sess-cancel-1" })
    expect(cancelled?.status).toBe("cancelled")
    expect(events.some(e => e.type === "job.cancelled")).toBe(true)
  })

  test("cancel unknown job is a no-op (undefined, never throws)", async () => {
    const db = await testDB("sess-cancel-2")
    const out = await cancelOrchestrateJob(db, "does-not-exist")
    expect(out).toBeUndefined()
  })

  test("abort signal reaches the in-flight wave node", async () => {
    const db = await testDB("sess-cancel-3")
    const events: CapturedEvent[] = []
    const bus = makeBus(events)
    let captured: AbortSignal | undefined
    let exited = false
    const runner: Runner = async (opts) => {
      captured = opts.signal
      try {
        await new Promise<void>((resolve, reject) => {
          if (opts.signal?.aborted) return reject(new Error("aborted"))
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
      } finally {
        exited = true
      }
      throw new Error("aborted")
    }
    const ctx = baseCtx({ sessionID: "sess-cancel-3", subagentRunner: runner, bus }) as ToolContext & { db: MiraDB }
    ctx.db = db
    const raw = await orchestrateTool.execute(
      {
        goal: "cancel me",
        tasks: [{ id: "a", prompt: "hang forever", budgetSteps: 10 }],
        mergeStrategy: "lead-synthesis",
        background: true,
      },
      ctx,
    ) as { jobIDs?: Array<{ taskID: string; jobID: string }> }
    const jobID = raw.jobIDs?.[0]?.jobID as string
    expect(jobID).toBeTruthy()
    // Wait until the deferred wave runner registers its controller…
    const deadline = Date.now() + 5000
    while (!orchestrateJobAborts.has(jobID) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10))
    }
    expect(orchestrateJobAborts.has(jobID)).toBe(true)
    await cancelOrchestrateJob(db, jobID, { bus, sessionID: "sess-cancel-3" })
    expect(captured?.aborted).toBe(true)
    // …and the node exits aborted (never runs to completion); cancel wins
    // the DB race (node terminal updates guard on status='running').
    const done = Date.now() + 5000
    while (!exited && Date.now() < done) {
      await new Promise(r => setTimeout(r, 10))
    }
    expect(exited).toBe(true)
    const row = await getJob(db, jobID)
    expect(row?.status).toBe("cancelled")
    expect(events.some(e => e.type === "job.cancelled")).toBe(true)
  }, 15_000)

  test("listJobs/getJob cover orchestrate-spawned rows (shared jobs table)", async () => {
    const db = await testDB("sess-cancel-4")
    const runner: Runner = async () => ({ sessionID: "s", text: "ok" })
    const ctx = baseCtx({ sessionID: "sess-cancel-4", subagentRunner: runner }) as ToolContext & { db: MiraDB }
    ctx.db = db
    await orchestrateTool.execute(
      {
        goal: "board coverage",
        tasks: [
          { id: "a", prompt: "work a", budgetSteps: 10 },
          { id: "b", prompt: "work b", budgetSteps: 10 },
        ],
        mergeStrategy: "lead-synthesis",
      },
      ctx,
    )
    const all = await listJobs(db, "sess-cancel-4")
    expect(all.length).toBe(2)
    const one = await getJob(db, all[0]?.id as string)
    expect(one?.status).toBe("completed")
  }, 10_000)
})
