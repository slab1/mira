/**
 * Mira Server — Main Entry
 *
 * Architecture (Better-than-OpenCode):
 *   Clients (TUI/Web/VSCode) ──RPC/WebSocket──► Server
 *     ├─ SessionPrompt.loop  — LLM.stream → tool-call → execute → finish-step → doom-loop → compaction
 *     ├─ Tool Registry (22+ tools, Zod schemas)
 *     ├─ Permission (5 layers + BashArity)
 *     ├─ GlobalBus → Worker → RPC → TUI  (event-driven, no polling)
 *     ├─ Storage: SQLite + Drizzle (WAL mode, sessions/messages/parts/todos)
 *     ├─ Model Gateway: Vercel AI SDK v5 → OpenRouter → 25+ providers
 *     └─ MCP: StreamableHTTP / SSE / Stdio
 *
 * Runtime: Bun (native SQLite, fast startup, ~3x Node for this workload)
 * Monorepo: Turborepo — packages/server, packages/tui, packages/web, packages/shared
 *
 * Usage:
 *   bun src/index.ts              # start server on :4096
 *   bun src/index.ts --port 3000  # custom port
 */

import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { Bus } from "./bus/index.js"
import { createDatabase, migrate } from "./storage/db.js"
import { createGateway } from "./gateway/index.js"
import { ToolRegistry } from "./tools/registry.js"
import { PermissionManager } from "./permission/index.js"
import { SessionPrompt } from "./session/prompt.js"
import { AGENT_TEMPLATES } from "./agents/templates.js"
import { MCPManager } from "./mcp/index.js"
import { loadConfig } from "./config/index.js"
import { createLearningSystem, mountLearningRoutes } from "./learning/index.js"
import { setSharedKnowledge } from "./learning/knowledge.js"
import { GuardrailsManager } from "./guardrails/index.js"

// ── Bootstrap ──────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? Bun.argv.find(a => a.startsWith("--port="))?.split("=")[1] ?? 4096)

