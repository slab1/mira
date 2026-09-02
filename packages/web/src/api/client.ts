/**
 * Mira API Client — REST + WebSocket to Mira Server (Hono on :4096)
 *
 * Endpoints (from packages/server/src/index.ts):
 *   GET    /health
 *   GET    /session            → Session[]
 *   POST   /session            → Session
 *   GET    /session/:id        → Session
 *   DELETE /session/:id
 *   POST   /session/:id/prompt → SSE stream
 *   GET    /session/:id/message → Message[]
 *   GET    /session/:id/todo   → Todo[]
 *   POST   /session/:id/todo
 *   GET    /tools
 *   POST   /permission/check
 *   WS     /                   → BusEvent stream
 */

export type Session = {
  id: string
  title?: string
  model?: string
  agent?: string
  createdAt: string
  updatedAt: string
  status?: string
}

export type Message = {
  id: string
  sessionId: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  parts?: Part[]
  createdAt: string
  /** optimistic flag — message is queued, not yet processed by the agent */
  queued?: boolean
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type Part = {
  type: "text" | "tool_call" | "tool_result" | "reasoning"
  text?: string
  tool?: string
  input?: JsonValue
  output?: JsonValue
}

export type Todo = {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority?: string
}

export type JsonSchema = {
  type?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: string[]
  items?: JsonSchema
  default?: JsonValue
  additionalProperties?: boolean | JsonSchema
}

export type ToolInfo = {
  name: string
  description: string
  parameters?: JsonSchema
}

export type Snapshot = {
  id: string
  sessionID: string
  messageID: string | null
  path: string
  existedBefore: boolean
  createdAt: number
}

export type Finding = {
  id: string
  sessionID: string | null
  source: string
  severity: "info" | "minor" | "major" | "critical"
  title: string
  evidence: string | null
  status: "open" | "resolved"
  createdAt: number
  updatedAt: number
  resolvedAt: number | null
}

export type Job = {
  id: string
  parentSessionID: string
  childSessionID: string | null
  agent: string | null
  prompt: string
  status: "running" | "completed" | "failed" | "cancelled"
  result: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export type BusEvent = {
  type: string
  payload?: JsonValue
  sessionID?: string
  timestamp: number
}

// ── Settings types ─────────────────────────────────────────────────
export type ThemeChoice = "light" | "dark" | "system"

export type MiraConfig = {
  model: string
  smallModel?: string
  permission: Record<string, string | Record<string, string>>
  guardrails?: {
    enforce?: boolean
    allowedRoots?: string[]
    blockedPaths?: string[]
    blockedCommands?: string[]
    allowedCommands?: string[]
    maxOutputBytes?: number
    auditLogPath?: string
  }
  mcp: Record<string, MCPServerConfig>
  provider: Record<string, ProviderConfig>
  agents?: Record<string, { system: string; description?: string; tools?: string[]; permissions?: string }>
  loop?: { maxSteps?: number; contextLimit?: number; compactionThreshold?: number; smallModel?: string }
  features?: Record<string, boolean>
  tools?: Record<string, JsonValue>
}

export type MCPServerConfig = {
  type: "local" | "remote"
  command?: string[]
  url?: string
  enabled: boolean
  env?: Record<string, string>
  headers?: Record<string, string>
}

/** Curated catalog entry (mirror of server ProviderModelConfig) */
export type ProviderModelConfig = {
  name: string
  limit?: { context: number; output: number }
  enabled?: boolean
  deprecated?: boolean
  pricing?: { prompt: number; completion: number }
  capabilities?: string[]
}

export type ProviderConfig = {
  npm?: string
  name: string
  options: { baseURL: string; apiKey: string }
  models: Record<string, ProviderModelConfig>
}

export type ConfigSchema = {
  properties?: Record<string, { type: string; description?: string; default?: JsonValue; enum?: string[] }>
  required?: string[]
}

export type ProviderEntry = {
  id: string
  name: string
  maskedKey?: string
  baseURL?: string
  status?: "ok" | "error" | "unknown"
  models?: string[]
}

export type MCPServerEntry = {
  name: string
  type: string
  status: "connected" | "error" | "disabled" | "unknown"
  toolCount: number
  tools: Array<{ name: string; description: string }>
  error?: string
  config?: MCPServerConfig
}

export type AgentEntry = {
  name: string
  description: string
  tools: string[]
  permissions: string
  custom: boolean
}

export type CommandEntry = {
  name: string
  description: string
  content?: string
  source: "command" | "skill"
}

export type SkillEntry = {
  name: string
  description: string
}

/** Curated model entry from GET /models (active provider only, enabled models). */
export type CatalogModel = {
  id: string
  name: string
  context?: number
  deprecated?: boolean
}

export type ModelsResponse = {
  provider: string | null
  hasKey: boolean
  models: CatalogModel[]
}

export type WorkspaceEntry = {
  path: string
  dir: string
  size: number
  mtimeMs: number
}

export type WorkspaceTreeResponse = {
  root: string
  count: number
  files: WorkspaceEntry[]
}

export type PermissionMatrix = Record<string, string | Record<string, string>>

const API_URL_KEY = "mira_api_url"

function getEnvBase(): string {
  try {
    const env = (import.meta as { env?: Record<string, string> }).env
    return env?.VITE_API_URL ?? ""
  } catch {
    return ""
  }
}

function getRuntimeApiUrl(): string {
  try {
    // 1. Explicit user override (survives rebuilds, fixes ephemeral trycloudflare URL without redeploy)
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(API_URL_KEY) : null
    if (stored && stored.trim()) return stored.trim().replace(/\/$/, "")
    // 2. URL query param ?api=https://... (shareable link)
    if (typeof window !== "undefined") {
      const q = new URLSearchParams(window.location.search).get("api")
      if (q && q.trim()) return q.trim().replace(/\/$/, "")
      // 3. Window-injected (for runtime-config.json or watchdog)
      const w = window as { __MIRA_API_URL?: string }
      if (w.__MIRA_API_URL && w.__MIRA_API_URL.trim()) return w.__MIRA_API_URL.trim().replace(/\/$/, "")
    }
  } catch {}
  return ""
}

export function getApiUrl(): string {
  return getRuntimeApiUrl() || getEnvBase()
}

export function setApiUrl(url: string): void {
  try {
    const trimmed = url.trim().replace(/\/$/, "")
    if (trimmed) window.localStorage.setItem(API_URL_KEY, trimmed)
    else window.localStorage.removeItem(API_URL_KEY)
    try { window.dispatchEvent(new CustomEvent("mira:api-url-change", { detail: { url: trimmed } })) } catch {}
  } catch {}
}

export function clearApiUrl(): void {
  try { window.localStorage.removeItem(API_URL_KEY) } catch {}
  try { window.dispatchEvent(new CustomEvent("mira:api-url-change", { detail: { url: "" } })) } catch {}
}

function baseUrl(): string {
  const runtime = getRuntimeApiUrl()
  if (runtime) return runtime
  const raw = getEnvBase()
  if (raw) return raw.replace(/\/$/, "")
  // dev proxy: relative urls go through Vite proxy to :4096
  // prod: same origin unless VITE_API_URL set
  if (typeof window !== "undefined" && window.location.port === "3000") return ""
  return "http://127.0.0.1:4096"
}

// ── Auth (bearer token; servers with MIRA_TOKEN/MIRA_API_KEYS require it) ──
// Token sources (in priority order):
//  1. localStorage `mira_token` — written by AuthGate via setToken(), survives reload,
//     dispatched as `mira:token-change` (same-tab) + `storage` event (cross-tab).
//  2. Vite env `VITE_MIRA_TOKEN` — dev fallback from packages/web/.env (getToken() fallback).
// Server side: ~/.mira/mira.env  →  MIRA_TOKEN=…  (sourced + exported by scripts/serve-local.sh:10)
//  then `scripts/serve-local.sh start` restarts the server. req() clears on 401 via clearTokenOn401.
const TOKEN_KEY = "mira_token"

export class ApiError extends Error {
  status: number
  body: string
  constructor(status: number, message: string, body = "") {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.body = body
  }
}

export function getToken(): string {
  try {
    const stored = localStorage.getItem(TOKEN_KEY)
    if (stored) return stored
    // dev fallback from Vite env
    return (import.meta.env.VITE_MIRA_TOKEN as string) ?? ""
  } catch { return "" }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
    // notify same-tab listeners (storage event only fires cross-tab)
    try {
      window.dispatchEvent(new CustomEvent("mira:token-change", { detail: { token } }))
    } catch {}
  } catch {}
}

export function clearTokenOn401(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent("mira:auth-invalid"))
  } catch {}
}

