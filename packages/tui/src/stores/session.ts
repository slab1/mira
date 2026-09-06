/**
 * Mira Session Store — SolidJS reactive store for TUI
 *
 * Single source of truth for sessions / messages / todos / streaming / permissions.
 * Server is source of truth; store mirrors it + drives optimistic UI.
 * Event-driven via WebSocket (GlobalBus), no polling.
 *
 * P1-8 Streaming Telemetry:
 *  - streamStartAt + elapsed + tokens/sec (port from web ChatView)
 *  - debounced loadMessages + incremental patch for part.created/updated
 */

import { createSignal, onCleanup } from 'solid-js'
import { createStore } from 'solid-js/store'
import {
  rpc,
  createSocket,
  type Session,
  type Message,
  type Todo,
  type BusEvent,
  type Part,
  type JsonValue,
} from '../rpc/client'

export type PendingPermission = {
  toolCallID: string
  tool: string
  args: Record<string, JsonValue>
  sessionID: string
}

export type PendingQuestion = {
  questionID: string
  sessionID?: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
  }>
}

export type StreamEvent = {
  type: string
  data: JsonValue
  at: number
}

type SessionState = {
  sessions: Session[]
  currentId: string | null
  messages: Message[]
  todos: Todo[]
  streaming: boolean
  streamText: string
  streamStartAt: number | null
  streamEvents: StreamEvent[]
  connected: boolean
  loading: boolean
  error: string | null
  pendingPermission: PendingPermission | null
  pendingQuestion: PendingQuestion | null
  queued: string[]
  cost: {
    requests: number
    inputTokens: number
    outputTokens: number
    costUSD: number
    avgLatencyMs: number
  } | null
  budgetWarning: string | null
  doomLoop: { tool: string; reason: string; pattern?: string[]; sessionID?: string } | null
}

function uid() {
  return Math.random().toString(36).slice(2, 9)
}

