import { For, Show, createSignal, createResource } from "solid-js"
import type { AppStore } from "../stores/app"
import { api, type ToolInfo } from "../api/client"

export function ToolView(props: { store: AppStore }) {
  const s = () => props.store.state
  const [tools] = createResource(() => api.listTools().catch(() => [] as ToolInfo[]))
  const [tab, setTab] = createSignal<"todos" | "tools" | "events">("todos")

  // local event log from BusEvent stream (last 50)
  const [events, setEvents] = createSignal<{ type: string; at: string }[]>([])

  // tap into store socket event stream lightly — poll connected status
  // Real events come via store's bus handler; we mirror a tiny log here
  // by subscribing directly if needed — for minimal version just show placeholder
  // Instead, expose a simple effect: when sessions change, push an event entry
  // (kept minimal; full bus log would subscribe to createSocket again)

  return (
    <aside
      style={{
        width: "300px",
        "flex-shrink": "0",
        display: "flex",
        "flex-direction": "column",
        "border-left": "1px solid #27272a",
        background: "#09090b",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", gap: "4px", padding: "10px", "border-bottom": "1px solid #27272a" }}>
        <For each={["todos", "tools", "events"] as const}>
          {(t) => (
            <button
              onClick={() => setTab(t)}
              style={{
                flex: "1",
                padding: "6px 8px",
                "border-radius": "8px",
                border: "1px solid " + (tab() === t ? "#3f3f46" : "#27272a"),
                background: tab() === t ? "#18181b" : "transparent",
                color: tab() === t ? "#fafafa" : "#a1a1aa",
                "font-size": "12px",
                "font-weight": tab() === t ? "600" : "400",
                cursor: "pointer",
                "text-transform": "capitalize",
              }}
            >
              {t}
            </button>
          )}
        </For>
      </div>

      <div style={{ flex: "1", overflow: "auto", padding: "12px" }}>
        <Show when={tab() === "todos"}>
          <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "10px" }}>
            <span style={{ "font-size": "12px", "font-weight": "700", color: "#d4d4d8", "letter-spacing": "0.04em", "text-transform": "uppercase" }}>
              Todos
            </span>
            <Show when={s().currentId}>
              <button
                onClick={() => s().currentId && props.store.loadTodos(s().currentId)}
                style={{
                  background: "transparent",
                  border: "1px solid #27272a",
                  color: "#a1a1aa",
                  "font-size": "11px",
                  padding: "3px 8px",
                  "border-radius": "999px",
                  cursor: "pointer",
                }}
              >
                ↻
              </button>
            </Show>
          </div>

          <Show when={s().currentId} fallback={<div style={{ color: "#52525b", "font-size": "13px" }}>Select a session.</div>}>
            <Show
              when={s().todos.length > 0}
              fallback={<div style={{ color: "#71717a", "font-size": "13px" }}>No todos yet.</div>}
            >
              <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                <For each={s().todos}>
                  {(t) => (
                    <div
                      style={{
                        padding: "9px 10px",
                        "border-radius": "10px",
                        border: "1px solid #27272a",
                        background: t.status === "completed" ? "#0f1a12" : t.status === "in_progress" ? "#1a160f" : "#111113",
                        display: "flex",
                        gap: "8px",
                        "align-items": "flex-start",
                      }}
                    >
                      <span
                        style={{
                          width: "18px",
                          height: "18px",
                          "border-radius": "50%",
                          border: "1px solid #3f3f46",
                          background:
                            t.status === "completed"
                              ? "#22c55e"
                              : t.status === "in_progress"
                                ? "#eab308"
                                : t.status === "cancelled"
                                  ? "#52525b"
                                  : "transparent",
                          display: "grid",
                          "place-items": "center",
                          "font-size": "10px",
                          color: "white",
                          flex: "none",
                          "margin-top": "1px",
                        }}
                      >
                        {t.status === "completed" ? "✓" : t.status === "in_progress" ? "◷" : t.status === "cancelled" ? "×" : "○"}
                      </span>
                      <div style={{ flex: "1", "min-width": "0" }}>
                        <div
                          style={{
                            "font-size": "13px",
                            color: t.status === "completed" ? "#86efac" : "#d4d4d8",
                            "text-decoration": t.status === "completed" ? "line-through" : "none",
                            "text-decoration-color": "#22c55e",
                          }}
                        >
                          {t.content}
                        </div>
                        <div style={{ "font-size": "11px", color: "#71717a" }}>
                          {t.status} {t.priority ? `· ${t.priority}` : ""}
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>

        <Show when={tab() === "tools"}>
          <div style={{ "font-size": "12px", "font-weight": "700", color: "#d4d4d8", "letter-spacing": "0.04em", "text-transform": "uppercase", "margin-bottom": "10px" }}>
            Tools · {tools()?.length ?? "…"}
          </div>
          <Show
            when={tools() && tools()!.length > 0}
            fallback={
              <div style={{ color: "#71717a", "font-size": "13px" }}>
                <Show when={tools.loading} fallback="No tools. Start server on :4096.">
                  Loading tools…
                </Show>
              </div>
            }
          >
            <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
              <For each={tools()!}>
                {(tool) => (
                  <div style={{ padding: "9px 10px", "border-radius": "10px", border: "1px solid #27272a", background: "#111113" }}>
                    <div style={{ "font-size": "12.5px", "font-weight": "600", color: "#fafafa", "font-family": "ui-monospace, SFMono-Regular, monospace" }}>
                      {tool.name}
                    </div>
                    <div style={{ "font-size": "12px", color: "#a1a1aa", "margin-top": "3px", "line-height": "1.4" }}>
                      {tool.description || "No description"}
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>

        <Show when={tab() === "events"}>
          <div style={{ "font-size": "12px", "font-weight": "700", color: "#d4d4d8", "letter-spacing": "0.04em", "text-transform": "uppercase", "margin-bottom": "10px" }}>
            Bus Events
          </div>
          <div style={{ "font-size": "12px", color: "#71717a" }}>
            WebSocket:{" "}
            <span style={{ color: s().connected ? "#22c55e" : "#ef4444", "font-weight": "600" }}>
              {s().connected ? "connected" : "disconnected"}
            </span>
            <div style={{ "margin-top": "8px", color: "#52525b", "font-size": "11px" }}>
              Live BusEvent stream from server (session.created, todo.updated, …) — no polling.
            </div>
            <Show when={s().streaming}>
              <div style={{ "margin-top": "10px", padding: "8px", background: "#18181b", border: "1px solid #27272a", "border-radius": "8px", color: "#a1a1aa" }}>
                Streaming prompt for <code style={{ color: "#fafafa" }}>{s().currentId?.slice(0, 8)}</code>…
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </aside>
  )
}
