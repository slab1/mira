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
}

export type Part = {
  type: "text" | "tool_call" | "tool_result" | "reasoning"
  text?: string
  tool?: string
  input?: unknown
  output?: unknown
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
  parameters?: unknown
}

export type BusEvent = {
  type: string
  payload?: unknown
  sessionID?: string
  timestamp: number
}

const BASE =
  (typeof import.meta !== "undefined" &&
    (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_URL) ||
  ""

function baseUrl(): string {
  if (BASE) return BASE.replace(/\/$/, "")
  // dev proxy: relative urls go through Vite proxy to :4096
  // prod: same origin unless VITE_API_URL set
  if (typeof window !== "undefined" && window.location.port === "3000") return ""
  return "http://localhost:4096"
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  })
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
  checkPermission: (body: unknown) =>
    req<{ allowed: boolean; reason?: string }>("/permission/check", {
      method: "POST",
      body: JSON.stringify(body),
    }),

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
  send: (msg: unknown) => void
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
      ws.onopen = () => handlers.open?.()
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
    send(msg: unknown) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    },
  }
}