export function createSessionStore() {
  const [state, setState] = createStore<SessionState>({
    sessions: [],
    currentId: null,
    messages: [],
    todos: [],
    streaming: false,
    streamText: '',
    streamStartAt: null,
    streamEvents: [],
    connected: false,
    loading: false,
    error: null,
    pendingPermission: null,
    pendingQuestion: null,
    queued: [],
    cost: null,
    budgetWarning: null,
    doomLoop: null,
  })

  const [input, setInput] = createSignal('')

  // ── WebSocket: GlobalBus subscription ────────────────────────────
  const socket = createSocket({
    open: () => setState('connected', true),
    close: () => setState('connected', false),
    error: () => setState('connected', false),
    event: (e: BusEvent) => handleBusEvent(e),
  })

  // Auto-connect in browser/Bun with WebSocket support; reconnect loop
  if (typeof window !== 'undefined' || typeof WebSocket !== 'undefined') {
    try {
      socket.connect()
    } catch {}
    const iv = setInterval(() => {
      if (!socket.ws || socket.ws.readyState === WebSocket.CLOSED) {
        try {
          socket.connect()
        } catch {}
      }
    }, 3000)
    // solid onCleanup only works inside a reactive root; guard
    try {
      onCleanup(() => clearInterval(iv))
    } catch {
      // ignore outside root
    }
  }

  // ── Debounced loadMessages + incremental patch (P1-8) ────────────
  let loadMessagesTimer: ReturnType<typeof setTimeout> | null = null
  let pendingLoadId: string | null = null

  function scheduleLoadMessages(id: string, immediate = false) {
    if (immediate) {
      if (loadMessagesTimer) {
        clearTimeout(loadMessagesTimer)
        loadMessagesTimer = null
      }
      void loadMessages(id)
      return
    }
    pendingLoadId = id
    if (loadMessagesTimer) return
    loadMessagesTimer = setTimeout(() => {
      loadMessagesTimer = null
      const target = pendingLoadId
      pendingLoadId = null
      if (target) void loadMessages(target)
    }, 250)
  }

  function tryIncrementalPatch(e: BusEvent): boolean {
    const payload = e.payload as Record<string, JsonValue> | null
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
    // part.created / part.updated payload is a Part
    if (e.type === 'part.created' || e.type === 'part.updated') {
      const part = payload as unknown as Part
      if (!part.id || !part.messageID) return false
      // Find message and patch part incrementally
      const msgIdx = state.messages.findIndex((m) => m.id === part.messageID)
      if (msgIdx === -1) return false
      if (e.type === 'part.created') {
        // avoid duplicates
        const exists = state.messages[msgIdx].parts?.some((p) => p.id === part.id)
        if (exists) return true
        setState('messages', msgIdx, 'parts', (prev) => [...(prev ?? []), part])
        return true
      }
      if (e.type === 'part.updated') {
        const partIdx = state.messages[msgIdx].parts?.findIndex((p) => p.id === part.id) ?? -1
        if (partIdx === -1) {
          setState('messages', msgIdx, 'parts', (prev) => [...(prev ?? []), part])
          return true
        }
        setState('messages', msgIdx, 'parts', partIdx, part)
        return true
      }
    }
    if (e.type === 'message.created') {
      const msg = payload as unknown as Message
      if (!msg.id) return false
      const exists = state.messages.some((m) => m.id === msg.id)
      if (exists) return true
      setState('messages', (prev) => [...prev, msg])
      return true
    }
    if (e.type === 'message.updated') {
      const msg = payload as unknown as Message
      if (!msg.id) return false
      const idx = state.messages.findIndex((m) => m.id === msg.id)
      if (idx === -1) return false
      setState('messages', idx, msg)
      return true
    }
    return false
  }

  function handleBusEvent(e: BusEvent) {
    const payload = e.payload as Record<string, JsonValue> | JsonValue[] | null
    switch (e.type) {
      case 'session.created': {
        const s = payload as Session
        if (s?.id) setState('sessions', (prev) => [s, ...prev.filter((x) => x.id !== s.id)])
        break
      }
      case 'session.deleted': {
        const p = payload as Record<string, JsonValue>
        const id = p?.id as string | undefined
        if (!id) break
        setState('sessions', (prev) => prev.filter((s) => s.id !== id))
        if (state.currentId === id) {
          const next = state.sessions[0]?.id ?? null
          setState({ currentId: next, messages: [], todos: [] })
        }
        break
      }
      case 'todo.updated': {
        if (e.sessionID === state.currentId) setState('todos', payload as Todo[])
        break
      }
      case 'message.created':
      case 'message.updated':
      case 'part.created':
      case 'part.updated': {
        if (e.sessionID !== state.currentId) break
        // Try incremental patch first; fall back to debounced full refetch
        if (!tryIncrementalPatch(e)) {
          scheduleLoadMessages(state.currentId!)
        }
        break
      }
      case 'permission.ask': {
        const p = payload as Record<string, JsonValue>
        setState('pendingPermission', {
          toolCallID: (p.toolCallID as string) ?? (p.id as string) ?? uid(),
          tool: (p.tool as string) ?? 'unknown',
          args: (p.args as Record<string, JsonValue>) ?? {},
          sessionID: e.sessionID ?? (p.sessionID as string) ?? state.currentId ?? '',
        })
        break
      }
      case 'question.ask': {
        const q = payload as PendingQuestion
        if (q?.questionID) setState('pendingQuestion', { ...q, sessionID: e.sessionID })
        break
      }
      case 'job.created':
      case 'job.updated':
      case 'job.cancelled': {
        // Refresh queue/jobs view when background task changes
        if (e.sessionID === state.currentId) {
          // Trigger a lightweight refresh — TUI doesn't have job list yet, but keep connected
          setState('error', null)
        }
        break
      }
      case 'learning.updated': {
        // Scheduler patching/online events — surface as transient status
        break
      }
      case 'server.heartbeat': {
        // Keepalive — ensure connected stays true
        setState('connected', true)
        break
      }
      case 'server.error': {
        const p = payload as {
          source?: string
          tool?: string
          error?: string
          pattern?: string[]
        } | null
        if (p?.source === 'doom-loop') {
          setState('doomLoop', {
            tool: p.tool ?? 'unknown',
            reason: p.error ?? 'repeating tool call',
            pattern: p.pattern,
            sessionID: e.sessionID,
          })
        }
        break
      }
      case 'doom_loop': {
        const p = payload as { tool?: string; reason?: string; pattern?: string[] } | null
        setState('doomLoop', {
          tool: p?.tool ?? 'unknown',
          reason: p?.reason ?? 'repeating tool call',
          pattern: p?.pattern,
          sessionID: e.sessionID,
        })
        break
      }
      default:
        break
    }
  }

  // ── REST actions ─────────────────────────────────────────────────

  async function loadSessions() {
    setState({ loading: true, error: null })
    try {
      const sessions = await rpc.listSessions()
      setState('sessions', sessions)
      if (!state.currentId && sessions.length > 0) {
        await selectSession(sessions[0].id)
      }
    } catch (e) {
      setState('error', (e as Error).message)
    } finally {
      setState('loading', false)
    }
  }

  async function createSession(title?: string, model?: string, agent?: string) {
    setState('error', null)
    try {
      const body: Partial<Pick<Session, 'title' | 'model' | 'parentID' | 'agent'>> = {}
      if (title) body.title = title
      if (model) body.model = model
      if (agent) body.agent = agent
      const s = await rpc.createSession(body)
      setState('sessions', (prev) => [s, ...prev])
      await selectSession(s.id)
      return s
    } catch (e) {
      setState('error', (e as Error).message)
      throw e
    }
  }

  async function createSessionWithAgent(
    opts: { title?: string; model?: string; agent?: string } = {},
  ) {
    return createSession(opts.title, opts.model, opts.agent)
  }

  async function selectSession(id: string) {
    // cancel any pending debounced load for previous session
    if (loadMessagesTimer) {
      clearTimeout(loadMessagesTimer)
      loadMessagesTimer = null
      pendingLoadId = null
    }
    setState({
      currentId: id,
      messages: [],
      todos: [],
      streamText: '',
      streamStartAt: null,
      streamEvents: [],
      error: null,
      doomLoop: null,
    })
    await Promise.all([loadMessages(id), loadTodos(id)])
  }

  async function deleteSession(id: string) {
    await rpc.deleteSession(id)
    setState('sessions', (prev) => prev.filter((s) => s.id !== id))
    if (state.currentId === id) {
      const next = state.sessions[0]?.id ?? null
      setState({ currentId: next, messages: [], todos: [] })
      if (next) await selectSession(next)
    }
  }

  async function loadMessages(id: string) {
    try {
      const msgs = await rpc.getMessages(id)
      setState('messages', msgs)
      // Reconcile queue with server truth
      try {
        setState('queued', await rpc.getQueue(id))
      } catch {}
    } catch (e) {
      if (!String((e as Error).message).includes('404')) setState('error', (e as Error).message)
    }
  }

  /** Undo the agent's most recent file mutation — pass messageID to rewind to that message */
  async function undoLast(messageID?: string) {
    if (!state.currentId) return
    try {
      const out = await rpc.revertSession(state.currentId, messageID)
      await loadMessages(state.currentId)
      return out
    } catch (e) {
      setState('error', (e as Error).message)
    }
  }

  async function loadTodos(id: string) {
    try {
      const todos = await rpc.getTodos(id)
      setState('todos', todos)
    } catch {
      // todos optional
    }
  }

  /** Refresh live spend from the gateway (called on mount, after turns, + interval) */
  async function loadCost() {
    try {
      const dev = await rpc.devHealth()
      if (dev.gateway) setState('cost', dev.gateway)
    } catch {}
  }
  loadCost()
  if (typeof window !== 'undefined') {
    type MiraWindow = Window & { __miraCostIv?: ReturnType<typeof setInterval> }
    const w = window as MiraWindow
    if (w.__miraCostIv) clearInterval(w.__miraCostIv)
    const tick = () => {
      if (document.visibilityState === 'visible') void loadCost()
    }
    w.__miraCostIv = setInterval(tick, 15_000)
    document.addEventListener('visibilitychange', tick)
    try {
      onCleanup(() => {
        clearInterval(w.__miraCostIv)
        document.removeEventListener('visibilitychange', tick)
      })
    } catch {}
  }

  // ── Streaming prompt (SSE) ───────────────────────────────────────

  let abort: AbortController | null = null

  async function sendPrompt(text?: string, model?: string) {
    const prompt = (text ?? input()).trim()
    if (!prompt || !state.currentId) return
    setInput('')
    // Agent busy → queue for chained-turn processing (Mira-parity UX)
    if (state.streaming) {
      try {
        await rpc.queuePrompt(state.currentId, prompt)
        setState('queued', (q) => [...q, prompt])
      } catch (e) {
        setState('error', (e as Error).message)
        setInput(prompt)
      }
      return
    }
    const userMsg: Message = {
      id: `tmp-${uid()}`,
      sessionID: state.currentId,
      role: 'user',
      createdAt: Date.now(),
      parts: [
        {
          id: `p-${uid()}`,
          messageID: '',
          sessionID: state.currentId,
          type: 'text',
          text: prompt,
          createdAt: Date.now(),
        } as Part,
      ],
    }
    setState('messages', (m) => [...m, userMsg])
    setState({ streaming: true, streamText: '', streamStartAt: Date.now(), error: null })

    abort?.abort()
    abort = new AbortController()
    const asstId = `asst-${uid()}`
    const asstMsg: Message = {
      id: asstId,
      sessionID: state.currentId,
      role: 'assistant',
      createdAt: Date.now(),
      parts: [
        {
          id: `p-${uid()}`,
          messageID: asstId,
          sessionID: state.currentId,
          type: 'text',
          text: '',
          createdAt: Date.now(),
        } as Part,
      ],
    }
    setState('messages', (m) => [...m, asstMsg])

    try {
      await rpc.streamPrompt(state.currentId, prompt, {
        model,
        signal: abort.signal,
        onEvent: (event, data) => {
          const d = data as Record<string, JsonValue>
          setState('streamEvents', (ev) => [...ev, { type: event, data, at: Date.now() }])

          if (event === 'text_delta') {
            const delta = (d.delta as string) ?? (d.text as string) ?? (d.content as string) ?? ''
            if (delta) {
              setState('streamText', (t) => t + String(delta))
              setState('messages', (msgs) =>
                msgs.map((mm) =>
                  mm.id === asstId
                    ? {
                        ...mm,
                        parts: (mm.parts ?? []).map((p) =>
                          p.type === 'text' ? { ...p, text: (p.text ?? '') + String(delta) } : p,
                        ),
                      }
                    : mm,
                ),
              )
            }
          } else if (event === 'tool_call' || event === 'tool_execute') {
            const tool = (d.tool as string) ?? (d.name as string) ?? 'tool'
            const toolCallID = (d.toolCallID as string) ?? (d.id as string) ?? uid()
            setState('messages', (msgs) =>
              msgs.map((mm) =>
                mm.id === asstId
                  ? {
                      ...mm,
                      parts: [
                        ...(mm.parts ?? []),
                        {
                          id: `p-${uid()}`,
                          messageID: asstId,
                          sessionID: state.currentId!,
                          type: 'tool-call',
                          tool,
                          toolCallID,
                          args:
                            (d.args as Record<string, JsonValue>) ??
                            (d.input as Record<string, JsonValue>) ??
                            {},
                          createdAt: Date.now(),
                        } as Part,
                      ],
                    }
                  : mm,
              ),
            )
          } else if (event === 'tool_result') {
            const tool = (d.tool as string) ?? (d.name as string) ?? 'tool'
            const toolCallID = (d.toolCallID as string) ?? (d.id as string) ?? ''
            setState('messages', (msgs) =>
              msgs.map((mm) =>
                mm.id === asstId
                  ? {
                      ...mm,
                      parts: [
                        ...(mm.parts ?? []),
                        {
                          id: `p-${uid()}`,
                          messageID: asstId,
                          sessionID: state.currentId!,
                          type: 'tool-result',
                          tool,
                          toolCallID,
                          result: (d.result as JsonValue) ?? (d.output as JsonValue) ?? data,
                          isError: Boolean(d.isError),
                          createdAt: Date.now(),
                        } as Part,
                      ],
                    }
                  : mm,
              ),
            )
          } else if (event === 'permission_ask') {
            setState('pendingPermission', {
              toolCallID: (d.toolCallID as string) ?? (d.id as string) ?? uid(),
              tool: (d.tool as string) ?? 'unknown',
              args: (d.args as Record<string, JsonValue>) ?? {},
              sessionID: state.currentId!,
            })
          }
        },
      })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setState('error', (e as Error).message)
    } finally {
      setState({ streaming: false, streamText: '', streamStartAt: null })
      if (state.currentId) await loadMessages(state.currentId)
      void loadCost()
    }
  }

  function stopStream() {
    abort?.abort()
    setState({ streaming: false, streamStartAt: null })
  }

  // ── Permission reply (WS → GlobalBus) ────────────────────────────

  function replyPermission(decision: 'allow' | 'deny') {
    const p = state.pendingPermission
    if (!p) return
    socket.send({
      type: 'permission.reply',
      sessionID: p.sessionID,
      payload: { toolCallID: p.toolCallID, decision, action: decision },
      timestamp: Date.now(),
    })
    setState('pendingPermission', null)
  }

  function dismissPermission() {
    replyPermission('deny')
  }

  function clearError() {
    setState('error', null)
  }

  function setBudgetWarning(msg: string | null) {
    setState('budgetWarning', msg)
  }
  function clearBudgetWarning() {
    setState('budgetWarning', null)
  }
  function clearDoomLoop() {
    setState('doomLoop', null)
  }
  async function rewindDoomLoop() {
    await undoLast()
    clearDoomLoop()
  }

  // ── Question reply (WS → GlobalBus) ───────────────────────────────

  function answerQuestion(answers: Array<{ header: string; selections: string[] }>) {
    const q = state.pendingQuestion
    if (!q) return
    const payload: Record<string, JsonValue> = {
      questionID: q.questionID,
      answers: answers as JsonValue,
    }
    const msg: Record<string, JsonValue> = {
      type: 'question.reply',
      payload,
      timestamp: Date.now(),
    }
    const sid = q.sessionID ?? state.currentId
    if (sid) msg.sessionID = sid
    socket.send(msg as JsonValue)
    setState('pendingQuestion', null)
  }

  return {
    state,
    input,
    setInput,
    socket,
    // state mutators
    setBudgetWarning,
    clearBudgetWarning,
    clearDoomLoop,
    rewindDoomLoop,
    // actions
    loadSessions,
    createSession,
    createSessionWithAgent,
    selectSession,
    deleteSession,
    loadMessages,
    loadTodos,
    loadCost,
    sendPrompt,
    stopStream,
    replyPermission,
    dismissPermission,
    answerQuestion,
    undoLast,
    clearError,
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>
