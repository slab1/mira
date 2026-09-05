/**
 * Mira RPC Client — WebSocket + REST to Mira Server (Hono on :4096)
 * Unified with packages/web/src/api/client.ts — JsonValue, no any/unknown
 *
 * Endpoints: health, session, message, todo, tools, permission, queue, revert,
 * config, providers, mcp, agents, skills, commands, jobs, findings, export, terminal
 * WS: / (BusEvent) + /terminal (PTY)
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type Session = {
  id: string
  title: string
  model: string
  provider: string
  createdAt: number
  updatedAt: number
  parentID?: string
  agent?: string
  ownerID?: string
}

export type Message = {
  id: string
  sessionID: string
  role: 'user' | 'assistant' | 'system'
  createdAt: number
  parts?: Part[]
}

export type Part = {
  id: string
  messageID: string
  sessionID: string
  type: 'text' | 'tool-call' | 'tool-result' | 'reasoning' | 'file'
  text?: string
  tool?: string
  toolCallID?: string
  args?: Record<string, JsonValue>
  result?: JsonValue
  isError?: boolean
  createdAt: number
}

export type Todo = {
  id: string
  sessionID: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
  createdAt: number
}

export type ToolInfo = {
  name: string
  description: string
  parameters?: Record<string, JsonValue>
}

export type BusEventType =
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'message.created'
  | 'message.updated'
  | 'part.created'
  | 'part.updated'
  | 'todo.updated'
  | 'job.created'
  | 'job.updated'
  | 'job.cancelled'
  | 'learning.updated'
  | 'permission.ask'
  | 'permission.reply'
  | 'question.ask'
  | 'question.reply'
  | 'server.heartbeat'
  | 'server.error'
  | 'doom_loop'
  | 'terminal.connected'
  | 'terminal.output'
  | 'terminal.exit'

export type BusEvent<T = JsonValue> = {
  type: BusEventType
  sessionID?: string
  payload: T
  timestamp: number
}

export type PermissionRequest = {
  sessionID: string
  tool: string
  args: Record<string, JsonValue>
}

export type PermissionDecision = {
  action: 'allow' | 'deny' | 'ask'
  reason: string
  matchedPattern?: string
  arity?: number
}

export type Job = {
  id: string
  parentSessionID: string
  childSessionID: string | null
  agent: string | null
  prompt: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  result: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export type Finding = {
  id: string
  sessionID: string | null
  source: string
  severity: 'info' | 'minor' | 'major' | 'critical'
  title: string
  evidence: string | null
  status: 'open' | 'resolved'
  createdAt: number
  updatedAt: number
  resolvedAt: number | null
}

export type MiraConfig = {
  model: string
  smallModel?: string
  loop?: {
    maxSteps?: number
    contextLimit?: number
    compactionThreshold?: number
    smallModel?: string
  }
  permission: Record<string, string | Record<string, string>>
  guardrails?: Record<string, JsonValue>
  mcp: Record<
    string,
    {
      type: 'local' | 'remote'
      command?: string[]
      url?: string
      enabled: boolean
      env?: Record<string, string>
      headers?: Record<string, string>
    }
  >
  provider: Record<
    string,
    {
      name: string
      options: { baseURL: string; apiKey: string }
      models: Record<string, { name: string; limit: { context: number; output: number } }>
    }
  >
  agents?: Record<
    string,
    { system: string; description?: string; tools?: string[]; permissions?: string }
  >
  features?: Record<string, boolean>
  tools?: Record<string, JsonValue>
  skills?: Record<string, JsonValue>
}

export type ProviderEntry = {
  id: string
  name: string
  maskedKey?: string
  baseURL?: string
  status?: string
  models?: string[]
}

export type MCPServerEntry = {
  name: string
  type: string
  status: 'connected' | 'error' | 'disabled' | 'unknown'
  toolCount: number
  tools: Array<{ name: string; description: string }>
  error?: string
  config?: { type: 'local' | 'remote'; command?: string[]; url?: string; enabled: boolean }
}

export type AgentEntry = {
  name: string
  description: string
  tools: string[]
  permissions: string
  custom: boolean
}

// ── Base URL + Auth ───────────────────────────────────────────────

function getBaseUrl(): string {
  const viteEnv =
    (typeof import.meta !== 'undefined' &&
      (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL) ||
    ''
  if (viteEnv) return viteEnv.replace(/\/$/, '')
  try {
    const envUrl =
      (typeof process !== 'undefined' &&
        (process as { env?: Record<string, string> }).env?.MIRA_API_URL) ||
      (typeof process !== 'undefined' &&
        (process as { env?: Record<string, string> }).env?.VITE_API_URL) ||
      ''
    if (envUrl) return envUrl.replace(/\/$/, '')
  } catch {}
  if (typeof window !== 'undefined' && window.location.port === '3001') return ''
  return 'http://127.0.0.1:4096'
}

const TOKEN_KEY = 'mira_token'
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
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
  const res = await fetch(`${getBaseUrl()}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders(init?.headers) },
    ...init,
  })
  if (res.status === 401) throw new Error('unauthorized — set token via mira_token')
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ''}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) return (await res.json()) as T
  return (await res.json().catch(() => ({}) as T)) as T
}

// ── REST ───────────────────────────────────────────────────────────

export const rpc = {
  health: () => req<{ ok: boolean; version: string; tools: number }>('/health'),
  devHealth: () =>
    req<{
      ok: boolean
      gateway: {
        requests: number
        inputTokens: number
        outputTokens: number
        costUSD: number
        avgLatencyMs: number
      }
    }>('/dev/health'),

  listSessions: () => req<Session[]>('/session'),
  createSession: (body: Partial<Pick<Session, 'title' | 'model' | 'parentID' | 'agent'>> = {}) =>
    req<Session>('/session', { method: 'POST', body: JSON.stringify(body) }),
  getSession: (id: string) => req<Session>(`/session/${id}`),
  deleteSession: (id: string) => req<{ ok: boolean }>(`/session/${id}`, { method: 'DELETE' }),
  getMessages: (id: string) => req<Message[]>(`/session/${id}/message`),
  getTodos: (id: string) => req<Todo[]>(`/session/${id}/todo`),
  setTodos: (id: string, todos: Partial<Todo>[]) =>
    req<Todo[]>(`/session/${id}/todo`, { method: 'POST', body: JSON.stringify(todos) }),
  listTools: () => req<ToolInfo[]>('/tools'),
  checkPermission: (body: PermissionRequest) =>
    req<PermissionDecision>('/permission/check', { method: 'POST', body: JSON.stringify(body) }),
  queuePrompt: (id: string, prompt: string) =>
    req<{ position: number }>(`/session/${id}/queue`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  getQueue: (id: string) => req<string[]>(`/session/${id}/queue`),
  clearQueue: (id: string) =>
    req<{ cleared: number }>(`/session/${id}/queue`, { method: 'DELETE' }),
  revertSession: (id: string, messageID?: string) =>
    req<{ ok: boolean; reverted: number; files: string[] }>(`/session/${id}/revert`, {
      method: 'POST',
      body: JSON.stringify(messageID ? { messageID } : {}),
    }),
  listSnapshots: (id: string) =>
    req<Array<{ id: string; path: string; createdAt: number }>>(`/session/${id}/snapshots`),
  exportSession: async (id: string, format: 'md' | 'json' = 'md'): Promise<string> => {
    const res = await fetch(`${getBaseUrl()}/session/${id}/export?format=${format}`, {
      headers: authHeaders(),
    })
    if (res.status === 401) throw new Error('unauthorized')
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return await res.text()
  },
  listJobs: (sessionId: string) => req<Job[]>(`/session/${encodeURIComponent(sessionId)}/jobs`),
  listAllJobs: () => req<Job[]>('/jobs'),
  getJob: (id: string) => req<Job>(`/job/${encodeURIComponent(id)}`),
  cancelJob: (id: string) => req<Job>(`/job/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  listFindings: (params: { status?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.limit) q.set('limit', String(params.limit))
    const qs = q.toString() ? `?${q}` : ''
    return req<Finding[]>(`/finding${qs}`)
  },
  resolveFinding: (id: string) =>
    req<Finding>(`/finding/${encodeURIComponent(id)}/resolve`, { method: 'POST' }),
  getConfig: () => req<MiraConfig>('/config'),
  patchConfig: (patch: Partial<MiraConfig>) =>
    req<MiraConfig>('/config', { method: 'PATCH', body: JSON.stringify({ patch }) }),
  getConfigSchema: () => req<{ properties?: Record<string, { type: string }> }>('/config/schema'),
  listProviders: () => req<ProviderEntry[]>('/providers'),
  testProvider: (id: string) =>
    req<{ ok: boolean; latencyMs?: number; error?: string }>(
      `/providers/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
    ),
  removeProvider: (id: string) =>
    req<{ ok: boolean }>(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listMcp: () => req<MCPServerEntry[]>('/mcp'),
  addMcp: (body: {
    name: string
    type: 'local' | 'remote'
    command?: string[]
    url?: string
    enabled?: boolean
    env?: Record<string, string>
    headers?: Record<string, string>
  }) => req<MCPServerEntry>('/mcp', { method: 'POST', body: JSON.stringify(body) }),
  toggleMcp: (name: string, enabled: boolean) =>
    req<MCPServerEntry>(`/mcp/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  testMcp: (name: string) =>
    req<{ ok: boolean; toolCount?: number; error?: string }>(
      `/mcp/${encodeURIComponent(name)}/test`,
      { method: 'POST' },
    ),
  removeMcp: (name: string) =>
    req<{ ok: boolean }>(`/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  listAgents: () => req<AgentEntry[]>('/agents'),
  listSkills: () => req<string[] | Array<{ name: string; description: string }>>('/skills'),
  listCommands: () => req<string[] | Array<{ name: string; description: string }>>('/commands'),
  getPermission: () => req<Record<string, JsonValue>>('/permission'),
  getTerminalStatus: () => req<{ enabled: boolean; sandbox: boolean; ws: string }>('/terminal'),

  streamPrompt: async (
    id: string,
    prompt: string,
    opts: {
      model?: string
      onEvent: (event: string, data: JsonValue) => void
      signal?: AbortSignal
    },
  ) => {
    const res = await fetch(`${getBaseUrl()}/session/${id}/prompt`, {
      method: 'POST',
      headers: {
        ...authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      },
      body: JSON.stringify({ prompt, model: opts.model }),
      signal: opts.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`prompt failed ${res.status}: ${t}`)
    }
    if (!res.body) {
      const t = await res.text()
      opts.onEvent('text_delta', t as JsonValue)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() || ''
      for (const frame of frames) {
        if (!frame.trim()) continue
        let event = 'message'
        let dataStr = ''
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim()
        }
        if (!dataStr) continue
        if (dataStr === '[DONE]') return
        try {
          const data = JSON.parse(dataStr) as JsonValue
          opts.onEvent(event, data)
        } catch {
          opts.onEvent(event, dataStr as JsonValue)
        }
      }
    }
    if (buf.trim()) {
      const m = buf.match(/event:\s*(\w+)\s*\ndata:\s*(.+)/)
      if (m) {
        try {
          opts.onEvent(m[1], JSON.parse(m[2]) as JsonValue)
        } catch {
          opts.onEvent(m[1], m[2] as JsonValue)
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

function wsUrl(path: string): string {
  const base = getBaseUrl()
  const suffix = path.startsWith('/') ? path : `/${path}`
  if (!base) {
    const proto =
      typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = typeof window !== 'undefined' ? window.location.host : '127.0.0.1:4096'
    return `${proto}//${host}${suffix}`
  }
  try {
    const u = new URL(base)
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${u.host}${suffix}`
  } catch {
    return `ws://127.0.0.1:4096${suffix}`
  }
}

export function createSocket(handlers: Partial<WSEvents> = {}): {
  connect: () => WebSocket
  disconnect: () => void
  send: (msg: JsonValue) => void
  get ws(): WebSocket | null
} {
  let ws: WebSocket | null = null
  return {
    get ws() {
      return ws
    },
    connect() {
      if (ws && ws.readyState === WebSocket.OPEN) return ws
      ws = new WebSocket(wsUrl('/'))
      ws.onopen = () => {
        const t = getToken()
        if (t) ws?.send(JSON.stringify({ type: 'auth', token: t }))
        handlers.open?.()
      }
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(String((ev as MessageEvent).data)) as BusEvent
          handlers.event?.(data)
        } catch {}
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

export function createTerminalSocket(handlers: {
  onConnected?: (payload: JsonValue) => void
  onOutput?: (stream: string, data: string) => void
  onExit?: (code: number) => void
  onClose?: () => void
  onError?: (err: Event) => void
}): {
  connect: () => WebSocket
  sendInput: (data: string) => void
  disconnect: () => void
  get ws(): WebSocket | null
} {
  let ws: WebSocket | null = null
  return {
    get ws() {
      return ws
    },
    connect() {
      ws = new WebSocket(wsUrl('/terminal'))
      ws.onopen = () => {
        const t = getToken()
        if (t) ws?.send(JSON.stringify({ type: 'auth', token: t }))
      }
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String((ev as MessageEvent).data)) as {
            type: string
            payload?: Record<string, JsonValue>
          }
          if (m.type === 'terminal.connected') handlers.onConnected?.(m.payload as JsonValue)
          else if (m.type === 'terminal.output')
            handlers.onOutput?.(
              String(m.payload?.stream ?? 'stdout'),
              String(m.payload?.data ?? ''),
            )
          else if (m.type === 'terminal.exit') handlers.onExit?.(Number(m.payload?.code ?? 0))
        } catch {}
      }
      ws.onclose = () => handlers.onClose?.()
      ws.onerror = (e) => handlers.onError?.(e as Event)
      return ws
    },
    sendInput(data: string) {
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'terminal.input', data }))
    },
    disconnect() {
      try {
        ws?.close()
      } catch {}
      ws = null
    },
  }
}

export function createMiraClient() {
  return { rpc, createSocket, createTerminalSocket, getToken, setToken }
}

export default rpc
