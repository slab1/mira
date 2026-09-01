/**
 * Admin Models Panel — curated model catalog management (backend admin surface).
 *
 * Backed by the /admin/providers/:id/models/* endpoints (master-token owner or
 * open dev servers). The catalog is the single source of truth for the picker:
 *   - Sync from provider  → live auto-fetch, never-delete upsert
 *   - Hide / Deprecate    → flags preserved across re-syncs (hide before delete)
 *   - Delete              → permanent removal from the registry (2-step confirm)
 *   - Inline name/limit   → PATCH on blur
 *
 * Gated on GET /admin/whoami.isAdmin — non-admins get a notice instead.
 */

import { createSignal, Show, For } from "solid-js"
import type { SettingsStore } from "../stores/settings"
import type { ProviderConfig } from "../api/client"

function ProviderCatalogSection(props: { store: SettingsStore; pid: string; prov: ProviderConfig }) {
  const s = () => props.store.state
  const models = () => s().config?.provider?.[props.pid]?.models ?? {}

  // sync
  const [syncing, setSyncing] = createSignal(false)
  const [syncMsg, setSyncMsg] = createSignal<{ text: string; err: boolean } | null>(null)
  // add form
  const [newId, setNewId] = createSignal("")
  const [newName, setNewName] = createSignal("")
  const [newCtx, setNewCtx] = createSignal("")
  const [newOut, setNewOut] = createSignal("")
  const [adding, setAdding] = createSignal(false)
  // inline edits keyed by modelId
  const [edits, setEdits] = createSignal<Record<string, { name?: string; context?: string; output?: string }>>({})
  // 2-step delete
  const [confirmDel, setConfirmDel] = createSignal<string | null>(null)

  async function handleSync() {
    setSyncing(true)
    setSyncMsg(null)
    const r = await props.store.syncModels(props.pid)
    setSyncing(false)
    if (!r) setSyncMsg({ text: "sync failed", err: true })
    else if (r.error) setSyncMsg({ text: r.error, err: true })
    else setSyncMsg({ text: `added ${r.added?.length ?? 0} · updated ${r.updated?.length ?? 0} · total ${r.total ?? 0}`, err: false })
  }

  async function handleAdd() {
    const id = newId().trim()
    if (!id) return
    setAdding(true)
    const ctx = Number(newCtx() || "0")
    const out = Number(newOut() || "0")
    await props.store.syncModels(props.pid, [{ id, name: newName().trim() || id, ...(ctx > 0 || out > 0 ? { limit: { context: ctx > 0 ? ctx : 0, output: out > 0 ? out : 0 } } : {}) }])
    setAdding(false)
    setNewId("")
    setNewName("")
    setNewCtx("")
    setNewOut("")
  }

  function commitEdit(modelId: string, field: "name" | "context" | "output") {
    const e = edits()[modelId]
    if (!e) return
    const patch: Record<string, unknown> = {}
    if (field === "name") {
      const name = e.name?.trim()
      if (typeof name === "string" && name) patch.name = name
    } else {
      const cur = models()[modelId]?.limit
      if (e.context !== undefined && e.context !== "") patch.limit = { context: Number(e.context), output: cur?.output ?? 0 }
      if (e.output !== undefined && e.output !== "") patch.limit = { context: cur?.context ?? 0, output: Number(e.output) }
    }
    if (Object.keys(patch).length > 0) void props.store.patchModel(props.pid, modelId, patch as never)
    setEdits((prev) => ({ ...prev, [modelId]: {} }))
  }

  function setEdit(modelId: string, field: "name" | "context" | "output", value: string) {
    setEdits((prev) => ({ ...prev, [modelId]: { ...(prev[modelId] ?? {}), [field]: value } }))
  }

  async function handleDelete(modelId: string) {
    if (confirmDel() !== modelId) {
      setConfirmDel(modelId)
      setTimeout(() => setConfirmDel((v) => (v === modelId ? null : v)), 3000)
      return
    }
    setConfirmDel(null)
    await props.store.deleteModel(props.pid, modelId)
  }

  const ids = () => Object.keys(models())

  return (
    <div class="settings-card" style={{ display: "flex", "flex-direction": "column", gap: "10px", "margin-bottom": "12px" }}>
      <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap" }}>
        <span style={{ "font-size": "var(--fs-sm)", "font-weight": "600", color: "var(--fg)" }}>{props.prov.name || props.pid}</span>
        <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "font-family": "var(--font-mono)" }}>{props.prov.options.baseURL || "—"}</span>
        <div style={{ "margin-left": "auto", display: "flex", gap: "8px", "align-items": "center" }}>
          <button type="button" class="btn btn-outline" disabled={syncing()} onClick={() => void handleSync()} style={{ padding: "5px 10px", "font-size": "var(--fs-xs)" }}>
            {syncing() ? "Syncing…" : "Sync from provider"}
          </button>
          <Show when={syncMsg()}>
            <span style={{ "font-size": "var(--fs-xs)", color: syncMsg()!.err ? "var(--danger)" : "var(--ok)" }}>{syncMsg()!.text}</span>
          </Show>
        </div>
      </div>

      {/* model rows */}
      <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
        <Show
          when={ids().length > 0}
          fallback={
            <div style={{ padding: "10px", border: "1px dashed var(--border-strong)", "border-radius": "var(--r-md)", "font-size": "var(--fs-xs)", color: "var(--fg-faint)", "text-align": "center" }}>
              No models in the registry yet — <em>Sync from provider</em> to import the live catalog, or add one below.
            </div>
          }
        >
          <For each={ids()}>
            {(mid) => {
              const m = () => models()[mid] ?? ({} as NonNullable<ReturnType<typeof models>[string]>)
              const e = () => edits()[mid]
              return (
                <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap", padding: "6px 8px", border: "1px solid var(--border)", "border-radius": "var(--r-sm)", background: "var(--bg-surface)" }}>
                  <code style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-2xs)", color: "var(--fg)" }}>{mid}</code>
                  <Show when={m().enabled === false}>
                    <span class="pill" style={{ "font-size": "var(--fs-2xs)" }}>hidden</span>
                  </Show>
                  <Show when={m().deprecated}>
                    <span class="pill" style={{ "font-size": "var(--fs-2xs)" }}>deprecated</span>
                  </Show>

                  <input
                    class="input"
                    value={(e()?.name ?? m().name ?? mid) as string}
                    onInput={(ev) => setEdit(mid, "name", ev.currentTarget.value)}
                    onBlur={() => commitEdit(mid, "name")}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") (ev.currentTarget as HTMLInputElement).blur()
                    }}
                    placeholder="name"
                    aria-label={`${mid} name`}
                    style={{ "flex": "1 1 140px", "min-width": "120px", padding: "4px 8px", "font-size": "var(--fs-xs)" }}
                  />

                  <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)" }}>ctx</span>
                  <input
                    class="input"
                    value={(e()?.context ?? String(m().limit?.context ?? "")) as string}
                    onInput={(ev) => setEdit(mid, "context", ev.currentTarget.value)}
                    onBlur={() => commitEdit(mid, "context")}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") (ev.currentTarget as HTMLInputElement).blur()
                    }}
                    aria-label={`${mid} context limit`}
                    style={{ width: "74px", padding: "4px 8px", "font-size": "var(--fs-xs)" }}
                  />
                  <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)" }}>out</span>
                  <input
                    class="input"
                    value={(e()?.output ?? String(m().limit?.output ?? "")) as string}
                    onInput={(ev) => setEdit(mid, "output", ev.currentTarget.value)}
                    onBlur={() => commitEdit(mid, "output")}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") (ev.currentTarget as HTMLInputElement).blur()
                    }}
                    aria-label={`${mid} output limit`}
                    style={{ width: "74px", padding: "4px 8px", "font-size": "var(--fs-xs)" }}
                  />

                  <div style={{ display: "flex", gap: "6px", "align-items": "center", "flex-shrink": "0" }}>
                    <button
                      type="button"
                      class="btn btn-outline"
                      onClick={() => void props.store.patchModel(props.pid, mid, { enabled: m().enabled === false ? true : false } as never)}
                      title={m().enabled === false ? "Show in picker (keep config)" : "Hide from picker (still callable by ref)"}
                      style={{ padding: "4px 8px", "font-size": "var(--fs-2xs)" }}
                    >
                      {m().enabled === false ? "Show" : "Hide"}
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      onClick={() => void props.store.patchModel(props.pid, mid, { deprecated: !m().deprecated } as never)}
                      title="Mark deprecated"
                      style={{ padding: "4px 8px", "font-size": "var(--fs-2xs)" }}
                    >
                      {m().deprecated ? "Un-deprecate" : "Deprecate"}
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      onClick={() => void handleDelete(mid)}
                      title="Permanently remove from registry"
                      style={{ padding: "4px 8px", "font-size": "var(--fs-2xs)", color: "var(--danger)" }}
                    >
                      {confirmDel() === mid ? "Sure?" : "Delete"}
                    </button>
                  </div>
                </div>
              )
            }}
          </For>
        </Show>
      </div>

      {/* add form */}
      <form
        onSubmit={(ev) => {
          ev.preventDefault()
          void handleAdd()
        }}
        style={{ display: "flex", gap: "8px", "align-items": "flex-end", "flex-wrap": "wrap" }}
      >
        <div class="settings-field" style={{ "flex-grow": "0" }}>
          <label class="settings-label" for={`add-id-${props.pid}`}>
            Model id
          </label>
          <input id={`add-id-${props.pid}`} class="input" value={newId()} onInput={(e) => setNewId(e.currentTarget.value)} placeholder="claude-sonnet-4" autocomplete="off" spellcheck={false} style={{ padding: "4px 8px", "font-size": "var(--fs-xs)", width: "150px" }} />
        </div>
        <div class="settings-field" style={{ "flex-grow": "1", "flex-basis": "120px" }}>
          <label class="settings-label" for={`add-name-${props.pid}`}>
            Display name
          </label>
          <input id={`add-name-${props.pid}`} class="input" value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} placeholder="Claude Sonnet 4" autocomplete="off" spellcheck={false} style={{ padding: "4px 8px", "font-size": "var(--fs-xs)", width: "100%" }} />
        </div>
        <div class="settings-field" style={{ "flex-grow": "0" }}>
          <label class="settings-label" for={`add-ctx-${props.pid}`}>
            Context
          </label>
          <input id={`add-ctx-${props.pid}`} class="input" type="number" value={newCtx()} onInput={(e) => setNewCtx(e.currentTarget.value)} placeholder="200000" autocomplete="off" style={{ padding: "4px 8px", "font-size": "var(--fs-xs)", width: "90px" }} />
        </div>
        <div class="settings-field" style={{ "flex-grow": "0" }}>
          <label class="settings-label" for={`add-out-${props.pid}`}>
            Output
          </label>
          <input id={`add-out-${props.pid}`} class="input" type="number" value={newOut()} onInput={(e) => setNewOut(e.currentTarget.value)} placeholder="8192" autocomplete="off" style={{ padding: "4px 8px", "font-size": "var(--fs-xs)", width: "90px" }} />
        </div>
        <button type="submit" class="btn btn-solid" disabled={!newId().trim() || adding()} style={{ padding: "5px 12px", "font-size": "var(--fs-xs)" }}>
          {adding() ? "Adding…" : "Add model"}
        </button>
      </form>
    </div>
  )
}

export function AdminModelsPanel(props: { store: SettingsStore }) {
  const s = () => props.store.state

  const providers = () => {
    const cfg = s().config?.provider ?? {}
    const ids = s().providers.length > 0 ? s().providers.map((p) => p.id) : Object.keys(cfg)
    return ids.filter((id) => cfg[id])
  }

  return (
    <div id="settings-panel-models" role="tabpanel" aria-labelledby="settings-tab-models">
      <Show
        when={s().isAdmin}
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
            🛡 Admins only — connect with the master <code style={{ "font-family": "var(--font-mono)" }}>MIRA_TOKEN</code> to manage the curated model catalog.
          </div>
        }
      >
        <div class="settings-section-title">Curated model catalog</div>
        <div class="settings-hint" style={{ "margin-bottom": "12px" }}>
          Single source of truth for the model picker. <em>Hide</em> removes a model from the picker (still callable by ref) —{' '}
          <em>Delete</em> permanently removes it. Flags survive re-syncs.
        </div>
        <For each={providers()}>{(pid) => <ProviderCatalogSection store={props.store} pid={pid} prov={s().config?.provider?.[pid]!} />}</For>
      </Show>
    </div>
  )
}