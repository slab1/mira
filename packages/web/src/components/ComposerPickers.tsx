/**
 * Composer pickers — model selector chip + @mention autocomplete.
 *
 * ModelPicker: chip in the composer footer showing the active model; opens a
 * listbox popover fed by GET /models (active provider's curated catalog).
 * Selecting persists via settings.saveConfig({ model }) — the same PATCH
 * /config path the Settings General tab uses.
 *
 * MentionPicker: triggered by "@" at the start of a token in the composer.
 * Suggests agent lanes (GET /agents) + workspace files (GET /workspace/tree,
 * newest-first). Inserting replaces the "@query" token with "@token ".
 */

import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import type { SettingsStore } from "../stores/settings"
import { api, type AgentEntry, type WorkspaceEntry } from "../api/client"

// ── Model picker ───────────────────────────────────────────────────

export function ModelPicker(props: { settings: SettingsStore; onOpenSettings?: () => void }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [models] = createResource(() => (open() ? api.listModels().catch(() => null) : null))

  const active = () => props.settings.state.config?.model ?? ""
  const short = () => {
    const a = active()
    if (!a) return "model"
    const seg = a.split("/")
    return seg[seg.length - 1] || a
  }
  const filtered = () => {
    const list = models()?.models ?? []
    const q = query().trim().toLowerCase()
    if (!q) return list
    return list.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
  }

  // close on outside click / Escape
  createEffect(() => {
    if (!open()) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest(".picker-popover") && !t.closest("[data-model-chip]")) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    })
  })

  const pick = (id: string) => {
    void props.settings.saveConfig({ model: id })
    setOpen(false)
    setQuery("")
  }

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        data-model-chip
        class="chip"
        aria-expanded={open() ? "true" : "false"}
        aria-haspopup="listbox"
        aria-label="Select model"
        onClick={() => setOpen((v) => !v)}
        title={`Model: ${active() || "not set"} — click to switch`}
        style={{ "max-width": "220px" }}
      >
        <span class="chip-name" style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
          {short()}
        </span>
        <span class="chip-chevron" aria-hidden="true">▾</span>
      </button>
      <Show when={open()}>
        <div class="picker-popover" role="listbox" aria-label="Model picker">
          <div class="picker-filter">
            <input
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="Filter models…"
              autocomplete="off"
              spellcheck={false}
              aria-label="Filter models"
            />
          </div>
          <div class="picker-list">
            <Show when={!models.loading} fallback={<div class="picker-empty">Loading models…</div>}>
              <Show
                when={(models()?.models.length ?? 0) > 0}
                fallback={
                  <div class="picker-empty" style={{ display: "flex", "flex-direction": "column", gap: "8px", "align-items": "center" }}>
                    <span>No models configured.</span>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      onClick={() => {
                        setOpen(false)
                        props.onOpenSettings?.()
                      }}
                      style={{ "font-size": "var(--fs-xs)", "border-radius": "var(--r-md)" }}
                    >
                      Add provider key →
                    </button>
                  </div>
                }
              >
                <div class="picker-section">{models()?.provider ?? "Models"}</div>
                <Show when={filtered().length > 0} fallback={<div class="picker-empty">No models match.</div>}>
                  <For each={filtered()}>
                    {(m) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={m.id === active() ? "true" : "false"}
                        class="picker-item"
                        onClick={() => pick(m.id)}
                      >
                        <span style={{ display: "flex", "flex-direction": "column", gap: "1px", "min-width": "0", "text-align": "left" }}>
                          <span class="picker-item-name">{m.name || m.id}</span>
                          <span class="picker-item-desc">
                            {m.id}
                            {m.deprecated ? " · deprecated" : ""}
                          </span>
                        </span>
                        <Show when={m.id === active()}>
                          <span class="pill pill-ok" style={{ "font-size": "var(--fs-2xs)", "flex-shrink": "0" }}>active</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </Show>
          </div>
          <div class="picker-footer">
            <span>
              {models()?.provider ? `${models()?.provider} · key ${models()?.hasKey ? "set" : "missing"}` : "No provider configured"}
            </span>
          </div>
        </div>
      </Show>
    </span>
  )
}

// ── @mention picker ────────────────────────────────────────────────

export type MentionItem = { kind: "agent" | "file"; token: string; label: string; desc: string }

/** Flatten agents + files into one ordered list, filtered by the mention query. */
export function mentionFlat(agents: AgentEntry[], files: WorkspaceEntry[], query: string): MentionItem[] {
  const q = query.trim().toLowerCase()
  const match = (s: string) => !q || s.toLowerCase().includes(q)
  const a = agents
    .filter((x) => match(x.name))
    .map((x) => ({ kind: "agent" as const, token: x.name, label: x.name, desc: x.description }))
  const f = files
    .filter((x) => match(x.path))
    .map((x) => ({ kind: "file" as const, token: x.path, label: x.path, desc: "" }))
  return [...a, ...f]
}

export function MentionPicker(props: {
  query: string
  agents: AgentEntry[]
  files: WorkspaceEntry[]
  selected: number
  onSelect: (token: string) => void
  onClose: () => void
}) {
  const items = () => mentionFlat(props.agents, props.files, props.query)
  return (
    <Show when={items().length > 0}>
      <div class="picker-popover" role="listbox" aria-label="Mention picker">
        <div class="picker-list">
          <For each={items()}>
            {(item, i) => (
              <>
                <Show when={i() === 0 || items()[i() - 1].kind !== item.kind}>
                  <div class="picker-section">{item.kind === "agent" ? "Agents" : "Files"}</div>
                </Show>
                <button
                  type="button"
                  role="option"
                  aria-selected={props.selected === i() ? "true" : "false"}
                  class="picker-item"
                  onClick={() => props.onSelect(item.token)}
                >
                  <span style={{ display: "flex", "flex-direction": "column", gap: "1px", "min-width": "0", "text-align": "left" }}>
                    <span class="picker-item-name">{item.label}</span>
                    <Show when={item.desc}>
                      <span class="picker-item-desc">{item.desc}</span>
                    </Show>
                  </span>
                  <span class="pill" style={{ "font-size": "var(--fs-2xs)", "flex-shrink": "0" }}>{item.kind}</span>
                </button>
              </>
            )}
          </For>
        </div>
        <div class="picker-footer">
          <span>
            <span class="kbd">↑↓</span> nav
          </span>
          <span>·</span>
          <span>
            <span class="kbd">Enter</span> insert
          </span>
          <span>·</span>
          <span>
            <span class="kbd">Esc</span> close
          </span>
        </div>
      </div>
    </Show>
  )
}