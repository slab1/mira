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

export type ProvenanceNode = {
  nodeId: string
  label: string
  tier: 'episodic' | 'semantic' | 'procedural'
  kind: 'knowledge' | 'finding'
  source: string
  updatedAt: number
  accessCount: number
  snippet?: string
  tags?: string[]
}

export type Message = {
  id: string
  sessionID: string
  role: 'user' | 'assistant' | 'system'
  createdAt: number
  parts?: Part[]
  provenance?: ProvenanceNode[]
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

export type GraphNode = {
  id: string
  label: string
  tier: string
  source: string
  tags: string[]
  entities: string[]
  createdAt: number
  updatedAt: number
  lastAccessedAt: number
  accessCount: number
  kind: 'knowledge' | 'finding'
  severity?: string
  status?: string
}

export type GraphEdge = {
  from: string
  to: string
  kind: 'related' | 'entity' | 'finding'
  label?: string
}

export type KnowledgeGraph = {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type ScoreData = {
  sessionID: string
  score: number
  cost: number
  costUSD: number
  doomLoops: number
  toolErrors: number
  memoryHits: number
  traceId: string
  spanId: string
  requestId: string
  durationMs: number
  model: string
  toolCalls: number
  steps: number
  totalTokensIn: number
  totalTokensOut: number
  success: boolean
  toolMetrics?: Array<{
    tool: string
    durationMs: number
    isError: boolean
    errorKind?: string
    timestamp: number
  }>
}

export type TraceData = {
  sessionID: string
  requestId: string
  traceId: string
  spanId: string
  durationMs: number
  model: string
  toolCalls: number
  toolErrors: number
  doomLoops: number
  spans: Array<{
    name: string
    traceId: string
    spanId: string
    startMs: number
    endMs?: number
    durationMs?: number
    status: string
    attributes: Record<string, JsonValue>
  }>
  toolMetrics: Array<{
    tool: string
    durationMs: number
    isError: boolean
    errorKind?: string
    timestamp: number
    sessionID: string
  }>
  metric: {
    sessionID: string
    model: string
    steps: number
    totalTokensIn: number
    totalTokensOut: number
    latencyMs: number
    toolCalls: number
    toolErrors: number
    doomLoops: number
    success: boolean
  } | null
}

export type ModelEval = {
  model: string
  score: number
  successRate?: number
  sessions?: number
  lastEvalAt?: string
}

export type SchedulerStatus = {
  status: string
  nextRunAt?: string | null
  lastRunAt?: string | null
  started?: boolean
  running?: string[]
  lastRun?: Record<string, number | null>
  intervals?: Record<string, number>
}

export type EvalDelta = {
  delta: number
  sessionID: string
  previousScore?: number
  currentScore?: number
}

export type Patch = {
  id: string
  painPointId: string
  reason: string
  change: string
  targetFile?: string | null
  severity?: string
  score?: number
}

// ── Base URL + Auth ───────────────────────────────────────────────

const API_URL_KEY = 'mira_api_url'

function getEnvBase(): string {
  try {
    const env = (import.meta as { env?: Record<string, string> }).env
    if (env?.VITE_API_URL) return env.VITE_API_URL
  } catch {}
  try {
    const envUrl =
      (typeof process !== 'undefined' &&
        (process as { env?: Record<string, string> }).env?.MIRA_API_URL) ||
      (typeof process !== 'undefined' &&
        (process as { env?: Record<string, string> }).env?.VITE_API_URL) ||
      ''
    if (envUrl) return envUrl
  } catch {}
  return ''
}

let runtimeApiUrlWarned = false
function getRuntimeApiUrl(): string {
  try {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(API_URL_KEY) : null
    if (stored && stored.trim()) return stored.trim().replace(/\/$/, '')
    if (typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search).get('api')
      if (q && q.trim()) return q.trim().replace(/\/$/, '')
      const w = window as { __MIRA_API_URL?: string }
      if (w.__MIRA_API_URL && w.__MIRA_API_URL.trim())
        return w.__MIRA_API_URL.trim().replace(/\/$/, '')
    }
  } catch (e) {
    if (!runtimeApiUrlWarned) {
      runtimeApiUrlWarned = true
      console.warn('[mira] getRuntimeApiUrl() unavailable, using baked default', e)
    }
  }
  return ''
}

export function getApiUrl(): string {
  return getRuntimeApiUrl() || getEnvBase()
}

export function setApiUrl(url: string): void {
  try {
    const trimmed = url.trim().replace(/\/$/, '')
    if (trimmed) window.localStorage.setItem(API_URL_KEY, trimmed)
    else window.localStorage.removeItem(API_URL_KEY)
    try {
      window.dispatchEvent(new CustomEvent('mira:api-url-change', { detail: { url: trimmed } }))
    } catch {}
  } catch {}
}

export function clearApiUrl(): void {
  try {
    window.localStorage.removeItem(API_URL_KEY)
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent('mira:api-url-change', { detail: { url: '' } }))
  } catch {}
}

