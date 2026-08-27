/**
 * Mira Session Store — SolidJS reactive store for TUI
 *
 * Single source of truth for sessions / messages / todos / streaming / permissions.
 * Server is source of truth; store mirrors it + drives optimistic UI.
 * Event-driven via WebSocket (GlobalBus), no polling.
 */

import { createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { rpc, createSocket, type Session, type Message, type Todo, type BusEvent, type Part, type JsonValue } from "../rpc/client"

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
  streamEvents: StreamEvent[]
  connected: boolean
  loading: boolean
  error: string | null
  pendingPermission: PendingPermission | null
  pendingQuestion: PendingQuestion | null
  queued: string[]
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
    streamText: "",
    streamEvents: [],
    connected: false,
    loading: false,
    error: null,
    pendingPermission: null,
    pendingQuestion: null,
    queued: [],
  })

  const [input, setInput] = createSignal("")

  // ── WebSocket: GlobalBus subscription ────────────────────────────
  const socket = createSocket({
    open: () => setState("connected", true),
    close: () => setState("connected", false),
    error: () => setState("connected", false),
    event: (e: BusEvent) => handleBusEvent(e),
  })

  // Auto-connect in browser/Bun with WebSocket support; reconnect loop
  if (typeof window !== "undefined" || typeof WebSocket !== "undefined") {
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

  function handleBusEvent(e: BusEvent) {
    const payload = e.payload as Record<string, JsonValue> | JsonValue[] | null
    switch (e.type) {
      case "session.created": {
        const s = payload as Session
        if (s?.id) setState("sessions", (prev) => [s, ...prev.filter((x) => x.id !== s.id)])
        break
      }
      case "session.deleted": {
        const p = payload as Record<string, JsonValue>
        const id = p?.id as string | undefined
        if (!id) break
        setState("sessions", (prev) => prev.filter((s) => s.id !== id))
        if (state.currentId === id) {
          const next = state.sessions[0]?.id ?? null
          setState({ currentId: next, messages: [], todos: [] })
        }
        break
      }
      case "todo.updated": {
        if (e.sessionID === state.currentId) setState("todos", payload as Todo[])
        break
      }
      case "message.created":
      case "message.updated":
      case "part.created":
      case "part.updated": {
        if (e.sessionID === state.currentId) void loadMessages(state.currentId!)
        break
      }
      case "permission.ask": {
        const p = payload as Record<string, JsonValue>
        setState("pendingPermission", {
          toolCallID: (p.toolCallID as string) ?? (p.id as string) ?? uid(),
          tool: (p.tool as string) ?? "unknown",
          args: (p.args as Record<string, JsonValue>) ?? {},
          sessionID: e.sessionID ?? (p.sessionID as string) ?? state.currentId ?? "",
        })
        break
      }
      case "question.ask": {
        const q = payload as PendingQuestion
        if (q?.questionID) setState("pendingQuestion", { ...q, sessionID: e.sessionID })
        break
      }
      case "job.created":
      case "job.updated":
      case "job.cancelled": {
        // Refresh queue/jobs view when background task changes
        if (e.sessionID === state.currentId) {
          // Trigger a lightweight refresh — TUI doesn't have job list yet, but keep connected
          setState("error", null)
        }
        break
      }
      case "learning.updated": {
        // Scheduler patching/online events — surface as transient status
        break
      }
      case "server.heartbeat": {
        // Keepalive — ensure connected stays true
        setState("connected", true)
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
      setState("sessions", sessions)
      if (!state.currentId && sessions.length > 0) {
        await selectSession(sessions[0].id)
      }
    } catch (e) {
      setState("error", (e as Error).message)
    } finally {
      setState("loading", false)
    }
  }

  async function createSession(title?: string, model?: string) {
    setState("error", null)
    try {
      const s = await rpc.createSession({ title, model })
      setState("sessions", (prev) => [s, ...prev])
      await selectSession(s.id)
      return s
    } catch (e) {
      setState("error", (e as Error).message)
      throw e
    }
  }

  async function selectSession(id: string) {
    setState({ currentId: id, messages: [], todos: [], streamText: "", streamEvents: [], error: null })
    await Promise.all([loadMessages(id), loadTodos(id)])
  }

  async function deleteSession(id: string) {
    await rpc.deleteSession(id)
    setState("sessions", (prev) => prev.filter((s) => s.id !== id))
    if (state.currentId === id) {
      const next = state.sessions[0]?.id ?? null
      setState({ currentId: next, messages: [], todos: [] })
      if (next) await selectSession(next)
    }
  }

  async function loadMessages(id: string) {
    try {
      const msgs = await rpc.getMessages(id)
      setState("messages", msgs)
      // Reconcile queue with server truth
      try { setState("queued", await rpc.getQueue(id)) } catch {}
    } catch (e) {
      if (!String((e as Error).message).includes("404")) setState("error", (e as Error).message)
    }
  }

  /** Undo the agent's most recent file mutation */
  async function undoLast() {
    if (!state.currentId) return
    try {
      const out = await rpc.revertSession(state.currentId)
      await loadMessages(state.currentId)
      return out
    } catch (e) {
      setState("error", (e as Error).message)
    }
  }

  async function loadTodos(id: string) {
    try {
      const todos = await rpc.getTodos(id)
      setState("todos", todos)
    } catch {
      // todos optional
    }
  }

  // ── Streaming prompt (SSE) ───────────────────────────────────────

  let abort: AbortController | null = null

  async function sendPrompt(text?: string, model?: string) {
    const prompt = (text ?? input()).trim()
    if (!prompt || !state.currentId) return
    setInput("")
    // Agent busy → queue for chained-turn processing (Mira-parity UX)
    if (state.streaming) {
      try {
        await rpc.queuePrompt(state.currentId, prompt)
        setState("queued", (q) => [...q, prompt])
      } catch (e) {
        setState("error", (e as Error).message)
        setInput(prompt)
      }
      return
    }
    const userMsg: Message = {
      id: `tmp-${uid()}`,
      sessionID: state.currentId,
      role: "user",
      createdAt: Date.now(),
      parts: [{ id: `p-${uid()}`, messageID: "", sessionID: state.currentId, type: "text", text: prompt, createdAt: Date.now() } as Part],
    }
    setState("messages", (m) => [...m, userMsg])
    setState({ streaming: true, streamText: "", error: null })

    abort?.abort()
    abort = new AbortController()
    const asstId = `asst-${uid()}`
    const asstMsg: Message = {
      id: asstId,
      sessionID: state.currentId,
      role: "assistant",
      createdAt: Date.now(),
      parts: [{ id: `p-${uid()}`, messageID: asstId, sessionID: state.currentId, type: "text", text: "", createdAt: Date.now() } as Part],
    }
    setState("messages", (m) => [...m, asstMsg])

    try {
      await rpc.streamPrompt(state.currentId, prompt, {
        model,
        signal: abort.signal,
        onEvent: (event, data) => {
          const d = data as Record<string, JsonValue>
          setState("streamEvents", (ev) => [...ev, { type: event, data, at: Date.now() }])

          if (event === "text_delta") {
            const delta = (d.delta as string) ?? (d.text as string) ?? (d.content as string) ?? ""
            if (delta) {
              setState("streamText", (t) => t + String(delta))
              setState("messages", (msgs) =>
                msgs.map((mm) =>
                  mm.id === asstId
                    ? {
                        ...mm,
                        parts: (mm.parts ?? []).map((p) =>
                          p.type === "text" ? { ...p, text: (p.text ?? "") + String(delta) } : p,
                        ),
                      }
                    : mm,
                ),
              )
            }
          } else if (event === "tool_call" || event === "tool_execute") {
            const tool = (d.tool as string) ?? (d.name as string) ?? "tool"
            const toolCallID = (d.toolCallID as string) ?? (d.id as string) ?? uid()
            setState("messages", (msgs) =>
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
                          type: "tool-call",
                          tool,
                          toolCallID,
                          args: (d.args as Record<string, JsonValue>) ?? (d.input as Record<string, JsonValue>) ?? {},
                          createdAt: Date.now(),
                        } as Part,
                      ],
                    }
                  : mm,
              ),
            )
          } else if (event === "tool_result") {
            const tool = (d.tool as string) ?? (d.name as string) ?? "tool"
            const toolCallID = (d.toolCallID as string) ?? (d.id as string) ?? ""
            setState("messages", (msgs) =>
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
                          type: "tool-result",
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
          } else if (event === "permission_ask") {
            setState("pendingPermission", {
              toolCallID: (d.toolCallID as string) ?? (d.id as string) ?? uid(),
              tool: (d.tool as string) ?? "unknown",
              args: (d.args as Record<string, JsonValue>) ?? {},
              sessionID: state.currentId!,
            })
          }
        },
      })
    } catch (e) {
      if ((e as Error).name !== "AbortError") setState("error", (e as Error).message)
    } finally {
      setState({ streaming: false, streamText: "" })
      if (state.currentId) await loadMessages(state.currentId)
    }
  }

  function stopStream() {
    abort?.abort()
    setState("streaming", false)
  }

  // ── Permission reply (WS → GlobalBus) ────────────────────────────

  function replyPermission(decision: "allow" | "deny") {
    const p = state.pendingPermission
    if (!p) return
    socket.send({
      type: "permission.reply",
      sessionID: p.sessionID,
      payload: { toolCallID: p.toolCallID, decision, action: decision },
      timestamp: Date.now(),
    })
    setState("pendingPermission", null)
  }

  function dismissPermission() {
    replyPermission("deny")
  }

  // ── Question reply (WS → GlobalBus) ───────────────────────────────

  function answerQuestion(answers: Array<{ header: string; selections: string[] }>) {
    const q = state.pendingQuestion
    if (!q) return
    const payload: Record<string, JsonValue> = { questionID: q.questionID, answers: answers as JsonValue }
    const msg: Record<string, JsonValue> = { type: "question.reply", payload, timestamp: Date.now() }
    const sid = q.sessionID ?? state.currentId
    if (sid) msg.sessionID = sid
    socket.send(msg as JsonValue)
    setState("pendingQuestion", null)
  }

  return {
    state,
    input,
    setInput,
    socket,
    // actions
    loadSessions,
    createSession,
    selectSession,
    deleteSession,
    loadMessages,
    loadTodos,
    sendPrompt,
    stopStream,
    replyPermission,
    dismissPermission,
    answerQuestion,
    undoLast,
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>
