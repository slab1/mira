import { createSignal, onMount, Show } from "solid-js"
import "./index.css"
import { createAppStore } from "./stores/app"
import { SessionList } from "./components/SessionList"
import { ChatView } from "./components/ChatView"
import { ToolView } from "./components/ToolView"
import { SkillSelector } from "./components/SkillSelector"
import { QuestionPrompt } from "./components/QuestionPrompt"
import { getToken, setToken } from "./api/client"

/** Token gate: servers with MIRA_TOKEN/MIRA_API_KEYS reject unauthenticated
 *  clients. Show a credential card until a token is stored and the server
 *  accepts it. Dev servers without auth let any (even empty) token pass. */
function AuthGate(props: { onReady: () => void }) {
  const [value, setValue] = createSignal(getToken())
  const [error, setError] = createSignal("")

  function connect(e?: Event) {
    e?.preventDefault()
    setError("")
    setToken(value().trim())
    try {
      props.onReady()
    } catch (err) {
      setError(String(err))
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
        background:
          "radial-gradient(640px 320px at 50% 36%, var(--accent-soft), transparent 70%), var(--bg-app)",
        color: "var(--fg)",
      }}
    >
      <form
        onSubmit={connect}
        style={{
          width: "380px",
          padding: "var(--sp-6)",
          border: "1px solid var(--border)",
          "border-radius": "var(--r-lg)",
          background: "var(--bg-surface)",
          "box-shadow": "var(--shadow-pop)",
          display: "flex",
          "flex-direction": "column",
          gap: "var(--sp-3)",
          animation: "fade-up var(--dur-med) var(--ease) both",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
          <div class="logo-tile">M</div>
          <span style={{ "font-size": "var(--fs-lg)", "font-weight": "700", "letter-spacing": "-0.02em" }}>Mira</span>
          <span class="pill">web</span>
        </div>

        <div>
          <div style={{ "font-size": "var(--fs-md)", "font-weight": "600", "margin-bottom": "4px" }}>
            Connect to your server
          </div>
          <div style={{ "font-size": "var(--fs-sm)", color: "var(--fg-muted)", "line-height": "1.55" }}>
            Paste the access token for your Mira server — ask your admin for a key. Open dev servers let you connect
            without one.
          </div>
        </div>

        <label for="mira-token" style={{ "font-size": "var(--fs-xs)", "font-weight": "600", color: "var(--fg-subtle)" }}>
          Access token
        </label>
        <input
          id="mira-token"
          type="password"
          class="input"
          value={value()}
          placeholder="mira_… (empty for open dev servers)"
          autocomplete="off"
          spellcheck={false}
          aria-invalid={error() ? "true" : "false"}
          aria-describedby={error() ? "auth-error" : undefined}
          onInput={(e) => setValue(e.currentTarget.value)}
        />

        <Show when={error()}>
          <div id="auth-error" role="alert" style={{ "font-size": "var(--fs-xs)", color: "var(--danger)" }}>
            ⚠ {error()}
          </div>
        </Show>

        <button type="submit" class="btn btn-solid" style={{ padding: "9px 12px", "font-size": "var(--fs-base)", "margin-top": "2px" }}>
          Connect →
        </button>

        <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)" }}>
          Tokens stay in this browser's localStorage and are sent only to your server.
        </div>
      </form>
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

  const currentSession = () => store.state.sessions.find((s) => s.id === store.state.currentId)

  return (
    <Show when={authorized()} fallback={<AuthGate onReady={() => { setAuthorized(true); void store.loadSessions() }} />}>
      <div
        style={{
          display: "flex",
          height: "100vh",
          width: "100vw",
          overflow: "hidden",
          background: "var(--bg-app)",
          color: "var(--fg)",
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
            background: "var(--bg-canvas)",
          }}
        >
          {/* top bar */}
          <header
            style={{
              height: "46px",
              "flex-shrink": "0",
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
              padding: "0 var(--sp-4)",
              "border-bottom": "1px solid var(--border)",
              background: "var(--bg-app)",
              gap: "var(--sp-3)",
            }}
          >
            <div style={{ display: "flex", "align-items": "center", gap: "10px", "min-width": "0" }}>
              <span
                style={{
                  "font-size": "var(--fs-sm)",
                  "font-weight": "600",
                  color: "var(--fg)",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  "white-space": "nowrap",
                  "max-width": "42ch",
                }}
              >
                {store.state.currentId
                  ? currentSession()?.title || `Session ${store.state.currentId.slice(0, 8)}`
                  : "No session selected"}
              </span>
              <Show when={store.state.currentId}>
                <span
                  title={store.state.currentId ?? undefined}
                  style={{
                    "font-size": "var(--fs-2xs)",
                    color: "var(--fg-faint)",
                    "font-family": "var(--font-mono)",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                    "max-width": "120px",
                  }}
                >
                  {store.state.currentId}
                </span>
              </Show>
              <Show when={store.state.streaming}>
                <span class="pill pill-warn">
                  <span class="dot dot-pulse" style={{ background: "var(--warn)" }} />
                  streaming
                </span>
              </Show>
            </div>

            <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-shrink": "0" }}>
              <Show when={store.state.currentId}>
                <button
                  type="button"
                  onClick={() => void store.undoLastMutation()}
                  title="Undo the agent's last file change (snapshot restore)"
                  class="pill pill-warn pill-btn"
                >
                  ↩ undo
                </button>
              </Show>
              <Show when={store.state.cost}>
                {(c) => (
                  <span
                    title={`Gateway: ${c().requests} requests · ${c().inputTokens.toLocaleString()} in / ${c().outputTokens.toLocaleString()} out · avg ${c().avgLatencyMs}ms`}
                    class="pill pill-cost"
                  >
                    ${c().costUSD.toFixed(4)}
                  </span>
                )}
              </Show>
              <SkillSelector onSelect={(skill) => { if (skill) void store.createSession(`${skill} session`).catch(() => {}) }} />
              <span
                title="Mira server health"
                class={`pill ${store.state.connected ? "pill-ok" : "pill-danger"}`}
              >
                <span
                  class={`dot ${store.state.connected ? "dot-pulse" : ""}`}
                  style={{ background: store.state.connected ? "var(--ok)" : "var(--danger)" }}
                />
                {store.state.connected ? "live" : "offline"}
              </span>
              <a
                href="http://127.0.0.1:4096/health"
                target="_blank"
                rel="noreferrer"
                title="Open server health endpoint"
                class="pill pill-btn"
              >
                health ↗
              </a>
            </div>
          </header>

          {/* offline banner — connection is self-healing (store retries every 3s),
              so this is a status strip, not an error */}
          <Show when={!store.state.connected}>
            <div class="banner-offline" role="status">
              <span class="dot dot-pulse" style={{ background: "var(--warn)" }} />
              Connection lost — reconnecting to the Mira server…
            </div>
          </Show>

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
