import { createSignal, createEffect, For, Show, onCleanup } from "solid-js"
import type { SettingsStore } from "../stores/settings"
import type { CommandEntry } from "../api/client"

// ── Fuzzy ──────────────────────────────────────────────────────────

/**
 * Simple fuzzy score: characters of `query` must appear in order in `target`.
 * Higher score = better match. Prefix and consecutive bonuses.
 * Returns 0 if no match.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (!q) return 1
  if (t.includes(q)) return 100 + (t.startsWith(q) ? 50 : 0) - t.length * 0.1

  let qi = 0
  let ti = 0
  let score = 0
  let consecutive = 0
  let lastMatch = -2

  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      const bonus = ti === 0 ? 10 : 0
      const contBonus = ti === lastMatch + 1 ? 5 + consecutive : 0
      score += 10 + bonus + contBonus
      consecutive = ti === lastMatch + 1 ? consecutive + 1 : 0
      lastMatch = ti
      qi++
    } else {
      consecutive = 0
    }
    ti++
  }
  if (qi < q.length) return 0
  // Penalize long targets
  score -= t.length * 0.2
  return score
}

export function filterCommands(query: string, commands: CommandEntry[]): CommandEntry[] {
  const q = query.trim().toLowerCase().replace(/^\//, "")
  if (!q) return commands.slice(0, 20)
  const scored = commands
    .map((c) => {
      const nameScore = fuzzyScore(q, c.name.replace(/^\//, ""))
      const descScore = fuzzyScore(q, c.description) * 0.5
      const s = Math.max(nameScore, descScore)
      return { c, s }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
  return scored.slice(0, 20).map((x) => x.c)
}

// ── Global palette (Ctrl+P) ────────────────────────────────────────

export function CommandPalette(props: {
  settings: SettingsStore
  open: boolean
  onClose: () => void
  onInsert: (text: string) => void
}) {
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  let inputRef: HTMLInputElement | undefined

  const commands = () => props.settings.allCommands()
  const filtered = () => filterCommands(query(), commands())

  createEffect(() => {
    if (props.open) {
      setQuery("")
      setSelected(0)
      queueMicrotask(() => inputRef?.focus())
      // Ensure commands are loaded
      if (commands().length === 0) void props.settings.loadAll()
    }
  })

  // Keyboard nav inside palette
  const onKeyDown = (e: KeyboardEvent) => {
    const list = filtered()
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, list.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const item = list[selected()]
      if (item) {
        props.onInsert(item.name + " ")
        props.onClose()
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      props.onClose()
    }
  }

  // Global Ctrl+P / Cmd+P listener — also "/" when not in input
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isModP = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p"
      if (isModP) {
        e.preventDefault()
        if (props.open) props.onClose()
        else {
          // Open palette — parent controls open state via App
          // Dispatch custom event so App can react even if this component isn't mounted open
          window.dispatchEvent(new CustomEvent("mira:open-palette"))
        }
      }
    }
    window.addEventListener("keydown", handler)
    onCleanup(() => window.removeEventListener("keydown", handler))
  })

  return (
    <Show when={props.open}>
      <div
        class="palette-backdrop"
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
      >
        <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
          <div class="palette-input-wrap">
            <span aria-hidden="true" style={{ color: "var(--fg-faint)", "font-size": "14px" }}>
              ⌘
            </span>
            <input
              ref={inputRef}
              class="palette-input"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value)
                setSelected(0)
              }}
              onKeyDown={onKeyDown}
              placeholder="Type a command or skill…  (/ for slash commands)"
              aria-label="Search commands"
              spellcheck={false}
              autocomplete="off"
            />
            <span class="palette-kbd">ESC</span>
          </div>

          <div class="palette-list" role="listbox" aria-label="Commands">
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="palette-empty">
                  No commands match “{query()}”. Try <code style={{ "font-family": "var(--font-mono)" }}>/</code> to see all.
                </div>
              }
            >
              <For each={filtered()}>
                {(cmd, i) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected() === i() ? "true" : "false"}
                    class="palette-item"
                    onMouseEnter={() => setSelected(i())}
                    onClick={() => {
                      props.onInsert(cmd.name + " ")
                      props.onClose()
                    }}
                  >
                    <span style={{ display: "flex", "flex-direction": "column", gap: "2px", "min-width": "0" }}>
                      <span class="palette-item-name">{cmd.name}</span>
                      <Show when={cmd.description}>
                        <span class="palette-item-desc">{cmd.description}</span>
                      </Show>
                    </span>
                    <span style={{ display: "flex", gap: "6px", "align-items": "center", "flex-shrink": "0" }}>
                      <span class="pill" style={{ "font-size": "var(--fs-2xs)" }}>
                        {cmd.source}
                      </span>
                      <span class="palette-kbd">↵</span>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>

          <div style={{ padding: "8px 12px", "border-top": "1px solid var(--border)", display: "flex", gap: "8px", "align-items": "center", "font-size": "var(--fs-2xs)", color: "var(--fg-faint)" }}>
            <span>
              <span class="kbd">↑↓</span> navigate
            </span>
            <span>·</span>
            <span>
              <span class="kbd">↵</span> insert
            </span>
            <span>·</span>
            <span>
              <span class="kbd">/</span> slash commands
            </span>
            <span style={{ "margin-left": "auto", "font-family": "var(--font-mono)" }}>{filtered().length} results</span>
          </div>
        </div>
      </div>
    </Show>
  )
}

// ── Inline slash autocomplete (for ChatView composer) ──────────────

export function SlashAutocomplete(props: {
  query: string
  commands: CommandEntry[]
  selected?: number
  onSelect: (name: string) => void
  onClose: () => void
}) {
  const filtered = () => filterCommands(props.query, props.commands)
  const selected = () => props.selected ?? 0

  // Arrow nav is handled by parent textarea; this is click-only + keyboard via prop
  return (
    <Show when={props.query.startsWith("/") && filtered().length > 0}>
      <div class="slash-dropdown" role="listbox" aria-label="Slash commands">
        <div class="slash-list">
          <For each={filtered().slice(0, 8)}>
            {(cmd, i) => (
              <button
                type="button"
                role="option"
                aria-selected={selected() === i() ? "true" : "false"}
                class="slash-item"
                onClick={() => props.onSelect(cmd.name)}
              >
                <span style={{ display: "flex", "flex-direction": "column", gap: "1px", "min-width": "0", "text-align": "left" }}>
                  <span style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-sm)", "font-weight": "600", color: "var(--fg)" }}>{cmd.name}</span>
                  <Show when={cmd.description}>
                    <span style={{ "font-size": "var(--fs-xs)", color: "var(--fg-subtle)", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis", "max-width": "36ch" }}>{cmd.description}</span>
                  </Show>
                </span>
                <span class="pill" style={{ "font-size": "var(--fs-2xs)", "flex-shrink": "0" }}>
                  {cmd.source}
                </span>
              </button>
            )}
          </For>
        </div>
        <div style={{ padding: "6px 10px", "border-top": "1px solid var(--border)", "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", display: "flex", gap: "6px" }}>
          <span>
            <span class="kbd">↑↓</span> nav
          </span>
          <span>·</span>
          <span>
            <span class="kbd">Tab</span> complete
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
