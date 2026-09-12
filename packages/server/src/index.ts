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

import { Hono } from 'hono'
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { Bus } from './bus/index.js'
import { createDatabase, migrate } from './storage/db.js'
import { SubgatewayRegistry } from './gateway/registry.js'
import { GatewayRouter, createRoutingGateway } from './gateway/router.js'
import { ToolRegistry } from './tools/registry.js'
import { PermissionManager } from './permission/index.js'
import { SessionPrompt } from './session/prompt.js'
import { MCPManager } from './mcp/index.js'
import { loadConfig, getConfig } from './config/index.js'
import { createLearningSystem, mountLearningRoutes } from './learning/index.js'
import { setSharedKnowledge } from './learning/knowledge.js'
import { GuardrailsManager } from './guardrails/index.js'
import type { BusEvent, MiraConfig, JsonValue } from './types/index.js'
import { mountHealthRoutes } from './routes/health.js'
import { mountSessionRoutes } from './routes/session.js'
import { mountConfigRoutes } from './routes/config.js'
import { mountMcpRoutes } from './routes/mcp.js'
import { mountAdminRoutes } from './routes/admin.js'
import { mountFindingRoutes } from './routes/finding.js'
import { mountSessionExtrasRoutes } from './routes/session-extras.js'
import { mountToolsRoutes } from './routes/tools-routes.js'
import { mountWorkspaceRoutes } from './routes/workspace.js'
import { mountSymbolRoutes } from './routes/symbol.js'
import { mountStaticRoutes } from './routes/static.js'
import { mountMiddleware } from './middleware/index.js'
import { boundSend, WS_CLOSE_TOO_SLOW } from './ws-backpressure.js'
import { log, warn, error } from './util/logger.js'

type PartialMiraConfig = Partial<MiraConfig>

// ── Bootstrap ──────────────────────────────────────────────────────
const PORT_RAW =
  process.env.PORT ?? Bun.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? '4096'
const PORT = (() => {
  const n = Number(PORT_RAW)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    error(`invalid PORT=${PORT_RAW}, falling back to 4096`)
    return 4096
  }
  return Math.floor(n)
})()
const STARTED_AT = new Date().toISOString()
let GIT_SHA: string = process.env.MIRA_GIT_SHA ?? ''
if (!GIT_SHA) {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
      cwd: import.meta.dir ? `${import.meta.dir}/../../..` : undefined,
      stdout: 'pipe',
    })
    const out = proc.stdout ? new TextDecoder().decode(proc.stdout).trim() : ''
    if (out && /^[0-9a-f]{4,40}$/.test(out)) GIT_SHA = out
  } catch {}
  if (!GIT_SHA) GIT_SHA = 'unknown'
}