export async function validateToken(): Promise<boolean> {
  try {
    await req<{ ok: boolean }>("/health")
    return true
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return false
    // try /config as fallback (also gated)
    try {
      await req<MiraConfig>("/config")
      return true
    } catch (e2) {
      if (e2 instanceof ApiError && e2.status === 401) return false
      // network or other error — don't treat as invalid
      return true
    }
  }
}

// cross-tab token sync — storage event only fires in other tabs
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === TOKEN_KEY) {
      try {
        window.dispatchEvent(new CustomEvent("mira:auth-invalid", { detail: { token: e.newValue } }))
        window.dispatchEvent(new CustomEvent("mira:token-change", { detail: { token: e.newValue ?? "" } }))
      } catch {}
    }
  })
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const t = getToken()
  return { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(extra || {}) }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const timeoutMs = 100_000
  const maxRetries = 3
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // combine caller signal + timeout signal
    let signal: AbortSignal = controller.signal
    if (init?.signal) {
      const caller = init.signal as AbortSignal
      if (caller.aborted) {
        clearTimeout(timer)
        controller.abort((caller as AbortSignal & { reason?: string }).reason)
      } else {
        try {
          const anyFn = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any
          if (typeof anyFn === "function") signal = anyFn([controller.signal, caller])
          else {
            caller.addEventListener("abort", () => controller.abort((caller as AbortSignal & { reason?: string }).reason), { once: true })
          }
        } catch {
          caller.addEventListener("abort", () => controller.abort((caller as AbortSignal & { reason?: string }).reason), { once: true })
        }
      }
    }
    try {
      const res = await fetch(`${baseUrl()}${path}`, {
        ...init,
        mode: "cors",
        signal,
        headers: { "Content-Type": "application/json", ...authHeaders(init?.headers) },
      })
      clearTimeout(timer)
      if (res.status === 401) {
        clearTokenOn401()
        throw new ApiError(401, "unauthorized")
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        let msg = `${res.status} ${res.statusText}${text ? `: ${text}` : ""}`
        try {
          const j = JSON.parse(text) as { error?: string; message?: string }
          if (typeof j.error === "string" && j.error) msg = `${res.status} ${j.error}`
          else if (typeof j.message === "string" && j.message) msg = `${res.status} ${j.message}`
        } catch {}
        throw new ApiError(res.status, msg, text)
      }
      // 204 / empty
      const ct = res.headers.get("content-type") || ""
      if (ct.includes("application/json")) return (await res.json()) as T
      return (await res.json().catch(() => ({} as T))) as T
    } catch (e) {
      clearTimeout(timer)
      if (e instanceof ApiError) throw e
      const err = e as Error
      const callerAborted = init?.signal ? (init.signal as AbortSignal).aborted : false
      // caller explicitly aborted — don't retry
      if (callerAborted && err.name === "AbortError") throw e
      const isAbort = err.name === "AbortError"
      const shouldRetry = attempt < maxRetries && (isAbort || err instanceof TypeError)
      if (shouldRetry) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      if (isAbort) throw new Error(`request timeout after ${timeoutMs}ms: ${path}`)
      throw e
    }
  }
  throw lastErr ?? new Error("request failed")
}

