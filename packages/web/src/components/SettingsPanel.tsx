import { createSignal, createEffect, For, Show, onCleanup } from "solid-js"
import type { SettingsStore } from "../stores/settings"
import type { MiraConfig, ThemeChoice } from "../api/client"

type TabId = "general" | "providers" | "permissions" | "connectors" | "agents" | "commands"

const TABS: Array<{ id: TabId; label: string; icon: string; desc: string }> = [
  { id: "general", label: "General", icon: "⚙", desc: "Model & appearance" },
  { id: "providers", label: "Providers", icon: "🔑", desc: "API keys" },
  { id: "permissions", label: "Permissions", icon: "🛡", desc: "Tool access" },
  { id: "connectors", label: "Connectors", icon: "🔌", desc: "MCP servers" },
  { id: "agents", label: "Agents", icon: "🤖", desc: "Lane personas" },
  { id: "commands", label: "Commands", icon: "⌘", desc: "Slash & skills" },
]

export function SettingsPanel(props: { store: SettingsStore; open: boolean; onClose: () => void }) {
  const [tab, setTab] = createSignal<TabId>("general")
  const s = () => props.store.state

  // Form state for General
  const [model, setModel] = createSignal("")
  const [smallModel, setSmallModel] = createSignal("")
  const [loopMaxSteps, setLoopMaxSteps] = createSignal("")
  const [loopContextLimit, setLoopContextLimit] = createSignal("")
  const [loopThreshold, setLoopThreshold] = createSignal("")
  const [loopSmallModel, setLoopSmallModel] = createSignal("")
  const [theme, setThemeLocal] = createSignal<ThemeChoice>("system")

  // Providers add form
  const [provName, setProvName] = createSignal("")
  const [provKey, setProvKey] = createSignal("")
  const [provUrl, setProvUrl] = createSignal("")
  const [provTesting, setProvTesting] = createSignal<string | null>(null)
  const [provResult, setProvResult] = createSignal<Record<string, string>>({})

  // MCP add form
  const [mcpName, setMcpName] = createSignal("")
  const [mcpType, setMcpType] = createSignal<"local" | "remote">("local")
  const [mcpCommand, setMcpCommand] = createSignal("")
  const [mcpUrl, setMcpUrl] = createSignal("")
  const [mcpTesting, setMcpTesting] = createSignal<string | null>(null)
  const [mcpResult, setMcpResult] = createSignal<Record<string, string>>({})

  let dialogRef: HTMLDivElement | undefined
  let firstFocusRef: HTMLButtonElement | undefined

  // Sync form from loaded config
  createEffect(() => {
    if (props.open && s().config) {
      setModel(s().config?.model ?? "")
      setSmallModel(s().config?.smallModel ?? "")
      const loop = s().config?.loop ?? {}
      setLoopMaxSteps(loop.maxSteps != null ? String(loop.maxSteps) : "")
      setLoopContextLimit(loop.contextLimit != null ? String(loop.contextLimit) : "")
      setLoopThreshold(loop.compactionThreshold != null ? String(loop.compactionThreshold) : "")
      setLoopSmallModel(loop.smallModel ?? "")
    }
    if (props.open) setThemeLocal(s().theme)
  })

  // Focus trap & Escape
  createEffect(() => {
    if (!props.open) return
    queueMicrotask(() => firstFocusRef?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
      if (e.key === "Tab" && dialogRef) {
        const focusable = dialogRef.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    onCleanup(() => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    })
  })

  // Load on open
  createEffect(() => {
    if (props.open) void props.store.loadAll()
  })

  const handleSaveGeneral = async (e: Event) => {
    e.preventDefault()
    const patch: Partial<MiraConfig> = {}
    if (model().trim()) patch.model = model().trim()
    if (smallModel().trim()) patch.smallModel = smallModel().trim()
    // Loop limits — only include fields the user touched (empty = leave as-is)
    const loopPatch: Record<string, string | number> = {}
    const maxSteps = parseInt(loopMaxSteps().trim(), 10)
    if (loopMaxSteps().trim() && Number.isFinite(maxSteps) && maxSteps > 0) loopPatch.maxSteps = maxSteps
    const ctxLimit = parseInt(loopContextLimit().trim(), 10)
    if (loopContextLimit().trim() && Number.isFinite(ctxLimit) && ctxLimit > 0) loopPatch.contextLimit = ctxLimit
    const thresh = parseFloat(loopThreshold().trim())
    if (loopThreshold().trim() && Number.isFinite(thresh) && thresh > 0 && thresh <= 1) loopPatch.compactionThreshold = thresh
    if (loopSmallModel().trim()) loopPatch.smallModel = loopSmallModel().trim()
    if (Object.keys(loopPatch).length > 0) patch.loop = loopPatch as MiraConfig["loop"]
    // Allow clearing loop fields when user empties them — send explicit null via delete? keep as-is for now
    if (Object.keys(patch).length > 0) await props.store.saveConfig(patch)
    // Theme is local-only (persisted via store, not server)
    props.store.setTheme(theme())
  }

  const handleAddProvider = async (e: Event) => {
    e.preventDefault()
    const name = provName().trim()
    const key = provKey().trim()
    if (!name || !key) return
    // Save as provider.<name> via PATCH /config
    const baseURL = provUrl().trim() || undefined
    const providerPatch = {
      provider: {
        ...(s().config?.provider ?? {}),
        [name]: {
          npm: "@ai-sdk/openai-compatible",
          name,
          options: { baseURL: baseURL ?? "https://api.openai.com/v1", apiKey: key },
          models: {},
        },
      },
    }
    const res = await props.store.saveConfig(providerPatch as Partial<MiraConfig>)
    if (res) {
      setProvName("")
      setProvKey("")
      setProvUrl("")
      void props.store.loadProviders()
    }
  }

  const handleTestProvider = async (id: string) => {
    setProvTesting(id)
    const r = await props.store.testProvider(id)
    setProvResult((prev) => ({ ...prev, [id]: r.ok ? `✓ ok${r.latencyMs ? ` · ${r.latencyMs}ms` : ""}` : `✗ ${r.error ?? "failed"}` }))
    setProvTesting(null)
  }

  const handleAddMcp = async (e: Event) => {
    e.preventDefault()
    const name = mcpName().trim()
    if (!name) return
    const body: { name: string; type: "local" | "remote"; command?: string[]; url?: string; enabled?: boolean } = {
      name,
      type: mcpType(),
      enabled: true,
    }
    if (mcpType() === "local") {
      const cmd = mcpCommand().trim()
      if (!cmd) return
      body.command = cmd.split(/\s+/).filter(Boolean)
    } else {
      const url = mcpUrl().trim()
      if (!url) return
      body.url = url
    }
    const created = await props.store.addMcp(body)
    if (created) {
      setMcpName("")
      setMcpCommand("")
      setMcpUrl("")
    }
  }

  const handleToggleMcp = async (name: string, enabled: boolean) => {
    await props.store.toggleMcp(name, enabled)
  }

  const handleTestMcp = async (name: string) => {
    setMcpTesting(name)
    const r = await props.store.testMcp(name)
    setMcpResult((prev) => ({ ...prev, [name]: r.ok ? `✓ ${r.toolCount ?? 0} tools` : `✗ ${r.error ?? "failed"}` }))
    setMcpTesting(null)
  }

  return (
    <Show when={props.open}>
      <div
        class="modal-backdrop"
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
      >
        <div
          ref={dialogRef}
          class="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="modal-header">
            <div>
              <div id="settings-title" class="modal-title">
                Settings
              </div>
              <div style={{ "font-size": "var(--fs-xs)", color: "var(--fg-subtle)", "margin-top": "2px" }}>
                Configure Mira — models, providers, permissions, and connectors.
              </div>
            </div>
            <button ref={firstFocusRef} type="button" class="modal-close" onClick={props.onClose} aria-label="Close settings">
              ×
            </button>
          </div>

          <div class="settings-layout">
            <nav class="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
              <For each={TABS}>
                {(t) => (
                  <button
                    type="button"
                    role="tab"
                    id={`settings-tab-${t.id}`}
                    aria-selected={tab() === t.id ? "true" : "false"}
                    aria-controls={`settings-panel-${t.id}`}
                    class="settings-tab"
                    onClick={() => setTab(t.id)}
                  >
                    <span aria-hidden="true" style={{ "font-size": "13px", width: "16px", "text-align": "center" }}>
                      {t.icon}
                    </span>
                    <span style={{ display: "flex", "flex-direction": "column", "align-items": "flex-start", gap: "1px" }}>
                      <span>{t.label}</span>
                      <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "font-weight": "400" }}>{t.desc}</span>
                    </span>
                  </button>
                )}
              </For>
              <div style={{ "margin-top": "12px", padding: "8px 0 2px", "border-top": "1px solid var(--border)" }}>
                <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "line-height": "1.5" }}>
                  Changes save to <code style={{ "font-family": "var(--font-mono)", background: "var(--bg-surface)", padding: "1px 4px", "border-radius": "4px" }}>mira.json</code> via PATCH /config.
                </div>
              </div>
            </nav>

            <div class="settings-content scroll">
              {/* ── General ─────────────────────────────────────────── */}
              <Show when={tab() === "general"}>
                <div id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general">
                  <div class="settings-section-title">General</div>

                  <Show when={s().loading}>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                      <div class="skeleton" style={{ height: "64px" }} />
                      <div class="skeleton" style={{ height: "64px" }} />
                    </div>
                  </Show>

                  <Show when={s().error}>
                    <div class="alert" role="alert" style={{ "margin-bottom": "12px" }}>
                      ⚠ {s().error}
                    </div>
                  </Show>

                  <form onSubmit={handleSaveGeneral} style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
                    <div class="settings-card" style={{ display: "flex", "flex-direction": "column", gap: "14px" }}>
                      <div class="settings-field">
                        <label for="settings-model" class="settings-label">
                          Model
                        </label>
                        <input
                          id="settings-model"
                          class="input"
                          value={model()}
                          onInput={(e) => setModel(e.currentTarget.value)}
                          placeholder="openrouter/anthropic/claude-sonnet-4"
                          spellcheck={false}
                          autocomplete="off"
                        />
                        <span class="settings-hint">Primary model for turns. Format: provider/model-id.</span>
                      </div>

                      <div class="settings-field">
                        <label for="settings-small-model" class="settings-label">
                          Small model (compaction)
                        </label>
                        <input
                          id="settings-small-model"
                          class="input"
                          value={smallModel()}
                          onInput={(e) => setSmallModel(e.currentTarget.value)}
                          placeholder="openrouter/deepseek/deepseek-v3.2-exp"
                          spellcheck={false}
                          autocomplete="off"
                        />
                        <span class="settings-hint">Used for context compaction and summaries.</span>
                      </div>

                      <div style={{ "font-size": "var(--fs-xs)", "font-weight": "700", color: "var(--fg-muted)", "letter-spacing": "0.04em", "text-transform": "uppercase", "margin-top": "4px" }}>
                        Loop limits
                      </div>
                      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "10px" }}>
                        <div class="settings-field">
                          <label for="settings-loop-maxsteps" class="settings-label">
                            Max steps
                          </label>
                          <input
                            id="settings-loop-maxsteps"
                            class="input"
                            type="number"
                            min="1"
                            value={loopMaxSteps()}
                            onInput={(e) => setLoopMaxSteps(e.currentTarget.value)}
                            placeholder="32"
                            autocomplete="off"
                          />
                          <span class="settings-hint">LLM turns per prompt.</span>
                        </div>
                        <div class="settings-field">
                          <label for="settings-loop-ctx" class="settings-label">
                            Context limit
                          </label>
                          <input
                            id="settings-loop-ctx"
                            class="input"
                            type="number"
                            min="1000"
                            value={loopContextLimit()}
                            onInput={(e) => setLoopContextLimit(e.currentTarget.value)}
                            placeholder="128000"
                            autocomplete="off"
                          />
                          <span class="settings-hint">Tokens before compaction.</span>
                        </div>
                      </div>
                      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "10px" }}>
                        <div class="settings-field">
                          <label for="settings-loop-thresh" class="settings-label">
                            Compaction threshold
                          </label>
                          <input
                            id="settings-loop-thresh"
                            class="input"
                            type="number"
                            min="0.1"
                            max="1"
                            step="0.05"
                            value={loopThreshold()}
                            onInput={(e) => setLoopThreshold(e.currentTarget.value)}
                            placeholder="0.8"
                            autocomplete="off"
                          />
                          <span class="settings-hint">0–1 fraction of limit.</span>
                        </div>
                        <div class="settings-field">
                          <label for="settings-loop-small" class="settings-label">
                            Loop small model
                          </label>
                          <input
                            id="settings-loop-small"
                            class="input"
                            value={loopSmallModel()}
                            onInput={(e) => setLoopSmallModel(e.currentTarget.value)}
                            placeholder="openrouter/deepseek/..."
                            autocomplete="off"
                            spellcheck={false}
                          />
                          <span class="settings-hint">Overrides smallModel for loops.</span>
                        </div>
                      </div>

                      <div class="settings-field">
                        <label for="settings-theme" class="settings-label">
                          Theme
                        </label>
                        <div style={{ display: "flex", gap: "6px" }}>
                          <For each={(["light", "dark", "system"] as ThemeChoice[])}>
                            {(choice) => (
                              <button
                                type="button"
                                aria-pressed={theme() === choice ? "true" : "false"}
                                onClick={() => setThemeLocal(choice)}
                                style={{
                                  flex: "1",
                                  padding: "8px 10px",
                                  "border-radius": "var(--r-md)",
                                  border: theme() === choice ? "1px solid var(--accent-border)" : "1px solid var(--border)",
                                  background: theme() === choice ? "var(--accent-soft)" : "var(--bg-app)",
                                  color: theme() === choice ? "var(--fg)" : "var(--fg-muted)",
                                  "font-size": "var(--fs-sm)",
                                  "font-weight": theme() === choice ? "600" : "500",
                                  cursor: "pointer",
                                }}
                              >
                                {choice === "light" ? "☀ Light" : choice === "dark" ? "☾ Dark" : "◐ System"}
                              </button>
                            )}
                          </For>
                        </div>
                        <span class="settings-hint">
                          System follows your OS preference via <code style={{ "font-family": "var(--font-mono)" }}>prefers-color-scheme</code>. Stored in localStorage.
                        </span>
                        {/* Hidden select for a11y / form semantics */}
                        <select id="settings-theme" value={theme()} onChange={(e) => setThemeLocal(e.currentTarget.value as ThemeChoice)} class="sr-only" aria-hidden="true" tabindex="-1">
                          <option value="light">Light</option>
                          <option value="dark">Dark</option>
                          <option value="system">System</option>
                        </select>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
                      <button type="button" class="btn btn-ghost" onClick={props.onClose} style={{ padding: "7px 14px", "font-size": "var(--fs-sm)" }}>
                        Cancel
                      </button>
                      <button type="submit" class="btn btn-solid" disabled={props.store.saving()} style={{ padding: "7px 14px", "font-size": "var(--fs-sm)" }}>
                        {props.store.saving() ? "Saving…" : "Save"}
                      </button>
                    </div>

                    <Show when={!s().config && !s().loading}>
                      <div
                        style={{
                          padding: "10px 12px",
                          "border-radius": "var(--r-md)",
                          border: "1px dashed var(--border-strong)",
                          color: "var(--fg-faint)",
                          "font-size": "var(--fs-xs)",
                          "text-align": "center",
                        }}
                      >
                        No config endpoint — server may be older. Settings still apply to theme locally.
                      </div>
                    </Show>
                  </form>
                </div>
              </Show>

              {/* ── Providers ───────────────────────────────────────── */}
              <Show when={tab() === "providers"}>
                <div id="settings-panel-providers" role="tabpanel" aria-labelledby="settings-tab-providers">
                  <div class="settings-section-title">Providers</div>
                  <div class="settings-hint" style={{ "margin-bottom": "12px" }}>
                    API keys are masked. Add a provider to PATCH /config — keys never leave your server.
                  </div>

                  <Show when={s().providers.length === 0 && !s().loading}>
                    <div
                      style={{
                        padding: "14px",
                        border: "1px dashed var(--border-strong)",
                        "border-radius": "var(--r-md)",
                        "text-align": "center",
                        color: "var(--fg-faint)",
                        "font-size": "var(--fs-sm)",
                        "margin-bottom": "12px",
                      }}
                    >
                      No providers configured. Add one below or set keys in <code style={{ "font-family": "var(--font-mono)" }}>mira.json</code>.
                    </div>
                  </Show>

                  <div style={{ display: "flex", "flex-direction": "column", gap: "8px", "margin-bottom": "16px" }}>
                    <For each={s().providers}>
                      {(p) => (
                        <div class="provider-row">
                          <div style={{ display: "flex", "flex-direction": "column", gap: "2px", "min-width": "0" }}>
                            <span style={{ "font-size": "var(--fs-sm)", "font-weight": "600", color: "var(--fg)" }}>{p.name || p.id}</span>
                            <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "font-family": "var(--font-mono)" }}>{p.baseURL || "—"}</span>
                          </div>
                          <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-shrink": "0" }}>
                            <span class="masked-key" title={p.maskedKey}>
                              {p.maskedKey ?? "—"}
                            </span>
                            <button
                              type="button"
                              class="btn btn-outline"
                              disabled={provTesting() === p.id}
                              onClick={() => void handleTestProvider(p.id)}
                              style={{ padding: "5px 10px", "font-size": "var(--fs-xs)" }}
                            >
                              {provTesting() === p.id ? "Testing…" : "Test"}
                            </button>
                            <Show when={provResult()[p.id]}>
                              <span style={{ "font-size": "var(--fs-xs)", color: provResult()[p.id].startsWith("✓") ? "var(--ok)" : "var(--danger)" }}>{provResult()[p.id]}</span>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>

                  <form onSubmit={handleAddProvider} class="settings-card" style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
                    <div style={{ "font-size": "var(--fs-sm)", "font-weight": "600", color: "var(--fg)" }}>Add provider</div>
                    <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "10px" }}>
                      <div class="settings-field">
                        <label for="prov-name" class="settings-label">
                          Provider id
                        </label>
                        <input id="prov-name" class="input" value={provName()} onInput={(e) => setProvName(e.currentTarget.value)} placeholder="openrouter" autocomplete="off" spellcheck={false} />
                      </div>
                      <div class="settings-field">
                        <label for="prov-url" class="settings-label">
                          Base URL (optional)
                        </label>
                        <input id="prov-url" class="input" value={provUrl()} onInput={(e) => setProvUrl(e.currentTarget.value)} placeholder="https://openrouter.ai/api/v1" autocomplete="off" spellcheck={false} />
                      </div>
                    </div>
                    <div class="settings-field">
                      <label for="prov-key" class="settings-label">
                        API key
                      </label>
                      <input id="prov-key" class="input" type="password" value={provKey()} onInput={(e) => setProvKey(e.currentTarget.value)} placeholder="sk-…" autocomplete="off" spellcheck={false} />
                    </div>
                    <div style={{ display: "flex", "justify-content": "flex-end" }}>
                      <button type="submit" class="btn btn-solid" disabled={!provName().trim() || !provKey().trim()} style={{ padding: "6px 12px", "font-size": "var(--fs-sm)" }}>
                        Add provider
                      </button>
                    </div>
                  </form>
                </div>
              </Show>

              {/* ── Permissions ─────────────────────────────────────── */}
              <Show when={tab() === "permissions"}>
                <div id="settings-panel-permissions" role="tabpanel" aria-labelledby="settings-tab-permissions">
                  <div class="settings-section-title">Permissions</div>
                  <div class="settings-hint" style={{ "margin-bottom": "12px" }}>
                    7-layer config: explicit deny → allow → pattern → BashArity → default ask. Read from{" "}
                    <code style={{ "font-family": "var(--font-mono)" }}>GET /permission</code> when available, otherwise{" "}
                    <code style={{ "font-family": "var(--font-mono)" }}>config.permission</code>.
                  </div>

                  <Show
                    when={s().permission !== null && Object.keys(s().permission ?? {}).length > 0}
                    fallback={
                      <div
                        style={{
                          padding: "14px",
                          border: "1px dashed var(--border-strong)",
                          "border-radius": "var(--r-md)",
                          "text-align": "center",
                          color: "var(--fg-faint)",
                          "font-size": "var(--fs-sm)",
                        }}
                      >
                        No permission rules found. Configure in <code style={{ "font-family": "var(--font-mono)" }}>mira.json → permission</code> — e.g.{" "}
                        <code style={{ "font-family": "var(--font-mono)" }}>&#123;"bash":"allow","read":"allow"&#125;</code>.
                      </div>
                    }
                  >
                    <div class="settings-card" style={{ padding: "0", overflow: "hidden" }}>
                      <table class="perm-table">
                        <thead>
                          <tr>
                            <th>Tool / pattern</th>
                            <th>Policy</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={Object.entries((s().permission ?? {}) as Record<string, string | Record<string, string> >)}>
                            {([tool, rule]) => {
                              const isRecord = typeof rule === "object" && rule !== null
                              return (
                                <>
                                  <Show
                                    when={!isRecord}
                                    fallback={
                                      <For each={Object.entries(rule as Record<string, string>)}>
                                        {([pattern, action]) => (
                                          <tr>
                                            <td>
                                              <span style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-xs)", color: "var(--fg)" }}>{tool}</span>
                                              <span style={{ color: "var(--fg-faint)", "margin-left": "6px" }}>{pattern}</span>
                                            </td>
                                            <td>
                                              <span class={`perm-badge ${action === "allow" ? "perm-allow" : action === "deny" ? "perm-deny" : "perm-ask"}`}>{action}</span>
                                            </td>
                                          </tr>
                                        )}
                                      </For>
                                    }
                                  >
                                    <tr>
                                      <td style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-xs)", color: "var(--fg)" }}>{tool}</td>
                                      <td>
                                        <span class={`perm-badge ${rule === "allow" ? "perm-allow" : rule === "deny" ? "perm-deny" : "perm-ask"}`}>{String(rule)}</span>
                                      </td>
                                    </tr>
                                  </Show>
                                </>
                              )
                            }}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>

                  <div style={{ "margin-top": "10px", "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "line-height": "1.6" }}>
                    Per-agent overrides live in <code style={{ "font-family": "var(--font-mono)" }}>agents.*.permissions</code> (readonly / standard / elevated). MCP tools surface as{" "}
                    <code style={{ "font-family": "var(--font-mono)" }}>mcp__&lt;server&gt;__*</code>.
                  </div>
                </div>
              </Show>

              {/* ── Connectors (MCP) ────────────────────────────────── */}
              <Show when={tab() === "connectors"}>
                <div id="settings-panel-connectors" role="tabpanel" aria-labelledby="settings-tab-connectors">
                  <div class="settings-section-title">Connectors — MCP</div>
                  <div class="settings-hint" style={{ "margin-bottom": "12px" }}>
                    Model Context Protocol servers. Toggle, test, or add via <code style={{ "font-family": "var(--font-mono)" }}>PATCH /config</code> /{" "}
                    <code style={{ "font-family": "var(--font-mono)" }}>POST /mcp</code>.
                  </div>

                  <Show when={s().mcp.length === 0 && !s().loading}>
                    <div
                      style={{
                        padding: "14px",
                        border: "1px dashed var(--border-strong)",
                        "border-radius": "var(--r-md)",
                        "text-align": "center",
                        color: "var(--fg-faint)",
                        "font-size": "var(--fs-sm)",
                        "margin-bottom": "12px",
                      }}
                    >
                      No MCP servers connected. Add one below — local (stdio) or remote (StreamableHTTP/SSE).
                    </div>
                  </Show>

                  <div style={{ display: "flex", "flex-direction": "column", gap: "8px", "margin-bottom": "16px" }}>
                    <For each={s().mcp}>
                      {(srv) => (
                        <div class="mcp-row">
                          <div style={{ display: "flex", gap: "10px", "align-items": "center", "min-width": "0", flex: "1" }}>
                            <span
                              class="dot"
                              style={{
                                width: "8px",
                                height: "8px",
                                background: srv.status === "connected" ? "var(--ok)" : srv.status === "disabled" ? "var(--fg-faint)" : "var(--danger)",
                                "box-shadow": srv.status === "connected" ? "0 0 8px var(--ok-soft)" : "none",
                              }}
                            />
                            <div style={{ display: "flex", "flex-direction": "column", gap: "2px", "min-width": "0" }}>
                              <span style={{ "font-size": "var(--fs-sm)", "font-weight": "600", color: "var(--fg)", "font-family": "var(--font-mono)" }}>{srv.name}</span>
                              <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)" }}>
                                {srv.type} · {srv.toolCount} tools · {srv.status}
                                {srv.error ? ` · ${srv.error}` : ""}
                              </span>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: "6px", "align-items": "center", "flex-shrink": "0", "flex-wrap": "wrap", "justify-content": "flex-end" }}>
                            <label style={{ display: "inline-flex", "align-items": "center", gap: "6px", "font-size": "var(--fs-xs)", color: "var(--fg-muted)", cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={srv.status !== "disabled"}
                                onChange={(e) => void handleToggleMcp(srv.name, e.currentTarget.checked)}
                                aria-label={`Enable ${srv.name}`}
                              />
                              enabled
                            </label>
                            <button
                              type="button"
                              class="btn btn-outline"
                              disabled={mcpTesting() === srv.name}
                              onClick={() => void handleTestMcp(srv.name)}
                              style={{ padding: "5px 10px", "font-size": "var(--fs-xs)" }}
                            >
                              {mcpTesting() === srv.name ? "Testing…" : "Test"}
                            </button>
                            <button
                              type="button"
                              class="btn btn-ghost"
                              onClick={() => void props.store.removeMcp(srv.name)}
                              title={`Remove ${srv.name}`}
                              style={{ padding: "5px 8px", "font-size": "var(--fs-xs)", color: "var(--danger)" }}
                            >
                              Remove
                            </button>
                            <Show when={mcpResult()[srv.name]}>
                              <span style={{ "font-size": "var(--fs-xs)", color: mcpResult()[srv.name].startsWith("✓") ? "var(--ok)" : "var(--danger)" }}>{mcpResult()[srv.name]}</span>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>

                  <form onSubmit={handleAddMcp} class="settings-card" style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
                    <div style={{ "font-size": "var(--fs-sm)", "font-weight": "600", color: "var(--fg)" }}>Add MCP server</div>
                    <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "10px" }}>
                      <div class="settings-field">
                        <label for="mcp-name" class="settings-label">
                          Name
                        </label>
                        <input id="mcp-name" class="input" value={mcpName()} onInput={(e) => setMcpName(e.currentTarget.value)} placeholder="my-tools" autocomplete="off" spellcheck={false} />
                      </div>
                      <div class="settings-field">
                        <label for="mcp-type" class="settings-label">
                          Type
                        </label>
                        <select id="mcp-type" class="input" value={mcpType()} onChange={(e) => setMcpType(e.currentTarget.value as "local" | "remote")}>
                          <option value="local">local (stdio)</option>
                          <option value="remote">remote (http/sse)</option>
                        </select>
                      </div>
                    </div>
                    <Show
                      when={mcpType() === "local"}
                      fallback={
                        <div class="settings-field">
                          <label for="mcp-url" class="settings-label">
                            URL
                          </label>
                          <input id="mcp-url" class="input" value={mcpUrl()} onInput={(e) => setMcpUrl(e.currentTarget.value)} placeholder="https://mcp.example.com/mcp" autocomplete="off" spellcheck={false} />
                        </div>
                      }
                    >
                      <div class="settings-field">
                        <label for="mcp-command" class="settings-label">
                          Command
                        </label>
                        <input
                          id="mcp-command"
                          class="input"
                          value={mcpCommand()}
                          onInput={(e) => setMcpCommand(e.currentTarget.value)}
                          placeholder="npx -y my-mcp-server"
                          autocomplete="off"
                          spellcheck={false}
                        />
                        <span class="settings-hint">Spawned via stdio. Env vars with {"{env:VAR}"} are expanded server-side.</span>
                      </div>
                    </Show>
                    <div style={{ display: "flex", "justify-content": "flex-end" }}>
                      <button type="submit" class="btn btn-solid" disabled={!mcpName().trim()} style={{ padding: "6px 12px", "font-size": "var(--fs-sm)" }}>
                        Add server
                      </button>
                    </div>
                  </form>
                </div>
              </Show>

              {/* ── Agents ──────────────────────────────────────────── */}
              <Show when={tab() === "agents"}>
                <div id="settings-panel-agents" role="tabpanel" aria-labelledby="settings-tab-agents">
                  <div class="settings-section-title">Agents</div>
                  <div class="settings-hint" style={{ "margin-bottom": "12px" }}>
                    Lane personas from <code style={{ "font-family": "var(--font-mono)" }}>GET /agents</code> — built-in + custom{" "}
                    <code style={{ "font-family": "var(--font-mono)" }}>mira.json → agents</code>.
                  </div>

                  <Show when={s().agents.length === 0 && !s().loading}>
                    <div
                      style={{
                        padding: "14px",
                        border: "1px dashed var(--border-strong)",
                        "border-radius": "var(--r-md)",
                        "text-align": "center",
                        color: "var(--fg-faint)",
                        "font-size": "var(--fs-sm)",
                      }}
                    >
                      No agents reported. Is the server running?
                    </div>
                  </Show>

                  <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                    <For each={s().agents}>
                      {(a) => (
                        <div class="settings-card" style={{ padding: "12px 14px" }}>
                          <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap" }}>
                            <span style={{ "font-size": "var(--fs-sm)", "font-weight": "700", color: "var(--fg)", "font-family": "var(--font-mono)" }}>{a.name}</span>
                            <span class={`pill ${a.custom ? "pill-accent" : ""}`} style={{ "font-size": "var(--fs-2xs)" }}>
                              {a.custom ? "custom" : "built-in"}
                            </span>
                            <span class={`pill ${a.permissions === "readonly" ? "pill-ok" : a.permissions === "elevated" ? "pill-danger" : "pill-warn"}`} style={{ "font-size": "var(--fs-2xs)" }}>
                              {a.permissions}
                            </span>
                          </div>
                          <div style={{ "font-size": "var(--fs-sm)", color: "var(--fg-subtle)", "margin-top": "6px", "line-height": "1.5" }}>{a.description || "No description"}</div>
                          <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px", "margin-top": "8px" }}>
                            <For each={a.tools}>
                              {(tool) => (
                                <span
                                  style={{
                                    "font-family": "var(--font-mono)",
                                    "font-size": "var(--fs-2xs)",
                                    padding: "2px 7px",
                                    "border-radius": "var(--r-full)",
                                    border: "1px solid var(--border)",
                                    background: "var(--bg-app)",
                                    color: "var(--fg-muted)",
                                  }}
                                >
                                  {tool}
                                </span>
                              )}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              {/* ── Commands ────────────────────────────────────────── */}
              <Show when={tab() === "commands"}>
                <div id="settings-panel-commands" role="tabpanel" aria-labelledby="settings-tab-commands">
                  <div class="settings-section-title">Commands & Skills</div>
                  <div class="settings-hint" style={{ "margin-bottom": "12px" }}>
                    Slash commands from <code style={{ "font-family": "var(--font-mono)" }}>.opencode/commands/*.md</code> via{" "}
                    <code style={{ "font-family": "var(--font-mono)" }}>GET /commands</code> + skills from{" "}
                    <code style={{ "font-family": "var(--font-mono)" }}>GET /skills</code>. Type <code style={{ "font-family": "var(--font-mono)" }}>/</code> in the composer or press{" "}
                    <span class="kbd">Ctrl+P</span> to fuzzy-search.
                  </div>

                  <Show when={s().commands.length === 0 && s().skills.length === 0 && !s().loading}>
                    <div
                      style={{
                        padding: "14px",
                        border: "1px dashed var(--border-strong)",
                        "border-radius": "var(--r-md)",
                        "text-align": "center",
                        color: "var(--fg-faint)",
                        "font-size": "var(--fs-sm)",
                      }}
                    >
                      No commands or skills found. Add markdown files to{" "}
                      <code style={{ "font-family": "var(--font-mono)" }}>.opencode/commands/</code> or{" "}
                      <code style={{ "font-family": "var(--font-mono)" }}>packages/server/data/skills/</code>.
                    </div>
                  </Show>

                  <Show when={s().commands.length > 0}>
                    <div style={{ "font-size": "var(--fs-xs)", "font-weight": "700", color: "var(--fg-muted)", "letter-spacing": "0.04em", "text-transform": "uppercase", "margin-bottom": "8px" }}>
                      Slash commands · {s().commands.length}
                    </div>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "margin-bottom": "16px" }}>
                      <For each={s().commands}>
                        {(c) => (
                          <div class="settings-card" style={{ padding: "10px 12px", display: "flex", "justify-content": "space-between", gap: "12px", "align-items": "center" }}>
                            <div>
                              <div style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-sm)", "font-weight": "600", color: "var(--fg)" }}>{c.name}</div>
                              <div style={{ "font-size": "var(--fs-xs)", color: "var(--fg-subtle)", "margin-top": "2px" }}>{c.description || "No description"}</div>
                            </div>
                            <span class="pill" style={{ "font-size": "var(--fs-2xs)", "flex-shrink": "0" }}>
                              {c.source}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={s().skills.length > 0}>
                    <div style={{ "font-size": "var(--fs-xs)", "font-weight": "700", color: "var(--fg-muted)", "letter-spacing": "0.04em", "text-transform": "uppercase", "margin-bottom": "8px" }}>
                      Skills · {s().skills.length}
                    </div>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                      <For each={s().skills}>
                        {(sk) => (
                          <div class="settings-card" style={{ padding: "10px 12px" }}>
                            <div style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-sm)", "font-weight": "600", color: "var(--fg)" }}>{sk.name}</div>
                            <div style={{ "font-size": "var(--fs-xs)", color: "var(--fg-subtle)", "margin-top": "2px", "line-height": "1.45" }}>{sk.description || "No description"}</div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}
