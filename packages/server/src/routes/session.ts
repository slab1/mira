import type { Hono } from "hono"
import type { MiraDB } from "../storage/db.js"
import type { Bus } from "../bus/index.js"
import type { SessionPrompt } from "../session/prompt.js"
import { getJob, listJobs, cancelJob } from "../tools/task.js"
import { writeFinding, listFindings, resolveFinding, type FindingSeverity } from "../tools/findings.js"

export function mountSessionRoutes(app: Hono<any>, deps: {
  db: MiraDB; bus: Bus; prompt: SessionPrompt;
  authorizedSession: (id: string, c: any) => Promise<any>;
  ownerOfSession: (id: string) => Promise<string | null>;
  resolveOwner: (t: string) => string | undefined;
  bearerOf: (h?: string) => string;
  OWNERSHIP_ENABLED: boolean;
  sessionOwnerCache: Map<string, string | null>;
}) {
  const { db, bus, prompt } = deps

  app.get("/session", async (c: any) => {
    const owner = deps.OWNERSHIP_ENABLED ? deps.resolveOwner(deps.bearerOf(c.req.header("Authorization"))) : undefined
    const all = await db.query.sessions.findMany({ orderBy: (s: any, { desc }: any) => [desc(s.updatedAt)] })
    return c.json(owner ? all.filter((s: any) => !s.ownerID || s.ownerID === owner) : all)
  })
  app.post("/session", async (c: any) => {
    const body = await c.req.json().catch(() => ({}))
    const session = await prompt.createSession({ ...body, ownerID: deps.OWNERSHIP_ENABLED ? deps.resolveOwner(deps.bearerOf(c.req.header("Authorization"))) ?? "default" : null })
    deps.sessionOwnerCache.set(session.id, (session as any).ownerID ?? null)
    bus.publish({ type: "session.created", payload: session, timestamp: Date.now() })
    return c.json(session, 201)
  })
  app.get("/session/:id", async (c: any) => {
    const session = await deps.authorizedSession(c.req.param("id"), c)
    if (!session) return c.json({ error: "not found" }, 404)
    return c.json(session)
  })
  app.delete("/session/:id", async (c: any) => {
    if (!(await deps.authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    deps.sessionOwnerCache.delete(c.req.param("id"))
    await prompt.deleteSession(c.req.param("id"))
    bus.publish({ type: "session.deleted", payload: { id: c.req.param("id") }, timestamp: Date.now() })
    return c.json({ ok: true })
  })

  app.get("/session/:id/jobs", async (c: any) => {
    const id = c.req.param("id")
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    return c.json(await listJobs(db, id))
  })
  app.get("/job/:id", async (c: any) => {
    const job = await getJob(db, c.req.param("id"))
    if (!job || !(await deps.authorizedSession((job as any).parentSessionID, c))) return c.json({ error: "not found" }, 404)
    return c.json(job)
  })
  app.post("/job/:id/cancel", async (c: any) => {
    const job = await getJob(db, c.req.param("id"))
    if (!job || !(await deps.authorizedSession((job as any).parentSessionID, c))) return c.json({ error: "not found" }, 404)
    const cancelled = await cancelJob(db, c.req.param("id"))
    bus.publish({ type: "job.cancelled", payload: { jobID: (job as any).id }, timestamp: Date.now() })
    return c.json(cancelled)
  })
  app.get("/jobs", async (c: any) => {
    const owner = deps.OWNERSHIP_ENABLED ? deps.resolveOwner(deps.bearerOf(c.req.header("Authorization"))) : undefined
    const all = await listJobs(db)
    if (!owner) return c.json(all)
    const filtered: typeof all = []
    for (const j of all) {
      const o = await deps.ownerOfSession((j as any).parentSessionID)
      if (o === null || o === owner) filtered.push(j as any)
    }
    return c.json(filtered)
  })
  app.get("/task/:id", async (c: any) => {
    const job = await getJob(db, c.req.param("id"))
    if (!job || !(await deps.authorizedSession((job as any).parentSessionID, c))) return c.json({ error: "not found" }, 404)
    return c.json(job)
  })
  app.post("/task/:id/cancel", async (c: any) => {
    const job = await getJob(db, c.req.param("id"))
    if (!job || !(await deps.authorizedSession((job as any).parentSessionID, c))) return c.json({ error: "not found" }, 404)
    const cancelled = await cancelJob(db, c.req.param("id"))
    bus.publish({ type: "job.cancelled", payload: { jobID: (job as any).id }, timestamp: Date.now() })
    return c.json(cancelled)
  })
  app.get("/jobs/:id", async (c: any) => {
    const job = await getJob(db, c.req.param("id"))
    if (!job || !(await deps.authorizedSession((job as any).parentSessionID, c))) return c.json({ error: "not found" }, 404)
    return c.json(job)
  })
}
