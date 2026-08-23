/**
 * Mira App Store — SolidJS reactive state for the web client.
 *
 * Single source of truth for sessions / messages / todos / streaming.
 * Server is source of truth; store mirrors it and drives optimistic UI.
 */

import { createSignal, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { api, createSocket, type Session, type Message, type Todo, type BusEvent } from "../api/client"

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
  pendingQuestion: { questionID: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiple?: boolean }> } | null
}

function uid() {
  return Math.random().toString(36).slice(2, 9)
}

export function createAppStore() {
  const [state, setState] = createStore<AppState>({
    sessions: [],
    currentId: null,
    messages: [],
    todos: [],
    streaming: false,
    streamText: "",
    connected: false,
    error: null,
    loading: false,
    pendingQuestion: null,
  })

  const [input, setInput] = createSignal("")

  // ── WebSocket: GlobalBus subscription ────────────────────────────
  const socket = createSocket({
    open: () => setState("connected", true),
    close: () => setState("connected", false),
    error: () => setState("connected", false),
    event: (e: BusEvent) => handleBusEvent(e),
  })

  // Auto-connect on creation (client only)
  if (typeof window !== "undefined") {
    socket.connect()
    // reconnect on close
    const iv = setInterval(() => {
      if (!socket.ws || socket.ws.readyState === WebSocket.CLOSED) socket.connect()
    }, 3000)
    onCleanup(() => clearInterval(iv))
  }

  function handleBusEvent(e: BusEvent) {
    switch (e.type) {
      case "question.ask": {
        const q = e.payload as AppState["pendingQuestion"]
        if (q?.questionID) setState("pendingQuestion", q)
        break
      }
      case "session.created": {
        const s = e.payload as Session
        if (s?.id) setState("sessions", (prev) => [s, ...prev.filter((x) => x.id !== s.id)])
        break
      }
      case "session.deleted": {
        const { id } = e.payload as { id: string }
        setState("sessions", (prev) => prev.filter((s) => s.id !== id))
        if (state.currentId === id) {
          setState({ currentId: state.sessions[0]?.id ?? null, messages: [], todos: [] })
        }
        break
      }
      case "todo.updated": {
        if (e.sessionID === state.currentId) setState("todos", e.payload as Todo[])
        break
      }
      case "message.created":
      case "message.updated": {
        // server can push new parts incrementally
        // fall back to reload messages for simplicity
        if (e.sessionID === state.currentId) void loadMessages(state.currentId!)
        break
      }
    }
  }

  // ── REST actions ─────────────────────────────────────────────────
  async function loadSessions() {
    setState("loading", true)
    setState("error", null)
    try {
      const sessions = await api.listSessions()
      setState("sessions", sessions)
      // auto-select first if none selected
      if (!state.currentId && sessions.length > 0) {
        await selectSession(sessions[0].id)
      }
    } catch (e) {
      setState("error", (e as Error).message)
    } finally {
      setState("loading", false)
    }
  }

  async function createSession(title?: string) {
    setState("error", null)
    try {
      const s = await api.createSession(title ? { title } : {})
      setState("sessions", (prev) => [s, ...prev])
      await selectSession(s.id)
      return s
    } catch (e) {
      setState("error", (e as Error).message)
      throw e
    }
  }

  async function selectSession(id: string) {
    setState({ currentId: id, messages: [], todos: [], streamText: "", error: null })
    await Promise.all([loadMessages(id), loadTodos(id)])
  }

  async function deleteSession(id: string) {
    await api.deleteSession(id)
    setState("sessions", (prev) => prev.filter((s) => s.id !== id))
    if (state.currentId === id) {
      const next = state.sessions[0]?.id ?? null
      setState({ currentId: next, messages: [], todos: [] })
      if (next) await selectSession(next)
    }
  }

  async function loadMessages(id: string) {
    try {
      const msgs = await api.getMessages(id)
      setState("messages", msgs)
    } catch (e) {
      // 404 = new session, ignore
      if (!String((e as Error).message).includes("404")) setState("error", (e as Error).message)
    }
  }

  async function loadTodos(id: string) {
    try {
      const todos = await api.getTodos(id)
      setState("todos", todos)
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

  let abort: AbortController | null = null

  async function sendPrompt(text?: string) {
    const prompt = (text ?? input()).trim()
    if (!prompt || !state.currentId || state.streaming) return
    setInput("")
    // optimistic user message
    const userMsg: Message = {
      id: `tmp-${uid()}`,
      sessionId: state.currentId,
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
    }
    setState("messages", (m) => [...m, userMsg])
    setState({ streaming: true, streamText: "", error: null })
    abort?.abort()
    abort = new AbortController()

    // placeholder assistant message that we append to live
    const asstId = `asst-${uid()}`
    setState("messages", (m) => [
      ...m,
      { id: asstId, sessionId: state.currentId!, role: "assistant", content: "", createdAt: new Date().toISOString() },
    ])

    try {
      await api.streamPrompt(state.currentId, prompt, {
        signal: abort.signal,
        onChunk: (chunk) => {
          setState("streamText", (t) => t + chunk)
          // also patch the last assistant message content live
          setState("messages", (msgs) =>
            msgs.map((mm) => (mm.id === asstId ? { ...mm, content: (mm.content || "") + chunk } : mm)),
          )
        },
      })
    } catch (e) {
      if ((e as Error).name !== "AbortError") setState("error", (e as Error).message)
    } finally {
      setState({ streaming: false, streamText: "" })
      // final sync from server to get tool parts / persisted state
      if (state.currentId) await loadMessages(state.currentId)
    }
  }

  function stopStream() {
    abort?.abort()
    setState("streaming", false)
  }

  /** Answer a pending HITL question (question.ask → question.reply over WS) */
  function answerQuestion(questionID: string, answers: Array<{ header: string; selections: string[] }>) {
    socket.send({ type: "question.reply", payload: { questionID, answers }, timestamp: Date.now() })
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
    answerQuestion,
  }
}

export type AppStore = ReturnType<typeof createAppStore>