// ── Tool cache (TTL 30s) ───────────────────────────────────────────
const TOOL_CACHE_TTL = 30_000
let toolCache: { data: ToolInfo[]; ts: number } | null = null

async function listToolsRaw(): Promise<ToolInfo[]> {
  return req<ToolInfo[]>("/tools")
}

async function listToolsCached(): Promise<ToolInfo[]> {
  if (toolCache && Date.now() - toolCache.ts < TOOL_CACHE_TTL) return toolCache.data
  const data = await listToolsRaw()
  toolCache = { data, ts: Date.now() }
  return data
}

function invalidateToolCache(): void {
  toolCache = null
}

// ── REST ─────────────────────────────────────────────────────────────
export const api = {
  health: () => req<{ ok: boolean; version: string; tools: number }>("/health"),

  listSessions: () => req<Session[]>("/session"),
  createSession: (body: Partial<Session> = {}) =>
    req<Session>("/session", { method: "POST", body: JSON.stringify(body) }),
  getSession: (id: string) => req<Session>(`/session/${id}`),
  deleteSession: (id: string) => req<{ ok: boolean }>(`/session/${id}`, { method: "DELETE" }),

  getMessages: (id: string) => req<Message[]>(`/session/${id}/message`),
  getTodos: (id: string) => req<Todo[]>(`/session/${id}/todo`),
  setTodos: (id: string, todos: Todo[]) =>
    req<Todo[]>(`/session/${id}/todo`, { method: "POST", body: JSON.stringify(todos) }),

  listTools: () => listToolsRaw(),
  listToolsCached,
  invalidateToolCache,

  /** Gateway cost/latency stats for the process */
  devHealth: () =>
    req<{
      ok: boolean
      tools: number
      gateway: { requests: number; inputTokens: number; outputTokens: number; costUSD: number; avgLatencyMs: number }
    }>("/dev/health"),

  /** Queue a message while the agent is streaming (processed after current turn) */
  queuePrompt: (id: string, prompt: string) =>
    req<{ position: number }>(`/session/${id}/queue`, { method: "POST", body: JSON.stringify({ prompt }) }),
  getQueue: (id: string) => req<string[]>(`/session/${id}/queue`),
  clearQueue: (id: string) => req<{ cleared: number }>(`/session/${id}/queue`, { method: "DELETE" }),

  /** File snapshot undo — revert last mutation or rewind to a message */
  revertSession: (id: string, messageID?: string) =>
    req<{ ok: boolean; reverted: number; files: string[] }>(`/session/${id}/revert`, {
      method: "POST",
      body: JSON.stringify(messageID ? { messageID } : {}),
    }),

  listSnapshots: (id: string) => req<Snapshot[]>(`/session/${id}/snapshots`),

  listFindings: (params: { status?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.status) q.set("status", params.status)
    if (params.limit) q.set("limit", String(params.limit))
    const qs = q.toString() ? `?${q}` : ""
    return req<Finding[]>(`/finding${qs}`)
  },
  resolveFinding: (id: string) => req<Finding>(`/finding/${encodeURIComponent(id)}/resolve`, { method: "POST" }),

  listJobs: (sessionId: string) => req<Job[]>(`/session/${encodeURIComponent(sessionId)}/jobs`),
  getJob: (id: string) => req<Job>(`/job/${encodeURIComponent(id)}`),
  cancelJob: (id: string) => req<Job>(`/job/${encodeURIComponent(id)}/cancel`, { method: "POST" }),

  /** Export session transcript — markdown or JSON (triggers download in caller) */
  exportSession: async (id: string, format: "md" | "json" = "md"): Promise<string> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await fetch(`${baseUrl()}/session/${id}/export?format=${format}`, {
        mode: "cors",
        signal: controller.signal,
        headers: authHeaders(),
      })
      if (res.status === 401) {
        clearTokenOn401()
        throw new ApiError(401, "unauthorized")
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "")
        let msg = `${res.status} ${res.statusText}`
        try {
          const j = JSON.parse(t) as { error?: string }
          if (j.error) msg = `${res.status} ${j.error}`
        } catch {}
        throw new ApiError(res.status, msg, t)
      }
      return await res.text()
    } catch (e) {
      if (e instanceof ApiError) throw e
      if ((e as Error).name === "AbortError") throw new Error(`request timeout after 10000ms: /session/${id}/export`)
      throw e
    } finally {
      clearTimeout(timer)
    }
  },

  checkPermission: (body: Record<string, JsonValue>) =>
    req<{ action?: string; allowed?: boolean; reason?: string; matchedPattern?: string; arity?: number; lane?: { agent: string; permissions: string; allowed?: string[]; blocked?: boolean } }>("/permission/check", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  checkGuardrails: (body: { tool: string; args?: Record<string, JsonValue>; sessionID?: string }) =>
    req<{ decision: "allow" | "deny" | "warn"; reason?: string; tool: string; sessionID: string }>("/guardrails/check", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  previewAgent: (name: string) =>
    req<{ agent: string; permissions: string; allowed: string[]; blocked: string[]; allowlist: string[] }>(`/agents/${encodeURIComponent(name)}/preview`),

  // ── Settings ─────────────────────────────────────────────────────
  getConfig: () => req<MiraConfig>("/config"),
  getConfigSchema: () => req<ConfigSchema>("/config/schema"),
  patchConfig: (patch: Partial<MiraConfig>) =>
    req<MiraConfig>("/config", { method: "PATCH", body: JSON.stringify(patch) }),

  listProviders: () => req<ProviderEntry[] | Record<string, ProviderConfig>>("/providers"),
  testProvider: (id: string) =>
    req<{ ok: boolean; latencyMs?: number; error?: string }>(`/providers/${encodeURIComponent(id)}/test`, { method: "POST" }),
  removeProvider: (id: string) => req<{ ok: boolean }>(`/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listMcp: () => req<MCPServerEntry[]>("/mcp"),
  addMcp: (body: { name: string; type: "local" | "remote"; command?: string[]; url?: string; enabled?: boolean; env?: Record<string, string>; headers?: Record<string, string> }) =>
    req<MCPServerEntry>("/mcp", { method: "POST", body: JSON.stringify(body) }),
  toggleMcp: (name: string, enabled: boolean) =>
    req<MCPServerEntry>(`/mcp/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  testMcp: (name: string) =>
    req<{ ok: boolean; toolCount?: number; error?: string }>(`/mcp/${encodeURIComponent(name)}/test`, { method: "POST" }),
  removeMcp: (name: string) => req<{ ok: boolean }>(`/mcp/${encodeURIComponent(name)}`, { method: "DELETE" }),

  listAgents: () => req<AgentEntry[]>("/agents"),
  listCommands: () => req<CommandEntry[] | string[]>("/commands"),
  listSkills: () => req<SkillEntry[] | string[]>("/skills"),
  getPermission: () => req<PermissionMatrix>("/permission"),

  /** Active provider's curated model list (60s server cache) — composer model picker */
  listModels: () => req<ModelsResponse>("/models"),
  /** Workspace file tree (newest-first) — @mention file suggestions */
  getWorkspaceTree: () => req<WorkspaceTreeResponse>("/workspace/tree"),

  // ── Admin (curated model catalog; master-token owners or open dev servers) ──
  whoami: () => req<{ ok: boolean; isAdmin: boolean; mode: "open" | "token" }>("/admin/whoami"),
  syncProviderModels: (id: string, models?: unknown[]) =>
    req<{ ok: boolean; provider: string; added: string[]; updated: string[]; total: number }>(
      `/admin/providers/${encodeURIComponent(id)}/models/sync`,
      { method: "POST", body: JSON.stringify(models ? { models } : {}) },
    ),
  patchProviderModel: (id: string, modelId: string, patch: Partial<ProviderModelConfig>) =>
    req<{ ok: boolean; model: ProviderModelConfig }>(
      `/admin/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),
  deleteProviderModel: (id: string, modelId: string) =>
    req<{ ok: boolean }>(
      `/admin/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`,
      { method: "DELETE" },
    ),

  /**
   * Stream prompt response via SSE (POST /session/:id/prompt).
   * Server returns `prompt.streamResponse()` as text/event-stream.
   * onChunk receives each SSE data payload; onDone when stream ends.
   */
  streamPrompt: async (
    id: string,
    prompt: string,
    opts: { model?: string; onChunk: (chunk: string) => void; signal?: AbortSignal },
  ) => {
    // fresh token + baseUrl on each call (watchdog may have redeployed)
    const headers = { ...authHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }) }
    const res = await fetch(`${baseUrl()}/session/${id}/prompt`, {
      method: "POST",
      mode: "cors",
      headers,
      body: JSON.stringify({ prompt, model: opts.model }),
      signal: opts.signal,
    })
    if (res.status === 401) {
      clearTokenOn401()
      throw new ApiError(401, "unauthorized")
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "")
      let msg = `prompt failed ${res.status}: ${t}`
      try {
        const j = JSON.parse(t) as { error?: string }
        if (j.error) msg = `prompt failed ${res.status}: ${j.error}`
      } catch {}
      throw new ApiError(res.status, msg, t)
    }
    if (!res.body) {
      const t = await res.text()
      opts.onChunk(t)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // SSE frames: data: {...}\n\n
      const frames = buf.split("\n\n")
      buf = frames.pop() || ""
      for (const f of frames) {
        const lines = f.split("\n").filter((l) => l.startsWith("data:"))
        for (const l of lines) {
          const data = l.slice(5).trim()
          if (data === "[DONE]") return
          if (!data) continue
          // Try JSON unwrap: some servers send JSON per frame
          try {
            const j = JSON.parse(data) as { textDelta?: string; text?: string; content?: string; delta?: string }
            // Vercel AI SDK style: { type: "text-delta", textDelta: "..." }
            const text = j.textDelta ?? j.text ?? j.content ?? j.delta ?? (typeof j === "string" ? j : "")
            if (text) opts.onChunk(String(text))
            else opts.onChunk(data)
          } catch {
            opts.onChunk(data)
          }
        }
      }
    }
    if (buf.trim()) {
      const m = buf.match(/data:\s*(.+)/)
      if (m) opts.onChunk(m[1])
    }
  },
}

// ── WebSocket (GlobalBus → Worker → RPC → TUI) ───────────────────
export type WSEvents = {
  open: () => void
  event: (e: BusEvent) => void
  close: () => void
  error: (err: Event) => void
}

export function createSocket(handlers: Partial<WSEvents> = {}): {
  connect: () => WebSocket
  disconnect: () => void
  send: (msg: JsonValue) => void
  reconnect: () => void
  get ws(): WebSocket | null
} {
  let ws: WebSocket | null = null

  function wsUrl(): string {
    const base = baseUrl()
    if (!base) {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
      return `${proto}//${window.location.host}/`
    }
    const u = new URL(base)
    const proto = u.protocol === "https:" ? "wss:" : "ws:"
    return `${proto}//${u.host}/`
  }

  function doConnect(): WebSocket {
    if (ws && ws.readyState === WebSocket.OPEN) return ws
    // fresh baseUrl + token on each connect (handles VITE_API_URL watchdog redeploy)
    ws = new WebSocket(wsUrl())
    ws.onopen = () => {
      // Servers with auth enabled close unauthenticated sockets after 5s —
      // browsers cannot set WS headers, so authenticate via first message.
      const t = getToken()
      if (t) ws?.send(JSON.stringify({ type: "auth", token: t }))
      handlers.open?.()
    }
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as BusEvent
        handlers.event?.(data)
      } catch {
        // ignore non-JSON heartbeat
      }
    }
    ws.onclose = () => handlers.close?.()
    ws.onerror = (e) => handlers.error?.(e as Event)
    return ws
  }

  // re-auth on token change (cross-tab or in-tab)
  if (typeof window !== "undefined") {
    const onTokenChange = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const t = getToken()
        try {
          if (t) ws.send(JSON.stringify({ type: "auth", token: t }))
          else {
            // token cleared — reconnect to trigger 401 handling
            ws.close()
          }
        } catch {}
      } else if (ws && ws.readyState === WebSocket.CLOSED) {
        // will reconnect via interval in app store
      }
    }
    window.addEventListener("mira:auth-invalid", onTokenChange)
    window.addEventListener("mira:token-change", onTokenChange)
  }

  return {
    get ws() {
      return ws
    },
    connect() {
      return doConnect()
    },
    disconnect() {
      try {
        ws?.close()
      } catch {}
      ws = null
    },
    reconnect() {
      try { ws?.close() } catch {}
      ws = null
      return doConnect()
    },
    send(msg: JsonValue) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    },
  }
}
