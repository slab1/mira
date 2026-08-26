/**
 * Mira Server — Main Entry
 *
 * Architecture (Better-than-Mira):
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
import { z } from "zod"
import { timingSafeEqual } from "node:crypto"
import { Bus } from "./bus/index.js"
import { createDatabase, migrate } from "./storage/db.js"
import { createGateway } from "./gateway/index.js"
import { ToolRegistry } from "./tools/registry.js"
import { PermissionManager } from "./permission/index.js"
import { SessionPrompt } from "./session/prompt.js"
import { getAgentTemplates, AGENT_TEMPLATES } from "./agents/templates.js"
const BUILTIN_AGENT_KEYS: Record<string, true> = Object.fromEntries(Object.keys(AGENT_TEMPLATES).map(k => [k, true as const]))
import { MCPManager } from "./mcp/index.js"
import { loadConfig, saveConfig, removeMcpFromConfig, removeProviderFromConfig, getConfigLayers, getConfig } from "./config/index.js"
import { createLearningSystem, mountLearningRoutes } from "./learning/index.js"
import { setSharedKnowledge } from "./learning/knowledge.js"
import { GuardrailsManager } from "./guardrails/index.js"
import { getJob, listJobs, cancelJob } from "./tools/task.js"
import { writeFinding, listFindings, resolveFinding, type FindingSeverity } from "./tools/findings.js"
import type { BusEvent, MiraConfig, JsonValue } from "./types/index.js"
import type { Snapshot } from "./storage/snapshots.js"

type PartialMiraConfig = Partial<MiraConfig>

// ── Bootstrap ──────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? Bun.argv.find(a => a.startsWith("--port="))?.split("=")[1] ?? 4096)
const STARTED_AT = new Date().toISOString()
const STARTED_AT_MS = Date.now()
// Best-effort git SHA for /healthz (helps correlate deploys); falls back to env or "unknown"
let GIT_SHA: string = process.env.MIRA_GIT_SHA ?? ""
if (!GIT_SHA) {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir ? `${import.meta.dir}/../../..` : undefined, stdout: "pipe" })
    const out = proc.stdout ? new TextDecoder().decode(proc.stdout).trim() : ""
    if (out && /^[0-9a-f]{4,40}$/.test(out)) GIT_SHA = out
  } catch {}
  if (!GIT_SHA) GIT_SHA = "unknown"
}

// ── Security config ────────────────────────────────────────────────
// Bearer token gate (HTTP + WS). Empty = auth disabled (dev only).
const REQUIRED_TOKEN = process.env.MIRA_TOKEN ?? ""
// Multi-tenant API keys: MIRA_API_KEYS="key1:alice,key2:bob" → credential→owner map.
// When set, sessions are stamped with an ownerID and all session routes/WS
// events enforce ownership. Single-token (MIRA_TOKEN-only) deployments map to
// the implicit "default" owner — behavior unchanged.
const API_KEY_OWNERS = new Map<string, string>()
for (const pair of (process.env.MIRA_API_KEYS ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
  const i = pair.indexOf(":")
  if (i > 0) API_KEY_OWNERS.set(pair.slice(0, i), pair.slice(i + 1))
}
const OWNERSHIP_ENABLED = API_KEY_OWNERS.size > 0
/** Resolve a bearer credential to its owner id (undefined = invalid). */
function resolveOwner(token: string): string | undefined {
  if (!token) return undefined
  if (REQUIRED_TOKEN && tokenEquals(token, REQUIRED_TOKEN)) return "default"
  return API_KEY_OWNERS.get(token)
}
function bearerOf(authHeader: string | undefined): string {
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : ""
}
// Timing-safe token comparison (avoids length/byte leaks via response time)
function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
// Origin allowlist for CORS + WebSocket upgrades. Empty list = allow all (dev).
const CORS_ORIGIN_LIST = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
function isOriginAllowed(origin: string | null | undefined): boolean {
  if (!origin) return true // non-browser clients (curl, TUI) send no Origin
  if (CORS_ORIGIN_LIST.length === 0) return true // dev: allow all
  return CORS_ORIGIN_LIST.includes(origin)
}

