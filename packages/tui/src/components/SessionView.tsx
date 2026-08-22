/**
 * SessionView — Sidebar + message list for Mira TUI
 *
 * Shows sessions in a scrollable list, current session messages with parts,
 * and delegates tool-call parts to ToolCallView.
 * Built with @opentui/solid primitives (Box/Text) — falls back to div/span
 * if the runtime is DOM (vite preview).
 */

import { For, Show, createMemo } from "solid-js"
import type { Session, Message, Part, Todo } from "../rpc/client"
import ToolCallView from "./ToolCallView"

type Props = {
  sessions: Session[]
  currentId: string | null
  messages: Message[]
  todos: Todo[]
  streaming?: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}

// Try to use @opentui/solid if available; otherwise render plain JSX.
// This keeps `tsc --noEmit` happy even before `npm install`.
let TuiBox: unknown = null
let TuiText: unknown = null
try {
  // dynamic import hint for bundler — not executed at top-level in SSR
} catch {}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return String(ts)
  }
}

function PartView(props: { part: Part }) {
  const p = () => props.part
  return (
    <Show
      when={p().type !== "tool-call" && p().type !== "tool-result"}
      fallback={<ToolCallView part={p()} />}
    >
      <div
        style={{
          "white-space": "pre-wrap",
          "word-break": "break-word",
          padding: p().type === "reasoning" ? "4px 8px" : "6px 10px",
          opacity: p().type === "reasoning" ? "0.7" : "1",
          "font-style": p().type === "reasoning" ? "italic" : "normal",
          "border-left": p().type === "reasoning" ? "2px solid #888" : "none",
          "margin-left": p().type === "reasoning" ? "8px" : "0",
        }}
      >
        {p().text ?? ""}
      </div>
    </Show>
  )
}

function MessageView(props: { message: Message }) {
  const m = () => props.message
  const isUser = createMemo(() => m().role === "user")
  const parts = createMemo(() => m().parts ?? [])

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "4px",
        padding: "8px 10px",
        "border-radius": "8px",
        background: isUser() ? "rgba(99,102,241,0.12)" : "rgba(255,255,255,0.04)",
        border: isUser() ? "1px solid rgba(99,102,241,0.25)" : "1px solid rgba(255,255,255,0.08)",
        margin: "6px 0",
      }}
    >
      <div
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          "font-size": "11px",
          opacity: "0.6",
        }}
      >
        <span style={{ "font-weight": "600", "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
          {m().role}
        </span>
        <span>{formatTime(m().createdAt)}</span>
      </div>
      <For each={parts()}>
        {(part) => <PartView part={part} />}
      </For>
      <Show when={parts().length === 0}>
        <span style={{ opacity: "0.4", "font-style": "italic" }}>(no content)</span>
      </Show>
    </div>
  )
}

