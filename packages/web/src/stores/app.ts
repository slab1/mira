// @ts-nocheck
/**
 * Mira App Store — SolidJS reactive state for the web client.
 *
 * Single source of truth for sessions / messages / todos / streaming.
 * Server is source of truth; store mirrors it and drives optimistic UI.
 */

import { createSignal, createEffect } from 'solid-js'
import { createStore } from 'solid-js/store'
import {
  api,
  addPermissionRule,
  ApiError,
  createSocket,
  type Session,
  type Message,
  type Todo,
  type Job,
  type BusEvent,
  type PendingPermission,
} from '../api/client'
import { isStale } from '../state/reconciliation'
import { toast } from '../components/Toast'

type AppState = {
  sessions: Session[]
  currentId: string | null
  messages: Message[]
  todos: Todo[]
  streaming: boolean
  streamText: string
  connected: boolean
  error: string | null
  loading: boolean
  pendingQuestion: {
    questionID: string
    questions: Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string }>
      multiple?: boolean
    }>
  } | null
  /** pending tool approval requests awaiting user allow/deny */
  pendingPermissions: PendingPermission[]
  /** messages queued while agent streams — mirrored from server */
  queued: string[]
  /** gateway spend for this server process */
  cost: {
    requests: number
    inputTokens: number
    outputTokens: number
    costUSD: number
    avgLatencyMs: number
  } | null
  /** doom-loop detection — set when server publishes server.error source doom-loop */
  doomLoop: {
    tool: string
    reason: string
    pattern?: string[]
    sessionID?: string
    messageID?: string
  } | null
  /** budget cap warning — set when spend exceeds configured cap */
  budgetWarning: string | null
  /** cost cap from config.costCap (perSession/perTask) — wired to gateway */
  costCap: { perSession?: number; perTask?: number } | null
  /** live streaming SSE events (step_start, tool_call, text_delta, etc.) for real-time activity panel */
  liveStreamEvents: Array<{
    type: string
    payload: Record<string, unknown>
    timestamp: number
  }>
  /** live job patches from BusEvent stream (job.created / job.updated / job.cancelled) */
  liveJobs: Record<string, Partial<Job>>
}

function uid() {
  return Math.random().toString(36).slice(2, 9)
}