async function initOtel() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) return
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node')
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
    const resources = await import('@opentelemetry/resources')
    const { SemanticResourceAttributes } = await import('@opentelemetry/semantic-conventions')
    type OtelResource = { attributes: Record<string, string>; merge: (other: OtelResource) => OtelResource; getRawAttributes: () => Record<string, string> }
    const maybeResource = (resources as object as Record<string, { new (attrs: Record<string, string>): OtelResource }>)["Resource"]
    const fallbackResource = (resources as object as { default: Record<string, { new (attrs: Record<string, string>): OtelResource }> }).default?.["Resource"]
    const Resource = maybeResource ?? fallbackResource
    if (!Resource) throw new Error("Resource not found in @opentelemetry/resources")
    const sdk = new NodeSDK({
      // @ts-expect-error — Resource interop between dynamic import and NodeSDK's expected type; runtime shape is correct
      resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: 'mira-server' }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` })
    })
    await sdk.start()
    console.log('[mira] OTel initialized')
  } catch (e) {
    console.warn('[mira] OTel init failed', e)
  }
}

async function main() {
  await initOtel()
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
    agent: opts.agent,
    model: opts.model,
  }))
  // Inject db/bus + fork runner so tools like session_list/session_fork work
  tools.setDefaultCtx({ db, bus, forkRunner: (opts) => prompt.forkSession(opts) })

  // 8. HTTP + WebSocket RPC (Hono)
  const app = new Hono<{ Variables: { requestId: string } }>()

  // Metrics collector
  const metrics = {
    httpRequestsTotal: new Map<string, number>(),
    httpRequestDurationSecondsSum: 0,
    httpRequestDurationSecondsCount: 0,
    activeSessions: 0,
  }

  // Security: CORS origin allowlist (CORS_ORIGINS, comma-separated; empty = allow all for dev)
  app.use("*", cors(CORS_ORIGIN_LIST.length > 0 ? { origin: CORS_ORIGIN_LIST } : {}))
  // OpenTelemetry tracer middleware
  app.use("*", async (c, next) => {
    const { trace } = await import('@opentelemetry/api')
    const tracer = trace.getTracer('mira-server')
    const span = tracer.startSpan('http.request', { attributes: { 'http.method': c.req.method, 'http.route': c.req.path } })
    try {
      await next()
      span.setAttribute('http.status_code', c.res.status)
    } finally {
      span.end()
    }
  })
  // Security: optional bearer-token gate (set MIRA_TOKEN to enable).
  // Authorization header ONLY — query-param tokens (?token=) are no longer accepted
  // (they leak into access logs, Referer headers, and browser history).
  // Public paths bypass the gate so liveness probes and metrics scrapes work unauthenticated.
  const PUBLIC_PATHS = new Set(["/healthz", "/metrics"])
  if (REQUIRED_TOKEN || API_KEY_OWNERS.size > 0) {
    app.use("*", async (c, next) => {
      if (PUBLIC_PATHS.has(c.req.path)) return await next()
      if (!resolveOwner(bearerOf(c.req.header("Authorization")))) return c.json({ error: "unauthorized" }, 401)
      await next()
    })
  }
  // Body-size limit: reject oversized request bodies before they are parsed (413)
  const MAX_BODY_BYTES = Number(process.env.MIRA_MAX_BODY_BYTES ?? 5 * 1024 * 1024)
  app.use("*", async (c, next) => {
    const len = Number(c.req.header("content-length") ?? 0)
    if (len > MAX_BODY_BYTES) return c.json({ error: "payload too large", limit: MAX_BODY_BYTES }, 413)
    await next()
  })
  // Global error handler — never leak stack traces to clients, always JSON
  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? crypto.randomUUID()
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", requestId, path: c.req.path, error: String(err?.stack ?? err) }))
    return c.json({ error: "internal server error", requestId }, 500)
  })
  // Zod body-validation helper — parse or answer 400 with field-level issues
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
  const mcpCreateSchema = z.object({
    name: z.string().min(1).max(100),
    type: z.enum(["local", "remote"]),
    command: z.array(z.string().min(1)).min(1).optional(),
    url: z.string().url().optional(),
    enabled: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }).superRefine((v, ctx) => {
    if (v.type === "local" && !v.command?.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "local type requires command[]" })
    if (v.type === "remote" && !v.url) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "remote type requires url" })
  })
  const mcpToggleSchema = z.object({ enabled: z.boolean() })
  // JsonValue for config patch values — avoids `unknown` per codebase rule (see types/index.ts)
  const jsonValueSchema: z.ZodType<JsonValue> = z.union([
    z.string(), z.number(), z.boolean(), z.null(),
    z.array(z.lazy(() => jsonValueSchema)),
    z.record(z.string(), z.lazy(() => jsonValueSchema)),
  ])
  const configPatchSchema = z.object({
    patch: z.record(z.string(), jsonValueSchema),
    layer: z.enum(["project", "local"]).optional(),
  }).refine((v) => v.patch && typeof v.patch === "object" && Object.keys(v.patch).length > 0, { message: "patch must be non-empty object", path: ["patch"] })
  const queuePushSchema = z.object({ prompt: z.string().min(1).max(20000) })
  app.use("*", async (c, next) => {
    const start = Date.now()
    const requestId = crypto.randomUUID()
    c.set("requestId", requestId)
    await next()
    const duration = Date.now() - start
    const status = c.res.status
    // Usage — surface cost/tokens per HTTP line for prompt turns (cumulative gateway stats)
    let usage: Record<string, number> = {}
    try {
      if (c.req.path.includes("/prompt") || c.req.path.includes("/session")) {
        const gw = gateway.stats()
        if (gw.costUSD || gw.inputTokens || gw.outputTokens) {
          usage = { cost_usd: Number(gw.costUSD.toFixed(4)), tokens_in: gw.inputTokens, tokens_out: gw.outputTokens }
        }
      }
    } catch {}
    const log = {
      timestamp: new Date().toISOString(),
      level: "info",
      method: c.req.method,
      path: c.req.path,
      status,
      duration_ms: duration,
      request_id: requestId,
      ...usage,
    }
    console.log(JSON.stringify(log))
  })

  // Rate limiting — token bucket per IP, 100 req/min, skip health/metrics probes
  const RATE_LIMIT_CAPACITY = 100
  const RATE_LIMIT_WINDOW_MS = 60_000
  const RATE_LIMIT_SKIP = new Set(["/health", "/dev/health", "/healthz", "/metrics"])
  const rateLimitBuckets = new Map<string, { tokens: number; last: number }>()
  // Hygiene: evict idle buckets (>10min) so the map can't grow unbounded under IP churn
  const RATE_LIMIT_BUCKET_TTL_MS = 10 * 60_000
  const rateLimitCleanup = setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_BUCKET_TTL_MS
    for (const [ip, bucket] of rateLimitBuckets) {
      if (bucket.last < cutoff) rateLimitBuckets.delete(ip)
    }
  }, 60_000)
  rateLimitCleanup.unref?.()
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (RATE_LIMIT_SKIP.has(path)) return await next()
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? "unknown"
    const now = Date.now()
    let bucket = rateLimitBuckets.get(ip)
    if (!bucket) {
      bucket = { tokens: RATE_LIMIT_CAPACITY, last: now }
      rateLimitBuckets.set(ip, bucket)
    }
    const elapsed = now - bucket.last
    if (elapsed > 0) {
      const refill = (elapsed / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_CAPACITY
      bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + refill)
      bucket.last = now
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      await next()
      // Standard RateLimit headers on every non-429 response
      c.res.headers.set("X-RateLimit-Limit", String(RATE_LIMIT_CAPACITY))
      c.res.headers.set("X-RateLimit-Remaining", String(Math.floor(bucket.tokens)))
    } else {
      // Seconds until one token refills (refill rate = capacity/window per ms)
      const refillPerMs = RATE_LIMIT_CAPACITY / RATE_LIMIT_WINDOW_MS
      const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000))
      const res = c.json({ error: "Too Many Requests" }, 429)
      res.headers.set("Retry-After", String(retryAfterSec))
      res.headers.set("X-RateLimit-Limit", String(RATE_LIMIT_CAPACITY))
      res.headers.set("X-RateLimit-Remaining", "0")
      return res
    }
  })

  // Metrics middleware
  // Cardinality guard: collapse IDs/UUIDs/long segments to ":id", cap label space.
  const METRICS_MAX_LABELS = 1000
  const metricPath = (p: string): string =>
    p.split("/").map(seg => (seg.length > 16 || /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(seg)) ? ":id" : seg).join("/")
  app.use('*', async (c, next) => {
    const start = Date.now()
    await next()
    const durationSec = (Date.now() - start) / 1000
    const method = c.req.method
    const path = metricPath(c.req.path)
    const status = c.res.status
    const key = `${method} ${path} ${status}`
    if (metrics.httpRequestsTotal.has(key) || metrics.httpRequestsTotal.size < METRICS_MAX_LABELS) {
      metrics.httpRequestsTotal.set(key, (metrics.httpRequestsTotal.get(key) ?? 0) + 1)
    }
    metrics.httpRequestDurationSecondsSum += durationSec
    metrics.httpRequestDurationSecondsCount += 1
    // Track active sessions in-memory
    if (method === 'POST' && path === '/session' && status === 201) {
      metrics.activeSessions += 1
    }
    if (method === 'DELETE' && path.startsWith('/session/') && status === 200) {
      metrics.activeSessions = Math.max(0, metrics.activeSessions - 1)
    }
  })

  // Landing page — friendly index when opened in a browser
  app.get("/", c => {
    return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>Mira</title>
<style>
  body{background:#09090b;color:#e4e4e7;font-family:ui-sans-serif,system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{max-width:560px;padding:32px;border:1px solid #27272a;border-radius:16px;background:#18181b}
  h1{margin:0 0 8px;font-size:22px}
  p{color:#a1a1aa;font-size:13px;line-height:1.6}
  code{background:#27272a;padding:2px 6px;border-radius:6px;font-size:12px;color:#c4b5fd}
  .live{color:#86efac}
</style></head>
<body><div class="card">
  <h1>Mira <span class="live">● live</span></h1>
  <p>Agent engine v0.1.0 · ${tools.count()} tools · gateway cost-tracked</p>
  <p>This is the <b>API</b>. For the chat UI run the web client:</p>
  <p><code>cd packages/web && bun run dev</code> → forward port <b>3000</b></p>
  <p>API surface: <code>/health</code> · <code>/dev/health</code> · <code>/session</code> · <code>/session/:id/prompt</code> (SSE) · <code>/tools</code> · <code>/mcp</code> · <code>/skills</code></p>
</div></body></html>`)
  })

  // Liveness — minimal, no internals, bypasses auth + rate limit (Docker/k8s probes)
  app.get("/healthz", c => c.json({ ok: true, version: "0.1.0", sha: GIT_SHA, startedAt: STARTED_AT, uptime: process.uptime() }))
  // Health — detailed; stays behind MIRA_TOKEN when set
  app.get("/health", c => c.json({ ok: true, version: "0.1.0", sha: GIT_SHA, startedAt: STARTED_AT, tools: tools.count(), uptime: process.uptime(), memory: process.memoryUsage() }))
  app.get("/dev/health", c => c.json({ ok: true, version: "0.1.0", sha: GIT_SHA, startedAt: STARTED_AT, tools: tools.count(), busHistory: bus.recent(5).length, learning: learning.scheduler.status(), gateway: gateway.stats(), uptime: process.uptime() }))
  // Metrics
  app.get("/metrics", async c => {
    const gatewayStats = gateway.stats()
    const cost = gatewayStats.costUSD
    const activeSessions = metrics.activeSessions

    let out = ''
    out += '# HELP http_requests_total Total HTTP requests\n'
    out += '# TYPE http_requests_total counter\n'
    for (const [key, val] of metrics.httpRequestsTotal) {
      const parts = key.split(' ')
      const method = parts[0]
      const status = parts[parts.length - 1]
      const route = parts.slice(1, -1).join(' ')
      out += `http_requests_total{method="${method}",route="${route}",status="${status}"} ${val}\n`
    }
    out += '# HELP http_request_duration_seconds HTTP request duration seconds\n'
    out += '# TYPE http_request_duration_seconds summary\n'
    out += `http_request_duration_seconds_sum ${metrics.httpRequestDurationSecondsSum}\n`
    out += `http_request_duration_seconds_count ${metrics.httpRequestDurationSecondsCount}\n`
    out += '# HELP active_sessions Number of active sessions\n'
    out += '# TYPE active_sessions gauge\n'
    out += `active_sessions ${activeSessions}\n`
    out += '# HELP gateway_cost_total Total gateway cost USD\n'
    out += '# TYPE gateway_cost_total counter\n'
    out += `gateway_cost_total ${cost}\n`
    return c.text(out, 200, { 'Content-Type': 'text/plain; version=0.0.4' })
  })
  // Skills
  app.get("/skills", async c => {
    const { loadSkills } = await import("./skills/loader.js")
    const skills = await loadSkills()
    return c.json(Object.keys(skills))
  })

  app.get("/commands", async c => {
    const { loadCommands } = await import("./commands/loader.js")
    const commands = await loadCommands()
    return c.json(commands)
  })

  // ── Multi-tenant ownership helpers ────────────────────────────────
  // Returns the session if it exists AND (ownership disabled OR requester owns
  // it OR it's a legacy unowned row). Null otherwise → routes answer 404.
  async function authorizedSession(id: string, c: { req: { header: (n: string) => string | undefined } }) {
    const s = await prompt.getSession(id)
    if (!s) return null
    if (!OWNERSHIP_ENABLED || !s.ownerID) return s
    return resolveOwner(bearerOf(c.req.header("Authorization"))) === s.ownerID ? s : null
  }

  // REST — sessions
  app.get("/session", async c => {
    const owner = OWNERSHIP_ENABLED ? resolveOwner(bearerOf(c.req.header("Authorization"))) : undefined
    const all = await db.query.sessions.findMany({ orderBy: (s, { desc }) => [desc(s.updatedAt)] })
    return c.json(owner ? all.filter(s => !s.ownerID || s.ownerID === owner) : all)
  })
  app.post("/session", async c => {
    const body = await c.req.json().catch(() => ({}))
    const session = await prompt.createSession({
      ...body,
      ownerID: OWNERSHIP_ENABLED ? resolveOwner(bearerOf(c.req.header("Authorization"))) ?? "default" : null,
    })
    sessionOwnerCache.set(session.id, session.ownerID ?? null)
    bus.publish({ type: "session.created", payload: session, timestamp: Date.now() })
    return c.json(session, 201)
  })
  app.get("/session/:id", async c => {
    const session = await authorizedSession(c.req.param("id"), c)
    if (!session) return c.json({ error: "not found" }, 404)
    return c.json(session)
  })
  app.delete("/session/:id", async c => {
    if (!(await authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    sessionOwnerCache.delete(c.req.param("id"))
    await prompt.deleteSession(c.req.param("id"))
    bus.publish({ type: "session.deleted", payload: { id: c.req.param("id") }, timestamp: Date.now() })
    return c.json({ ok: true })
  })

  // Job board — background subagent task status/results (persistent jobs table)
  app.get("/session/:id/jobs", async c => {
    const id = c.req.param("id")
    if (!(await authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    return c.json(await listJobs(db, id))
  })
  app.get("/job/:id", async c => {
    const job = await getJob(db, c.req.param("id"))
    if (!job || !(await authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
    return c.json(job)
  })
  app.post("/job/:id/cancel", async c => {
    const job = await getJob(db, c.req.param("id"))
    if (!job || !(await authorizedSession(job.parentSessionID, c))) return c.json({ error: "not found" }, 404)
    const cancelled = await cancelJob(db, c.req.param("id"))
    bus.publish({ type: "job.cancelled", payload: { jobID: job.id }, timestamp: Date.now() })
    return c.json(cancelled)
  })

  // Findings — structured cross-agent team memory (shared by design across owners)
  app.get("/finding", async c => {
    const status = c.req.query("status") as "open" | "resolved" | undefined
    const severity = c.req.query("severity") as FindingSeverity | undefined
    const limit = Number(c.req.query("limit") ?? "") || undefined
    return c.json(await listFindings(db, { status, severity, limit }))
  })
  app.post("/finding", async c => {
    const parsed = findingSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: "invalid finding", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    }
    const body = parsed.data
    const f = await writeFinding(db, {
      title: body.title.trim(),
      severity: body.severity,
      evidence: body.evidence,
      source: body.source ?? "user",
      sessionID: body.sessionID ?? null,
    })
    bus.publish({ type: "job.updated", payload: { finding: f.id, action: "created" }, timestamp: Date.now() })
    return c.json(f, 201)
  })
  app.post("/finding/:id/resolve", async c => {
    const f = await resolveFinding(db, c.req.param("id"))
    if (!f) return c.json({ error: "not found" }, 404)
    bus.publish({ type: "job.updated", payload: { finding: f.id, action: "resolved" }, timestamp: Date.now() })
    return c.json(f)
  })

  // Prompt — the core loop (streamed via SSE)
  app.post("/session/:id/prompt", async c => {
    const id = c.req.param("id")
    const { prompt: text, model, maxSteps } = await c.req.json().catch(() => ({}))
    if (!text?.trim?.()) return c.json({ error: "empty prompt" }, 400)
    // Validate session exists + requester owns it
    if (!(await authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)

    // Stream response as SSE (Vercel AI SDK style); per-request loop options honored
    return prompt.streamResponse(id, text, model, { maxSteps })
  })

  // Messages & parts
  app.get("/session/:id/message", async c => {
    if (!(await authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    const messages = await prompt.getMessages(c.req.param("id"))
    return c.json(messages)
  })

  // Session export — shareable transcript (markdown or JSON)
  app.get("/session/:id/export", async c => {
    const id = c.req.param("id")
    const session = await authorizedSession(id, c)
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
    for (const m of messages) {
      const role = m.role === "user" ? "🙋 User" : m.role === "assistant" ? "🤖 Mira" : m.role
      lines.push(`## ${role}`)
      for (const p of m.parts ?? []) {
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

  app.post("/mcp", async c => {
    const parsed = mcpCreateSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid mcp", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    const body = parsed.data
    try {
      const cfg = {
        type: body.type,
        command: body.command,
        url: body.url,
        enabled: body.enabled ?? true,
        env: body.env,
        headers: body.headers,
      }
      const entry = await mcp.addServer(body.name.trim(), cfg)
      const current = getConfig().mcp ?? {}
      await saveConfig({ mcp: { ...current, [body.name.trim()]: cfg } }, "project")
      return c.json(entry, 201)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return c.json({ error: msg }, 400)
    }
  })

  app.delete("/mcp/:name", async c => {
    const name = c.req.param("name")
    try {
      await mcp.removeServer(name)
      await removeMcpFromConfig(name)
      return c.json({ ok: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return c.json({ error: msg }, 404)
    }
  })

  app.patch("/mcp/:name", async c => {
    const name = c.req.param("name")
    const parsed = mcpToggleSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid mcp toggle", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    const body = parsed.data
    try {
      const entry = await mcp.toggleServer(name, body.enabled)
      const current = getConfig().mcp ?? {}
      const existing = current[name]
      if (existing) {
        await saveConfig({ mcp: { ...current, [name]: { ...existing, enabled: body.enabled } } }, "project")
      }
      return c.json(entry)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return c.json({ error: msg }, 404)
    }
  })

  app.post("/mcp/:name/test", async c => {
    const name = c.req.param("name")
    const result = await mcp.testServer(name)
    if (!result.ok && result.error?.includes("not found")) return c.json(result, 404)
    return c.json(result)
  })

  // ── Config — layered settings (behind auth gate, same as /mcp) ─────
  function maskApiKey(key: string): string {
    if (!key) return ""
    if (key.length <= 4) return "***"
    return `${key.slice(0, 3)}***${key.slice(-4)}`
  }
  function redactConfig<T extends MiraConfig | Partial<MiraConfig>>(cfg: T): T {
    const out = JSON.parse(JSON.stringify(cfg)) as T
    const providers = (out as MiraConfig).provider as Record<string, { options?: { apiKey?: string } }> | undefined
    if (providers && typeof providers === "object") {
      for (const p of Object.values(providers)) {
        const opts = p.options
        if (opts && typeof opts.apiKey === "string" && opts.apiKey) {
          opts.apiKey = "***"
        }
      }
    }
    return out
  }
  function redactLayers(layers: Array<{ source: string; path: string | null; config: Partial<MiraConfig> }>) {
    return layers.map(l => ({ ...l, config: redactConfig(l.config) }))
  }

  app.get("/config", async c => {
    const { merged, layers } = await getConfigLayers()
    return c.json({ merged: redactConfig(merged), layers: redactLayers(layers) })
  })

  app.patch("/config", async c => {
    const parsed = configPatchSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid config patch", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    const body = parsed.data
    const layer = body.layer === "local" ? "local" : "project"
    try {
      const merged = await saveConfig(body.patch as Partial<MiraConfig>, layer)
      return c.json({ merged: redactConfig(merged) })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return c.json({ error: msg }, 400)
    }
  })

  app.get("/config/schema", async c => {
    // Try zod-to-json-schema if available, else hand-map
    try {
      const mod = await import("zod-to-json-schema" as string).catch(() => null) as { zodToJsonSchema?: (schema: { parse: (data: PartialMiraConfig) => MiraConfig }) => Record<string, string> } | null
      if (mod?.zodToJsonSchema) {
        const configModule = await import("./config/index.js").catch(() => ({ miraConfigSchema: null })) as { miraConfigSchema?: { parse: (data: PartialMiraConfig) => MiraConfig } }
        let schema: { parse: (data: PartialMiraConfig) => MiraConfig } | null = configModule.miraConfigSchema ?? null
        if (!schema) {
          try {
            const shared = await import("../../shared/src/schemas/config.js") as { miraConfigSchema?: { parse: (data: PartialMiraConfig) => MiraConfig } }
            schema = shared.miraConfigSchema ?? null
          } catch {}
        }
        if (schema) return c.json(mod.zodToJsonSchema(schema))
      }
    } catch {}
    // Fallback hand-mapped schema with 7 top keys
    return c.json({
      type: "object",
      properties: {
        model: { type: "string", description: "Primary model ref" },
        smallModel: { type: "string" },
        loop: { type: "object", properties: { maxSteps: { type: "number" }, contextLimit: { type: "number" }, compactionThreshold: { type: "number" }, smallModel: { type: "string" } } },
        permission: { type: "object", description: "Permission matrix" },
        guardrails: { type: "object" },
        mcp: { type: "object", description: "MCP servers" },
        provider: { type: "object", description: "Provider registry" },
        agents: { type: "object" },
        theme: { type: "string", enum: ["dark", "light", "system"] },
        debug: { type: "boolean" },
      },
    })
  })

  app.get("/providers", async c => {
    const cfg = getConfig()
    const providers = cfg.provider ?? {}
    const list = Object.entries(providers).map(([id, p]) => {
      const prov = p as { name?: string; options?: { baseURL?: string; apiKey?: string }; models?: Record<string, { name: string; limit: { context: number; output: number } }> }
      const apiKey = prov.options?.apiKey ?? ""
      return {
        id,
        name: prov.name ?? id,
        hasKey: !!apiKey,
        masked: apiKey ? maskApiKey(apiKey) : "",
        baseURL: prov.options?.baseURL ?? "",
        modelCount: prov.models ? Object.keys(prov.models).length : 0,
      }
    })
    return c.json(list)
  })

  // Provider test (mira parity — checks apiKey presence + baseURL reachability)
  app.post("/providers/:id/test", async c => {
    const id = c.req.param("id")
    const cfg = getConfig()
    const prov = cfg.provider?.[id] as { options?: { apiKey?: string; baseURL?: string } } | undefined
    if (!prov) return c.json({ ok: false, error: "provider not found" }, 404)
    const hasKey = !!prov.options?.apiKey
    if (!hasKey) return c.json({ ok: false, error: "missing apiKey" }, 400)
    const baseURL = prov.options?.baseURL
    if (baseURL) {
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 3000)
        await fetch(baseURL, { method: "HEAD", signal: controller.signal }).catch(() => {})
        clearTimeout(t)
      } catch {}
    }
    return c.json({ ok: true, hasKey, baseURL: baseURL ?? "" })
  })
  app.post("/provider/:id/test", async c => {
    const id = c.req.param("id")
    const cfg = getConfig()
    const prov = cfg.provider?.[id] as { options?: { apiKey?: string; baseURL?: string } } | undefined
    if (!prov) return c.json({ ok: false, error: "provider not found" }, 404)
    const hasKey = !!prov.options?.apiKey
    if (!hasKey) return c.json({ ok: false, error: "missing apiKey" }, 400)
    const baseURL = prov.options?.baseURL
    if (baseURL) {
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 3000)
        await fetch(baseURL, { method: "HEAD", signal: controller.signal }).catch(() => {})
        clearTimeout(t)
      } catch {}
    }
    return c.json({ ok: true, hasKey, baseURL: baseURL ?? "" })
  })

  // Provider delete (mira parity)
  app.delete("/providers/:id", async c => {
    const id = c.req.param("id")
    const cfg = getConfig()
    if (!cfg.provider?.[id]) return c.json({ error: "provider not found" }, 404)
    await removeProviderFromConfig(id)
    return c.json({ ok: true })
  })
  app.delete("/provider/:id", async c => {
    const id = c.req.param("id")
    const cfg = getConfig()
    if (!cfg.provider?.[id]) return c.json({ error: "provider not found" }, 404)
    await removeProviderFromConfig(id)
    return c.json({ ok: true })
  })

  // Message queue — type while the agent streams (Mira-parity UX)
  app.post("/session/:id/queue", async c => {
    const parsed = queuePushSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid queue push", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    const text = parsed.data.prompt
    const id = c.req.param("id")
    if (!(await authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    return c.json(prompt.queueMessage(id, String(text).trim()))
  })
  app.get("/session/:id/queue", c => c.json(prompt.getQueue(c.req.param("id"))))
  app.delete("/session/:id/queue", c => c.json({ cleared: prompt.clearQueue(c.req.param("id")) }))

  // File snapshots — undo/rewind agent file mutations
  app.get("/session/:id/snapshots", async c => {
    if (!(await authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    const { listSnapshots } = await import("./storage/snapshots.js")
    return c.json(listSnapshots(db, c.req.param("id")))
  })
  app.post("/session/:id/revert", async c => {
    const body = await c.req.json().catch(() => ({}))
    const { revertLast, revertToMessage } = await import("./storage/snapshots.js")
    const id = c.req.param("id")
    if (!(await authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    try {
      const reverted = body.messageID
        ? await revertToMessage(db, id, body.messageID)
        : [await revertLast(db, id)].filter(Boolean)
      bus.publish({ type: "session.updated", sessionID: id, payload: { reverted: reverted.length }, timestamp: Date.now() })
      return c.json({ ok: true, reverted: reverted.length, files: reverted.filter(Boolean).map(r => (r as Snapshot).path) })
    } catch (e) {
      return c.json({ ok: false, error: String(e) }, 400)
    }
  })

  // Todos
  app.get("/session/:id/todo", async c => {
    if (!(await authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    const todos = await prompt.getTodos(c.req.param("id"))
    return c.json(todos)
  })
  app.post("/session/:id/todo", async c => {
    if (!(await authorizedSession(c.req.param("id"), c))) return c.json({ error: "not found" }, 404)
    const parsed = todoSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: "invalid todos", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    }
    const sid = c.req.param("id")
    const todos = parsed.data.map(t => ({ ...t, id: crypto.randomUUID(), sessionID: sid, createdAt: Date.now() })) as Parameters<SessionPrompt["setTodos"]>[1]
    const result = await prompt.setTodos(sid, todos)
    bus.publish({ type: "todo.updated", sessionID: sid, payload: result, timestamp: Date.now() })
    return c.json(result)
  })

  // Tools list (for TUI introspection)
  app.get("/tools", c => c.json(tools.list()))

  // Agent catalog — built-in lane templates + mira.json custom agents
  app.get("/agents", c => {
    const registry = getAgentTemplates()
    return c.json(Object.entries(registry).map(([name, tpl]) => ({
      name,
      description: tpl.description,
      tools: [...tpl.tools],
      permissions: tpl.permissions,
      custom: !(name in BUILTIN_AGENT_KEYS),
    })))
  })

  // Permissions check (for TUI preflight)
  app.post("/permission/check", async c => {
    const req = await c.req.json()
    const decision = await permissions.check(req)
    return c.json(decision)
  })

  // Learning system routes with privacy safeguards and backward compatibility
  mountLearningRoutes(app, learning)

  // WebSocket upgrade — GlobalBus → Worker → RPC → TUI (no polling)
  //
  // Security model:
  //   • Upgrades are admitted EXPLICITLY in fetch below (a fall-through Response means
  //     Bun never upgrades), so every socket passes the same checks as HTTP.
  //   • Origin validated against CORS_ORIGINS allowlist (empty = allow all for dev).
  //   • Auth = same bearer token as HTTP. Preferred: Authorization header on the upgrade
  //     request. Fallback for clients that cannot set headers (browsers): send
  //     {"type":"auth","token":"..."} as the FIRST message within 5s of open.
  //   • Unauthenticated sockets are closed with 1008 (policy violation).
  //   • Query-param tokens (?token=) are NOT accepted anywhere.
  const WS_AUTH_TIMEOUT_MS = 5_000

  // ── Per-owner live event filtering ────────────────────────────────
  // Maps sessionID → ownerID (cached; lazily backfilled from the DB).
  // Unknown sessions fail closed: events are dropped until ownership resolves.
  const sessionOwnerCache = new Map<string, string | null>()
  const pendingOwnerLookups = new Map<string, Promise<string | null>>()
  function ownerOfSession(sessionID: string): Promise<string | null> {
    const cached = sessionOwnerCache.get(sessionID)
    if (cached !== undefined) return Promise.resolve(cached)
    let p = pendingOwnerLookups.get(sessionID) as Promise<string | null> | undefined
    if (!p) {
      const lookup: Promise<string | null> = db.query.sessions.findFirst({ where: (s, { eq }) => eq(s.id, sessionID) })
        .then(s => {
          const o = (s?.ownerID ?? null) as string | null
          sessionOwnerCache.set(sessionID, o)
          pendingOwnerLookups.delete(sessionID)
          return o
        })
        .catch(() => { pendingOwnerLookups.delete(sessionID); return null })
      p = lookup
      pendingOwnerLookups.set(sessionID, lookup)
    }
    return p
  }

  // WebSocket sockets carry server-side state beyond Bun's wire data —
  // this structural type describes the extended shape (no `any`).
  interface MiraWSData {
    authenticated?: boolean
    owner?: string
  }
  interface MiraWS {
    data?: MiraWSData
    __active: boolean
    __authTimer?: ReturnType<typeof setTimeout>
    __unsub?: () => void
    __owner?: string | null
    send(data: string): void
    close(code: number, reason?: string): void
  }

  function activateSocket(ws: MiraWS, owner?: string) {
    if (ws.__active) return
    ws.__active = true
    ws.__owner = owner ?? null
    clearTimeout(ws.__authTimer)
    // Subscribe this socket to GlobalBus only after authentication;
    // with multi-tenant keys enabled, events are scoped to the socket's owner.
    ws.__unsub = bus.subscribeAll(event => {
      try {
        if (!OWNERSHIP_ENABLED || !event.sessionID || event.type.startsWith("server.")) {
          ws.send(JSON.stringify(event))
          return
        }
        void ownerOfSession(event.sessionID).then(o => {
          // Fail closed: drop events whose owner is unknown or foreign
          if (!ws.__active) return
          if (o === null || o === ws.__owner) ws.send(JSON.stringify(event))
        })
      } catch {}
    })
    ws.send(JSON.stringify({ type: "server.heartbeat", payload: { connected: true }, timestamp: Date.now() }))
  }

  const server = Bun.serve<MiraWSData>({
    port: PORT,
    // Security: loopback by default — remote access requires HOST env override
    hostname: process.env.HOST ?? "127.0.0.1",
    // Long SSE streams (LLM first-token latency can exceed 10s) need a generous idle timeout
    idleTimeout: 180,
    fetch(req, srv) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!isOriginAllowed(req.headers.get("origin"))) {
          return new Response(JSON.stringify({ error: "forbidden origin" }), { status: 403, headers: { "content-type": "application/json" } })
        }
        let authenticated = false
        let owner: string | undefined
        if (!REQUIRED_TOKEN && API_KEY_OWNERS.size === 0) {
          authenticated = true // dev mode: no credentials configured
        } else {
          const auth = req.headers.get("authorization") ?? ""
          owner = resolveOwner(bearerOf(auth))
          authenticated = owner !== undefined
        }
        const upgraded = srv.upgrade(req, { data: { authenticated, owner } })
        if (!upgraded) return new Response("WebSocket upgrade failed", { status: 500 })
        return undefined
      }
      return app.fetch(req)
    },
    websocket: {
      // Frame cap enforced in message() below (close 1009 >1MB) — Bun ws has no maxPayload option here
      open(ws) {
        const w = ws as object as MiraWS
        w.__active = false
        if ((!REQUIRED_TOKEN && API_KEY_OWNERS.size === 0) || w.data?.authenticated === true) {
          activateSocket(w, w.data?.owner)
        } else {
          // Grace window: client must send {"type":"auth","token":...} within 5s
          w.__authTimer = setTimeout(() => {
            if (!w.__active) {
              try { w.close(1008, "unauthorized: auth message not received within timeout") } catch {}
            }
          }, WS_AUTH_TIMEOUT_MS)
        }
      },
      message(ws, msg) {
        const w = ws as object as MiraWS
        const raw = String(msg)
        if (raw.length > 1_000_000) {
          try { w.close(1009, "message too large") } catch {}
          return
        }
        let event: { type?: string; token?: string; sessionID?: string } | null = null
        try { event = JSON.parse(raw) } catch {}
        if (!w.__active) {
          // Pre-auth: only the auth handshake is accepted; anything else is ignored
          // (the 5s timer closes unauthenticated sockets with 1008)
          const owner = event?.type === "auth" && typeof event.token === "string"
            ? resolveOwner(event.token)
            : undefined
          if (owner !== undefined) activateSocket(w, owner)
          return
        }
        // Handle permission replies, client pings, etc.
        if (event?.type !== "permission.reply" && event?.type !== "question.reply") return
        bus.publish(event as BusEvent)
      },
      close(ws) {
        const w = ws as object as MiraWS
        clearTimeout(w.__authTimer)
        try { w.__unsub?.() } catch {}
      },
    },
  })

  console.log(`[mira] ✓ listening on http://${server.hostname}:${server.port}`)
  console.log(`[mira]   liveness: GET /healthz (no auth) · detail: GET /health`)
  console.log(`[mira]   prompt:  POST /session/:id/prompt  (SSE)`)
  console.log(`[mira]   ws:      WS   /  (BusEvent stream)`)

  // Graceful shutdown — handles SIGINT (Ctrl-C) AND SIGTERM (systemd/docker/kill)
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[mira] ${signal} — draining…`)
    clearInterval(rateLimitCleanup)
    try { server.stop(true) } catch {}
    try { mcp.disconnectAll() } catch {}
    try {
      const { shutdownAllServers } = await import("./lsp/client.js")
      await shutdownAllServers().catch(() => {})
    } catch {}
    try { db.sqlite?.close?.() } catch {}
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
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
