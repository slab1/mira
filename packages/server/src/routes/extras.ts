import type { Hono } from "hono"
import { z } from "zod"
import { writeFinding, listFindings, resolveFinding, type FindingSeverity } from "../tools/findings.js"
import type { MiraDB } from "../storage/db.js"
import type { Bus } from "../bus/index.js"
import type { SessionPrompt } from "../session/prompt.js"
import type { Snapshot } from "../storage/snapshots.js"

const todoSchema = z.array(z.object({
  content: z.string().min(1).max(2000),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]).default("pending"),
  priority: z.enum(["high", "medium", "low"]).default("medium"),
})).max(200)
const findingSchema = z.object({
  title: z.string().min(1).max(500),
  severity: z.enum(["info", "minor", "major", "critical"]).optional(),
  evidence: z.string().max(20_000).optional(),
  source: z.enum(["user", "agent", "tool"]).optional(),
  sessionID: z.string().max(100).optional(),
})
const queuePushSchema = z.object({ prompt: z.string().min(1).max(20000) })

export function mountExtrasRoutes(app: Hono<any>, deps: {
  db: MiraDB; bus: Bus; prompt: SessionPrompt;
  authorizedSession: (id: string, c: any) => Promise<any>;
}) {
  const { db, bus, prompt } = deps

  // Queue
  app.post("/session/:id/queue", async (c: any) => {
    const parsed = queuePushSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid queue push", issues: parsed.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`) }, 400)
    const id = c.req.param("id")
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    return c.json(prompt.queueMessage(id, String(parsed.data.prompt).trim()))
  })
  app.get("/session/:id/queue", (c: any) => c.json(prompt.getQueue(c.req.param("id"))))
  app.delete("/session/:id/queue", (c: any) => c.json({ cleared: prompt.clearQueue(c.req.param("id")) }))

  // Snapshots
  app.get("/session/:id/snapshots", async (c: any) => {
    if (!(await deps.authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    const { listSnapshots } = await import("../storage/snapshots.js")
    return c.json(listSnapshots(db, c.req.param("id")))
  })
  app.post("/session/:id/revert", async (c: any) => {
    const body = await c.req.json().catch(() => ({}))
    const { revertLast, revertToMessage } = await import("../storage/snapshots.js")
    const id = c.req.param("id")
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    try {
      const reverted = body.messageID ? await revertToMessage(db, id, body.messageID) : [await revertLast(db, id)].filter(Boolean)
      bus.publish({ type: "session.updated", sessionID: id, payload: { reverted: (reverted as any).length }, timestamp: Date.now() })
      return c.json({ ok: true, reverted: (reverted as any).length, files: (reverted as any).filter(Boolean).map((r: Snapshot) => r.path) })
    } catch (e) { return c.json({ ok: false, error: String(e) }, 400) }
  })

  // Todos
  app.get("/session/:id/todo", async (c: any) => {
    if (!(await deps.authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    return c.json(await prompt.getTodos(c.req.param("id")))
  })
  app.post("/session/:id/todo", async (c: any) => {
    if (!(await deps.authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    const parsed = todoSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid todos", issues: parsed.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`) }, 400)
    const sid = c.req.param("id")
    const todos = parsed.data.map((t: any) => ({ ...t, id: crypto.randomUUID(), sessionID: sid, createdAt: Date.now() })) as any
    const result = await prompt.setTodos(sid, todos)
    bus.publish({ type: "todo.updated", sessionID: sid, payload: result, timestamp: Date.now() })
    return c.json(result)
  })

  // Findings
  app.get("/finding", async (c: any) => {
    const status = c.req.query("status") as "open" | "resolved" | undefined
    const severity = c.req.query("severity") as FindingSeverity | undefined
    const limit = Number(c.req.query("limit") ?? "") || undefined
    return c.json(await listFindings(db, { status, severity, limit }))
  })
  app.post("/finding", async (c: any) => {
    const parsed = findingSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid finding", issues: parsed.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`) }, 400)
    const f = await writeFinding(db, { title: parsed.data.title.trim(), severity: parsed.data.severity, evidence: parsed.data.evidence, source: parsed.data.source ?? "user", sessionID: parsed.data.sessionID ?? null })
    bus.publish({ type: "job.updated", payload: { finding: (f as any).id, action: "created" }, timestamp: Date.now() })
    return c.json(f, 201)
  })
  app.post("/finding/:id/resolve", async (c: any) => {
    const f = await resolveFinding(db, c.req.param("id"))
    if (!f) return c.json({ error: "not found" }, 404)
    bus.publish({ type: "job.updated", payload: { finding: (f as any).id, action: "resolved" }, timestamp: Date.now() })
    return c.json(f)
  })

  // Prompt core loop
  app.post("/session/:id/prompt", async (c: any) => {
    const id = c.req.param("id")
    const { prompt: text, model, maxSteps } = await c.req.json().catch(() => ({}))
    if (!text?.trim?.()) return c.json({ error: "empty prompt" }, 400)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    const signal = (c.req.raw as Request & { signal?: AbortSignal })?.signal
    return prompt.streamResponse(id, text, model, { maxSteps, signal } as any)
  })

  // Messages & export
  app.get("/session/:id/message", async (c: any) => {
    if (!(await deps.authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    return c.json(await prompt.getMessages(c.req.param("id")))
  })
  app.get("/session/:id/export", async (c: any) => {
    const id = c.req.param("id")
    const session = await deps.authorizedSession(id, c)
    if (!session) return c.json({ error: "not found" }, 404)
    const messages = await prompt.getMessages(id)
    const format = c.req.query("format") ?? "md"
    if (format === "json") return c.json({ session, messages, exportedAt: new Date().toISOString(), version: "0.1.0" })
    const lines: string[] = [`# ${(session as any).title}`, "", `- Model: \`${(session as any).model}\``, `- Exported: ${new Date().toISOString()}`, ""]
    for (const m of messages as any[]) {
      const role = m.role === "user" ? "🙋 User" : m.role === "assistant" ? "🤖 Mira" : m.role
      lines.push(`## ${role}`); for (const p of m.parts ?? []) { if (p.type === "text" && p.text) lines.push(p.text); else if (p.type === "tool-call") lines.push(`> 🔧 \`${p.tool}\``); else if (p.type === "tool-result") lines.push(p.isError ? `> ⚠️ tool error` : `> ✓ result`) } ; lines.push("")
    }
    return c.text(lines.join("\n"), 200, { "Content-Type": "text/markdown; charset=utf-8" })
  })

  // Note: /tools, /agents, /skills, /commands, /permission remain inline in index.ts to avoid circular deps

}
