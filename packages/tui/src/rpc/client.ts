/**
 * Mira RPC Client — WebSocket + REST to Mira Server (Hono on :4096)
 *
 * Mirrors packages/server/src/index.ts endpoints + GlobalBus WebSocket.
 * Used by TUI stores + PermissionView (permission.reply via WS).
 *
 * Endpoints:
 *   GET    /health
 *   GET    /session                 → Session[]
 *   POST   /session                 → Session
 *   GET    /session/:id             → Session
 *   DELETE /session/:id
 *   POST   /session/:id/prompt      → SSE (text/event-stream)
 *   GET    /session/:id/message     → Message[]
 *   GET    /session/:id/todo        → Todo[]
 *   POST   /session/:id/todo
 *   GET    /tools
 *   POST   /permission/check
 *   WS     /                        → BusEvent stream
 */

// ── Types (mirrors server/src/types + shared/src/schemas/session.ts) ──

export type Session = {
  id: string
  title: string
  model: string
  provider: string
  createdAt: number
  updatedAt: number
  parentID?: string
}

export type Message = {
  id: string
  sessionID: string
  role: "user" | "assistant" | "system"
  createdAt: number
  parts?: Part[]
}

export type Part = {
  id: string
  messageID: string
  sessionID: string
  type: "text" | "tool-call" | "tool-result" | "reasoning" | "file"
  text?: string
  tool?: string
  toolCallID?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  createdAt: number
}

export type Todo = {
  id: string
  sessionID: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
  createdAt: number
}

export type ToolInfo = {
  name: string
  description: string
  parameters?: unknown
}

export type BusEventType =
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "message.created"
  | "message.updated"
  | "part.created"
  | "part.updated"
  | "todo.updated"
  | "permission.ask"
  | "permission.reply"
  | "server.heartbeat"
  | "server.error"

export type BusEvent<T = unknown> = {
  type: BusEventType
  sessionID?: string
  payload: T
  timestamp: number
}

export type PermissionRequest = {
  sessionID: string
  tool: string
  args: unknown
}

export type PermissionDecision = {
  action: "allow" | "deny" | "ask"
  reason: string
  matchedPattern?: string
  arity?: number
}

// ── Base URL ───────────────────────────────────────────────────────