/**
 * Shared default when no explicit URL is configured.
 * Prefers the browser origin (tunnel / same-origin) → falls back to localhost.
 */
export function defaultApiUrl(): string {
  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
    return window.location.origin
  }
  return 'http://127.0.0.1:4096'
}

export function baseUrl(): string {
  const runtime = getRuntimeApiUrl()
  if (runtime) return runtime
  const raw = getEnvBase()
  if (raw) return raw.replace(/\/$/, '')
  if (typeof window !== 'undefined' && window.location.port === '3001') return ''
  return defaultApiUrl()
}

// Keep legacy name for internal callers
function getBaseUrl(): string {
  return baseUrl()
}

const TOKEN_KEY = 'mira_token'

export class ApiError extends Error {
  status: number
  body: string
  constructor(status: number, message: string, body = '') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export function getToken(): string {
  try {
    const stored = localStorage.getItem(TOKEN_KEY)
    if (stored) return stored
    try {
      const env = (import.meta as { env?: Record<string, string> }).env
      if (env?.VITE_MIRA_TOKEN) return env.VITE_MIRA_TOKEN
    } catch {}
    return ''
  } catch {
    return ''
  }
}
export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
    try {
      window.dispatchEvent(new CustomEvent('mira:token-change', { detail: { token } }))
    } catch {}
  } catch {}
}

export function clearTokenOn401(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent('mira:auth-invalid'))
  } catch {}
}

export async function validateToken(): Promise<boolean> {
  try {
    await req<{ ok: boolean }>('/health')
    return true
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return false
    try {
      await req<{ ok: boolean }>('/config')
      return true
    } catch {
      return false
    }
  }
}

