import { createSignal, onMount, Show } from "solid-js"
import { createAppStore } from "./stores/app"
import { SessionList } from "./components/SessionList"
import { ChatView } from "./components/ChatView"
import { ToolView } from "./components/ToolView"
import { SkillSelector } from "./components/SkillSelector"
import { QuestionPrompt } from "./components/QuestionPrompt"
import { getToken, setToken } from "./api/client"

/** Token gate: servers with MIRA_TOKEN/MIRA_API_KEYS reject unauthenticated
 *  clients. Show a minimal credential card until a token is stored and the
 *  server accepts it. Dev servers without auth let any (even empty) token pass. */
function AuthGate(props: { onReady: () => void }) {
  const [value, setValue] = createSignal(getToken())
  const [error, setError] = createSignal("")

  async function connect() {
    setError("")
    setToken(value().trim())
    try {
      props.onReady()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        height: "100vh",
        width: "100vw",
        background: "#09090b",
        color: "#e4e4e7",
      }}
    >
      <div
        style={{
          width: "360px",
          padding: "28px",
          border: "1px solid #27272a",
          "border-radius": "14px",
          background: "#18181b",
          display: "flex",
          "flex-direction": "column",
          gap: "12px",
        }}
      >
        <div style={{ "font-size": "16px", "font-weight": "600" }}>Mira</div>
        <div style={{ "font-size": "12px", color: "#a1a1aa", "line-height": "1.5" }}>
          Paste your access token to connect. Ask your server admin for a key, or leave empty for an open dev server.
        </div>
        <input
          type="password"
          value={value()}
          placeholder="access token"
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void connect()}
          style={{
            padding: "8px 10px",
            "border-radius": "8px",
            border: "1px solid #27272a",
            background: "#09090b",
            color: "#e4e4e7",
            "font-size": "13px",
            outline: "none",
          }}
        />
        <Show when={error()}>
          <div style={{ "font-size": "11px", color: "#fca5a5" }}>{error()}</div>
        </Show>
        <button
          onClick={() => void connect()}
          style={{
            padding: "8px 10px",
            "border-radius": "8px",
            border: "none",
            background: "#6366f1",
            color: "white",
            "font-size": "13px",
            cursor: "pointer",
          }}
        >
          Connect
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const store = createAppStore()
  const [authorized, setAuthorized] = createSignal(false)

  onMount(() => {
    // Probe with stored credentials; unauthorized → show the gate
    void store
      .loadSessions()
      .then(() => setAuthorized(true))
      .catch((e: Error) => {
        if (getToken()) console.warn("[mira] load failed:", e.message)
        if (e.message !== "unauthorized") setAuthorized(true) // non-auth failure: proceed, banner shows offline
        else if (getToken()) setAuthorized(true) // stale token case — still let UI render; errors surface per-call
      })
  })

  return (
    <Show when={authorized()} fallback={<AuthGate onReady={() => { setAuthorized(true); void store.loadSessions() }} />}>
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
              href="http://127.0.0.1:4096/health"
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
    </Show>
  )
}