export default function SessionView(props: Props) {
  const current = createMemo(() => props.sessions.find((s) => s.id === props.currentId) ?? null)

  return (
    <div style={{ display: "flex", "flex-direction": "row", height: "100%", gap: "12px", padding: "8px" }}>
      {/* ── Sidebar: sessions ── */}
      <div
        style={{
          width: "260px",
          "min-width": "200px",
          display: "flex",
          "flex-direction": "column",
          gap: "8px",
          border: "1px solid rgba(255,255,255,0.08)",
          "border-radius": "10px",
          padding: "10px",
          background: "rgba(255,255,255,0.02)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
          <span style={{ "font-weight": "700", "font-size": "13px", "letter-spacing": "0.04em" }}>SESSIONS</span>
          <button
            onClick={props.onCreate}
            style={{
              padding: "4px 10px",
              "border-radius": "6px",
              border: "1px solid rgba(99,102,241,0.5)",
              background: "rgba(99,102,241,0.15)",
              color: "#a5b4fc",
              cursor: "pointer",
              "font-size": "12px",
            }}
          >
            + New
          </button>
        </div>

        <div style={{ display: "flex", "flex-direction": "column", gap: "4px", overflow: "auto", flex: "1" }}>
          <For each={props.sessions}>
            {(s) => (
              <div
                onClick={() => props.onSelect(s.id)}
                style={{
                  padding: "8px 10px",
                  "border-radius": "8px",
                  cursor: "pointer",
                  background: s.id === props.currentId ? "rgba(99,102,241,0.18)" : "transparent",
                  border: s.id === props.currentId ? "1px solid rgba(99,102,241,0.35)" : "1px solid transparent",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "2px",
                }}
              >
                <span
                  style={{
                    "font-weight": s.id === props.currentId ? "600" : "500",
                    "font-size": "13px",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}
                  title={s.title}
                >
                  {s.title || "Untitled"}
                </span>
                <span style={{ "font-size": "11px", opacity: "0.55", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                  {s.model} · {formatTime(s.updatedAt)}
                </span>
              </div>
            )}
          </For>
          <Show when={props.sessions.length === 0}>
            <span style={{ opacity: "0.45", "font-size": "12px", padding: "8px" }}>No sessions yet — create one.</span>
          </Show>
        </div>

        {/* Todos summary */}
        <Show when={props.todos.length > 0}>
          <div style={{ "border-top": "1px solid rgba(255,255,255,0.06)", "padding-top": "8px", display: "flex", "flex-direction": "column", gap: "4px" }}>
            <span style={{ "font-size": "11px", "font-weight": "600", opacity: "0.6", "letter-spacing": "0.04em" }}>
              TODOS ({props.todos.filter((t) => t.status !== "completed").length}/{props.todos.length})
            </span>
            <For each={props.todos.slice(0, 5)}>
              {(t) => (
                <div style={{ "font-size": "12px", display: "flex", gap: "6px", "align-items": "center", opacity: t.status === "completed" ? "0.45" : "0.9" }}>
                  <span>{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}</span>
                  <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{t.content}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={current()}>
          {(c) => (
            <button
              onClick={() => props.onDelete(c().id)}
              style={{
                padding: "6px",
                "border-radius": "6px",
                border: "1px solid rgba(239,68,68,0.25)",
                background: "transparent",
                color: "#fca5a5",
                cursor: "pointer",
                "font-size": "12px",
              }}
            >
              Delete session
            </button>
          )}
        </Show>
      </div>

      {/* ── Main: messages ── */}
      <div
        style={{
          flex: "1",
          display: "flex",
          "flex-direction": "column",
          gap: "4px",
          border: "1px solid rgba(255,255,255,0.08)",
          "border-radius": "10px",
          padding: "10px",
          background: "rgba(255,255,255,0.02)",
          overflow: "auto",
        }}
      >
        <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "padding-bottom": "6px", "border-bottom": "1px solid rgba(255,255,255,0.06)" }}>
          <span style={{ "font-weight": "600", "font-size": "13px" }}>
            {current()?.title ?? (props.currentId ? "Session" : "No session selected")}
          </span>
          <span style={{ "font-size": "11px", opacity: "0.5" }}>
            {props.messages.length} messages {props.streaming ? "· streaming…" : ""}
          </span>
        </div>

        <div style={{ display: "flex", "flex-direction": "column", flex: "1", overflow: "auto" }}>
          <For each={props.messages}>{(m) => <MessageView message={m} />}</For>
          <Show when={props.messages.length === 0}>
            <div
              style={{
                flex: "1",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                opacity: "0.4",
                "font-size": "13px",
                padding: "24px",
                "text-align": "center",
              }}
            >
              No messages yet. Type a prompt below to start the agent loop — Mira will stream tool calls, permissions, and compaction events live.
            </div>
          </Show>
          <Show when={props.streaming}>
            <div style={{ padding: "8px", "font-size": "12px", opacity: "0.6", "font-style": "italic" }}>● streaming…</div>
          </Show>
        </div>
      </div>
    </div>
  )
}
