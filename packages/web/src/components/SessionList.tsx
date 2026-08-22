import { For, Show } from "solid-js"
import type { AppStore } from "../stores/app"

export function SessionList(props: { store: AppStore }) {
  const s = () => props.store.state

  return (
    <aside
      style={{
        width: "280px",
        "flex-shrink": "0",
        display: "flex",
        "flex-direction": "column",
        "border-right": "1px solid #27272a",
        background: "#09090b",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* header */}
      <div
        style={{
          padding: "14px 16px",
          "border-bottom": "1px solid #27272a",
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <div
            style={{
              width: "28px",
              height: "28px",
              "border-radius": "8px",
              background: "linear-gradient(135deg,#7c3aed,#ec4899)",
              display: "grid",
              "place-items": "center",
              "font-weight": "800",
              "font-size": "13px",
              color: "white",
            }}
          >
            M
          </div>
          <span style={{ "font-weight": "700", "font-size": "14px", "letter-spacing": "-0.02em" }}>Mira</span>
          <span
            style={{
              "font-size": "11px",
              background: "#18181b",
              border: "1px solid #27272a",
              padding: "1px 6px",
              "border-radius": "999px",
              color: "#a1a1aa",
            }}
          >
            web
          </span>
        </div>
        <span
          title={s().connected ? "WebSocket connected" : "Disconnected"}
          style={{
            width: "8px",
            height: "8px",
            "border-radius": "50%",
            background: s().connected ? "#22c55e" : "#ef4444",
            "box-shadow": s().connected ? "0 0 8px rgba(34,197,94,.6)" : "none",
            flex: "none",
          }}
        />
      </div>

      {/* new session */}
      <div style={{ padding: "12px", "border-bottom": "1px solid #1f1f23" }}>
        <button
          onClick={() => props.store.createSession()}
          style={{
            width: "100%",
            padding: "9px 12px",
            "border-radius": "10px",
            border: "1px solid #3f3f46",
            background: "#18181b",
            color: "#fafafa",
            "font-size": "13px",
            "font-weight": "600",
            cursor: "pointer",
          }}
        >
          + New session
        </button>
        <div style={{ "margin-top": "8px", display: "flex", gap: "6px" }}>
          <button
            onClick={() => props.store.loadSessions()}
            style={{
              flex: "1",
              padding: "6px",
              "border-radius": "8px",
              border: "1px solid #27272a",
              background: "transparent",
              color: "#a1a1aa",
              "font-size": "12px",
              cursor: "pointer",
            }}
          >
            ↻ Refresh
          </button>
          <span
            style={{
              "font-size": "11px",
              color: "#71717a",
              display: "flex",
              "align-items": "center",
              padding: "0 4px",
            }}
          >
            {s().sessions.length} sessions
          </span>
        </div>
      </div>

      {/* list */}
      <div style={{ flex: "1", overflow: "auto", padding: "8px" }}>
        <Show when={!s().loading} fallback={<div style={{ padding: "16px", color: "#71717a", "font-size": "13px" }}>Loading…</div>}>
          <Show
            when={s().sessions.length > 0}
            fallback={
              <div style={{ padding: "16px", color: "#71717a", "font-size": "13px", "text-align": "center" }}>
                No sessions yet.<br />
                <span style={{ color: "#52525b", "font-size": "12px" }}>Create one to start.</span>
              </div>
            }
          >
            <For each={s().sessions}>
              {(sess) => {
                const active = () => s().currentId === sess.id
                return (
                  <div
                    onClick={() => props.store.selectSession(sess.id)}
                    style={{
                      padding: "10px 12px",
                      "border-radius": "10px",
                      background: active() ? "#18181b" : "transparent",
                      border: active() ? "1px solid #3f3f46" : "1px solid transparent",
                      cursor: "pointer",
                      display: "flex",
                      "flex-direction": "column",
                      gap: "4px",
                      "margin-bottom": "6px",
                    }}
                  >
                    <div style={{ display: "flex", "justify-content": "space-between", gap: "8px", "align-items": "center" }}>
                      <span
                        style={{
                          "font-size": "13px",
                          "font-weight": active() ? "600" : "500",
                          color: active() ? "#fafafa" : "#d4d4d8",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {sess.title || `Session ${sess.id.slice(0, 6)}`}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm("Delete session?")) props.store.deleteSession(sess.id)
                        }}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#71717a",
                          cursor: "pointer",
                          "font-size": "14px",
                          padding: "2px 4px",
                          "border-radius": "6px",
                        }}
                        title="Delete"
                      >
                        ×
                      </button>
                    </div>
                    <span style={{ "font-size": "11px", color: "#71717a" }}>
                      {sess.model || "default"} · {new Date(sess.updatedAt || sess.createdAt).toLocaleString()}
                    </span>
                    <span
                      style={{
                        "font-size": "11px",
                        color: "#52525b",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                      }}
                    >
                      {sess.id}
                    </span>
                  </div>
                )
              }}
            </For>
          </Show>
        </Show>
      </div>

      <Show when={s().error}>
        <div style={{ padding: "10px 12px", "border-top": "1px solid #27272a", color: "#f87171", "font-size": "12px" }}>
          {s().error}
        </div>
      </Show>

      <div style={{ padding: "10px 12px", "border-top": "1px solid #27272a", color: "#52525b", "font-size": "11px" }}>
        Mira Web · Vite + SolidJS · server :4096
      </div>
    </aside>
  )
}
