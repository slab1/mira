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
import { getAgentTemplates, AGENT_TEMPLATES, isKnownAgent } from "./agents/templates.js"
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
import { mountHealthRoutes } from "./routes/health.js"
import { mountSessionRoutes } from "./routes/session.js"
import { mountConfigRoutes } from "./routes/config.js"
import { mountMcpRoutes } from "./routes/mcp.js"
import { mountAdminRoutes } from "./routes/admin.js"

type PartialMiraConfig = Partial<MiraConfig>

// ── Bootstrap ──────────────────────────────────────────────────────
const PORT_RAW = process.env.PORT ?? Bun.argv.find(a => a.startsWith("--port="))?.split("=")[1] ?? "4096"
const PORT = (() => {
  const n = Number(PORT_RAW)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    console.error(`[mira] invalid PORT=${PORT_RAW}, falling back to 4096`)
    return 4096
  }
  return Math.floor(n)
})()
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
if (REQUIRED_TOKEN === "change-me-to-a-long-random-secret") {
  console.warn("[mira] ⚠️  MIRA_TOKEN is placeholder — set a real secret via /root/.mira/mira.env or env")
}
// Multi-tenant API keys: MIRA_API_KEYS="key1:alice,key2:bob" → credential→owner map.
// When set, sessions are stamped with an ownerID and all session routes/WS
// events enforce ownership. Single-token (MIRA_TOKEN-only) deployments map to
// the implicit "default" owner — behavior unchanged.
const API_KEY_OWNERS = new Map<string, string>()
for (const pair of (process.env.MIRA_API_KEYS ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
  const i = pair.indexOf(":")
  if (i > 0) API_KEY_OWNERS.set(pair.slice(0, i), pair.slice(i + 1))
}
if (process.env.NODE_ENV === "production" && !REQUIRED_TOKEN && API_KEY_OWNERS.size === 0 && process.env.MIRA_STRICT_AUTH !== "0") {
  console.error("[mira] ❌ MIRA_TOKEN or MIRA_API_KEYS required in production — refusing to start without auth")
  process.exit(1)
}
let OWNERSHIP_ENABLED = API_KEY_OWNERS.size > 0
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
// Host binding — validate allowed values
const HOST = process.env.HOST ?? "127.0.0.1"
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"])
if (!ALLOWED_HOSTS.has(HOST)) {
  console.warn(`[mira] ⚠️  HOST=${HOST} not in allowed list, defaulting to 127.0.0.1`)
}
// Origin allowlist for CORS + WebSocket upgrades. Empty list = allow all (dev).
const CORS_ORIGIN_LIST = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
if (process.env.NODE_ENV === "production" && HOST === "0.0.0.0" && CORS_ORIGIN_LIST.length === 0) {
  console.error("[mira] ❌ CORS_ORIGINS must be set when HOST=0.0.0.0 in production — refusing to start with open CORS")
  if (process.env.MIRA_STRICT_CORS !== "0") process.exit(1)
}
function isOriginAllowed(origin: string | null | undefined): boolean {
  if (!origin) return true // non-browser clients (curl, TUI) send no Origin
  if (origin.startsWith("vscode-webview://") || origin.startsWith("vscode-file://") || origin.startsWith("vscode:")) return true // VS Code webview
  if (CORS_ORIGIN_LIST.length === 0) return true // dev: allow all
  if (CORS_ORIGIN_LIST.includes(origin)) return true
  // localhost bypass only in dev or when explicitly allowed — prevents prod CORS void
  const allowLocal = process.env.MIRA_ALLOW_LOCALHOST !== "0" && (process.env.NODE_ENV !== "production" || CORS_ORIGIN_LIST.length === 0)
  if (allowLocal && (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))) return true
  return false
}

// Terminal WS config (wired via MIRA_TERMINAL_ENABLED)
const TERMINAL_ENABLED = process.env.MIRA_TERMINAL_ENABLED !== "0"
const TERMINAL_SANDBOX = process.env.MIRA_TERMINAL_SANDBOX === "1"

