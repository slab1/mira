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

export type ToolInfo = {
  name: string
  description: string
  parameters?: Record<string, JsonValue>
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

export type ProviderConfig = {
  npm?: string
  name: string
  options: { baseURL: string; apiKey: string }
  models: Record<string, { name: string; limit: { context: number; output: number } }>
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

export type PermissionMatrix = Record<string, string | Record<string, string>>

const BASE =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL) ||
  ""

function baseUrl(): string {
  if (BASE) return BASE.replace(/\/$/, "")
  // dev proxy: relative urls go through Vite proxy to :4096
  // prod: same origin unless VITE_API_URL set
  if (typeof window !== "undefined" && window.location.port === "3000") return ""
  return "http://127.0.0.1:4096"
}

// ── Auth (bearer token; servers with MIRA_TOKEN/MIRA_API_KEYS require it) ──
const TOKEN_KEY = "mira_token"

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
  } catch {}
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const t = getToken()
  return { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(extra || {}) }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeaders(init?.headers) },
  })
  if (res.status === 401) throw new Error("unauthorized")
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`)
  }
  // 204 / empty
  const ct = res.headers.get("content-type") || ""
  if (ct.includes("application/json")) return (await res.json()) as T
  return (await res.json().catch(() => ({} as T))) as T
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

  listTools: () => req<ToolInfo[]>("/tools"),

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
    const res = await fetch(`${baseUrl()}/session/${id}/export?format=${format}`, {
      headers: authHeaders(),
    })
    if (res.status === 401) throw new Error("unauthorized")
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return await res.text()
  },

  checkPermission: (body: Record<string, JsonValue>) =>
    req<{ allowed: boolean; reason?: string }>("/permission/check", {
      method: "POST",
      body: JSON.stringify(body),
    }),

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
    const res = await fetch(`${baseUrl()}/session/${id}/prompt`, {
      method: "POST",
      headers: { ...authHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }) },
      body: JSON.stringify({ prompt, model: opts.model }),
      signal: opts.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => "")
      throw new Error(`prompt failed ${res.status}: ${t}`)
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
            const j = JSON.parse(data)
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

  return {
    get ws() {
      return ws
    },
    connect() {
      if (ws && ws.readyState === WebSocket.OPEN) return ws
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
    },
    disconnect() {
      try {
        ws?.close()
      } catch {}
      ws = null
    },
    send(msg: JsonValue) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    },
  }
}