async function main() {
  console.log(`[mira] starting server on :${PORT} — Bun ${Bun.version}`)

  // 1. Config
  const config = await loadConfig()
  console.log(`[mira] model=${config.model}`)

  // 2. Storage (SQLite WAL + Drizzle)
  const db = createDatabase(process.env.MIRA_DB ?? "./data/mira.db")
  await migrate(db)
  console.log(`[mira] storage ready`)

  // 3. Event Bus (GlobalBus)
  const bus = new Bus()
  bus.subscribe("server.heartbeat", () => {}) // keepalive example

  // 4. Permission (5 layers)
  const permissions = new PermissionManager(config.permission)
  console.log(`[mira] permissions: ${Object.keys(config.permission).length} rules`)

  // 4b. Guardrails (tool-layer security)
  const guardrails = new GuardrailsManager(undefined, config)
  console.log(`[mira] guardrails: enforce=${guardrails ? "enabled" : "disabled"}`)

  // 5. Model Gateway (Vercel AI SDK v5 → OpenRouter → 25+ providers)
  const gateway = createGateway(config)
  console.log(`[mira] gateway ready — providers: ${Object.keys(config.provider).join(", ")}`)

  // 5b. Learning System (online, usage, knowledge, improvement, scheduler)
  const learning = createLearningSystem({ db, bus, gateway })
  await learning.knowledge.load()
  setSharedKnowledge(learning.knowledge)
  learning.scheduler.start()
  console.log(`[mira] learning ready — knowledge=${learning.knowledge.size()} scheduler=${learning.scheduler.status().running ? "running" : "idle"}`)

  // 6. Tool Registry (22+ tools, each Zod-validated)
  const tools = new ToolRegistry({ db, bus, permissions, gateway, guardrails })
  await tools.registerAll()
  // Attach MCP tools as they connect (dynamic augmentation)
  const mcp = new MCPManager({ bus, tools, config: config.mcp })
  await mcp.connectAll()
  console.log(`[mira] tools: ${tools.count()} registered (${mcp.count()} from MCP)`)

  // 7. Session loop engine
  const prompt = new SessionPrompt({ db, bus, gateway, tools, permissions, knowledge: learning.knowledge, usage: learning.usage })
  // Subagent spawning for the `task` tool
  tools.setSubagentRunner((opts) => prompt.runSubagent({
    prompt: opts.prompt,
    parentID: opts.parentID,
    agent: opts.agent as keyof typeof AGENT_TEMPLATES | undefined,
    model: opts.model,
  }))
  // Inject db/bus + fork runner so tools like session_list/session_fork work
  tools.setDefaultCtx({ db, bus, forkRunner: (opts) => prompt.forkSession(opts) })

  // 8. HTTP + WebSocket RPC (Hono)
  const app = new Hono()

  app.use("*", cors())
  app.use("*", logger())

  // Health
  app.get("/health", c => c.json({ ok: true, version: "0.1.0", tools: tools.count(), uptime: process.uptime(), memory: process.memoryUsage() }))
  app.get("/dev/health", c => c.json({ ok: true, version: "0.1.0", tools: tools.count(), busHistory: bus.recent(5).length, learning: learning.scheduler.status(), gateway: gateway.stats(), uptime: process.uptime() }))
  // Skills
  app.get("/skills", async c => {
    const { loadSkills } = await import("./skills/loader.js")
    const skills = await loadSkills()
    return c.json(Object.keys(skills))
  })

  // REST — sessions
  app.get("/session", async c => {
    const sessions = await db.query.sessions.findMany({ orderBy: (s, { desc }) => [desc(s.updatedAt)] })
    return c.json(sessions)
  })
  app.post("/session", async c => {
    const body = await c.req.json().catch(() => ({}))
    const session = await prompt.createSession(body)
    bus.publish({ type: "session.created", payload: session, timestamp: Date.now() })
    return c.json(session, 201)
  })
  app.get("/session/:id", async c => {
    const session = await prompt.getSession(c.req.param("id"))
    if (!session) return c.json({ error: "not found" }, 404)
    return c.json(session)
  })
  app.delete("/session/:id", async c => {
    await prompt.deleteSession(c.req.param("id"))
    bus.publish({ type: "session.deleted", payload: { id: c.req.param("id") }, timestamp: Date.now() })
    return c.json({ ok: true })
  })

  // Prompt — the core loop (streamed via SSE)
  app.post("/session/:id/prompt", async c => {
    const id = c.req.param("id")
    const { prompt: text, model } = await c.req.json()
    // Validate session exists
    const session = await prompt.getSession(id)
    if (!session) return c.json({ error: "session not found" }, 404)

    // Stream response as SSE (Vercel AI SDK style)
    return prompt.streamResponse(id, text, model)
  })

  // Messages & parts
  app.get("/session/:id/message", async c => {
    const messages = await prompt.getMessages(c.req.param("id"))
    return c.json(messages)
  })

  // Session export — shareable transcript (markdown or JSON)
  app.get("/session/:id/export", async c => {
    const id = c.req.param("id")
    const session = await prompt.getSession(id)
    if (!session) return c.json({ error: "not found" }, 404)
    const messages = await prompt.getMessages(id)
    const format = c.req.query("format") ?? "md"

    if (format === "json") {
      return c.json({ session, messages, exportedAt: new Date().toISOString(), version: "0.1.0" })
    }

    const lines: string[] = [
      `# ${session.title}`,
      "",
      `- Model: \`${session.model}\``,
      `- Exported: ${new Date().toISOString()}`,
      "",
    ]
    for (const m of messages as any[]) {
      const role = m.role === "user" ? "🙋 User" : m.role === "assistant" ? "🤖 Mira" : m.role
      lines.push(`## ${role}`)
      for (const p of (m.parts ?? []) as any[]) {
        if (p.type === "text" && p.text) lines.push(p.text)
        else if (p.type === "tool-call") lines.push(`> 🔧 \`${p.tool}\``)
        else if (p.type === "tool-result") lines.push(p.isError ? `> ⚠️ tool error` : `> ✓ result`)
      }
      lines.push("")
    }
    return c.text(lines.join("\n"), 200, { "Content-Type": "text/markdown; charset=utf-8" })
  })

  // MCP discovery — server statuses + tool counts
  app.get("/mcp", c => c.json(mcp.listServers()))

  // File snapshots — undo/rewind agent file mutations
  app.get("/session/:id/snapshots", async c => {
    const { listSnapshots } = await import("./storage/snapshots.js")
    return c.json(listSnapshots(db, c.req.param("id")))
  })
  app.post("/session/:id/revert", async c => {
    const body = await c.req.json().catch(() => ({}))
    const { revertLast, revertToMessage } = await import("./storage/snapshots.js")
    const id = c.req.param("id")
    if (!(await prompt.getSession(id))) return c.json({ error: "not found" }, 404)
    try {
      const reverted = body.messageID
        ? await revertToMessage(db, id, body.messageID)
        : [await revertLast(db, id)].filter(Boolean)
      bus.publish({ type: "session.updated", sessionID: id, payload: { reverted: reverted.length }, timestamp: Date.now() })
      return c.json({ ok: true, reverted: reverted.length, files: reverted.map((r: any) => r.path) })
    } catch (e) {
      return c.json({ ok: false, error: String(e) }, 400)
    }
  })

  // Todos
  app.get("/session/:id/todo", async c => {
    const todos = await prompt.getTodos(c.req.param("id"))
    return c.json(todos)
  })
  app.post("/session/:id/todo", async c => {
    const todos = await c.req.json()
    const result = await prompt.setTodos(c.req.param("id"), todos)
    bus.publish({ type: "todo.updated", sessionID: c.req.param("id"), payload: result, timestamp: Date.now() })
    return c.json(result)
  })

  // Tools list (for TUI introspection)
  app.get("/tools", c => c.json(tools.list()))

  // Permissions check (for TUI preflight)
  app.post("/permission/check", async c => {
    const req = await c.req.json()
    const decision = await permissions.check(req)
    return c.json(decision)
  })

  // Learning system routes with privacy safeguards and backward compatibility
  mountLearningRoutes(app, learning)

  // WebSocket upgrade — GlobalBus → Worker → RPC → TUI (no polling)
  // Hono WS via Bun.serve websocket handler below
  const server = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    // Long SSE streams (LLM first-token latency can exceed 10s) need a generous idle timeout
    idleTimeout: 180,
    fetch: app.fetch,
    websocket: {
      open(ws) {
        // Subscribe this socket to GlobalBus
        const unsub = bus.subscribeAll(event => {
          try { ws.send(JSON.stringify(event)) } catch {}
        })
        // Store unsub on ws data
        ;(ws as any).__unsub = unsub
        ws.send(JSON.stringify({ type: "server.heartbeat", payload: { connected: true }, timestamp: Date.now() }))
      },
      message(ws, msg) {
        // Handle permission replies, client pings, etc.
        try {
          const event = JSON.parse(String(msg))
          if (event.type === "permission.reply" || event.type === "question.reply") {
            bus.publish(event)
          }
        } catch {}
      },
      close(ws) {
        try { (ws as any).__unsub?.() } catch {}
      },
    },
  })

  console.log(`[mira] ✓ listening on http://${server.hostname}:${server.port}`)
  console.log(`[mira]   health:  GET  /health`)
  console.log(`[mira]   prompt:  POST /session/:id/prompt  (SSE)`)
  console.log(`[mira]   ws:      WS   /  (BusEvent stream)`)

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[mira] shutting down...")
    server.stop()
    mcp.disconnectAll()
    process.exit(0)
  })
}

// Only auto-start when run directly (not imported)
if (import.meta.main) {
  main().catch(err => {
    console.error("[mira] fatal:", err)
    process.exit(1)
  })
}

export { main }
export * from "./session/prompt.js"
export * from "./tools/registry.js"
export * from "./bus/index.js"
export * from "./storage/db.js"
export * from "./gateway/index.js"
export * from "./permission/index.js"