// ── First-run: auto-provision ~/.mira/mira.env ──────────────────────
// A first-time user has no token file and no env token. Create the file
// with a generated secret so web/CLI/TUI auth works out of the box.
// Production without auth still refuses below; this never overwrites an
// existing file and never fails startup (opt out: MIRA_NO_AUTOPROVISION=1).
function miraEnvFile(): string {
  const dir = process.env.MIRA_DIR?.trim() || join(homedir(), '.mira')
  return join(dir, 'mira.env')
}
function readMiraEnvFile(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const line of readFileSync(miraEnvFile(), 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      const k = m?.[1]
      if (k) out[k] = (m?.[2] ?? '').replace(/^(['"])(.*)\1$/, '$2').trim()
    }
  } catch {}
  return out
}
function provisionFirstRunToken(): void {
  if (process.env.MIRA_NO_AUTOPROVISION === '1') return
  if (process.env.NODE_ENV === 'production') return // fail-closed refusal below stays authoritative
  try {
    const file = miraEnvFile()
    if (existsSync(file)) {
      // Adopt existing file for direct runs (serve-local.sh sources it too).
      const vars = readMiraEnvFile()
      if (!process.env.MIRA_TOKEN && vars.MIRA_TOKEN) process.env.MIRA_TOKEN = vars.MIRA_TOKEN
      if (!process.env.MIRA_API_KEYS && vars.MIRA_API_KEYS)
        process.env.MIRA_API_KEYS = vars.MIRA_API_KEYS
      return
    }
    if (process.env.MIRA_TOKEN || process.env.MIRA_API_KEYS) return
    const token = randomBytes(32).toString('hex') // 64-hex, like scripts/gen-mira-token.sh
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      `# Mira env — auto-created on first run. Keep private.\nMIRA_TOKEN=${token}\n`,
      { mode: 0o600 },
    )
    if (process.platform !== 'win32') {
      try {
        chmodSync(file, 0o600)
      } catch {}
    }
    process.env.MIRA_TOKEN = token
    log(`🔑 first run: generated MIRA_TOKEN in ${file}`)
  } catch (e) {
    warn('first-run token provisioning failed (continuing open):', String(e))
  }
}
provisionFirstRunToken()

// ── Security config ────────────────────────────────────────────────
let REQUIRED_TOKEN = process.env.MIRA_TOKEN ?? ''
if (REQUIRED_TOKEN === 'change-me-to-a-long-random-secret') {
  if (process.env.NODE_ENV === 'production') {
    error(
      '❌ MIRA_TOKEN is placeholder — refusing to start with guessable token (set a real secret via /root/.mira/mira.env or env)',
    )
    process.exit(1)
  }
  // Non-prod: treat placeholder as empty (no auth) — log error if strict, warn otherwise
  if (process.env.MIRA_STRICT_AUTH !== '0') {
    error(
      '❌ MIRA_TOKEN is placeholder — treating as empty (no auth) — set a real secret via /root/.mira/mira.env or env',
    )
  } else {
    warn(
      '⚠️  MIRA_TOKEN is placeholder — treating as empty (no auth) — set a real secret via /root/.mira/mira.env or env',
    )
  }
  REQUIRED_TOKEN = ''
}
const API_KEY_OWNERS = new Map<string, string>()
for (const pair of (process.env.MIRA_API_KEYS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)) {
  const i = pair.indexOf(':')
  if (i > 0) API_KEY_OWNERS.set(pair.slice(0, i), pair.slice(i + 1))
}
if (
  process.env.NODE_ENV === 'production' &&
  !REQUIRED_TOKEN &&
  API_KEY_OWNERS.size === 0 &&
  process.env.MIRA_STRICT_AUTH !== '0'
) {
  error('❌ MIRA_TOKEN or MIRA_API_KEYS required in production — refusing to start without auth')
  process.exit(1)
}
let OWNERSHIP_ENABLED = API_KEY_OWNERS.size > 0
function resolveOwner(token: string): string | undefined {
  if (!token) return undefined
  if (REQUIRED_TOKEN && tokenEquals(token, REQUIRED_TOKEN)) return 'default'
  return API_KEY_OWNERS.get(token)
}
function bearerOf(authHeader: string | undefined): string {
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
}
function tokenEquals(a: string, b: string): boolean {
  // Hash then compare — always 32 bytes, no length leak via timing (P3-4)
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}
const HOST = process.env.HOST ?? '127.0.0.1'
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1'])
if (!ALLOWED_HOSTS.has(HOST)) {
  warn(`⚠️  HOST=${HOST} not in allowed list, defaulting to 127.0.0.1`)
}
// MIRA_WORKSPACE_ROOTS — comma-separated allowedRoots override (per-project isolation, env wins)
const WORKSPACE_ROOTS = (process.env.MIRA_WORKSPACE_ROOTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
if (WORKSPACE_ROOTS.length) {
  log(`workspace roots (MIRA_WORKSPACE_ROOTS): ${WORKSPACE_ROOTS.join(', ')}`)
}
const CORS_ORIGIN_LIST = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
if (process.env.NODE_ENV === 'production' && HOST === '0.0.0.0' && CORS_ORIGIN_LIST.length === 0) {
  error(
    '❌ CORS_ORIGINS must be set when HOST=0.0.0.0 in production — refusing to start with open CORS',
  )
  if (process.env.MIRA_STRICT_CORS !== '0') process.exit(1)
}
function isOriginAllowed(origin: string | null | undefined): boolean {
  if (!origin) return true
  if (
    origin.startsWith('vscode-webview://') ||
    origin.startsWith('vscode-file://') ||
    origin.startsWith('vscode:')
  )
    return true
  if (CORS_ORIGIN_LIST.length === 0) return true
  if (CORS_ORIGIN_LIST.includes(origin)) return true
  // Align with middleware/index.ts:73 — strict MIRA_ALLOW_LOCALHOST === '1' gate.
  // Prod with CORS_ORIGINS set: localhost only allowed when gate is '1'.
  // Dev default (empty list) already returned true above, so localhost allowed without gate.
  if (
    process.env.MIRA_ALLOW_LOCALHOST === '1' &&
    (origin.startsWith('http://localhost:') ||
      origin.startsWith('https://localhost:') ||
      origin.startsWith('http://127.0.0.1:') ||
      origin.startsWith('https://127.0.0.1:') ||
      origin.startsWith('http://[::1]:') ||
      origin.startsWith('https://[::1]:'))
  )
    return true
  return false
}

// ── Terminal WS config ─────────────────────────────────────────────
type TerminalToolConfig = {
  enabled?: boolean
  sandbox?: boolean
  allowedCommands?: string[]
  timeoutMs?: number
}
function terminalToolConfig(): TerminalToolConfig | undefined {
  try {
    return (getConfig() as { tools?: { terminal?: TerminalToolConfig } }).tools?.terminal
  } catch {
    return undefined
  }
}
function terminalEnabled(): boolean {
  if (process.env.MIRA_TERMINAL_ENABLED === '0') return false
  if (terminalToolConfig()?.enabled === false) return false
  return true
}
function terminalSandboxed(): boolean {
  if (process.env.MIRA_TERMINAL_SANDBOX === '1') return true
  return terminalToolConfig()?.sandbox === true
}
function terminalTimeoutMs(): number | null {
  const ms = terminalToolConfig()?.timeoutMs
  return typeof ms === 'number' && ms > 0 ? ms : null
}

function expandEnv(value: string): string {
  if (!value) return value
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? '')
}

async function initOtel() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) return
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node')
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
    const { getNodeAutoInstrumentations } =
      // @ts-ignore — dynamically imported only when OTEL_EXPORTER_OTLP_ENDPOINT is set
      await import('@opentelemetry/auto-instrumentations-node')
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      instrumentations: [getNodeAutoInstrumentations()],
    })
    sdk.start()
    log(`OTel tracing → ${endpoint}`)
  } catch (e) {
    warn('OTel init failed:', String(e))
  }
}

