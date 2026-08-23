/**
 * Mira TUI — SolidJS + @opentui/solid terminal UI
 *
 * Architecture:
 *   TUI (SolidJS)  ⇄  WebSocket RPC (GlobalBus)  ⇄  Mira Server (Hono + SessionPrompt.loop)
 *   - Event-driven, no polling: WS streams BusEvent → store updates → reactive render
 *   - Prompt via SSE: POST /session/:id/prompt streams text_delta/tool_call/tool_result
 *   - Permission HITL: server emits permission.ask → PermissionView → permission.reply via WS
 *
 * Layout:
 *   ┌─ Header (Mira, connection, model, health) ─────────────────────┐
 *   │ SessionView (sidebar + messages)                                 │
 *   │ PermissionView (overlay when pending)                            │
 *   │ Input bar + status                                               │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Run: `bun run dev` (Vite on :3001 → proxy to :4096) or `bun src/index.ts` for native TUI via @opentui/solid renderer.
 */

import { Show, createEffect, createSignal, onMount, onCleanup } from "solid-js"
// @opentui/solid — SolidJS renderer for terminal (Box/Text primitives, Yoga layout)
// Vite preview renders to DOM (#root); native TUI uses renderTui → stdout.
import { render } from "@opentui/solid"
import { createSessionStore } from "./stores/session"
import SessionView from "./components/SessionView"
import PermissionView from "./components/PermissionView"