// cross-tab token sync — storage event only fires in other tabs
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === TOKEN_KEY) {
      try {
        window.dispatchEvent(
          new CustomEvent('mira:auth-invalid', { detail: { token: e.newValue } }),
        )
        window.dispatchEvent(
          new CustomEvent('mira:token-change', { detail: { token: e.newValue ?? '' } }),
        )
      } catch {}
    }
  })
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
  if (res.status === 401) {
    clearTokenOn401()
    throw new ApiError(401, 'unauthorized')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = `${res.status} ${res.statusText}${text ? `: ${text}` : ''}`
    try {
      const j = JSON.parse(text) as { error?: string; message?: string }
      if (typeof j.error === 'string' && j.error) msg = `${res.status} ${j.error}`
      else if (typeof j.message === 'string' && j.message) msg = `${res.status} ${j.message}`
    } catch {}
    throw new ApiError(res.status, msg, text)
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
  reorderQueue: (id: string, orderedItems: string[]) =>
    req<{ ok: boolean }>(`/session/${id}/queue/reorder`, {
      method: 'POST',
      body: JSON.stringify({ texts: orderedItems }),
    }),
  deleteQueueItem: (id: string, text: string) =>
    req<{ ok: boolean; deleted: boolean }>(`/session/${id}/queue/item`, {
      method: 'DELETE',
      body: JSON.stringify({ text }),
    }),
  revertSession: (id: string, messageID?: string) =>
    req<{ ok: boolean; reverted: number; files: string[] }>(`/session/${id}/revert`, {
      method: 'POST',
      body: JSON.stringify(messageID ? { messageID } : {}),
    }),
  listSnapshots: (id: string) =>
    req<
      Array<{
        id: string
        sessionID: string
        messageID: string | null
        path: string
        existedBefore: boolean
        createdAt: number
      }>
    >(`/session/${id}/snapshots`),
  getSnapshot: (id: string, snapshotId: string) =>
    req<{
      path: string
      snapshotContent: string | null
      currentContent: string | null
      existedBefore: boolean
    }>(`/session/${id}/snapshots/${snapshotId}`),
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
  // ── Knowledge Graph (H2-1 Memory v2 read + H3-E mutations) ────
  getKnowledgeGraph: (limit = 100) => req<KnowledgeGraph>(`/knowledge/graph?limit=${limit}`),
  getLearningGraph: (limit = 100) => req<KnowledgeGraph>(`/learning/graph?limit=${limit}`),
  touchKnowledge: (id: string) =>
    req<GraphNode>(`/knowledge/${encodeURIComponent(id)}/touch`, { method: 'POST' }),
  seedKnowledge: (body: {
    title: string
    content: string
    tier?: string
    tags?: string[]
    sessionID?: string
  }) => req<GraphNode>('/knowledge', { method: 'POST', body: JSON.stringify(body) }),
  promoteFinding: (id: string, tier?: string) =>
    req<{ finding: Finding; entry: GraphNode }>(`/finding/${encodeURIComponent(id)}/promote`, {
      method: 'POST',
      body: JSON.stringify(tier ? { tier } : {}),
    }),
  deleteKnowledge: (id: string) =>
    req<{ ok: boolean; id: string }>(`/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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

  // ── Mira Score GA (H2-2) — per-session score + trace (port from web/src/api/client.ts:736-818) ──
  getScore: (sessionID: string) =>
    req<ScoreData>(`/learning/score?sessionID=${encodeURIComponent(sessionID)}`),
  getScoreBadgeUrl: (sessionID: string) =>
    `${baseUrl()}/learning/score?sessionID=${encodeURIComponent(sessionID)}&format=badge`,
  getScoreMarkdown: async (sessionID: string): Promise<string> => {
    const res = await fetch(
      `${baseUrl()}/learning/score?sessionID=${encodeURIComponent(sessionID)}&format=markdown`,
      {
        headers: authHeaders(),
      },
    )
    if (res.status === 401) throw new ApiError(401, 'unauthorized')
    if (!res.ok) throw new ApiError(res.status, `score markdown ${res.status}`)
    return res.text()
  },
  getTrace: (sessionID: string) =>
    req<TraceData>(`/learning/trace?sessionID=${encodeURIComponent(sessionID)}`),

  // ── Eval Badge (P1-4) — per-model eval (stub; server has no /eval endpoint yet) ──
  getModelEval: (model: string): Promise<ModelEval> =>
    Promise.resolve({ model, score: 0, successRate: 0, sessions: 0 }),

  // ── Autopilot (P1-5) — scheduler status, eval delta, pending patches ──
  getLearningSchedulerStatus: (): Promise<SchedulerStatus> =>
    req<{ scheduler?: SchedulerStatus } & SchedulerStatus>('/learning/status')
      .then((r) => {
        const s = (r as { scheduler?: SchedulerStatus }).scheduler
        if (s && typeof s === 'object') return s as SchedulerStatus
        return r as SchedulerStatus
      })
      .catch(() => ({ status: 'idle' })),

  getLearningLastEvalDelta: (): Promise<EvalDelta> =>
    req<EvalDelta & { score?: number; delta?: number }>('/learning/score')
      .then((r) => ({
        delta: typeof r.delta === 'number' ? r.delta : 0,
        sessionID: (r as { sessionID?: string }).sessionID ?? '',
        currentScore:
          typeof (r as { score?: number }).score === 'number'
            ? (r as { score?: number }).score
            : undefined,
      }))
      .catch(() => ({ delta: 0, sessionID: '' })),

  listPendingPatches: (): Promise<Patch[]> =>
    req<Patch[]>('/learning/patches').catch(() =>
      req<Patch[]>('/patching/history').catch(() => [] as Patch[]),
    ),

  approvePatch: (id: string): Promise<{ ok: boolean }> =>
    req<{ ok: boolean }>(`/learning/patches/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
    }).catch(() =>
      req<{ ok: boolean }>(`/patching/${encodeURIComponent(id)}/approve`, { method: 'POST' }).catch(
        () => ({ ok: true }),
      ),
    ),

  checkGuardrails: (body: { tool: string; args?: Record<string, JsonValue>; sessionID?: string }) =>
    req<{ decision: 'allow' | 'deny' | 'warn'; reason?: string; tool: string; sessionID: string }>(
      '/guardrails/check',
      { method: 'POST', body: JSON.stringify(body) },
    ),

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
    const host =
      typeof window !== 'undefined' ? window.location.host : new URL(defaultApiUrl()).host
    return `${proto}//${host}${suffix}`
  }
  try {
    const u = new URL(base)
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${u.host}${suffix}`
  } catch {
    const u = new URL(defaultApiUrl())
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${u.host}${suffix}`
  }
}

export function createSocket(handlers: Partial<WSEvents> = {}): {
  connect: () => WebSocket
  disconnect: () => void
  send: (msg: JsonValue) => void
  reconnect: () => void
  get ws(): WebSocket | null
} {
  let ws: WebSocket | null = null

  function doConnect(): WebSocket {
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
  }

  if (typeof window !== 'undefined') {
    const onTokenChange = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const t = getToken()
        try {
          if (t) ws.send(JSON.stringify({ type: 'auth', token: t }))
          else ws.close()
        } catch {}
      }
    }
    window.addEventListener('mira:auth-invalid', onTokenChange)
    window.addEventListener('mira:token-change', onTokenChange)
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
      try {
        ws?.close()
      } catch {}
      ws = null
      return doConnect()
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

/** Add or update a permission rule for a tool pattern */
export async function addPermissionRule(
  tool: string,
  pattern: string,
  action: 'allow' | 'deny' | 'ask',
): Promise<MiraConfig> {
  return rpc.patchConfig({ permission: { [tool]: { [pattern]: action } } })
}

export function createMiraClient() {
  return {
    rpc,
    createSocket,
    createTerminalSocket,
    getToken,
    setToken,
    getApiUrl,
    setApiUrl,
    clearApiUrl,
    validateToken,
    clearTokenOn401,
    baseUrl,
    ApiError,
    addPermissionRule,
  }
}

export default rpc