// ── Owner helpers ──────────────────────────────────────────────────
const sessionOwnerCache = new Map<string, { owner: string | null; ts: number }>()
const pendingOwnerLookups = new Map<string, Promise<string | null>>()
let dbRef: ReturnType<typeof createDatabase> | null = null
function ownerOfSession(sessionID: string): Promise<string | null> {
  const cached = sessionOwnerCache.get(sessionID)
  if (cached && Date.now() - cached.ts < 5 * 60_000) return Promise.resolve(cached.owner)
  let p = pendingOwnerLookups.get(sessionID) as Promise<string | null> | undefined
  if (!p) {
    const lookup: Promise<string | null> = dbRef!.query.sessions
      .findFirst({ where: (s, { eq }) => eq(s.id, sessionID) })
      .then((s) => {
        const o = (s?.ownerID ?? null) as string | null
        sessionOwnerCache.set(sessionID, { owner: o, ts: Date.now() })
        pendingOwnerLookups.delete(sessionID)
        return o
      })
      .catch(() => {
        pendingOwnerLookups.delete(sessionID)
        return null
      })
    p = lookup
    pendingOwnerLookups.set(sessionID, lookup)
  }
  return p
}

async function main() {
  await initOtel()
  log(`starting server on :${PORT} — Bun ${Bun.version}`)

  const config = await loadConfig()
  log(`model=${config.model}`)

  const db = createDatabase(process.env.MIRA_DB ?? './data/mira.db')
  await migrate(db)
  dbRef = db
  log(`storage ready`)

  // Memory Bank init
  try {
    const dbPath = process.env.MIRA_DB ?? './data/mira.db'
    const slash = dbPath.lastIndexOf('/')
    const bankDir = slash >= 0 ? `${dbPath.slice(0, slash)}/memory_bank` : './data/memory_bank'
    const { mkdir, readdir } = await import('node:fs/promises')
    await mkdir(bankDir, { recursive: true })
    const existing = await readdir(bankDir).catch(() => [] as string[])
    if (existing.length === 0) {
      const starters: Record<string, string> = {
        'decisions.md': '# Decisions\n\nArchitectural decisions and rationale.\n',
        'conventions.md': '# Conventions\n\nCode style, naming, repo patterns.\n',
        'tech_debt.md': '# Tech Debt\n\nKnown shortcuts, TODOs, and fragility.\n',
        'active_work.md': '# Active Work\n\nIn-progress branches, mid-migration notes.\n',
        'file_paths.md': '# File Paths\n\nFrequently referenced files and their roles.\n',
      }
      for (const [name, content] of Object.entries(starters)) {
        try {
          await Bun.write(`${bankDir}/${name}`, content)
        } catch {}
      }
      log(`memory_bank initialized at ${bankDir} (5 files)`)
    }
  } catch (e) {
    warn('memory_bank init failed:', String(e))
  }

  // Load runtime-issued API keys from db
  try {
    const rows = db.sqlite.prepare('SELECT key, owner FROM api_keys').all() as {
      key: string
      owner: string
    }[]
    for (const r of rows) API_KEY_OWNERS.set(r.key, r.owner)
    if (rows.length) log(`loaded ${rows.length} issued API key(s) from db`)
    OWNERSHIP_ENABLED = API_KEY_OWNERS.size > 0
  } catch (e) {
    warn('failed to load issued API keys:', String(e))
  }

  const bus = new Bus()
  bus.subscribe('server.heartbeat', () => {})

  const permissions = new PermissionManager(config.permission)
  log(`permissions: ${Object.keys(config.permission).length} rules`)

  const guardrails = new GuardrailsManager(undefined, config, db)
  const enforceEnabled =
    config.guardrails?.enforce ??
    (process.env.NODE_ENV === 'production' ||
      process.env.HOST === '0.0.0.0' ||
      process.env.MIRA_STRICT_AUTH === '1')
  const rootsInfo = WORKSPACE_ROOTS.length
    ? WORKSPACE_ROOTS.join(',')
    : (config.guardrails?.allowedRoots?.join(',') ??
      (enforceEnabled ? './data,./packages,./src' : '(per-project)'))
  log(
    `guardrails: enforce=${enforceEnabled ? 'enabled' : 'disabled'} roots=${rootsInfo} (DB mirror: audit_entries)`,
  )

  const registry = new SubgatewayRegistry(config)
  const router = new GatewayRouter(registry, config)
  const gateway = createRoutingGateway(registry, router)
  log(
    `gateway ready — providers: ${Object.keys(config.provider).join(', ')} lanes: ${registry.lanes().join(', ')}`,
  )

  // Hot-reload subgateways when config changes (PATCH /config)
  bus.subscribe('config.updated', (event) => {
    try {
      const newConfig = (event.payload as { config?: MiraConfig })?.config ?? getConfig()
      registry.syncFromConfig(newConfig)
      router.syncConfig(newConfig)
      log(`subgateways reloaded from config.updated`)
    } catch (e) {
      warn('failed to reload subgateways:', String(e))
    }
  })

  const learning = createLearningSystem({ db, bus, gateway })
  await learning.knowledge.load()
  setSharedKnowledge(learning.knowledge)
  learning.scheduler.start()
  log(
    `learning ready — knowledge=${learning.knowledge.size()} scheduler=${learning.scheduler.status().running ? 'running' : 'idle'}`,
  )

  const tools = new ToolRegistry({ db, bus, permissions, gateway, guardrails })
  await tools.registerAll()
  const mcp = new MCPManager({ bus, tools, config: config.mcp })
  await mcp.connectAll()
  mcp.startHealthCheck(30_000)
  log(`tools: ${tools.count()} registered (${mcp.count()} from MCP)`)

  const prompt = new SessionPrompt({
    db,
    bus,
    gateway,
    registry,
    router,
    tools,
    permissions,
    knowledge: learning.knowledge,
    usage: learning.usage,
  })
  tools.setSubagentRunner((opts) =>
    prompt.runSubagent({
      prompt: opts.prompt,
      parentID: opts.parentID,
      agent: opts.agent,
      model: opts.model,
      signal: opts.signal,
    }),
  )
  tools.setDefaultCtx({ db, bus, forkRunner: (opts) => prompt.forkSession(opts) })

  // ── HTTP + WebSocket RPC (Hono) ─────────────────────────────────
  const app = new Hono<{ Variables: { requestId: string } }>()

  let bunServer: ReturnType<typeof Bun.serve> | null = null

  // Mount middleware (CORS, request ID, OTel, auth, body-size, rate limiting, metrics)
  const { metrics, rateLimitCleanup } = mountMiddleware(app, {
    CORS_ORIGIN_LIST,
    REQUIRED_TOKEN,
    API_KEY_OWNERS,
    resolveOwner,
    bearerOf,
    getBunServer: () => bunServer,
  })

  // Mount static routes (landing page + SPA)
  mountStaticRoutes(app, { tools })

  // Mount route modules
  mountHealthRoutes(app, {
    GIT_SHA,
    STARTED_AT,
    tools,
    mcp,
    config,
    bus,
    learning,
    gateway,
    metrics,
    TERMINAL_ENABLED: terminalEnabled(),
    TERMINAL_SANDBOX: terminalSandboxed(),
    REQUIRED_TOKEN,
    API_KEY_OWNERS,
    CORS_ORIGIN_LIST,
  })

  mountSessionRoutes(app, {
    db,
    bus,
    prompt,
    authorizedSession: async (id, c) => {
      const s = await prompt.getSession(id)
      if (!s) return null
      if (API_KEY_OWNERS.size === 0 || !s.ownerID) return s
      return resolveOwner(bearerOf(c.req.header('Authorization'))) === s.ownerID ? s : null
    },
    ownerOfSession,
    resolveOwner,
    bearerOf,
    OWNERSHIP_ENABLED: () => API_KEY_OWNERS.size > 0,
    sessionOwnerCache,
  })

  mountAdminRoutes(app, {
    db,
    REQUIRED_TOKEN,
    API_KEY_OWNERS,
    resolveOwner,
    bearerOf,
    sessionOwnerCache,
  })

  mountFindingRoutes(app, { db, bus })

  mountSessionExtrasRoutes(app, {
    db,
    bus,
    prompt,
    authorizedSession: async (id, c) => {
      const s = await prompt.getSession(id)
      if (!s) return null
      if (API_KEY_OWNERS.size === 0 || !s.ownerID) return s
      return resolveOwner(bearerOf(c.req.header('Authorization'))) === s.ownerID ? s : null
    },
    ownerOfSession,
    resolveOwner,
    bearerOf,
    API_KEY_OWNERS,
    sessionOwnerCache,
  })

  mountMcpRoutes(app, mcp)
  mountConfigRoutes(app, { bus })
  mountToolsRoutes(app, { tools, permissions, guardrails, gateway })
  mountLearningRoutes(app, learning)
  mountWorkspaceRoutes(app)
  mountSymbolRoutes(app)

  // Terminal — HTTP status + browser client hint
  app.get('/terminal', (c) => {
    if (!terminalEnabled())
      return c.json(
        {
          enabled: false,
          error: 'terminal disabled (MIRA_TERMINAL_ENABLED=0 or tools.terminal.enabled=false)',
        },
        403,
      )
    const host = c.req.header('host') ?? `localhost:${PORT}`
    const proto = c.req.header('x-forwarded-proto') ?? (host.includes('localhost') ? 'ws' : 'wss')
    return c.json({
      enabled: true,
      sandbox: terminalSandboxed(),
      ws: `${proto}://${host}/terminal`,
      auth: 'Bearer token or {type:"auth",token} first message',
    })
  })

  // ── WebSocket ────────────────────────────────────────────────────
  const WS_AUTH_TIMEOUT_MS = 20_000
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
    __idleTimer?: ReturnType<typeof setTimeout>
    __armIdle?: () => void
    send(data: string): void
    close(code: number, reason?: string): void
    getBufferedAmount?(): number
  }

  function evictSlowSocket(ws: MiraWS, reason = 'client too slow') {
    try {
      ws.__unsub?.()
    } catch {}
    try {
      ws.__active = false
    } catch {}
    try {
      ws.__proc?.kill()
    } catch {}
    try {
      ws.close(WS_CLOSE_TOO_SLOW, reason)
    } catch {}
  }
  function sendToSocket(ws: MiraWS, data: string) {
    if (!boundSend(ws, data)) evictSlowSocket(ws)
  }

  function activateSocket(ws: MiraWS, owner?: string) {
    if (ws.__active) return
    ws.__active = true
    ws.__owner = owner ?? null
    clearTimeout(ws.__authTimer)
    ws.__unsub = bus.subscribeAll((event) => {
      try {
        let json: string
        if (API_KEY_OWNERS.size === 0 || !event.sessionID || event.type.startsWith('server.')) {
          json = JSON.stringify(event)
        } else {
          return void ownerOfSession(event.sessionID).then((o) => {
            if (!ws.__active) return
            if (o === null || o === ws.__owner) sendToSocket(ws, JSON.stringify(event))
          })
        }
        sendToSocket(ws, json)
      } catch {}
    })
    ws.send(
      JSON.stringify({
        type: 'server.heartbeat',
        payload: { connected: true },
        timestamp: Date.now(),
      }),
    )
  }

  function activateTerminalSocket(ws: MiraWS, owner?: string) {
    if (ws.__active) return
    ws.__active = true
    ws.__owner = owner ?? null
    clearTimeout(ws.__authTimer)
    ws.send(
      JSON.stringify({
        type: 'terminal.connected',
        payload: { connected: true, owner: ws.__owner, sandbox: terminalSandboxed() },
        timestamp: Date.now(),
      }),
    )
    const proc = Bun.spawn(['bash'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    })
    const ac = new AbortController()
    ws.__proc = proc
    ws.__ac = ac
    ws.__armIdle = () => {
      if (ws.__idleTimer) clearTimeout(ws.__idleTimer)
      const ms = terminalTimeoutMs()
      if (!ms) return
      ws.__idleTimer = setTimeout(() => {
        try {
          ws.send(
            JSON.stringify({
              type: 'terminal.output',
              payload: {
                stream: 'stderr',
                data: `\n[idle timeout after ${ms}ms — terminal closed]\n`,
              },
              timestamp: Date.now(),
            }),
          )
        } catch {}
        try {
          ac.abort()
        } catch {}
        try {
          proc.kill()
        } catch {}
        try {
          ws.close(1000, 'terminal idle timeout')
        } catch {}
      }, ms)
    }
    ws.__armIdle()
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
          if (
            !boundSend(
              ws,
              JSON.stringify({
                type: 'terminal.output',
                payload: { stream: name, data: text },
                timestamp: Date.now(),
              }),
            )
          ) {
            evictSlowSocket(ws, 'terminal client too slow')
            break
          }
        }
      } catch {}
    }
    void streamOutput(proc.stdout as ReadableStream<Uint8Array>, 'stdout')
    void streamOutput(proc.stderr as ReadableStream<Uint8Array>, 'stderr')
    void (proc as { exited: Promise<number> }).exited.then((code: number) => {
      if (ws.__idleTimer) clearTimeout(ws.__idleTimer)
      try {
        ws.send(JSON.stringify({ type: 'terminal.exit', payload: { code }, timestamp: Date.now() }))
      } catch {}
      try {
        ws.close(1000, 'terminal exit')
      } catch {}
    })
  }

  // ── Bun.serve with port rotation (4096 → 4106 if in use) ─────────
  let server: ReturnType<typeof Bun.serve> | null = null
  let actualPort = PORT
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      server = Bun.serve<MiraWSData>({
        port: actualPort,
        hostname: HOST,
        idleTimeout: 180,
        fetch(req, srv) {
          bunServer = srv
          if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            if (!isOriginAllowed(req.headers.get('origin'))) {
              return new Response(JSON.stringify({ error: 'forbidden origin' }), {
                status: 403,
                headers: { 'content-type': 'application/json' },
              })
            }
            const url = new URL(req.url)
            const isTerminal = url.pathname === '/terminal'
            if (isTerminal && !terminalEnabled()) {
              return new Response(JSON.stringify({ error: 'terminal disabled' }), {
                status: 403,
                headers: { 'content-type': 'application/json' },
              })
            }
            let authenticated = false
            let owner: string | undefined
            if (!REQUIRED_TOKEN && API_KEY_OWNERS.size === 0) {
              authenticated = true
            } else {
              const auth = req.headers.get('authorization') ?? ''
              owner = resolveOwner(bearerOf(auth))
              authenticated = owner !== undefined
            }
            let upgraded = false
            try {
              upgraded = srv.upgrade(req, { data: { authenticated, owner, isTerminal } })
            } catch (e) {
              const msg = String((e as Error)?.message ?? e)
              if (msg.includes('writeAfterFIN') || msg.includes('FIN')) {
                // HMR reconnect during bun --watch restart — socket already closed, ignore gracefully
                return undefined
              }
              throw e
            }
            if (!upgraded) {
              // During bun --watch restart HMR may race; don't log writeAfterFIN as error
              return new Response('WebSocket upgrade failed', { status: 500 })
            }
            return undefined
          }
          return app.fetch(req)
        },
        websocket: {
          open(ws) {
            const w = ws as object as MiraWS
            w.__active = false
            const isTerminal = (w.data as MiraWSData | undefined)?.isTerminal === true
            const needsAuth = !!REQUIRED_TOKEN || API_KEY_OWNERS.size > 0
            if (!needsAuth || w.data?.authenticated === true) {
              if (isTerminal) activateTerminalSocket(w, w.data?.owner)
              else activateSocket(w, w.data?.owner)
            } else {
              w.__authTimer = setTimeout(() => {
                if (!w.__active) {
                  try {
                    w.close(1008, 'unauthorized: auth message not received within timeout')
                  } catch {}
                }
              }, WS_AUTH_TIMEOUT_MS)
            }
          },
          message(ws, msg) {
            const w = ws as object as MiraWS
            const raw = String(msg)
            if (raw.length > 1_000_000) {
              try {
                w.close(1009, 'message too large')
              } catch {}
              return
            }
            let event: {
              type?: string
              token?: string
              sessionID?: string
              data?: string
              cols?: number
              rows?: number
            } | null = null
            try {
              event = JSON.parse(raw)
            } catch {}
            if (!w.__active) {
              const owner =
                event?.type === 'auth' && typeof event.token === 'string'
                  ? resolveOwner(event.token)
                  : undefined
              if (owner !== undefined) {
                const isTerminal = (w.data as MiraWSData | undefined)?.isTerminal === true
                if (isTerminal) activateTerminalSocket(w, owner)
                else activateSocket(w, owner)
              }
              return
            }
            if ((w.data as MiraWSData | undefined)?.isTerminal) {
              if (event?.type === 'terminal.input' && typeof event.data === 'string') {
                w.__armIdle?.()
                if (terminalSandboxed()) {
                  const raw = event.data.trim()
                  if (raw && !raw.startsWith('#')) {
                    const first = raw.split(/[\s;|&]+/)[0] ?? ''
                    const base = first.split('/').pop() ?? first
                    let allowed: string[] = [
                      'bash',
                      'ls',
                      'cat',
                      'grep',
                      'find',
                      'git',
                      'bun',
                      'node',
                      'tsc',
                      'echo',
                      'pwd',
                      'head',
                      'tail',
                      'wc',
                      'sort',
                      'uniq',
                      'date',
                      'env',
                      'which',
                      'whoami',
                      'printf',
                      'sed',
                      'awk',
                    ]
                    try {
                      const cfg = getConfig() as MiraConfig
                      const t = (cfg.tools as Record<string, JsonValue> | undefined)?.terminal as
                        Record<string, JsonValue> | undefined
                      const list = t?.allowedCommands as string[] | undefined
                      if (Array.isArray(list)) allowed = list
                    } catch {}
                    if (base && !allowed.includes(base) && !allowed.includes(first)) {
                      try {
                        w.send(
                          JSON.stringify({
                            type: 'terminal.output',
                            payload: {
                              stream: 'stderr',
                              data: `sandbox: command "${base}" not in allowedCommands [${allowed.join(',')}] — blocked\n`,
                            },
                            timestamp: Date.now(),
                          }),
                        )
                      } catch {}
                    } else {
                      try {
                        const stdin = w.__proc?.stdin
                        if (
                          stdin &&
                          typeof stdin !== 'number' &&
                          typeof (stdin as Bun.FileSink).write === 'function'
                        )
                          (stdin as Bun.FileSink).write(event.data)
                      } catch {}
                    }
                  } else {
                    try {
                      const stdin = w.__proc?.stdin
                      if (
                        stdin &&
                        typeof stdin !== 'number' &&
                        typeof (stdin as Bun.FileSink).write === 'function'
                      )
                        (stdin as Bun.FileSink).write(event.data)
                    } catch {}
                  }
                } else {
                  try {
                    const stdin = w.__proc?.stdin
                    if (
                      stdin &&
                      typeof stdin !== 'number' &&
                      typeof (stdin as Bun.FileSink).write === 'function'
                    )
                      (stdin as Bun.FileSink).write(event.data)
                  } catch {}
                }
              }
              if (event?.type === 'permission.reply' || event?.type === 'question.reply')
                bus.publish(event as BusEvent)
              return
            }
            if (event?.type !== 'permission.reply' && event?.type !== 'question.reply') return
            bus.publish(event as BusEvent)
          },
          close(ws) {
            const w = ws as object as MiraWS
            clearTimeout(w.__authTimer)
            try {
              w.__unsub?.()
            } catch {}
            try {
              w.__ac?.abort()
            } catch {}
            try {
              w.__proc?.kill()
            } catch {}
          },
        },
      })
      break
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (
        msg.includes('EADDRINUSE') ||
        msg.includes('address already in use') ||
        msg.includes('Failed to start server')
      ) {
        if (attempt < 9) {
          warn(`port ${actualPort} in use — trying ${actualPort + 1}`)
          actualPort++
          continue
        }
      }
      throw e
    }
  }
  if (!server) throw new Error(`failed to bind after 10 attempts from ${PORT}`)
  // Export actual port so child processes and clients can discover rotation
  try {
    process.env.PORT = String(server.port)
  } catch {}
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    // Write .mira/port relative to cwd (repo root in normal runs) and also to
    // repo root resolved from file location — handles `bun --cwd packages/server`.
    const candidates = new Set<string>(['.mira/port'])
    try {
      const repoRoot = join(import.meta.dir, '../../..')
      candidates.add(join(repoRoot, '.mira/port'))
    } catch {}
    for (const p of candidates) {
      try {
        const slash = p.lastIndexOf('/')
        const dir = slash >= 0 ? p.slice(0, slash) : '.'
        // node:fs mkdirSync handles both relative and absolute
        mkdirSync(dir, { recursive: true })
        writeFileSync(p, String(server.port), 'utf-8')
      } catch {}
    }
  } catch {}
  log(`✓ listening on http://${server.hostname}:${server.port}`)
  log(`  liveness: GET /healthz (no auth) · detail: GET /health`)
  log(`  prompt:  POST /session/:id/prompt  (SSE)`)
  log(
    `  ws:      WS   /  (BusEvent stream)${terminalEnabled() ? ' · WS /terminal (pty)' : ' · terminal disabled'}`,
  )
  log(`  terminal: GET /terminal → {enabled:${terminalEnabled()}, sandbox:${terminalSandboxed()}}`)

  // Graceful shutdown
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log(`\n${signal} — draining…`)
    clearInterval(rateLimitCleanup)
    try {
      server.stop(true)
    } catch {}
    try {
      await mcp.disconnectAll()
    } catch {}
    try {
      const { shutdownAllServers } = await import('./lsp/client.js')
      await shutdownAllServers().catch(() => {})
    } catch {}
    try {
      db.sqlite?.close?.()
    } catch {}
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('beforeExit', () => {
    try {
      void mcp.disconnectAll()
    } catch {}
  })
}

if (import.meta.main) {
  main().catch((err) => {
    error('fatal:', err)
    process.exit(1)
  })
}

export { main }
export * from './session/prompt.js'
export * from './tools/registry.js'
export * from './bus/index.js'
export * from './storage/db.js'
export * from './gateway/index.js'
export * from './permission/index.js'