// Expand {env:VAR} placeholders in provider/MCP config strings — lets mira.json keep secrets out of git
function expandEnv(value: string): string {
  if (!value) return value
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? "")
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

  // 2b. Memory Bank (Kilo K3 parity) — ensure data/memory_bank exists with starter files
  try {
    const dbPath = process.env.MIRA_DB ?? "./data/mira.db"
    const slash = dbPath.lastIndexOf("/")
    const bankDir = slash >= 0 ? `${dbPath.slice(0, slash)}/memory_bank` : "./data/memory_bank"
    const { mkdir, readdir } = await import("node:fs/promises")
    await mkdir(bankDir, { recursive: true })
    const existing = await readdir(bankDir).catch(() => [] as string[])
    if (existing.length === 0) {
      const starters: Record<string, string> = {
        "decisions.md": "# Decisions\n\nArchitectural decisions and rationale. Update when you choose a pattern, library, or boundary.\n",
        "conventions.md": "# Conventions\n\nCode style, naming, repo patterns. E.g. repository pattern for DB, Zod for validation.\n",
        "tech_debt.md": "# Tech Debt\n\nKnown shortcuts, TODOs, and fragility. Mark what not to touch.\n",
        "active_work.md": "# Active Work\n\nIn-progress branches, mid-migration notes, what the next session should resume.\n",
        "file_paths.md": "# File Paths\n\nFrequently referenced files and their roles.\n",
      }
      for (const [name, content] of Object.entries(starters)) {
        try { await Bun.write(`${bankDir}/${name}`, content) } catch {}
      }
      console.log(`[mira] memory_bank initialized at ${bankDir} (5 files)`)
    }
  } catch (e) {
    console.warn("[mira] memory_bank init failed:", String(e))
  }

  // Load runtime-issued API keys (persisted in db) into the owner map so they
  // survive restarts. Env keys were loaded above; these augment that map.
  try {
    const rows = db.sqlite.prepare("SELECT key, owner FROM api_keys").all() as { key: string; owner: string }[]
    for (const r of rows) API_KEY_OWNERS.set(r.key, r.owner)
    if (rows.length) console.log(`[mira] loaded ${rows.length} issued API key(s) from db`)
    OWNERSHIP_ENABLED = API_KEY_OWNERS.size > 0
  } catch (e) {
    console.warn("[mira] failed to load issued API keys:", String(e))
  }

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
    signal: opts.signal,
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
  // OpenTelemetry tracer middleware — cache tracer outside per-request import
  let cachedTracer: { startSpan: (name: string, opts?: JsonValue) => { setAttribute: (k: string, v: JsonValue) => void; end: () => void } } | null = null
  let otelFailed = false
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    try {
      const { trace } = await import('@opentelemetry/api')
      cachedTracer = trace.getTracer('mira-server') as { startSpan: (name: string, opts?: JsonValue) => { setAttribute: (k: string, v: JsonValue) => void; end: () => void } }
    } catch { otelFailed = true }
  }
  app.use("*", async (c, next) => {
      if (!cachedTracer || otelFailed) return await next()
      const tracer = cachedTracer
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
  // Public paths bypass the gate so liveness probes, metrics scrapes, and the
  // static web client (SPA shell + hashed assets) load without a token. The API
  // itself stays gated — only the HTML/JS/CSS that *render* the login card are open.
  const PUBLIC_PATHS = new Set(["/healthz", "/metrics"])
  const isPublicUiPath = (p: string) =>
    p === "/" || p.startsWith("/assets/") || p === "/favicon.ico" || p === "/robots.txt" || p === "/vite.svg"
  if (REQUIRED_TOKEN || API_KEY_OWNERS.size > 0) {
    app.use("*", async (c, next) => {
      if (PUBLIC_PATHS.has(c.req.path) || isPublicUiPath(c.req.path)) return await next()
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
    c.header("X-Request-Id", requestId)
    await next()
    c.header("X-Request-Id", requestId)
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
  // Only trust proxy headers when explicitly enabled (MIRA_TRUST_PROXY=1)
  const TRUST_PROXY = process.env.MIRA_TRUST_PROXY === "1"
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (RATE_LIMIT_SKIP.has(path)) return await next()
    const ip = TRUST_PROXY
      ? (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown")
      : (c.req.header("x-real-ip") ?? "unknown")
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
  // If web build exists (packages/web/dist), serve it; otherwise show API landing
  app.get("/", async c => {
    try {
      const indexFile = Bun.file(`${import.meta.dir}/../../web/dist/index.html`)
      if (await indexFile.exists()) {
        const html = await indexFile.text()
        return c.html(html)
      }
    } catch {}
    try {
      const altIndex = Bun.file(`${import.meta.dir}/../dist/index.html`)
      if (await altIndex.exists()) {
        const html = await altIndex.text()
        return c.html(html)
      }
    } catch {}
    return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>Mira</title>
<style>
  body{background:#09090b;color:#e4e4e7;font-family:ui-sans-serif,system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{max-width:640px;padding:32px;border:1px solid #27272a;border-radius:16px;background:#18181b}
  h1{margin:0 0 8px;font-size:22px}
  p{color:#a1a1aa;font-size:13px;line-height:1.6}
  code{background:#27272a;padding:2px 6px;border-radius:6px;font-size:12px;color:#c4b5fd}
  .live{color:#86efac}
  .clients{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:12px}
  .client-card{padding:10px;border:1px solid #27272a;border-radius:10px;background:#27272a}
  .client-card strong{color:#e4e4e7;font-size:12px}
  .client-card span{color:#a1a1aa;font-size:11px}
</style></head>
<body><div class="card">
  <h1>Mira <span class="live">● live</span></h1>
  <p>Agent engine v0.1.0 · ${tools.count()} tools · gateway cost-tracked · WS / (Bus) · WS /terminal (PTY)</p>
  <p>API: <code>/health</code> · <code>/session</code> · <code>/terminal</code> · <code>/jobs</code> · <code>/finding</code> · <code>/mcp</code> · <code>/providers</code></p>
  <div class="clients">
    <div class="client-card"><strong>Web</strong><br><span>bun run dev in packages/web → :3000 (proxy :4096) or <code>vite build</code> → served here</span></div>
    <div class="client-card"><strong>TUI</strong><br><span>bun run dev in packages/tui → :3001 (proxy)</span></div>
    <div class="client-card"><strong>VS Code</strong><br><span>Extension: set <code>mira.apiUrl</code> + <code>mira.token</code> (SecretStorage)</span></div>
  </div>
  <p style="margin-top:12px">CORS: <code>CORS_ORIGINS</code> allowlists prod; <code>vscode-webview://</code> + <code>http://localhost:*</code> always allowed. Host: <code>HOST=127.0.0.1</code> (dev) or <code>0.0.0.0</code> (Docker/remote).</p>
</div></body></html>`)
  })

  // Static for web build (when `vite build` has run) — serves /assets/*, etc.
  app.get("/*", async (c, next) => {
    const path = c.req.path
    // Don't intercept API routes
    if (
      path.startsWith("/health") ||
      path.startsWith("/dev/") ||
      path.startsWith("/metrics") ||
      path.startsWith("/session") ||
      path.startsWith("/mcp") ||
      path.startsWith("/config") ||
      path.startsWith("/providers") ||
      path.startsWith("/provider") ||
      path.startsWith("/tools") ||
      path.startsWith("/agents") ||
      path.startsWith("/skills") ||
      path.startsWith("/commands") ||
      path.startsWith("/finding") ||
      path.startsWith("/job") ||
      path.startsWith("/task") ||
      path.startsWith("/jobs") ||
      path.startsWith("/terminal") ||
      path.startsWith("/learning") ||
      path.startsWith("/permission") ||
      path.startsWith("/guardrails") ||
      path.startsWith("/admin") ||
      path.startsWith("/manager") ||
      path.startsWith("/complete") ||
      path.startsWith("/autocomplete")
    ) {
      return await next()
    }
    try {
      const candidates = [`${import.meta.dir}/../../web/dist${path}`, `${import.meta.dir}/../dist${path}`]
      for (const fp of candidates) {
        const f = Bun.file(fp)
        if (await f.exists()) {
          const ext = fp.split(".").pop() ?? ""
          const ct =
            ext === "html"
              ? "text/html"
              : ext === "js"
                ? "application/javascript"
                : ext === "css"
                  ? "text/css"
                  : ext === "json"
                    ? "application/json"
                    : ext === "svg"
                      ? "image/svg+xml"
                      : "text/plain"
          return new Response(f.stream() as BodyInit, { headers: { "Content-Type": ct, "Cache-Control": "max-age=3600" } })
        }
      }
      // SPA fallback: serve index.html for unknown routes when web build exists
      const index = Bun.file(`${import.meta.dir}/../../web/dist/index.html`)
      if (await index.exists()) {
        // Only fallback for non-API GET that looks like a page (no extension)
        if (!path.includes(".")) {
          return c.html(await index.text())
        }
      }
    } catch {}
    return await next()
  })

  mountHealthRoutes(app, {
    GIT_SHA, STARTED_AT, tools, mcp, config, bus, learning, gateway, metrics,
    TERMINAL_ENABLED, TERMINAL_SANDBOX, REQUIRED_TOKEN, API_KEY_OWNERS, CORS_ORIGIN_LIST,
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

  // Guard for c.req.param("id"): string|undefined → string|null (404 vs 500)
  function requireId(c: { req: { param: (k: string) => string | undefined } }): string | null {
    const v = c.req.param("id")
    return v && v.length > 0 ? v : null
  }

  // ── Per-owner live event filtering (moved up for route mounts) ────────
  const CACHE_TTL_MS = 5 * 60_000 // 5 minutes — bounded staleness for owner lookups
  const sessionOwnerCache = new Map<string, { owner: string | null; ts: number }>()
  const pendingOwnerLookups = new Map<string, Promise<string | null>>()
  function ownerOfSession(sessionID: string): Promise<string | null> {
    const cached = sessionOwnerCache.get(sessionID)
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return Promise.resolve(cached.owner)
    let p = pendingOwnerLookups.get(sessionID) as Promise<string | null> | undefined
    if (!p) {
      const lookup: Promise<string | null> = db.query.sessions.findFirst({ where: (s, { eq }) => eq(s.id, sessionID) })
        .then(s => {
          const o = (s?.ownerID ?? null) as string | null
          sessionOwnerCache.set(sessionID, { owner: o, ts: Date.now() })
          pendingOwnerLookups.delete(sessionID)
          return o
        })
        .catch(() => { pendingOwnerLookups.delete(sessionID); return null })
      p = lookup
      pendingOwnerLookups.set(sessionID, lookup)
    }
    return p
  }

  mountSessionRoutes(app, {
    db, bus, prompt, authorizedSession, ownerOfSession, resolveOwner, bearerOf, OWNERSHIP_ENABLED, sessionOwnerCache,
  })

  // ── Admin: runtime API-key issuance (admin-guarded, persisted) ─────
  mountAdminRoutes(app, { db, REQUIRED_TOKEN, API_KEY_OWNERS, resolveOwner, bearerOf, sessionOwnerCache })

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
    const fid = c.req.param("id")
    if (!fid) return c.json({ error: "not found" }, 404)
    const f = await resolveFinding(db, fid)
    if (!f) return c.json({ error: "not found" }, 404)
    bus.publish({ type: "job.updated", payload: { finding: f.id, action: "resolved" }, timestamp: Date.now() })
    return c.json(f)
  })

  // Session import — Sessions Sync (Kilo K7): POST /session/import with exported JSON from GET /session/:id/export?format=json
  const importSessionSchema = z.object({
    session: z.object({
      title: z.string().max(200).optional(),
      model: z.string().min(1).optional(),
      agent: z.string().max(100).optional(),
    }).passthrough().optional(),
    messages: z.array(z.object({
      role: z.enum(["user", "assistant", "system"]).or(z.string()),
      parts: z.array(z.object({
        type: z.enum(["text", "tool-call", "tool-result", "reasoning", "file"]).or(z.string()),
        text: z.string().nullable().optional(),
        tool: z.string().nullable().optional(),
        toolCallID: z.string().nullable().optional(),
        args: z.custom<JsonValue>().nullable().optional(),
        result: z.custom<JsonValue>().nullable().optional(),
        isError: z.boolean().nullable().optional(),
      }).passthrough()).optional(),
      // also support flat parts array from Drizzle query
    }).passthrough()).optional(),
    title: z.string().max(200).optional(),
    model: z.string().min(1).optional(),
    agent: z.string().max(100).optional(),
  }).passthrough()
  app.post("/session/import", async (c) => {
    const raw = await c.req.json().catch(() => null)
    const parsed = importSessionSchema.safeParse(raw)
    if (!parsed.success) return c.json({ error: "invalid import", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    const body = parsed.data as { session?: { title?: string; model?: string; agent?: string }; messages?: Array<{ role: string; parts?: Array<{ type: string; text?: string; tool?: string; toolCallID?: string; args?: JsonValue; result?: JsonValue; isError?: boolean }> }>; title?: string; model?: string; agent?: string }
    const srcSession = body.session
    const title = body.title ?? srcSession?.title ?? "Imported Session"
    const model = body.model ?? srcSession?.model
    const agent = body.agent ?? srcSession?.agent
    if (agent && !isKnownAgent(agent)) return c.json({ error: `unknown agent "${agent}"` }, 400)
    const owner = OWNERSHIP_ENABLED ? (resolveOwner(bearerOf(c.req.header("Authorization"))) ?? "default") : null
    const created = await prompt.createSession({ title, model, agent, ownerID: owner })
    const msgs = body.messages ?? []
    let copiedMessages = 0
    let copiedParts = 0
    for (const m of msgs) {
      const mid = crypto.randomUUID()
      try {
        await db.insert(db.schema.messages).values({ id: mid, sessionID: created.id, role: m.role as "user" | "assistant" | "system", createdAt: Date.now() })
        copiedMessages++
        for (const p of m.parts ?? []) {
          await db.insert(db.schema.parts).values({
            id: crypto.randomUUID(),
            messageID: mid,
            sessionID: created.id,
            type: p.type as "text" | "tool-call" | "tool-result" | "reasoning" | "file",
            text: p.text ?? null,
            tool: p.tool ?? null,
            toolCallID: p.toolCallID ?? null,
            args: (p.args ?? null) as Record<string, JsonValue> | null,
            result: (p.result ?? null) as JsonValue,
            isError: p.isError ?? null,
            createdAt: Date.now(),
          })
          copiedParts++
        }
      } catch {}
    }
    sessionOwnerCache.set(created.id, { owner: (created as { ownerID?: string | null }).ownerID ?? owner, ts: Date.now() })
    bus.publish({ type: "session.created", payload: { id: created.id, title: created.title, importedFrom: true, copiedMessages, copiedParts } as JsonValue, timestamp: Date.now() })
    return c.json({ session: created, copiedMessages, copiedParts }, 201)
  })

  // Agent Manager lite (Kilo K7): GET /manager — active jobs + recent sessions for IDE worktree-style overview
  app.get("/manager", async (c) => {
    const owner = OWNERSHIP_ENABLED ? resolveOwner(bearerOf(c.req.header("Authorization"))) : undefined
    const allJobs = await listJobs(db)
    const activeJobs = allJobs.filter(j => j.status === "running").slice(0, 20)
    let jobs = activeJobs
    if (owner) {
      jobs = []
      for (const j of activeJobs) {
        const o = await ownerOfSession(j.parentSessionID)
        if (o === null || o === owner) jobs.push(j)
      }
    }
    const sessions = await db.query.sessions.findMany({ orderBy: (s, { desc }) => [desc(s.updatedAt)], limit: 10 }) as Array<Record<string, JsonValue>>
    const filteredSessions = owner ? (sessions as Array<{ ownerID?: string | null }>).filter(s => !s.ownerID || s.ownerID === owner) : sessions
    return c.json({ activeJobs: jobs, recentSessions: filteredSessions.slice(0, 10), at: new Date().toISOString() })
  })

  // Prompt — the core loop (streamed via SSE) — supports per-turn agent override (Kilo K1)
  app.post("/session/:id/prompt", async c => {
    const id = requireId(c)
    if (!id) return c.json({ error: "session not found" }, 404)
    const { prompt: text, model, agent, maxSteps } = await c.req.json().catch(() => ({} as Record<string, JsonValue>))
    if (!text?.trim?.()) return c.json({ error: "empty prompt" }, 400)
    // Validate session exists + requester owns it
    if (!(await authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    // Validate agent if supplied (unknown agent → 400, Kilo parity)
    if (agent !== undefined && agent !== null && typeof agent === "string" && agent.length > 0 && !isKnownAgent(agent)) {
      return c.json({ error: `unknown agent "${agent}"` }, 400)
    }

    // Stream response as SSE (Vercel AI SDK style); per-request loop options honored
    // Propagate client abort (disconnect) to gateway fetch via AbortSignal
    const signal = (c.req.raw as Request & { signal?: AbortSignal })?.signal
    return prompt.streamResponse(id, text as string, model as string | undefined, { maxSteps: maxSteps as number | undefined, agent: (agent as string | undefined) ?? null, signal })
  })

  // Messages & parts
  app.get("/session/:id/message", async c => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    if (!(await authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    const messages = await prompt.getMessages(id)
    return c.json(messages)
  })

  // Session export — shareable transcript (markdown or JSON)
  app.get("/session/:id/export", async c => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
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

  mountMcpRoutes(app, mcp)

  mountConfigRoutes(app)

  // Message queue — type while the agent streams (Mira-parity UX)
  app.post("/session/:id/queue", async c => {
    const parsed = queuePushSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid queue push", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    const text = parsed.data.prompt
    const id = requireId(c)
    if (!id) return c.json({ error: "session not found" }, 404)
    if (!(await authorizedSession(id, c))) return c.json({ error: "session not found" }, 404)
    return c.json(prompt.queueMessage(id, String(text).trim()))
  })
  app.get("/session/:id/queue", c => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    return c.json(prompt.getQueue(id))
  })
  app.delete("/session/:id/queue", c => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    return c.json({ cleared: prompt.clearQueue(id) })
  })

  // File snapshots — undo/rewind agent file mutations
  app.get("/session/:id/snapshots", async c => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    if (!(await authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    const { listSnapshots } = await import("./storage/snapshots.js")
    return c.json(listSnapshots(db, id))
  })
  app.post("/session/:id/revert", async c => {
    const body = await c.req.json().catch(() => ({}))
    const { revertLast, revertToMessage } = await import("./storage/snapshots.js")
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
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
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    if (!(await authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    const todos = await prompt.getTodos(id)
    return c.json(todos)
  })
  app.post("/session/:id/todo", async c => {
    const id = requireId(c)
    if (!id) return c.json({ error: "not found" }, 404)
    if (!(await authorizedSession(id, c))) return c.json({ error: "not found" }, 404)
    const parsed = todoSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: "invalid todos", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    }
    const sid = id
    const todos = parsed.data.map(t => ({ ...t, id: crypto.randomUUID(), sessionID: sid, createdAt: Date.now() })) as Parameters<SessionPrompt["setTodos"]>[1]
    const result = await prompt.setTodos(sid, todos)
    bus.publish({ type: "todo.updated", sessionID: sid, payload: result, timestamp: Date.now() })
    return c.json(result)
  })

  // Tools list (for TUI introspection)
  app.get("/tools", c => c.json(tools.list()))

  // Agent catalog — built-in lane templates + mira.json custom agents (Kilo K1 parity: includes model per agent)
  app.get("/agents", c => {
    const registry = getAgentTemplates()
    return c.json(Object.entries(registry).map(([name, tpl]) => ({
      name,
      description: tpl.description,
      tools: [...tpl.tools],
      permissions: tpl.permissions,
      model: (tpl as { model?: string }).model ?? null,
      custom: !(name in BUILTIN_AGENT_KEYS),
    })))
  })

  // Permissions check (for TUI preflight + Settings dry-run)
  app.post("/permission/check", async c => {
    const req = await c.req.json() as { tool: string; args?: JsonValue; sessionID?: string; agent?: string }
    // Lane-contract preview: if agent supplied, also evaluate lane allowlist + readonly posture
    if (req.agent) {
      const tpl = getAgentTemplates()[req.agent]
      if (tpl) {
        const allow = new Set<string>(tpl.tools ?? [])
        const isAllowedByLane = tpl.tools?.length ? allow.has(req.tool) : true
        if (!isAllowedByLane) {
          return c.json({ action: "deny", reason: `lane contract: agent "${req.agent}" — tool "${req.tool}" not in allowlist [${[...allow].join(", ")}]`, lane: { agent: req.agent, allowed: [...allow], blocked: true, permissions: tpl.permissions } })
        }
        if (tpl.permissions === "readonly") {
          const mutating = new Set(["write", "edit", "patch", "todowrite"])
          if (mutating.has(req.tool)) {
            return c.json({ action: "deny", reason: `lane contract: agent "${req.agent}" is readonly — ${req.tool} blocked`, lane: { agent: req.agent, permissions: tpl.permissions, blocked: true } })
          }
          if (req.tool === "bash" && req.args && typeof req.args === "object") {
            const cmd = (req.args as Record<string, JsonValue>).command as string | undefined
            if (cmd) {
              const { classifyBashArity } = await import("./permission/index.js")
              const { level } = classifyBashArity(cmd)
              if (level > 0) return c.json({ action: "deny", reason: `lane contract: readonly agent "${req.agent}" — bash level ${level} blocked (${cmd.slice(0,60)})`, lane: { agent: req.agent, permissions: tpl.permissions, blocked: true, arity: level } })
            }
          }
        }
      }
    }
    const decision = await permissions.check({ tool: req.tool, args: (req.args as Record<string, JsonValue>) ?? {}, sessionID: req.sessionID ?? "preview" } as import("./types/index.js").PermissionRequest)
    // Attach lane context when agent was checked and passed
    if (req.agent) {
      const tpl = getAgentTemplates()[req.agent]
      if (tpl) return c.json({ ...decision, lane: { agent: req.agent, permissions: tpl.permissions, allowed: [...(tpl.tools ?? [])] } })
    }
    return c.json(decision)
  })

  // Guardrails audit preview (dry-run) — mirrors ToolRegistry guardrails.check without executing
  // @ts-expect-error — recursive JsonValue causes TS2589 deep instantiation in Hono+JsonValue generic, runtime shape is correct
  app.post("/guardrails/check", async c => {
    const body = await c.req.json().catch(() => null) as { tool?: string; args?: JsonValue; sessionID?: string } | null
    if (!body?.tool) return c.json({ error: "tool required" }, 400)
    const args: JsonValue = body.args ?? {}
    const result = await guardrails.check(body.tool, args, { sessionID: body.sessionID ?? "preview" })
    return c.json(result)
  })

  // Lane-contract preview: which tools would filterToolsForAgent allow for a given agent?
  app.get("/agents/:name/preview", c => {
    const name = c.req.param("name")
    if (!name) return c.json({ error: "agent required" }, 400)
    const tpl = getAgentTemplates()[name]
    if (!tpl) return c.json({ error: `unknown agent "${name}"` }, 404)
    const allTools = tools.list().map(t => t.name)
    const allow = tpl.tools?.length ? new Set<string>(tpl.tools) : null
    const allowed = allow ? allTools.filter(n => allow.has(n)) : allTools
    const blocked = allow ? allTools.filter(n => !allow.has(n)) : []
    return c.json({ agent: name, permissions: tpl.permissions, allowed, blocked, allowlist: tpl.tools ?? [] })
  })

  // Autocomplete (Kilo K4): ghost-text via gateway — POST /complete and POST /autocomplete (alias)
  const completeSchema = z.object({
    prefix: z.string().max(4000).optional(),
    suffix: z.string().max(4000).optional(),
    prompt: z.string().max(4000).optional(),
    file: z.string().max(500).optional(),
    model: z.string().min(1).optional(),
    maxTokens: z.number().int().positive().max(512).optional(),
  })
  app.post("/complete", async (c) => {
    if (process.env.MIRA_AUTOCOMPLETE === "0") return c.json({ error: "autocomplete disabled (MIRA_AUTOCOMPLETE=0)" }, 403)
    const parsed = completeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid complete", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    const { prefix = "", suffix = "", prompt, file, model, maxTokens = 64 } = parsed.data
    const effectivePrompt = prompt ?? (prefix || suffix ? `Complete the code. File: ${file ?? "unknown"}\nPrefix:\n${prefix.slice(-2000)}\nSuffix:\n${suffix.slice(0, 1000)}\nProvide only the completion (no explanation, no markdown).` : "")
    if (!effectivePrompt.trim()) return c.json({ error: "prefix/suffix or prompt required" }, 400)
    const cfg = getConfig() as MiraConfig & { smallModel?: string }
    const m = model ?? process.env.MIRA_AUTOCOMPLETE_MODEL ?? cfg.smallModel ?? cfg.model
    try {
      const res = await gateway.complete({ model: m, prompt: effectivePrompt, maxTokens })
      return c.json({ text: res.text, model: m, prefix, suffix })
    } catch (e) {
      return c.json({ error: String(e), model: m }, 500)
    }
  })
  app.post("/autocomplete", async (c) => {
    if (process.env.MIRA_AUTOCOMPLETE === "0") return c.json({ error: "autocomplete disabled (MIRA_AUTOCOMPLETE=0)" }, 403)
    const parsed = completeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid complete", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    const { prefix = "", suffix = "", prompt, file, model, maxTokens = 64 } = parsed.data
    const effectivePrompt = prompt ?? (prefix || suffix ? `Complete the code. File: ${file ?? "unknown"}\nPrefix:\n${prefix.slice(-2000)}\nSuffix:\n${suffix.slice(0, 1000)}\nProvide only the completion (no explanation, no markdown).` : "")
    if (!effectivePrompt.trim()) return c.json({ error: "prefix/suffix or prompt required" }, 400)
    const cfg = getConfig() as MiraConfig & { smallModel?: string }
    const m = model ?? process.env.MIRA_AUTOCOMPLETE_MODEL ?? cfg.smallModel ?? cfg.model
    try {
      const res = await gateway.complete({ model: m, prompt: effectivePrompt, maxTokens })
      return c.json({ text: res.text, model: m, prefix, suffix })
    } catch (e) {
      return c.json({ error: String(e), model: m }, 500)
    }
  })

  // Learning system routes with privacy safeguards and backward compatibility
  mountLearningRoutes(app, learning)

  // Terminal — HTTP status + browser client hint
  app.get("/terminal", c => {
    if (!TERMINAL_ENABLED) return c.json({ enabled: false, error: "terminal disabled (MIRA_TERMINAL_ENABLED=0)" }, 403)
    const host = c.req.header("host") ?? `localhost:${PORT}`
    const proto = c.req.header("x-forwarded-proto") ?? (host.includes("localhost") ? "ws" : "wss")
    return c.json({ enabled: true, sandbox: TERMINAL_SANDBOX, ws: `${proto}://${host}/terminal`, auth: "Bearer token or {type:\"auth\",token} first message" })
  })

  // WebSocket upgrade — GlobalBus → Worker → RPC → TUI (no polling)
  //
  // Security model:
  //   • Upgrades are admitted EXPLICITLY in fetch below (a fall-through Response means
  //     Bun never upgrades), so every socket passes the same checks as HTTP.
  //   • Origin validated against CORS_ORIGINS allowlist (empty = allow all for dev).
  //     vscode-webview:// and http://localhost:* are always allowed for TUI/Web/VS Code dev.
  //   • Auth = same bearer token as HTTP. Preferred: Authorization header on the upgrade
  //     request. Fallback for clients that cannot set headers (browsers / VS Code webview): send
  //     {"type":"auth","token":"..."} as the FIRST message within 10s of open.
  //   • Unauthenticated sockets are closed with 1008 (policy violation).
  //   • Query-param tokens (?token=) are NOT accepted anywhere.
  const WS_AUTH_TIMEOUT_MS = 20_000

  // WebSocket sockets carry server-side state beyond Bun's wire data —
  // this structural type describes the extended shape (no `any`).
  interface MiraWSData {
    authenticated?: boolean
    owner?: string
    isTerminal?: boolean
  }
  interface MiraWS {
    data?: MiraWSData
    __active: boolean
    __authTimer?: ReturnType<typeof setTimeout>
    __unsub?: () => void
    __owner?: string | null
    __proc?: ReturnType<typeof Bun.spawn>
    __ac?: AbortController
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

  function activateTerminalSocket(ws: MiraWS, owner?: string) {
    if (ws.__active) return
    ws.__active = true
    ws.__owner = owner ?? null
    clearTimeout(ws.__authTimer)
    ws.send(JSON.stringify({ type: "terminal.connected", payload: { connected: true, owner: ws.__owner, sandbox: TERMINAL_SANDBOX }, timestamp: Date.now() }))
    // Spawn interactive bash; TERM=xterm-256color for TUI compat
    const proc = Bun.spawn(["bash"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    })
    const ac = new AbortController()
    ws.__proc = proc
    ws.__ac = ac
    const streamOutput = async (stream: ReadableStream<Uint8Array> | null, name: string) => {
      if (!stream) return
      const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>
      const decoder = new TextDecoder()
      try {
        while (true) {
          if (ac.signal.aborted || !ws.__active) break
          const { value, done } = await reader.read()
          if (done) break
          if (!value?.length) continue
          const text = decoder.decode(value, { stream: true })
          try { ws.send(JSON.stringify({ type: "terminal.output", payload: { stream: name, data: text }, timestamp: Date.now() })) } catch { break }
        }
      } catch {}
    }
    void streamOutput(proc.stdout as ReadableStream<Uint8Array>, "stdout")
    void streamOutput(proc.stderr as ReadableStream<Uint8Array>, "stderr")
    void (proc as { exited: Promise<number> }).exited.then((code: number) => {
      try { ws.send(JSON.stringify({ type: "terminal.exit", payload: { code }, timestamp: Date.now() })) } catch {}
      try { ws.close(1000, "terminal exit") } catch {}
    })
  }

  const server = Bun.serve<MiraWSData>({
    port: PORT,
    // Security: loopback by default — remote access requires HOST env override
    hostname: HOST,
    // Long SSE streams (LLM first-token latency can exceed 10s) need a generous idle timeout
    idleTimeout: 180,
    fetch(req, srv) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!isOriginAllowed(req.headers.get("origin"))) {
          return new Response(JSON.stringify({ error: "forbidden origin" }), { status: 403, headers: { "content-type": "application/json" } })
        }
        const url = new URL(req.url)
        const isTerminal = url.pathname === "/terminal"
        if (isTerminal && !TERMINAL_ENABLED) {
          return new Response(JSON.stringify({ error: "terminal disabled" }), { status: 403, headers: { "content-type": "application/json" } })
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
        const upgraded = srv.upgrade(req, { data: { authenticated, owner, isTerminal } })
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
        const isTerminal = (w.data as MiraWSData | undefined)?.isTerminal === true
        const needsAuth = !!REQUIRED_TOKEN || API_KEY_OWNERS.size > 0
        if (!needsAuth || w.data?.authenticated === true) {
          if (isTerminal) activateTerminalSocket(w, w.data?.owner)
          else activateSocket(w, w.data?.owner)
        } else {
          // Grace window: client must send {"type":"auth","token":...} within 10s
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
        let event: { type?: string; token?: string; sessionID?: string; data?: string; cols?: number; rows?: number } | null = null
        try { event = JSON.parse(raw) } catch {}
        if (!w.__active) {
          // Pre-auth: only the auth handshake is accepted; anything else is ignored
          // (the 10s timer closes unauthenticated sockets with 1008)
          const owner = event?.type === "auth" && typeof event.token === "string"
            ? resolveOwner(event.token)
            : undefined
          if (owner !== undefined) {
            const isTerminal = (w.data as MiraWSData | undefined)?.isTerminal === true
            if (isTerminal) activateTerminalSocket(w, owner)
            else activateSocket(w, owner)
          }
          return
        }
        // Terminal input path
        if ((w.data as MiraWSData | undefined)?.isTerminal) {
          if (event?.type === "terminal.input" && typeof event.data === "string") {
            // Sandbox: enforce allowedCommands when enabled
            if (TERMINAL_SANDBOX) {
              const raw = event.data.trim()
              // allow empty, single word commands only at line start; skip control chars
              if (raw && !raw.startsWith("#")) {
                const first = raw.split(/[\s;|&]+/)[0] ?? ""
                const base = first.split("/").pop() ?? first
                // dynamic allowlist from config if present
                let allowed: string[] = ["bash","ls","cat","grep","find","git","bun","node","tsc","echo","pwd","head","tail","wc","sort","uniq","date","env","which","whoami","printf","sed","awk"]
                try {
                  const cfg = getConfig() as MiraConfig
                  const t = (cfg.tools as Record<string, JsonValue> | undefined)?.terminal as Record<string, JsonValue> | undefined
                  const list = t?.allowedCommands as string[] | undefined
                  if (Array.isArray(list)) allowed = list
                } catch {}
                if (base && !allowed.includes(base) && !allowed.includes(first)) {
                  try { w.send(JSON.stringify({ type: "terminal.output", payload: { stream: "stderr", data: `sandbox: command "${base}" not in allowedCommands [${allowed.join(",")}] — blocked\n` }, timestamp: Date.now() })) } catch {}
                  // don't forward to shell
                } else {
                  try {
                    const stdin = w.__proc?.stdin
                    if (stdin && typeof stdin !== "number" && typeof (stdin as Bun.FileSink).write === "function") (stdin as Bun.FileSink).write(event.data)
                  } catch {}
                }
              } else {
                try {
                  const stdin = w.__proc?.stdin
                  if (stdin && typeof stdin !== "number" && typeof (stdin as Bun.FileSink).write === "function") (stdin as Bun.FileSink).write(event.data)
                } catch {}
              }
            } else {
              try {
                const stdin = w.__proc?.stdin
                if (stdin && typeof stdin !== "number" && typeof (stdin as Bun.FileSink).write === "function") (stdin as Bun.FileSink).write(event.data)
              } catch {}
            }
          }
          // permission/question replies still flow through bus even on terminal sockets
          if (event?.type === "permission.reply" || event?.type === "question.reply") {
            bus.publish(event as BusEvent)
          }
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
        try { w.__ac?.abort() } catch {}
        try { w.__proc?.kill() } catch {}
      },
    },
  })

  console.log(`[mira] ✓ listening on http://${server.hostname}:${server.port}`)
  console.log(`[mira]   liveness: GET /healthz (no auth) · detail: GET /health`)
  console.log(`[mira]   prompt:  POST /session/:id/prompt  (SSE)`)
  console.log(`[mira]   ws:      WS   /  (BusEvent stream)${TERMINAL_ENABLED ? " · WS /terminal (pty)" : " · terminal disabled"}`)
  console.log(`[mira]   terminal: GET /terminal → {enabled:${TERMINAL_ENABLED}, sandbox:${TERMINAL_SANDBOX}}`)

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
  process.on("beforeExit", () => { try { mcp.disconnectAll() } catch {} })
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
