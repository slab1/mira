import { For, Show, onMount, createEffect } from "solid-js"
import type { AppStore } from "../stores/app"
import type { Message } from "../api/client"

function RoleBadge(props: { role: Message["role"] }) {
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    user: { label: "You", bg: "#27272a", fg: "#fafafa" },
    assistant: { label: "Mira", bg: "linear-gradient(135deg,#7c3aed,#ec4899)", fg: "#fff" },
    system: { label: "System", bg: "#1e293b", fg: "#94a3b8" },
    tool: { label: "Tool", bg: "#422006", fg: "#fdba74" },
  }
  const v = map[props.role] ?? map.assistant
  return (
    <span
      style={{
        "font-size": "11px",
        "font-weight": "700",
        padding: "2px 7px",
        "border-radius": "999px",
        background: v.bg,
        color: v.fg,
        flex: "none",
      }}
    >
      {v.label}
    </span>
  )
}

export function ChatView(props: { store: AppStore }) {
  const s = () => props.store.state
  let endRef: HTMLDivElement | undefined
  let inputRef: HTMLTextAreaElement | undefined

  const scrollToEnd = () => endRef?.scrollIntoView({ behavior: "smooth" })

  createEffect(() => {
    // react to message count / streaming text
    s().messages.length
    s().streamText
    scrollToEnd()
  })

  onMount(() => inputRef?.focus())

  const handleSubmit = (e: Event) => {
    e.preventDefault()
    props.store.sendPrompt()
    inputRef?.focus()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      props.store.sendPrompt()
    }
  }

  return (
    <section
      style={{
        flex: "1",
        display: "flex",
        "flex-direction": "column",
        background: "#0a0a0b",
        "min-width": "0",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* messages */}
      <div style={{ flex: "1", overflow: "auto", padding: "20px", display: "flex", "flex-direction": "column", gap: "14px" }}>
        <Show
          when={s().currentId}
          fallback={
            <div
              style={{
                flex: "1",
                display: "grid",
                "place-items": "center",
                color: "#71717a",
                "text-align": "center",
                padding: "24px",
              }}
            >
              <div>
                <div style={{ "font-size": "28px", "margin-bottom": "8px" }}>✦</div>
                <div style={{ "font-weight": "600", color: "#d4d4d8", "font-size": "14px" }}>Welcome to Mira</div>
                <div style={{ "font-size": "13px", "margin-top": "6px", "max-width": "36ch" }}>
                  Better than all — OpenCode openness + Claude reasoning + Cursor polish + memory/evals/guardrails.
                  Create a session to start.
                </div>
              </div>
            </div>
          }
        >
          <Show
            when={s().messages.length > 0}
            fallback={
              <div style={{ color: "#71717a", "font-size": "13px", padding: "12px 0" }}>
                No messages yet. Say hello to Mira →
              </div>
            }
          >
            <For each={s().messages}>
              {(m) => (
                <div
                  style={{
                    display: "flex",
                    gap: "10px",
                    "align-items": "flex-start",
                    background: m.role === "user" ? "#18181b" : m.role === "assistant" ? "#111113" : "transparent",
                    border: "1px solid #27272a",
                    "border-radius": "14px",
                    padding: "12px 14px",
                  }}
                >
                  <RoleBadge role={m.role} />
                  <div style={{ flex: "1", "min-width": "0" }}>
                    <pre
                      style={{
                        "white-space": "pre-wrap",
                        "word-break": "break-word",
                        "font-family": "ui-sans-system, system-ui, sans-serif",
                        "font-size": "13.5px",
                        "line-height": "1.6",
                        color: "#e4e4e7",
                        margin: "0",
                      }}
                    >
                      {m.content || (m.parts?.map((p) => p.text || "").join("\n") ?? "")}
                    </pre>
                    <Show when={m.parts && m.parts.length > 0}>
                      <div style={{ "margin-top": "8px", display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
                        <For each={m.parts}>
                          {(p) => (
                            <Show when={p.type === "tool_call" || p.type === "tool_result"}>
                              <span
                                style={{
                                  "font-size": "11px",
                                  background: "#1f1f23",
                                  border: "1px solid #27272a",
                                  padding: "3px 7px",
                                  "border-radius": "999px",
                                  color: "#a1a1aa",
                                }}
                              >
                                {p.type === "tool_call" ? "◷ " : "✓ "}
                                {p.tool ?? p.type}
                              </span>
                            </Show>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div style={{ "margin-top": "6px", "font-size": "11px", color: "#52525b" }}>
                      {new Date(m.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              )}
            </For>
          </Show>

          <Show when={s().streaming && s().streamText}>
            <div style={{ color: "#a1a1aa", "font-size": "12px", padding: "6px 2px" }}>
              <span style={{ display: "inline-block", width: "6px", height: "6px", background: "#a78bfa", "border-radius": "50%", "margin-right": "6px", animation: "pulse 1s infinite" }} />
              streaming…
            </div>
          </Show>

          <div ref={endRef} />
        </Show>
      </div>

      {/* composer */}
      <Show when={s().currentId}>
        <form
          onSubmit={handleSubmit}
          style={{
            padding: "12px",
            "border-top": "1px solid #27272a",
            background: "#09090b",
            display: "flex",
            gap: "10px",
            "align-items": "flex-end",
          }}
        >
          <textarea
            ref={inputRef}
            value={props.store.input()}
            onInput={(e) => props.store.setInput(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            placeholder="Message Mira… (Enter to send, Shift+Enter for newline)"
            rows={1}
            style={{
              flex: "1",
              resize: "none",
              "min-height": "42px",
              "max-height": "140px",
              padding: "11px 12px",
              "border-radius": "12px",
              border: "1px solid #3f3f46",
              background: "#18181b",
              color: "#fafafa",
              "font-size": "13.5px",
              "line-height": "1.4",
              outline: "none",
            }}
            onFocus={(e) => {
              // auto-grow
              const el = e.currentTarget
              el.style.height = "auto"
              el.style.height = Math.min(el.scrollHeight, 140) + "px"
            }}
            onInput={(e) => {
              const el = e.currentTarget as HTMLTextAreaElement
              props.store.setInput(el.value)
              el.style.height = "auto"
              el.style.height = Math.min(el.scrollHeight, 140) + "px"
            }}
          />
          <Show
            when={!s().streaming}
            fallback={
              <button
                type="button"
                onClick={() => props.store.stopStream()}
                style={{
                  padding: "10px 14px",
                  "border-radius": "10px",
                  border: "1px solid #44403c",
                  background: "#1c1917",
                  color: "#fdba74",
                  "font-size": "13px",
                  "font-weight": "600",
                  cursor: "pointer",
                  flex: "none",
                }}
              >
                Stop
              </button>
            }
          >
            <button
              type="submit"
              disabled={!props.store.input().trim()}
              style={{
                padding: "10px 16px",
                "border-radius": "10px",
                border: "none",
                background: props.store.input().trim() ? "linear-gradient(135deg,#7c3aed,#ec4899)" : "#27272a",
                color: props.store.input().trim() ? "white" : "#71717a",
                "font-size": "13px",
                "font-weight": "700",
                cursor: props.store.input().trim() ? "pointer" : "not-allowed",
                flex: "none",
              }}
            >
              Send ↵
            </button>
          </Show>
        </form>
      </Show>
    </section>
  )
}