export default function App() {
  const store = createSessionStore()
  const [health, setHealth] = createSignal<{ ok: boolean; version: string; tools: number } | null>(null)

  onMount(() => {
    store.loadSessions()
    // health check
    import("./rpc/client").then(({ rpc }) =>
      rpc
        .health()
        .then(setHealth)
        .catch(() => {}),
    )
  })

  // Keyboard shortcuts: a = allow, d = deny when permission pending
  const onKeyDown = (e: KeyboardEvent) => {
    if (!store.state.pendingPermission) return
    if (e.key === "a" || e.key === "A") store.replyPermission("allow")
    if (e.key === "d" || e.key === "D" || e.key === "Escape") store.replyPermission("deny")
  }

  // Attach global key handler when permission is pending
  createEffect(() => {
    if (store.state.pendingPermission) window.addEventListener("keydown", onKeyDown)
    else window.removeEventListener("keydown", onKeyDown)
  })
  onCleanup(() => window.removeEventListener("keydown", onKeyDown))

  const handleSend = () => {
    void store.sendPrompt()
  }

  const handleInputKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === "Escape" && store.state.streaming) {
      store.stopStream()
    }
  }

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100vh",
        "min-height": "420px",
        background: "#0a0a0f",
        color: "#e5e7eb",
        "font-family": "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
        "font-size": "13px",
        overflow: "hidden",
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          padding: "10px 14px",
          border: "1px solid rgba(255,255,255,0.08)",
          "border-radius": "10px",
          margin: "8px 8px 0 8px",
          background: "linear-gradient(135deg, rgba(99,102,241,0.14), rgba(168,85,247,0.10))",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
          <span
            style={{
              width: "28px",
              height: "28px",
              display: "inline-flex",
              "align-items": "center",
              "justify-content": "center",
              "border-radius": "8px",
              background: "rgba(99,102,241,0.9)",
              color: "white",
              "font-weight": "800",
              "font-size": "14px",
              "letter-spacing": "-0.02em",
            }}
          >
            M
          </span>
          <div style={{ display: "flex", "flex-direction": "column" }}>
            <span style={{ "font-weight": "800", "letter-spacing": "-0.02em", "font-size": "14px" }}>Mira</span>
            <span style={{ "font-size": "11px", opacity: "0.6" }}>better than all — agent platform</span>
          </div>
          <span
            style={{
              margin: "0 8px",
              padding: "3px 8px",
              "border-radius": "999px",
              background: store.state.connected ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.12)",
              border: store.state.connected ? "1px solid rgba(16,185,129,0.25)" : "1px solid rgba(239,68,68,0.25)",
              color: store.state.connected ? "#6ee7b7" : "#fca5a5",
              "font-size": "11px",
              "font-weight": "600",
            }}
            title={store.state.connected ? "WebSocket connected (GlobalBus)" : "WebSocket disconnected — reconnecting…"}
          >
            {store.state.connected ? "● live" : "○ offline"}
          </span>
        </div>

        <div style={{ display: "flex", "align-items": "center", gap: "10px", "font-size": "11px" }}>
          <Show when={health()}>
            {(h) => (
              <span style={{ opacity: "0.7" }}>
                v{h().version} · {h().tools} tools
              </span>
            )}
          </Show>
          <Show when={store.state.currentId}>
            <span style={{ opacity: "0.55", "max-width": "220px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
              {store.state.sessions.find((s) => s.id === store.state.currentId)?.model ?? ""}
            </span>
          </Show>
          <Show when={store.state.loading}>
            <span style={{ opacity: "0.5" }}>loading…</span>
          </Show>
        </div>
      </div>

      {/* ── Error banner ── */}
      <Show when={store.state.error}>
        <div
          style={{
            margin: "8px 8px 0 8px",
            padding: "8px 12px",
            "border-radius": "8px",
            background: "rgba(239,68,68,0.10)",
            border: "1px solid rgba(239,68,68,0.22)",
            color: "#fecaca",
            "font-size": "12px",
            display: "flex",
            "justify-content": "space-between",
            "align-items": "center",
          }}
        >
          <span>{store.state.error}</span>
          <button
            onClick={() => store.state.error && (store as unknown as { state: { error: string | null } })}
            style={{ background: "transparent", border: "none", color: "#fecaca", cursor: "pointer", "font-size": "12px" }}
          >
            ✕
          </button>
        </div>
      </Show>

      {/* ── Main: SessionView ── */}
      <div style={{ flex: "1", overflow: "hidden", display: "flex", "flex-direction": "column", gap: "8px", padding: "8px" }}>
        <SessionView
          sessions={store.state.sessions}
          currentId={store.state.currentId}
          messages={store.state.messages}
          todos={store.state.todos}
          streaming={store.state.streaming}
          onSelect={(id) => void store.selectSession(id)}
          onCreate={() => void store.createSession()}
          onDelete={(id) => void store.deleteSession(id)}
        />

        {/* ── Permission overlay ── */}
        <Show when={store.state.pendingPermission}>
          <div style={{ "margin-top": "4px" }}>
            <PermissionView
              request={store.state.pendingPermission}
              onAllow={() => store.replyPermission("allow")}
              onDeny={() => store.replyPermission("deny")}
            />
          </div>
        </Show>
      </div>

      {/* ── Input bar ── */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          padding: "10px",
          border: "1px solid rgba(255,255,255,0.08)",
          "border-radius": "10px",
          margin: "0 8px 8px 8px",
          background: "rgba(255,255,255,0.03)",
          "align-items": "flex-end",
        }}
      >
        <textarea
          value={store.input()}
          onInput={(e) => store.setInput(e.currentTarget.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={
            !store.state.currentId
              ? "Create or select a session to start…"
              : store.state.streaming
                ? "Streaming… press Esc to stop"
                : "Ask Mira anything — Enter to send, Shift+Enter for newline"
          }
          disabled={!store.state.currentId || Boolean(store.state.pendingPermission)}
          rows={2}
          style={{
            flex: "1",
            padding: "9px 11px",
            "border-radius": "8px",
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(0,0,0,0.28)",
            color: "#e5e7eb",
            resize: "none",
            outline: "none",
            "font-family": "inherit",
            "font-size": "13px",
          }}
        />
        <div style={{ display: "flex", gap: "6px" }}>
          <Show
            when={!store.state.streaming}
            fallback={
              <button
                onClick={() => store.stopStream()}
                style={{
                  padding: "9px 14px",
                  "border-radius": "8px",
                  border: "1px solid rgba(239,68,68,0.35)",
                  background: "rgba(239,68,68,0.14)",
                  color: "#fecaca",
                  cursor: "pointer",
                  "font-weight": "700",
                  "font-size": "12px",
                }}
              >
                Stop
              </button>
            }
          >
            <button
              onClick={handleSend}
              disabled={!store.state.currentId || !store.input().trim()}
              style={{
                padding: "9px 16px",
                "border-radius": "8px",
                border: "1px solid rgba(99,102,241,0.5)",
                background: !store.state.currentId || !store.input().trim() ? "rgba(255,255,255,0.06)" : "rgba(99,102,241,0.9)",
                color: !store.state.currentId || !store.input().trim() ? "rgba(255,255,255,0.35)" : "white",
                cursor: !store.state.currentId || !store.input().trim() ? "not-allowed" : "pointer",
                "font-weight": "700",
                "font-size": "12px",
              }}
            >
              Send ↵
            </button>
          </Show>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{ display: "flex", "justify-content": "space-between", padding: "0 10px 8px 10px", "font-size": "10px", opacity: "0.42" }}>
        <span>
          Mira TUI · SolidJS + @opentui/solid · WS RPC to :4096 · {store.state.sessions.length} sessions
        </span>
        <span>Enter send · Esc stop · a/d on permission · “better than all”</span>
      </div>
    </div>
  )
}
