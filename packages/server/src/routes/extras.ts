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

function requireId(c: Context): string | null {
  const v = c.req.param("id")
  return v && v.length > 0 ? v : null
}

export function mountExtrasRoutes(app: Hono<{ Variables: { requestId: string } }>, deps: {
  db: MiraDB; bus: Bus; prompt: SessionPrompt;
  authorizedSession: (id: string, c: Context) => Promise<JsonValue | null>;
}) {
  const { db, bus, prompt } = deps

  // Queue
  app.post("/session/:id/queue", async (c: Context) => {
    const parsed = queuePushSchema.safeParse(await c.req.json().catch(() => null) as JsonValue)
    if (!parsed.success) return c.json({ error: "invalid queue push", issues: parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`) }, 400)
    const id = requireId(c)
    if (!id) return c.json({ error: "session not found" }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    return c.json(prompt.queueMessage(id, String(parsed.data.prompt).trim()))
  })
  app.get("/session/:id/queue", (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    return c.json(prompt.getQueue(id))
  })
  app.delete("/session/:id/queue", (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    return c.json({ cleared: prompt.clearQueue(id) })
  })

  // Snapshots
  app.get("/session/:id/snapshots", async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    const { listSnapshots } = await import("../storage/snapshots.js")
    return c.json(listSnapshots(db, id))
  })
  app.post("/session/:id/revert", async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, JsonValue>
    const { revertLast, revertToMessage } = await import("../storage/snapshots.js")
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    try {
      const messageId = typeof body.messageID === "string" ? body.messageID : null
      const reverted: Snapshot[] = messageId ? await revertToMessage(db, id, messageId) : [await revertLast(db, id)].filter((v): v is Snapshot => Boolean(v))
      bus.publish({ type: "session.updated", sessionID: id, payload: { reverted: reverted.length } as JsonValue, timestamp: Date.now() })
      return c.json({ ok: true, reverted: reverted.length, files: reverted.filter(Boolean).map((r) => r.path) })
    } catch (e) { return c.json({ ok: false, error: String(e) }, 400) }
  })

  // Todos
  app.get("/session/:id/todo", async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    return c.json(await prompt.getTodos(id))
  })
  app.post("/session/:id/todo", async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    const parsed = todoSchema.safeParse(await c.req.json().catch(() => null) as JsonValue)
    if (!parsed.success) return c.json({ error: "invalid todos", issues: parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`) }, 400)
    const sid = id
    const todos = parsed.data.map((t) => ({ ...t, id: crypto.randomUUID(), sessionID: sid, createdAt: Date.now() }))
    const result = await prompt.setTodos(sid, todos as Parameters<typeof prompt.setTodos>[1])
    bus.publish({ type: "todo.updated", sessionID: sid, payload: result as JsonValue, timestamp: Date.now() })
    return c.json(result)
  })

  // Findings
  app.get("/finding", async (c: Context) => {
    const status = c.req.query("status") as "open" | "resolved" | undefined
    const severity = c.req.query("severity") as FindingSeverity | undefined
    const limitRaw = c.req.query("limit")
    const limit = limitRaw ? Number(limitRaw) : undefined
    const nLimit = limit !== undefined && Number.isFinite(limit) ? limit : undefined
    return c.json(await listFindings(db, { status, severity, limit: nLimit }))
  })
  app.post("/finding", async (c: Context) => {
    const parsed = findingSchema.safeParse(await c.req.json().catch(() => null) as JsonValue)
    if (!parsed.success) return c.json({ error: "invalid finding", issues: parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`) }, 400)
    const f = await writeFinding(db, { title: parsed.data.title.trim(), severity: parsed.data.severity, evidence: parsed.data.evidence, source: parsed.data.source ?? "user", sessionID: parsed.data.sessionID ?? null })
    const fid = (f as { id: string }).id
    bus.publish({ type: "job.updated", payload: { finding: fid, action: "created" } as JsonValue, timestamp: Date.now() })
    return c.json(f, 201)
  })
  app.post("/finding/:id/resolve", async (c: Context) => {
    const fid = c.req.param("id")
    if (!fid) return c.json({ error: "not found" }, 404)
    const f = await resolveFinding(db, fid)
    if (!f) return c.json({ error: "not found" }, 404)
    const resolvedId = (f as { id: string }).id
    bus.publish({ type: "job.updated", payload: { finding: resolvedId, action: "resolved" } as JsonValue, timestamp: Date.now() })
    return c.json(f)
  })

  // Prompt core loop
  app.post("/session/:id/prompt", async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: "session not found" }, 404)
    const { prompt: text, model, maxSteps } = await c.req.json().catch(() => ({})) as Record<string, JsonValue>
    if (!(typeof text === "string" && text.trim())) return c.json({ error: "empty prompt" }, 400)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    const signal = (c.req.raw as Request & { signal?: AbortSignal })?.signal
    const streamOpts: { maxSteps?: number; signal?: AbortSignal } = {}
    if (typeof maxSteps === "number" && Number.isFinite(maxSteps)) streamOpts.maxSteps = maxSteps
    if (signal) streamOpts.signal = signal
    return prompt.streamResponse(id, text, model as string | undefined, streamOpts)
  })

  // Messages & export
  app.get("/session/:id/message", async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    return c.json(await prompt.getMessages(id))
  })
  app.get("/session/:id/export", async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    const session = await deps.authorizedSession(id, c) as { title: string; model: string } | null
    if (!session) return c.json({ error: "not found" }, 404)
    const messages = await prompt.getMessages(id) as Array<{ role: string; parts?: Array<{ type: string; text?: string; tool?: string; isError?: boolean }> }>
    const format = c.req.query("format") ?? "md"
    if (format === "json") return c.json({ session, messages, exportedAt: new Date().toISOString(), version: "0.1.0" })
    const lines: string[] = [`# ${session.title}`, "", `- Model: \`${session.model}\``, `- Exported: ${new Date().toISOString()}`, ""]
    for (const m of messages) {
      const role = m.role === "user" ? "🙋 User" : m.role === "assistant" ? "🤖 Mira" : m.role
      lines.push(`## ${role}`); for (const p of m.parts ?? []) { if (p.type === "text" && p.text) lines.push(p.text); else if (p.type === "tool-call") lines.push(`> 🔧 \`${p.tool}\``); else if (p.type === "tool-result") lines.push(p.isError ? `> ⚠️ tool error` : `> ✓ result`) } ; lines.push("")
    }
    return c.text(lines.join("\n"), 200, { "Content-Type": "text/markdown; charset=utf-8" })
  })

  // Note: /tools, /agents, /skills, /commands, /permission remain inline in index.ts to avoid circular deps

}
