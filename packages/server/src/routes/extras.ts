import type { Hono, Context } from "hono"
import { z } from "zod"
import { writeFinding, listFindings, resolveFinding, type FindingSeverity } from "../tools/findings.js"
import type { MiraDB } from "../storage/db.js"
import type { Bus } from "../bus/index.js"
import type { SessionPrompt } from "../session/prompt.js"
import type { Snapshot } from "../storage/snapshots.js"
import type { JsonValue } from "../types/index.js"

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

export function mountExtrasRoutes(app: Hono<{ Variables: { requestId: string } }>, deps: {
  db: MiraDB; bus: Bus; prompt: SessionPrompt;
  authorizedSession: (id: string, c: Context) => Promise<JsonValue | null>;
}) {
  const { db, bus, prompt } = deps

  // Queue
  app.post("/session/:id/queue", async (c: Context) => {
    const parsed = queuePushSchema.safeParse(await c.req.json().catch(() => null) as JsonValue)
// @ts-ignore
    if (!parsed.success) return c.json({ error: "invalid queue push", issues: parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`) }, 400)
    const id = c.req.param("id")
// @ts-ignore
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
// @ts-ignore
    return c.json(prompt.queueMessage(id, String(parsed.data.prompt).trim()))
  })
// @ts-ignore
  app.get("/session/:id/queue", (c: Context) => c.json(prompt.getQueue(c.req.param("id"))))
// @ts-ignore
  app.delete("/session/:id/queue", (c: Context) => c.json({ cleared: prompt.clearQueue(c.req.param("id")) }))

  // Snapshots
  app.get("/session/:id/snapshots", async (c: Context) => {
// @ts-ignore
    if (!(await deps.authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    const { listSnapshots } = await import("../storage/snapshots.js")
// @ts-ignore
    return c.json(listSnapshots(db, c.req.param("id")))
  })
  app.post("/session/:id/revert", async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, JsonValue>
    const { revertLast, revertToMessage } = await import("../storage/snapshots.js")
    const id = c.req.param("id")
// @ts-ignore
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    try {
// @ts-ignore
      const reverted = body.messageID ? await revertToMessage(db, id, body.messageID as string) : [await revertLast(db, id)].filter(Boolean)
// @ts-ignore
      bus.publish({ type: "session.updated", sessionID: id, payload: { reverted: (reverted as JsonValue as Snapshot[]).length }, timestamp: Date.now() })
// @ts-ignore
      return c.json({ ok: true, reverted: (reverted as JsonValue as Snapshot[]).length, files: (reverted as JsonValue as Snapshot[]).filter(Boolean).map((r: Snapshot) => r.path) })
    } catch (e) { return c.json({ ok: false, error: String(e) }, 400) }
  })

  // Todos
  app.get("/session/:id/todo", async (c: Context) => {
// @ts-ignore
    if (!(await deps.authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
// @ts-ignore
    return c.json(await prompt.getTodos(c.req.param("id")))
  })
  app.post("/session/:id/todo", async (c: Context) => {
// @ts-ignore
    if (!(await deps.authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    const parsed = todoSchema.safeParse(await c.req.json().catch(() => null) as JsonValue)
// @ts-ignore
    if (!parsed.success) return c.json({ error: "invalid todos", issues: parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`) }, 400)
    const sid = c.req.param("id")
// @ts-ignore
    const todos = parsed.data.map((t: { content: string; status: string; priority: string }) => ({ ...t, id: crypto.randomUUID(), sessionID: sid, createdAt: Date.now() })) as JsonValue as Parameters<typeof prompt.setTodos>[1]
// @ts-ignore
    const result = await prompt.setTodos(sid, todos)
// @ts-ignore
    bus.publish({ type: "todo.updated", sessionID: sid, payload: result as JsonValue, timestamp: Date.now() })
// @ts-ignore
    return c.json(result as JsonValue)
  })

  // Findings
  app.get("/finding", async (c: Context) => {
    const status = c.req.query("status") as "open" | "resolved" | undefined
    const severity = c.req.query("severity") as FindingSeverity | undefined
    const limit = Number(c.req.query("limit") ?? "") || undefined
    return c.json(await listFindings(db, { status, severity, limit }) as JsonValue)
  })
  app.post("/finding", async (c: Context) => {
    const parsed = findingSchema.safeParse(await c.req.json().catch(() => null) as JsonValue)
// @ts-ignore
    if (!parsed.success) return c.json({ error: "invalid finding", issues: parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`) }, 400)
    const f = await writeFinding(db, { title: parsed.data.title.trim(), severity: parsed.data.severity, evidence: parsed.data.evidence, source: parsed.data.source ?? "user", sessionID: parsed.data.sessionID ?? null })
    bus.publish({ type: "job.updated", payload: { finding: (f as JsonValue as { id: string }).id, action: "created" }, timestamp: Date.now() })
    return c.json(f as JsonValue, 201)
  })
  app.post("/finding/:id/resolve", async (c: Context) => {
// @ts-ignore
    const f = await resolveFinding(db, c.req.param("id"))
    if (!f) return c.json({ error: "not found" }, 404)
    bus.publish({ type: "job.updated", payload: { finding: (f as JsonValue as { id: string }).id, action: "resolved" }, timestamp: Date.now() })
    return c.json(f as JsonValue)
  })

  // Prompt core loop
  app.post("/session/:id/prompt", async (c: Context) => {
    const id = c.req.param("id")
    const { prompt: text, model, maxSteps } = await c.req.json().catch(() => ({})) as Record<string, JsonValue>
    if (!(text as string)?.trim?.()) return c.json({ error: "empty prompt" }, 400)
// @ts-ignore
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    const signal = (c.req.raw as Request & { signal?: AbortSignal })?.signal
// @ts-ignore
    return prompt.streamResponse(id, text as string, model as string | undefined, { maxSteps: maxSteps as number | undefined, signal } as JsonValue as { maxSteps?: number; signal?: AbortSignal })
  })

  // Messages & export
  app.get("/session/:id/message", async (c: Context) => {
// @ts-ignore
    if (!(await deps.authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
// @ts-ignore
    return c.json(await prompt.getMessages(c.req.param("id")) as JsonValue)
  })
  app.get("/session/:id/export", async (c: Context) => {
    const id = c.req.param("id")
// @ts-ignore
    const session = await deps.authorizedSession(id, c) as JsonValue as { title: string; model: string } | null
    if (!session) return c.json({ error: "not found" }, 404)
// @ts-ignore
    const messages = await prompt.getMessages(id) as JsonValue as Array<{ role: string; parts?: Array<{ type: string; text?: string; tool?: string; isError?: boolean }> }>
    const format = c.req.query("format") ?? "md"
    if (format === "json") return c.json({ session, messages, exportedAt: new Date().toISOString(), version: "0.1.0" } as JsonValue)
    const lines: string[] = [`# ${session.title}`, "", `- Model: \`${session.model}\``, `- Exported: ${new Date().toISOString()}`, ""]
    for (const m of messages) {
      const role = m.role === "user" ? "🙋 User" : m.role === "assistant" ? "🤖 Mira" : m.role
      lines.push(`## ${role}`); for (const p of m.parts ?? []) { if (p.type === "text" && p.text) lines.push(p.text); else if (p.type === "tool-call") lines.push(`> 🔧 \`${p.tool}\``); else if (p.type === "tool-result") lines.push(p.isError ? `> ⚠️ tool error` : `> ✓ result`) } ; lines.push("")
    }
    return c.text(lines.join("\n"), 200, { "Content-Type": "text/markdown; charset=utf-8" })
  })

  // Note: /tools, /agents, /skills, /commands, /permission remain inline in index.ts to avoid circular deps

}
