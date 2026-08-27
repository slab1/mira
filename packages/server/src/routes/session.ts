import type { Hono, Context } from "hono"
import type { MiraDB } from "../storage/db.js"
import type { Bus } from "../bus/index.js"
import type { SessionPrompt } from "../session/prompt.js"
import { getJob, listJobs, cancelJob } from "../tools/task.js"
import type { JsonValue } from "../types/index.js"

export function mountSessionRoutes(app: Hono<{ Variables: { requestId: string } }>, deps: {
  db: MiraDB; bus: Bus; prompt: SessionPrompt;
  authorizedSession: (id: string, c: Context) => Promise<JsonValue | null>;
  ownerOfSession: (id: string) => Promise<string | null>;
  resolveOwner: (t: string) => string | undefined;
  bearerOf: (h?: string) => string;
  OWNERSHIP_ENABLED: boolean;
  sessionOwnerCache: Map<string, string | null>;
}) {
  const { db, bus, prompt } = deps

  app.get("/session", async (c: Context) => {
    const owner = deps.OWNERSHIP_ENABLED ? deps.resolveOwner(deps.bearerOf(c.req.header("Authorization"))) : undefined
// @ts-ignore
    const all = await db.query.sessions.findMany({ orderBy: (s: { updatedAt: JsonValue }, { desc }: { desc: (col: JsonValue) => JsonValue }) => [desc(s.updatedAt)] })
// @ts-ignore
    return c.json((owner ? all.filter((s) => !((s as JsonValue as Record<string, JsonValue>).ownerID) || (s as JsonValue as Record<string, JsonValue>).ownerID === owner) : all) as JsonValue)
  })
  app.post("/session", async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, JsonValue>
    const session = await prompt.createSession({ ...(body as object), ownerID: deps.OWNERSHIP_ENABLED ? deps.resolveOwner(deps.bearerOf(c.req.header("Authorization"))) ?? "default" : null } as Parameters<typeof prompt.createSession>[0])
    deps.sessionOwnerCache.set(session.id, (session as JsonValue as { ownerID?: string | null }).ownerID ?? null)
    bus.publish({ type: "session.created", payload: session as JsonValue, timestamp: Date.now() })
    return c.json(session as JsonValue, 201)
  })
  app.get("/session/:id", async (c: Context) => {
// @ts-ignore
    const session = await deps.authorizedSession(c.req.param("id"), c)
    if (!session) return c.json({ error: "not found" }, 404)
    return c.json(session as JsonValue)
  })
  app.delete("/session/:id", async (c: Context) => {
// @ts-ignore
    if (!(await deps.authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
// @ts-ignore
    deps.sessionOwnerCache.delete(c.req.param("id"))
// @ts-ignore
    await prompt.deleteSession(c.req.param("id"))
    bus.publish({ type: "session.deleted", payload: { id: c.req.param("id") }, timestamp: Date.now() })
    return c.json({ ok: true })
  })

  app.get("/session/:id/jobs", async (c: Context) => {
    const id = c.req.param("id")
// @ts-ignore
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    return c.json(await listJobs(db, id) as JsonValue)
  })
  app.get("/job/:id", async (c: Context) => {
// @ts-ignore
    const job = await getJob(db, c.req.param("id")) as JsonValue as { parentSessionID: string } | null
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
    return c.json(job as JsonValue)
  })
  app.post("/job/:id/cancel", async (c: Context) => {
// @ts-ignore
    const job = await getJob(db, c.req.param("id")) as JsonValue as { parentSessionID: string; id: string } | null
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
// @ts-ignore
    const cancelled = await cancelJob(db, c.req.param("id"))
    bus.publish({ type: "job.cancelled", payload: { jobID: job.id }, timestamp: Date.now() })
    return c.json(cancelled as JsonValue)
  })
  app.get("/jobs", async (c: Context) => {
    const owner = deps.OWNERSHIP_ENABLED ? deps.resolveOwner(deps.bearerOf(c.req.header("Authorization"))) : undefined
    const all = await listJobs(db) as JsonValue as Array<{ parentSessionID: string }>
    if (!owner) return c.json(all as JsonValue)
    const filtered: typeof all = []
    for (const j of all) {
      const o = await deps.ownerOfSession((j as JsonValue as { parentSessionID: string }).parentSessionID)
      if (o === null || o === owner) filtered.push(j)
    }
    return c.json(filtered as JsonValue)
  })
  app.get("/task/:id", async (c: Context) => {
// @ts-ignore
    const job = await getJob(db, c.req.param("id")) as JsonValue as { parentSessionID: string } | null
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
    return c.json(job as JsonValue)
  })
  app.post("/task/:id/cancel", async (c: Context) => {
// @ts-ignore
    const job = await getJob(db, c.req.param("id")) as JsonValue as { parentSessionID: string; id: string } | null
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
// @ts-ignore
    const cancelled = await cancelJob(db, c.req.param("id"))
    bus.publish({ type: "job.cancelled", payload: { jobID: job.id }, timestamp: Date.now() })
    return c.json(cancelled as JsonValue)
  })
  app.get("/jobs/:id", async (c: Context) => {
// @ts-ignore
    const job = await getJob(db, c.req.param("id")) as JsonValue as { parentSessionID: string } | null
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
    return c.json(job as JsonValue)
  })
}
