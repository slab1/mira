import { onMount, Show } from "solid-js"
import { createAppStore } from "./stores/app"
import { SessionList } from "./components/SessionList"
import { ChatView } from "./components/ChatView"
import { ToolView } from "./components/ToolView"
import { SkillSelector } from "./components/SkillSelector"
import { QuestionPrompt } from "./components/QuestionPrompt"

export default function App() {
  const store = createAppStore()

  onMount(() => {
    store.loadSessions()
  })

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
        background: "#09090b",
        color: "#e4e4e7",
      }}
    >
      <SessionList store={store} />

      <div
        style={{
          flex: "1",
          display: "flex",
          "flex-direction": "column",
          "min-width": "0",
          overflow: "hidden",
        }}
      >
        {/* top bar */}
        <header
          style={{
            height: "48px",
            "flex-shrink": "0",
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            padding: "0 16px",
            "border-bottom": "1px solid #27272a",
            background: "#09090b",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", "align-items": "center", gap: "10px", "min-width": "0" }}>
            <span style={{ "font-size": "13px", "font-weight": "600", color: "#fafafa" }}>
              {store.state.currentId
                ? store.state.sessions.find((s) => s.id === store.state.currentId)?.title ||
                  `Session ${store.state.currentId.slice(0, 8)}`
                : "No session selected"}
            </span>
            <Show when={store.state.currentId}>
              <span style={{ "font-size": "11px", color: "#71717a", "font-family": "ui-monospace, monospace" }}>
                {store.state.currentId}
              </span>
            </Show>
            <Show when={store.state.streaming}>
              <span
                style={{
                  "font-size": "11px",
                  background: "#422006",
                  color: "#fdba74",
                  padding: "2px 8px",
                  "border-radius": "999px",
                  border: "1px solid #78350f",
                }}
              >
                ● streaming
              </span>
            </Show>
          </div>

          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <Show when={store.state.currentId}>
              <button
                onClick={() => void store.undoLastMutation()}
                title="Undo the agent's last file change (snapshot restore)"
                style={{
                  "font-size": "11px",
                  color: "#fdba74",
                  background: "#422006",
                  border: "1px solid #78350f",
                  padding: "3px 8px",
                  "border-radius": "999px",
                  cursor: "pointer",
                }}
              >
                ↩ undo
              </button>
            </Show>
            <Show when={store.state.cost}>
              {(c) => (
                <span
                  title={`Gateway: ${c().requests} requests · ${c().inputTokens.toLocaleString()} in / ${c().outputTokens.toLocaleString()} out · avg ${c().avgLatencyMs}ms`}
                  style={{
                    "font-size": "11px",
                    color: "#93c5fd",
                    background: "#172554",
                    border: "1px solid #1e3a8a",
                    padding: "3px 8px",
                    "border-radius": "999px",
                    "font-family": "ui-monospace, monospace",
                  }}
                >
                  ${c().costUSD.toFixed(4)}
                </span>
              )}
            </Show>
            <SkillSelector onSelect={(skill) => { if (skill) store.createSession(`${skill} session`) }} />
            <span
              title="Mira server health"
              style={{
                "font-size": "11px",
                color: store.state.connected ? "#86efac" : "#fca5a5",
                background: store.state.connected ? "#052e16" : "#450a0a",
                border: `1px solid ${store.state.connected ? "#14532d" : "#7f1d1d"}`,
                padding: "3px 8px",
                "border-radius": "999px",
              }}
            >
              {store.state.connected ? "● live" : "○ offline"}
            </span>
            <a
              href="http://localhost:4096/health"
              target="_blank"
              rel="noreferrer"
              style={{
                "font-size": "11px",
                color: "#a1a1aa",
                "text-decoration": "none",
                border: "1px solid #27272a",
                padding: "3px 8px",
                "border-radius": "999px",
              }}
            >
              health
            </a>
          </div>
        </header>

        <div style={{ flex: "1", display: "flex", overflow: "hidden", "min-height": "0" }}>
          <ChatView store={store} />
          <ToolView store={store} />
        </div>
        <QuestionPrompt store={store} />
      </div>
    </div>
  )
}