export function createAppStore(
  apiClient: typeof api = api,
  socketFactory: typeof createSocket = createSocket,
) {
  const [state, setState] = createStore<AppState>({
    sessions: [],
    currentId: null,
    messages: [],
    todos: [],
    streaming: false,
    streamText: '',
    connected: false,
    error: null,
    loading: false,
    pendingQuestion: null,
    pendingPermissions: [],
    queued: [],
    cost: null,
    doomLoop: null,
    budgetWarning: null,
    costCap: null,
    liveStreamEvents: [],
    liveJobs: {},
  })

  const [input, setInput] = createSignal('')

  // ── Extra BusEvent listeners ──────────────────────────────────────
  // Pages that need events the store itself doesn't own (Mission Control
  // watches session.* / job.* for EVERY session, not just the current one)
  // subscribe here so they share this single authenticated + reconnecting
  // socket instead of opening a second WebSocket.
  const busListeners = new Set<(e: BusEvent) => void>()
  function subscribeBus(fn: (e: BusEvent) => void): () => void {
    busListeners.add(fn)
    return () => {
      busListeners.delete(fn)
    }
  }

  // Guard against concurrent session creates (race: user clicks "+" while
  // loadSessions auto-creates the first session, leading to two entries).
  let creating = false
  // Monotonic sequence counter for selectSession so stale async fetches
  // from a previously clicked session never overwrite a newer selection.
  let selectSeq = 0
  const CURRENT_SESSION_KEY = 'mira.currentSessionId'
  const persistCurrentId = (id: string | null) => {
    try {
      if (id) localStorage.setItem(CURRENT_SESSION_KEY, id)
      else localStorage.removeItem(CURRENT_SESSION_KEY)
    } catch {}
  }
  const savedCurrentId = (): string | null => {
    try {
      return localStorage.getItem(CURRENT_SESSION_KEY) || null
    } catch {
      return null
    }
  }

  type ActiveStream = {
    controller: AbortController
    text: string
    events: AppState['liveStreamEvents']
    assistantId: string
  }
  const streams = new Map<string, ActiveStream>()

  // ── WebSocket: GlobalBus subscription ────────────────────────────
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // Exponential backoff reconnect (1s → 2s → 4s … capped at 30s) instead of a
  // fixed 3s interval — avoids thundering-herd reconnect storms on server recovery.
  function scheduleReconnect() {
    if (reconnectTimer) return
    if (!socket.ws || socket.ws.readyState !== WebSocket.CLOSED) return
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 30_000)
    reconnectAttempts += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      socket.connect()
    }, delay)
  }

  const socket = socketFactory({
    open: () => {
      setState('connected', true)
      reconnectAttempts = 0
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (state.currentId) void loadPendingPermissions(state.currentId)
    },
    close: () => {
      setState('connected', false)
      scheduleReconnect()
    },
    error: () => {
      setState('connected', false)
      scheduleReconnect()
    },
    event: (e: BusEvent) => handleBusEvent(e),
  })

  function upsertPendingPermission(perm: PendingPermission) {
    if (!perm?.toolCallID || !perm?.nonce) return
    setState('pendingPermissions', (prev) => {
      const filtered = prev.filter((p) => p.toolCallID !== perm.toolCallID)
      return [...filtered, perm]
    })
  }

  function removePendingPermission(toolCallID: string) {
    if (!toolCallID) return
    setState('pendingPermissions', (prev) => prev.filter((p) => p.toolCallID !== toolCallID))
  }

  async function loadPendingPermissions(sessionID?: string, expectedSeq?: number) {
    try {
      const res = await apiClient.listPendingPermissions?.(sessionID)
      if (expectedSeq !== undefined && expectedSeq !== selectSeq) return
      const list = Array.isArray(res?.pending) ? res.pending : []
      if (!sessionID || sessionID === state.currentId) {
        setState('pendingPermissions', list)
      }
    } catch {
      // Older servers or transient errors — non-fatal
    }
  }

  function handleBusEvent(e: BusEvent) {
    // Reconciliation guard — flag stale events that may have been
    // out-of-sync across REST/WebSocket/polling sources.
    if (isStale(e.timestamp)) {
      console.warn(`[realtime] stale event '${e.type}' detected at timestamp ${e.timestamp}`)
    }
    switch (e.type) {
      case 'question.ask': {
        if (e.sessionID && state.currentId && e.sessionID !== state.currentId) break
        const q = e.payload as AppState['pendingQuestion']
        if (q?.questionID) setState('pendingQuestion', q)
        break
      }
      case 'permission.ask': {
        const p = e.payload as Partial<PendingPermission> | null
        const sid = p?.sessionID ?? e.sessionID ?? state.currentId ?? ''
        if (p?.toolCallID && p?.nonce && (!state.currentId || !sid || sid === state.currentId)) {
          upsertPendingPermission({
            sessionID: sid,
            toolCallID: p.toolCallID,
            tool: p.tool ?? 'tool',
            args: p.args,
            nonce: p.nonce,
            reason: p.reason,
            risk: p.risk,
            blastRadius: p.blastRadius,
            canUndo: p.canUndo,
            timeoutMs: p.timeoutMs,
            expiresAt: p.expiresAt,
          })
        }
        break
      }
      case 'permission.reply': {
        const p = e.payload as { toolCallID?: string } | null
        if (p?.toolCallID) removePendingPermission(p.toolCallID)
        break
      }
      case 'permission.timeout': {
        const p = e.payload as { toolCallID?: string; tool?: string } | null
        if (p?.toolCallID) removePendingPermission(p.toolCallID)
        break
      }
      case 'session.created': {
        const s = e.payload as Session
        if (s?.id) setState('sessions', (prev) => [s, ...prev.filter((x) => x.id !== s.id)])
        break
      }
      case 'session.updated': {
        const s = e.payload as Session
        if (s?.id) {
          setState('sessions', (prev) =>
            prev.some((x) => x.id === s.id)
              ? prev.map((x) => (x.id === s.id ? { ...x, ...s } : x))
              : [s, ...prev],
          )
        }
        break
      }
      case 'session.deleted': {
        const { id } = e.payload as { id: string }
        const remaining = state.sessions.filter((s) => s.id !== id)
        setState('sessions', remaining)
        if (state.currentId === id) {
          persistCurrentId(null)
          const next = remaining[0]?.id ?? null
          if (next) {
            void selectSession(next)
          } else {
            setState({
              currentId: null,
              messages: [],
              todos: [],
              queued: [],
              pendingQuestion: null,
              pendingPermissions: [],
              streamText: '',
              streaming: false,
              liveStreamEvents: [],
            })
          }
        }
        break
      }
      case 'todo.updated': {
        if (e.sessionID === state.currentId) setState('todos', e.payload as Todo[])
        break
      }
      case 'job.created': {
        if (e.sessionID !== state.currentId) break
        const p = e.payload as { jobID?: string; agent?: string; title?: string } | null
        if (p?.jobID) {
          setState('liveJobs', p.jobID, {
            id: p.jobID,
            agent: p.agent ?? null,
            prompt: p.title ?? '',
            status: 'running',
          })
        }
        break
      }
      case 'job.updated': {
        if (e.sessionID !== state.currentId) break
        const p = e.payload as {
          jobID?: string
          status?: string
          childSessionID?: string
          preview?: string
        } | null
        if (p?.jobID) {
          const existing = state.liveJobs[p.jobID] ?? {}
          const patch: Partial<Job> = { ...existing, id: p.jobID }
          if (p.status) patch.status = p.status as Job['status']
          if (p.childSessionID) patch.childSessionID = p.childSessionID
          if (p.preview) patch.result = p.preview
          setState('liveJobs', p.jobID, patch)
        }
        break
      }
      case 'job.cancelled': {
        if (e.sessionID !== state.currentId) break
        const p = e.payload as { jobID?: string } | null
        if (p?.jobID) {
          const existing = state.liveJobs[p.jobID] ?? {}
          setState('liveJobs', p.jobID, { ...existing, status: 'cancelled' as const })
        }
        break
      }
      case 'message.created':
      case 'message.updated': {
        // server can push new parts incrementally
        // fall back to reload messages for simplicity
        if (e.sessionID === state.currentId) void loadMessages(state.currentId!)
        break
      }
      case 'server.error': {
        const p = e.payload as {
          source?: string
          tool?: string
          error?: string
          pattern?: string[]
          messageID?: string
        } | null
        if (p?.source === 'doom-loop') {
          setState('doomLoop', {
            tool: p.tool ?? 'unknown',
            reason: p.error ?? 'repeating tool call',
            pattern: p.pattern,
            sessionID: e.sessionID,
            messageID: typeof p.messageID === 'string' ? p.messageID : undefined,
          })
        }
        break
      }
      case 'doom_loop': {
        const p = e.payload as {
          tool?: string
          reason?: string
          pattern?: string[]
          messageID?: string
        } | null
        setState('doomLoop', {
          tool: p?.tool ?? 'unknown',
          reason: p?.reason ?? 'repeating tool call',
          pattern: p?.pattern,
          sessionID: e.sessionID,
          messageID: typeof p?.messageID === 'string' ? p.messageID : undefined,
        })
        break
      }
      case 'cost.warning': {
        const p = e.payload as {
          currentUSD?: number
          capUSD?: number
          pct?: number
        } | null
        if (p && typeof p.currentUSD === 'number' && typeof p.capUSD === 'number') {
          const pct = p.pct ?? Math.round((p.currentUSD / p.capUSD) * 100)
          setState('budgetWarning', `Cost $${p.currentUSD.toFixed(4)} / $${p.capUSD} (${pct}%)`)
        }
        break
      }
    }
    // Fan out to page-level subscribers (Mission Control live cockpit) —
    // never let a listener's throw break the store's own handling.
    for (const fn of busListeners) {
      try {
        fn(e)
      } catch (err) {
        console.warn('[mira] bus listener error', err)
      }
    }
  }

  // ── REST actions ─────────────────────────────────────────────────
  async function loadSessions() {
    setState('loading', true)
    setState('error', null)
    try {
      let sessions = await apiClient.listSessions()
      // First-run UX: land straight into a usable chat.
      // Skip if a session was just created (race with createSession guard).
      if (sessions.length === 0 && !state.currentId && !creating) {
        await createSession('New chat')
        sessions = await apiClient.listSessions()
      }
      setState('sessions', sessions)
      // Restore previously selected session if still present; otherwise fall back to first session
      const currentValid = !!state.currentId && sessions.some((s) => s.id === state.currentId)
      if (!currentValid && sessions.length > 0) {
        const saved = savedCurrentId()
        const target =
          saved && sessions.some((s) => s.id === saved) ? saved : sessions[0].id
        await selectSession(target)
      } else if (!currentValid && sessions.length === 0) {
        persistCurrentId(null)
        setState('currentId', null)
      }
    } catch (e) {
      setState('error', (e as Error).message)
    } finally {
      setState('loading', false)
    }
  }

  async function createSession(
    title?: string,
    opts: { agent?: string; cwd?: string; projectId?: string; parentID?: string } = {},
  ) {
    if (creating) return null
    creating = true
    setState('error', null)
    try {
      const body: Record<string, string> = {}
      if (title) body.title = title
      if (opts.agent) body.agent = opts.agent
      if (opts.cwd) body.cwd = opts.cwd
      if (opts.projectId) body.projectId = opts.projectId
      if (opts.parentID) body.parentID = opts.parentID
      const s = await apiClient.createSession(body)
      setState('sessions', (prev) => [s, ...prev.filter((x) => x.id !== s.id)])
      await selectSession(s.id)
      return s
    } catch (e) {
      setState('error', (e as Error).message)
      throw e
    } finally {
      creating = false
    }
  }

  async function forkSession(
    messageID?: string,
    title?: string,
    opts?: { branchKind?: string; hypothesisLabel?: string },
  ) {
    const id = state.currentId
    if (!id) return null
    try {
      const res = await apiClient.forkSession(id, {
        messageID,
        title,
        branchKind: opts?.branchKind,
        hypothesisLabel: opts?.hypothesisLabel,
      })
      const forked = res.session
      if (forked?.id) {
        setState('sessions', (prev) => [forked, ...prev.filter((x) => x.id !== forked.id)])
        await selectSession(forked.id)
        return forked
      }
      await loadSessions()
      if (res.id) await selectSession(res.id)
      return null
    } catch (e) {
      setState('error', (e as Error).message)
      throw e
    }
  }

  async function selectSession(id: string) {
    if (!id) return
    const seq = ++selectSeq
    persistCurrentId(id)
    const active = streams.get(id)
    setState({
      currentId: id,
      messages: [],
      todos: [],
      queued: [],
      pendingQuestion: null,
      streaming: Boolean(active),
      streamText: active?.text ?? '',
      error: null,
      doomLoop: null,
      budgetWarning: null,
      liveJobs: {},
      liveStreamEvents: active?.events ?? [],
      pendingPermissions: [],
    })
    await Promise.all([
      loadMessages(id, seq),
      loadTodos(id, seq),
      loadPendingPermissions(id, seq),
    ])
  }

  async function deleteSession(id: string) {
    await apiClient.deleteSession(id)
    const remaining = state.sessions.filter((s) => s.id !== id)
    setState('sessions', remaining)
    if (state.currentId === id) {
      persistCurrentId(null)
      const next = remaining[0]?.id ?? null
      if (next) {
        await selectSession(next)
      } else {
        setState({
          currentId: null,
          messages: [],
          todos: [],
          queued: [],
          pendingQuestion: null,
          pendingPermissions: [],
          streamText: '',
          streaming: false,
          liveStreamEvents: [],
        })
      }
    }
  }

  async function loadMessages(id: string, expectedSeq?: number) {
    try {
      const msgs = await apiClient.getMessages(id)
      if (state.currentId !== id || (expectedSeq !== undefined && expectedSeq !== selectSeq)) return
      if (Array.isArray(msgs) && msgs.length > 0) {
        setState('messages', msgs)
      } else if (state.messages.length === 0 && Array.isArray(msgs)) {
        setState('messages', msgs)
      }
      // Reconcile queue with server truth (queued items drain as chained turns)
      try {
        const q = await apiClient.getQueue(id)
        if (state.currentId !== id || (expectedSeq !== undefined && expectedSeq !== selectSeq)) return
        setState('queued', q)
      } catch {}
    } catch (e) {
      if (state.currentId !== id || (expectedSeq !== undefined && expectedSeq !== selectSeq)) return
      // 404 = new session, ignore
      if (!String((e as Error).message).includes('404')) {
        setState('error', (e as Error).message)
      }
    }
  }

  /** Refresh live spend from the gateway (called on mount, after turns, + interval) */
  async function loadCost() {
    try {
      const dev = await apiClient.devHealth()
      if (dev.gateway) setState('cost', dev.gateway)
    } catch {}
    // Also refresh per-session cost for current session + costCap from config
    try {
      const cfg = await apiClient.getConfig()
      if (cfg.costCap) setState('costCap', cfg.costCap)
    } catch {}
    // Refresh current session's costUsd/tokens without full list reload
    if (state.currentId) {
      try {
        const sess = await apiClient.getSession(state.currentId)
        if (sess) {
          setState('sessions', (prev) =>
            prev.map((s) =>
              s.id === sess.id
                ? {
                    ...s,
                    costUsd: sess.costUsd,
                    tokensIn: sess.tokensIn,
                    tokensOut: sess.tokensOut,
                  }
                : s,
            ),
          )
        }
      } catch {}
    }
  }
  loadCost()
  // Pause the interval when the page is hidden to avoid wasted polls + HMR leaks.
  // Use a sentinel that survives HMR via window-level tracking.
  if (typeof window !== 'undefined') {
    type MiraWindow = Window & { __miraCostIv?: ReturnType<typeof setInterval> }
    const w = window as MiraWindow
    if (w.__miraCostIv) clearInterval(w.__miraCostIv)
    const tick = () => {
      if (document.visibilityState === 'visible') void loadCost()
    }
    w.__miraCostIv = setInterval(tick, 15_000)
    document.addEventListener('visibilitychange', tick)
  }

  async function loadTodos(id: string, expectedSeq?: number) {
    try {
      const todos = await apiClient.getTodos(id)
      if (state.currentId !== id || (expectedSeq !== undefined && expectedSeq !== selectSeq)) return
      setState('todos', todos)
    } catch {
      // todos optional
    }
  }

  // Keep messages in sync when currentId changes via effect
  createEffect(() => {
    const id = state.currentId
    if (id) {
      // already loaded in selectSession; no-op to avoid double fetch
    }
  })

  /** Send a prompt — `model` is a per-message override for this send only. */
  async function sendPrompt(text?: string, model?: string) {
    const prompt = (text ?? input()).trim()
    if (!prompt) return
    if (!state.currentId) {
      try {
        const newSess = await createSession('New Chat')
        if (!newSess) return
      } catch (e) {
        toast.error(`Failed to create chat session: ${(e as Error).message}`)
        return
      }
    }
    const sessionId = state.currentId
    if (!sessionId) return
    setInput('')

    // Agent busy → queue the message instead of dropping it (Mira-parity UX)
    if (streams.has(sessionId)) {
      const startSeq = selectSeq
      try {
        const result = await apiClient.queuePrompt(sessionId, prompt)
        if (state.currentId !== sessionId || selectSeq !== startSeq) return
        setState('queued', (q) => [...q, prompt])
        setState('messages', (m) => [
          ...m,
          {
            id: `tmp-${uid()}`,
            sessionId,
            role: 'user',
            content: `${prompt}`,
            createdAt: new Date().toISOString(),
            queued: true,
          },
        ])
        toast.info(`Queued (#${result.position})`)
        // Reconcile queue with server in case server-side ordering differs
        try {
          const serverQueue = await apiClient.getQueue(sessionId)
          if (state.currentId !== sessionId || selectSeq !== startSeq) return
          setState('queued', serverQueue)
          // If our prompt didn't make it to the queue, surface the failure
          if (!serverQueue.includes(prompt)) {
            toast.warn('Queued message may not have been accepted by the server')
            setInput(prompt) // restore so the user can retry
          }
        } catch {}
      } catch (e) {
        if (state.currentId === sessionId) {
          setState('error', (e as Error).message)
          setInput(prompt) // restore input on failure
        }
        toast.error(`Queue failed: ${(e as Error).message}`)
      }
      return
    }
    // optimistic user message
    const userMsg: Message = {
      id: `tmp-${uid()}`,
      sessionId,
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
    }
    setState('messages', (m) => [...m, userMsg])
    setState({ streaming: true, streamText: '', error: null, liveStreamEvents: [] })
    const controller = new AbortController()

    // placeholder assistant message that we append to live
    const asstId = `asst-${uid()}`
    const stream: ActiveStream = { controller, text: '', events: [], assistantId: asstId }
    streams.set(sessionId, stream)
    setState('messages', (m) => [
      ...m,
      {
        id: asstId,
        sessionId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      },
    ])

    try {
      await apiClient.streamPrompt(sessionId, prompt, {
        model,
        signal: controller.signal,
        onChunk: (chunk) => {
          if (streams.get(sessionId) !== stream) return
          stream.text += chunk
          if (state.currentId !== sessionId) return
          setState('streamText', (t) => t + chunk)
          // O(1) in-place update of the streaming assistant message (always last)
          const msgs = state.messages
          const idx = msgs.length - 1
          const last = msgs[idx]
          if (last && last.id === asstId) {
            setState('messages', idx, 'content', (last.content || '') + chunk)
          }
        },
        onEvent: (event) => {
          if (streams.get(sessionId) !== stream) return
          // Push live streaming events for the activity panel
          const streamEvent = {
            type: event.type,
            payload: event.payload as Record<string, unknown>,
            timestamp: Date.now(),
          }
          stream.events = [...stream.events, streamEvent]
          if (state.currentId !== sessionId) return
          setState('liveStreamEvents', stream.events)
          if (event.type === 'error') {
            const raw = event.payload as unknown
            let msg: string
            if (typeof raw === 'string') msg = raw
            else if (raw && typeof raw === 'object') {
              const p = raw as Record<string, unknown>
              const cand = (p.error ?? p.message) as unknown
              if (typeof cand === 'string' && cand) msg = cand
              else {
                try {
                  msg = JSON.stringify(raw)
                } catch {
                  msg = String(raw)
                }
              }
            } else msg = String(raw ?? 'Unknown error')
            if (!msg) msg = 'Unknown error'
            setState('error', msg)
            const banner = `⚠️ ${msg}`
            setState('messages', (msgs) =>
              msgs.map((mm) => {
                if (mm.id !== asstId) return mm
                const cur = mm.content || ''
                if (cur.includes(banner)) return mm
                return { ...mm, content: cur ? `${cur}\n\n${banner}` : banner }
              }),
            )
          } else if (event.type === 'permission_ask') {
            const p = event.payload as Partial<PendingPermission> | null
            if (p?.toolCallID && p?.nonce) {
              upsertPendingPermission({
                sessionID: p.sessionID ?? sessionId,
                toolCallID: p.toolCallID,
                tool: p.tool ?? 'tool',
                args: p.args,
                nonce: p.nonce,
                reason: p.reason,
                risk: p.risk,
                blastRadius: p.blastRadius,
                canUndo: p.canUndo,
                timeoutMs: p.timeoutMs,
                expiresAt: p.expiresAt,
              })
            }
          } else if (event.type === 'permission_timeout') {
            const p = event.payload as { toolCallID?: string; tool?: string } | null
            if (p?.toolCallID) removePendingPermission(p.toolCallID)
            toast.warn(`Permission request for "${p?.tool ?? 'tool'}" timed out`)
          } else if (event.type === 'tool_result') {
            const p = event.payload as { toolCallID?: string } | null
            if (p?.toolCallID) removePendingPermission(p.toolCallID)
          } else if (event.type === 'doom_loop') {
            const p = event.payload as Record<string, unknown> | null
            if (!state.doomLoop) {
              setState('doomLoop', {
                tool: (p?.tool as string) ?? 'unknown',
                reason: (p?.reason as string) ?? 'repeating tool call',
                pattern: p?.pattern as string[] | undefined,
                sessionID: sessionId,
                messageID: typeof p?.messageID === 'string' ? (p?.messageID as string) : undefined,
              })
            }
            // Optional banner so SSE doom_loop is visible even before bus event
            const reason = (p?.reason as string) ?? 'repeating tool call'
            const tool = (p?.tool as string) ?? 'unknown'
            const banner = `⚠️ Doom-loop detected: ${reason} — tool "${tool}"`
            setState('messages', (msgs) =>
              msgs.map((mm) => {
                if (mm.id !== asstId) return mm
                const cur = mm.content || ''
                if (cur.includes(banner)) return mm
                return { ...mm, content: cur ? `${cur}\n\n${banner}` : banner }
              }),
            )
          } else if (event.type === 'doom_loop_adjusted') {
            const p = event.payload as { tool?: string; reason?: string } | null
            const tool = p?.tool ?? 'tool'
            const reason = p?.reason ?? 'repeating pattern'
            toast.info(`Loop detected (${reason}) on "${tool}" — agent adjusting strategy`)
          }
        },
      })
    } catch (e) {
      if (
        streams.get(sessionId) === stream &&
        state.currentId === sessionId &&
        (e as Error).name !== 'AbortError'
      )
        setState('error', (e as Error).message)
    } finally {
      if (streams.get(sessionId) === stream) {
        streams.delete(sessionId)
        if (state.currentId === sessionId)
          setState({ streaming: false, streamText: '', liveStreamEvents: [] })
      }
      // final sync from server to get tool parts / persisted state + fresh spend
      if (!streams.has(sessionId)) await loadMessages(sessionId)
      void loadCost()
    }
  }

  function stopStream() {
    const id = state.currentId
    if (id) void apiClient.abortPrompt?.(id)?.catch(() => {})
    const stream = id ? streams.get(id) : undefined
    stream?.controller.abort()
    if (id && stream) streams.delete(id)
    setState({ streaming: false, streamText: '', liveStreamEvents: [] })
  }

  /** Answer a pending HITL question (question.ask → question.reply over WS) */
  function answerQuestion(
    questionID: string,
    answers: Array<{ header: string; selections: string[] }>,
  ) {
    socket.send({ type: 'question.reply', payload: { questionID, answers }, timestamp: Date.now() })
    setState('pendingQuestion', null)
  }

  /** Answer a pending tool permission gate via WS + REST fallback */
  async function answerPermission(
    toolCallID: string,
    nonce: string,
    decision: 'allow' | 'deny',
    opts?: { alwaysAllowTool?: string },
  ) {
    removePendingPermission(toolCallID)
    socket.send({
      type: 'permission.reply',
      payload: { toolCallID, nonce, decision },
      timestamp: Date.now(),
    })
    try {
      await apiClient.replyPermission({ toolCallID, nonce, decision })
    } catch {
      // WS reply may have already resolved and cleared the waiter
    }
    if (decision === 'allow' && opts?.alwaysAllowTool) {
      try {
        await addPermissionRule(opts.alwaysAllowTool, '*', 'allow')
        toast.success(`Always allowing "${opts.alwaysAllowTool}"`)
      } catch (e) {
        toast.warn(`Allowed once, but failed to persist rule: ${(e as Error).message}`)
      }
    }
  }

  /** Undo the agent's most recent file mutation (snapshot restore) */
  async function undoLastMutation(messageID?: string) {
    const id = state.currentId
    if (!id) return
    try {
      // NOTE: req() throws ApiError on non-2xx, so a returned `!ok` is unreachable —
      // server 400s (e.g. unknown messageID) surface via the catch branch below.
      const out = await apiClient.revertSession(id, messageID)
      if (out.ok && out.reverted > 0) {
        await loadMessages(id)
        const extra =
          typeof out.messagesDeleted === 'number' && out.messagesDeleted > 0
            ? ` (${out.messagesDeleted} message${out.messagesDeleted === 1 ? '' : 's'} deleted)`
            : ''
        toast.success(`Reverted ${out.reverted} change${out.reverted === 1 ? '' : 's'}${extra}`)
      } else if (out.ok) {
        toast.info('Nothing to undo')
      }
      return out
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        let detail = e.message
        try {
          const j = JSON.parse(e.body) as { error?: string }
          if (typeof j.error === 'string' && j.error) detail = j.error
        } catch {}
        toast.warn(detail)
        return
      }
      toast.error(`Undo failed: ${(e as Error).message}`)
    }
  }

  function clearDoomLoop() {
    setState('doomLoop', null)
  }

  async function rewindDoomLoop() {
    await undoLastMutation(state.doomLoop?.messageID)
    clearDoomLoop()
  }

  async function updateSession(
    id: string,
    patch: Partial<{ title: string; model: string; agent: string }>,
  ) {
    try {
      const updated = await apiClient.updateSession(id, patch)
      setState('sessions', (prev) => prev.map((s) => (s.id === id ? { ...s, ...updated } : s)))
      return updated
    } catch (e) {
      toast.error(`Failed to update session: ${(e as Error).message}`)
    }
  }

  return {
    state,
    input,
    setInput,
    socket,
    // state mutators
    setError: (msg: string | null) => setState('error', msg),
    clearError: () => setState('error', null),
    setBudgetWarning: (msg: string | null) => setState('budgetWarning', msg),
    clearBudgetWarning: () => setState('budgetWarning', null),
    /** Subscribe to the shared WebSocket BusEvent stream (returns unsubscribe). */
    subscribeBus,
    // actions
    loadSessions,
    createSession,
    forkSession,
    selectSession,
    updateSession,
    deleteSession,
    loadMessages,
    loadTodos,
    sendPrompt,
    stopStream,
    answerQuestion,
    answerPermission,
    loadPendingPermissions,
    undoLastMutation,
    clearDoomLoop,
    rewindDoomLoop,
  }
}

export type AppStore = ReturnType<typeof createAppStore>
