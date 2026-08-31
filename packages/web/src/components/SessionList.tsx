import { For, Show } from "solid-js"
import type { AppStore } from "../stores/app"

export function SessionList(props: { store: AppStore; open?: boolean }) {
  const s = () => props.store.state

  return (
    <aside
      class={`mira-sidebar${props.open ? " mira-sidebar-open" : ""}`}
      style={{
        width: "280px",
        "flex-shrink": "0",
        display: "flex",
        "flex-direction": "column",
        "border-right": "1px solid var(--border)",
        background: "var(--bg-app)",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* header */}
      <div
        style={{
          padding: "var(--sp-3) var(--sp-4)",
          "border-bottom": "1px solid var(--border)",
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: "var(--sp-2)",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "9px" }}>
          <div class="logo-tile">M</div>
          <span style={{ "font-weight": "700", "font-size": "var(--fs-md)", "letter-spacing": "-0.02em" }}>Mira</span>
          <span class="pill">web</span>
        </div>
        <span
          title={s().connected ? "WebSocket connected" : "Disconnected — retrying"}
          aria-label={s().connected ? "Connected" : "Disconnected"}
          style={{ display: "inline-flex" }}
        >
          <span
            class={`dot ${s().connected ? "dot-pulse" : ""}`}
            style={{
              width: "8px",
              height: "8px",
              background: s().connected ? "var(--ok)" : "var(--danger)",
              "box-shadow": s().connected ? "0 0 8px var(--ok-soft)" : "none",
            }}
          />
        </span>
      </div>

      {/* actions */}
      <div style={{ padding: "var(--sp-3)", "border-bottom": "1px solid var(--border)" }}>
        <button
          type="button"
          class="btn btn-solid"
          onClick={() => void props.store.createSession().catch(() => {})}
          style={{ width: "100%", padding: "8px 12px", "font-size": "var(--fs-sm)" }}
        >
          ＋ New session
        </button>
        <div style={{ "margin-top": "var(--sp-2)", display: "flex", gap: "6px", "align-items": "center" }}>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => void props.store.loadSessions()}
            style={{
              flex: "1",
              padding: "5px 8px",
              "font-size": "var(--fs-xs)",
              border: "1px solid var(--border)",
              "border-radius": "var(--r-md)",
            }}
          >
            ↻ Refresh
          </button>
          <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", padding: "0 4px" }} role="status">
            {s().sessions.length} session{s().sessions.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {/* list */}
      <div class="scroll" style={{ flex: "1", padding: "var(--sp-2)" }}>
        <Show
          when={!s().loading}
          fallback={
            <div style={{ display: "flex", "flex-direction": "column", gap: "8px", padding: "4px" }} aria-label="Loading sessions">
              {[0, 1, 2, 3].map(() => (
                <div class="skeleton" style={{ height: "52px", "border-radius": "var(--r-md)" }} />
              ))}
            </div>
          }
        >
          <Show
            when={s().sessions.length > 0}
            fallback={
              /* designed empty state with an exit — never a dead end */
              <div
                style={{
                  margin: "var(--sp-4) var(--sp-2)",
                  padding: "var(--sp-5) var(--sp-4)",
                  border: "1px dashed var(--border-strong)",
                  "border-radius": "var(--r-lg)",
                  "text-align": "center",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "10px",
                  "align-items": "center",
                }}
              >
                <div
                  style={{
                    width: "36px",
                    height: "36px",
                    "border-radius": "var(--r-md)",
                    background: "var(--accent-soft)",
                    border: "1px solid var(--accent-border)",
                    display: "grid",
                    "place-items": "center",
                    color: "var(--accent)",
                    "font-size": "16px",
                  }}
                >
                  ✦
                </div>
                <div>
                  <div style={{ "font-size": "var(--fs-sm)", "font-weight": "600", color: "var(--fg)" }}>No sessions yet</div>
                  <div style={{ "font-size": "var(--fs-xs)", color: "var(--fg-subtle)", "margin-top": "3px" }}>
                    Spin up your first chat to start working with the agent.
                  </div>
                </div>
                <button
                  type="button"
                  class="btn btn-outline"
                  onClick={() => void props.store.createSession().catch(() => {})}
                  style={{ padding: "6px 12px", "font-size": "var(--fs-sm)" }}
                >
                  ＋ New session
                </button>
              </div>
            }
          >
            <div role="list" style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
              <For each={s().sessions}>
                {(sess) => {
                  const active = () => s().currentId === sess.id
                  return (
                    <div class={`session-row ${active() ? "active" : ""}`} role="listitem">
                      <button
                        type="button"
                        class="session-main"
                        aria-current={active() ? "true" : undefined}
                        onClick={() => props.store.selectSession(sess.id)}
                      >
                        <span
                          style={{
                            display: "block",
                            "font-size": "var(--fs-sm)",
                            "font-weight": active() ? "600" : "500",
                            color: active() ? "var(--fg)" : "var(--fg-muted)",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {sess.title || `Session ${sess.id.slice(0, 6)}`}
                        </span>
                        <span
                          style={{
                            display: "block",
                            "margin-top": "3px",
                            "font-size": "var(--fs-2xs)",
                            color: "var(--fg-subtle)",
                          }}
                        >
                          {sess.model || "default"} · {new Date(sess.updatedAt || sess.createdAt).toLocaleString()}
                        </span>
                        <span
                          style={{
                            display: "block",
                            "margin-top": "2px",
                            "font-family": "var(--font-mono)",
                            "font-size": "var(--fs-2xs)",
                            color: "var(--fg-faint)",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {sess.id}
                        </span>
                      </button>
                      <button
                        type="button"
                        class="session-del"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm("Delete session?")) props.store.deleteSession(sess.id)
                        }}
                        title="Delete session"
                        aria-label={`Delete session ${sess.title || sess.id.slice(0, 6)}`}
                      >
                        ×
                      </button>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={s().error}>
        <div class="alert" role="alert" style={{ margin: "0 var(--sp-3) var(--sp-2)", padding: "8px 10px", "font-size": "var(--fs-xs)" }}>
          ⚠ {s().error}
        </div>
      </Show>

      <div
        style={{
          padding: "9px var(--sp-3)",
          "border-top": "1px solid var(--border)",
          color: "var(--fg-faint)",
          "font-size": "var(--fs-2xs)",
          display: "flex",
          "justify-content": "space-between",
          "font-family": "var(--font-mono)",
        }}
      >
        <span>Mira Web · SolidJS</span>
        <span>server :4096</span>
      </div>
    </aside>
  )
}
