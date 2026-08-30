import { createSignal, onMount, Show, onCleanup, createResource, For } from "solid-js"
import "./index.css"
import { createAppStore } from "./stores/app"
import { createSettingsStore } from "./stores/settings"
import { SessionList } from "./components/SessionList"
import { ChatView } from "./components/ChatView"
import { ToolView } from "./components/ToolView"
import { SkillSelector } from "./components/SkillSelector"
import { QuestionPrompt } from "./components/QuestionPrompt"
import { SettingsPanel } from "./components/SettingsPanel"
import { CommandPalette } from "./components/CommandPalette"
import { api, getToken, setToken } from "./api/client"

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
  const settings = createSettingsStore()
  const [authorized, setAuthorized] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [agents] = createResource(() => api.listAgents().catch(() => []))
  const [selectedAgent, setSelectedAgent] = createSignal("")

  onMount(() => {
    // Probe with stored credentials; unauthorized → show the gate
    void store
      .loadSessions()
      .then(() => setAuthorized(true))
      .catch((e: Error) => {
        if (getToken()) console.warn("[mira] load failed:", e.message)
        if (e.message !== "unauthorized") setAuthorized(true) // non-auth failure: proceed, banner shows offline
        else setAuthorized(false)
      })

    // Token invalid → clear gate (req() already cleared localStorage + dispatched)
    const onAuthInvalid = () => setAuthorized(false)
    window.addEventListener("mira:auth-invalid", onAuthInvalid)

    // Global palette shortcut: Ctrl+P / Cmd+P and "/" hint
    const onPaletteEvent = () => setPaletteOpen(true)
    window.addEventListener("mira:open-palette", onPaletteEvent)
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if (e.key === "," && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => {
      window.removeEventListener("mira:auth-invalid", onAuthInvalid)
      window.removeEventListener("mira:open-palette", onPaletteEvent)
      window.removeEventListener("keydown", onKey)
    })
  })

  const currentSession = () => store.state.sessions.find((s) => s.id === store.state.currentId)

  const handlePaletteInsert = (text: string) => {
    store.setInput(text)
    // Focus composer after insert — ChatView's textarea is [aria-label="Message Mira"]
    queueMicrotask(() => {
      const el = document.querySelector<HTMLTextAreaElement>('[aria-label="Message Mira"]')
      el?.focus()
    })
  }

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
              <Show when={currentSession()?.agent}>
                {(agent) => (
                  <span
                    title={`Lane: ${agent()} — ${agent() === "researcher" ? "readonly · web/read only" : agent() === "coder" ? "standard · edit/bash" : agent() === "explorer" ? "readonly · grep/glob" : agent() === "reviewer" ? "standard · read/patch" : "lane contract"}`}
                    class={`pill ${agent() === "researcher" ? "pill-ok" : agent() === "coder" ? "pill-warn" : agent() === "explorer" ? "pill-ok" : agent() === "reviewer" ? "pill-warn" : "pill-accent"}`}
                    style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-2xs)", "text-transform": "lowercase" }}
                  >
                    {agent() === "researcher" ? "🔍 researcher" : agent() === "coder" ? "⌨ coder" : agent() === "explorer" ? "🧭 explorer" : agent() === "reviewer" ? "👁 reviewer" : `🤖 ${agent()}`}
                  </span>
                )}
              </Show>
            </div>

            <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-shrink": "0" }}>
              <button
                type="button"
                class="btn btn-ghost"
                onClick={() => setPaletteOpen(true)}
                title="Command palette (Ctrl+P)"
                aria-label="Open command palette"
                style={{ padding: "5px 9px", "font-size": "var(--fs-xs)", border: "1px solid var(--border)", "border-radius": "var(--r-md)" }}
              >
                ⌘ <span style={{ "font-family": "var(--font-mono)", "margin-left": "2px" }}>P</span>
              </button>
              <button
                type="button"
                class="btn btn-ghost"
                onClick={() => setSettingsOpen(true)}
                title="Settings (Ctrl+,)"
                aria-label="Open settings"
                style={{ padding: "5px 9px", "font-size": "var(--fs-xs)", border: "1px solid var(--border)", "border-radius": "var(--r-md)" }}
              >
                ⚙ Settings
              </button>
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
              <Show when={store.state.currentId}>
                <button
                  type="button"
                  onClick={() =>
                    void (async () => {
                      const id = store.state.currentId
                      if (!id) return
                      try {
                        const md = await api.exportSession(id, "md")
                        const blob = new Blob([md], { type: "text/markdown;charset=utf-8" })
                        const url = URL.createObjectURL(blob)
                        const a = document.createElement("a")
                        a.href = url
                        a.download = `mira-${id.slice(0, 8)}.md`
                        a.click()
                        URL.revokeObjectURL(url)
                      } catch (e) {
                        console.error("[mira] export failed:", e)
                      }
                    })()
                  }
                  title="Export conversation transcript as Markdown"
                  class="pill pill-btn"
                >
                  ⤓ export
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
              <Show when={(agents() ?? []).length > 0}>
                <select
                  value={selectedAgent()}
                  onChange={(e) => setSelectedAgent(e.currentTarget.value)}
                  title="Agent lane — session template (tools + posture)"
                  aria-label="Agent lane"
                  class="btn btn-ghost"
                  style={{ padding: "4px 8px", "font-size": "var(--fs-xs)", border: "1px solid var(--border)", "border-radius": "var(--r-md)", background: "var(--bg-surface)", color: "var(--fg)" }}
                >
                  <option value="">general</option>
                  <For each={agents() ?? []}>{(a) => <option value={a.name}>{a.name}{a.custom ? " *" : ""}</option>}</For>
                </select>
              </Show>
              <button
                type="button"
                class="btn btn-ghost"
                onClick={() => void store.createSession(selectedAgent() ? `${selectedAgent()} session` : undefined, { agent: selectedAgent() || undefined }).catch(() => {})}
                title={selectedAgent() ? `New ${selectedAgent()} session` : "New session"}
                style={{ padding: "4px 9px", "font-size": "var(--fs-xs)", border: "1px solid var(--border)", "border-radius": "var(--r-md)" }}
              >
                ＋ {selectedAgent() || "new"}
              </button>
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
            <ChatView store={store} settings={settings} onPaletteOpen={() => setPaletteOpen(true)} />
            <ToolView store={store} />
          </div>
          <QuestionPrompt store={store} />
        </div>
      </div>
      <SettingsPanel store={settings} open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      <CommandPalette settings={settings} open={paletteOpen()} onClose={() => setPaletteOpen(false)} onInsert={handlePaletteInsert} />
    </Show>
  )
}