function getBaseUrl(): string {
  // Allow override via Vite env or process env (Bun/Node)
  const viteEnv =
    (typeof import.meta !== "undefined" &&
      (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_URL) ||
    ""
  if (viteEnv) return viteEnv.replace(/\/$/, "")

  // Node/Bun env
  try {
    const envUrl =
      (typeof process !== "undefined" && (process as unknown as { env?: Record<string, string> }).env?.MIRA_API_URL) ||
      (typeof process !== "undefined" && (process as unknown as { env?: Record<string, string> }).env?.VITE_API_URL) ||
      ""
    if (envUrl) return envUrl.replace(/\/$/, "")
  } catch {}

  // Vite proxy: relative URLs go through vite proxy when served on :3001 → :4096
  if (typeof window !== "undefined" && window.location.port === "3001") return ""
  return "http://localhost:4096"
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`)
  }
  const ct = res.headers.get("content-type") || ""
  if (ct.includes("application/json")) return (await res.json()) as T
  return (await res.json().catch(() => ({} as T))) as T
}

// ── REST ───────────────────────────────────────────────────────────

export const rpc = {
  health: () => req<{ ok: boolean; version: string; tools: number }>("/health"),

  listSessions: () => req<Session[]>("/session"),
  createSession: (body: Partial<Pick<Session, "title" | "model" | "parentID">> = {}) =>
    req<Session>("/session", { method: "POST", body: JSON.stringify(body) }),
  getSession: (id: string) => req<Session>(`/session/${id}`),
  deleteSession: (id: string) => req<{ ok: boolean }>(`/session/${id}`, { method: "DELETE" }),

  getMessages: (id: string) => req<Message[]>(`/session/${id}/message`),
  getTodos: (id: string) => req<Todo[]>(`/session/${id}/todo`),
  setTodos: (id: string, todos: Partial<Todo>[]) =>
    req<Todo[]>(`/session/${id}/todo`, { method: "POST", body: JSON.stringify(todos) }),

  listTools: () => req<ToolInfo[]>("/tools"),
  checkPermission: (body: PermissionRequest) =>
    req<PermissionDecision>("/permission/check", { method: "POST", body: JSON.stringify(body) }),

  /**
   * Stream prompt via SSE (POST /session/:id/prompt).
   * Server returns `SessionPrompt.streamResponse()` as text/event-stream:
   *   event: text_delta / tool_call / tool_result / permission_ask / step_finish / finish / error
   *   data: { ... }
   */
  streamPrompt: async (
    id: string,
    prompt: string,
    opts: { model?: string; onEvent: (event: string, data: unknown) => void; signal?: AbortSignal },
  ) => {
    const res = await fetch(`${getBaseUrl()}/session/${id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ prompt, model: opts.model }),
      signal: opts.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => "")
      throw new Error(`prompt failed ${res.status}: ${t}`)
    }
    if (!res.body) {
      const t = await res.text()
      opts.onEvent("text_delta", { delta: t })
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split("\n\n")
      buf = frames.pop() || ""
      for (const frame of frames) {
        if (!frame.trim()) continue
        let event = "message"
        let dataStr = ""
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim()
          else if (line.startsWith("data:")) dataStr += line.slice(5).trim()
        }
        if (!dataStr) continue
        if (dataStr === "[DONE]") return
        try {
          const data = JSON.parse(dataStr)
          opts.onEvent(event, data)
        } catch {
          opts.onEvent(event, dataStr)
        }
      }
    }
    // flush remainder
    if (buf.trim()) {
      const m = buf.match(/event:\s*(\w+)\s*\ndata:\s*(.+)/)
      if (m) {
        try {
          opts.onEvent(m[1], JSON.parse(m[2]))
        } catch {
          opts.onEvent(m[1], m[2])
        }
      }
    }
  },
}

// ── WebSocket — GlobalBus → TUI (no polling) ─────────────────────

export type WSEvents = {
  open: () => void
  event: (e: BusEvent) => void
  close: () => void
  error: (err: Event) => void
}

export function createSocket(handlers: Partial<WSEvents> = {}): {
  connect: () => WebSocket
  disconnect: () => void
  send: (msg: unknown) => void
  get ws(): WebSocket | null
} {
  let ws: WebSocket | null = null

  function wsUrl(): string {
    const base = getBaseUrl()
    if (!base) {
      const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:"
      const host = typeof window !== "undefined" ? window.location.host : "localhost:4096"
      return `${proto}//${host}/`
    }
    try {
      const u = new URL(base)
      const proto = u.protocol === "https:" ? "wss:" : "ws:"
      return `${proto}//${u.host}/`
    } catch {
      return "ws://localhost:4096/"
    }
  }

  return {
    get ws() {
      return ws
    },
    connect() {
      if (ws && ws.readyState === WebSocket.OPEN) return ws
      const url = wsUrl()
      // Bun/Node: global WebSocket exists; fallback to `ws` package if needed
      ws = new WebSocket(url)
      ws.onopen = () => handlers.open?.()
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(String((ev as MessageEvent).data)) as BusEvent
          handlers.event?.(data)
        } catch {
          // ignore non-JSON heartbeat
        }
      }
      ws.onclose = () => handlers.close?.()
      ws.onerror = (e) => handlers.error?.(e as unknown as Event)
      return ws
    },
    disconnect() {
      try {
        ws?.close()
      } catch {}
      ws = null
    },
    send(msg: unknown) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    },
  }
}

// Convenience: singleton client factory
export function createMiraClient() {
  return { rpc, createSocket }
}

export default rpc
