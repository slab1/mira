import type { Hono, Context } from "hono"
import type { MiraDB } from "../storage/db.js"
import type { Bus } from "../bus/index.js"
import type { SessionPrompt } from "../session/prompt.js"
import { getJob, listJobs, cancelJob, type Job } from "../tools/task.js"
import type { JsonValue } from "../types/index.js"
import { z } from "zod"
import { desc } from "drizzle-orm"
import { sessions } from "../storage/schema.js"

/** Typed session row — mirrors the Drizzle `sessions` schema. */
interface SessionRow {
  id: string
  title: string
  model: string
  provider: string
  createdAt: number
  updatedAt: number
  parentID: string | null
  agent: string | null
  ownerID: string | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
}

/** Zod schema for POST /session body validation. */
const createSessionSchema = z.object({
  model: z.string().min(1).optional(),
  title: z.string().max(200).optional(),
})

export function mountSessionRoutes(app: Hono<{ Variables: { requestId: string } }>, deps: {
  db: MiraDB; bus: Bus; prompt: SessionPrompt;
  authorizedSession: (id: string, c: Context) => Promise<SessionRow | null>;
  ownerOfSession: (id: string) => Promise<string | null>;
  resolveOwner: (t: string) => string | undefined;
  bearerOf: (h?: string) => string;
  OWNERSHIP_ENABLED: boolean;
  sessionOwnerCache: Map<string, { owner: string | null; ts: number }>;
}) {
  const { db, bus, prompt } = deps

  app.get("/session", async (c: Context) => {
    const owner = deps.OWNERSHIP_ENABLED ? deps.resolveOwner(deps.bearerOf(c.req.header("Authorization"))) : undefined
    const all = await db.query.sessions.findMany({ orderBy: desc(sessions.updatedAt) }) as SessionRow[]
    return c.json(owner ? all.filter((s) => !s.ownerID || s.ownerID === owner) : all)
  })
  app.post("/session", async (c: Context) => {
    const parsed = createSessionSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: "invalid session", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    }
    const body = parsed.data
    const rawSession = await prompt.createSession({ ...body, ownerID: deps.OWNERSHIP_ENABLED ? deps.resolveOwner(deps.bearerOf(c.req.header("Authorization"))) ?? "default" : null })
    // Proper type bridge: prompt.createSession returns Session-like object, narrow to SessionRow via runtime check
    const session: SessionRow = {
      id: rawSession.id,
      title: rawSession.title,
      model: rawSession.model,
      provider: rawSession.provider,
      createdAt: rawSession.createdAt,
      updatedAt: rawSession.updatedAt,
      parentID: rawSession.parentID ?? null,
      agent: rawSession.agent ?? null,
      ownerID: rawSession.ownerID ?? null,
      tokensIn: (rawSession as Partial<SessionRow>).tokensIn ?? null,
      tokensOut: (rawSession as Partial<SessionRow>).tokensOut ?? null,
      costUsd: (rawSession as Partial<SessionRow>).costUsd ?? null,
    }
    deps.sessionOwnerCache.set(session.id, { owner: session.ownerID ?? null, ts: Date.now() })
    bus.publish({ type: "session.created", payload: JSON.parse(JSON.stringify(session)) as JsonValue, timestamp: Date.now() })
    return c.json(session, 201)
  })
  app.get("/session/:id", async (c: Context) => {
    const session = await deps.authorizedSession(c.req.param("id") as string, c)
    if (!session) return c.json({ error: "not found" }, 404)
    return c.json(session)
  })
  app.delete("/session/:id", async (c: Context) => {
    if (!(await deps.authorizedSession(c.req.param("id") as string, c))) return c.json({ error: "not found" }, 404)
    deps.sessionOwnerCache.delete(c.req.param("id") as string)
    await prompt.deleteSession(c.req.param("id") as string)
    bus.publish({ type: "session.deleted", payload: { id: c.req.param("id") as string }, timestamp: Date.now() })
    return c.json({ ok: true })
  })

  app.get("/session/:id/jobs", async (c: Context) => {
    const id = c.req.param("id") as string
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    return c.json(await listJobs(db, id))
  })
  app.get("/job/:id", async (c: Context) => {
    const job = await getJob(db, c.req.param("id") as string)
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
    return c.json(job)
  })
  app.post("/job/:id/cancel", async (c: Context) => {
    const job = await getJob(db, c.req.param("id") as string)
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
    const cancelled = await cancelJob(db, c.req.param("id") as string)
    bus.publish({ type: "job.cancelled", payload: { jobID: job.id }, timestamp: Date.now() })
    return c.json(cancelled)
  })
  app.get("/jobs", async (c: Context) => {
    const owner = deps.OWNERSHIP_ENABLED ? deps.resolveOwner(deps.bearerOf(c.req.header("Authorization"))) : undefined
    const all = await listJobs(db)
    if (!owner) return c.json(all)
    const filtered: typeof all = []
    for (const j of all) {
      const o = await deps.ownerOfSession(j.parentSessionID)
      if (o === null || o === owner) filtered.push(j)
    }
    return c.json(filtered)
  })
  app.get("/task/:id", async (c: Context) => {
    const job = await getJob(db, c.req.param("id") as string)
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
    return c.json(job)
  })
  app.post("/task/:id/cancel", async (c: Context) => {
    const job = await getJob(db, c.req.param("id") as string)
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
    const cancelled = await cancelJob(db, c.req.param("id") as string)
    bus.publish({ type: "job.cancelled", payload: { jobID: job.id }, timestamp: Date.now() })
    return c.json(cancelled)
  })
  app.get("/jobs/:id", async (c: Context) => {
    const job = await getJob(db, c.req.param("id") as string)
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
    return c.json(job)
  })
}
