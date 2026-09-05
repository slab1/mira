/**
 * CommandPalette — TUI command mode for Mira
 *
 * Triggered by leading '/' in input or via shortcut.
 * Commands: /cost, /undo, /queue, /jobs, /fork, /export
 */

import { createSignal, createMemo, onMount, onCleanup, For, Show } from "solid-js"

type Props = {
  open: boolean
  onClose: () => void
  onExecute: (cmd: string) => void
}

const COMMANDS = [
  { id: "cost", label: "/cost", desc: "Show current spend & token usage" },
  { id: "undo", label: "/undo", desc: "Undo last file mutation" },
  { id: "queue", label: "/queue", desc: "Show queued prompts" },
  { id: "jobs", label: "/jobs", desc: "List background jobs" },
  { id: "fork", label: "/fork", desc: "Fork current session" },
  { id: "export", label: "/export", desc: "Export session transcript" },
]

export default function CommandPalette(props: Props) {
  const [query, setQuery] = createSignal("")
  const [index, setIndex] = createSignal(0)

  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim()
    if (!q) return COMMANDS
    return COMMANDS.filter(
      (c) => c.label.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)
    )
  })

  const execute = (cmd: string) => {
    props.onExecute(cmd)
    props.onClose()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const items = filtered()
    if (e.key === "Escape") {
      e.preventDefault()
      props.onClose()
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setIndex((i) => (i + 1) % items.length)
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setIndex((i) => (i - 1 + items.length) % items.length)
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      const item = items[index()]
      if (item) execute(item.id)
      return
    }
    if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key) - 1
      const item = items[n]
      if (item) {
        e.preventDefault()
        execute(item.id)
      }
    }
  }

  onMount(() => {
    if (props.open) {
      setQuery("")
      setIndex(0)
      window.addEventListener("keydown", onKeyDown)
    }
  })

  onCleanup(() => window.removeEventListener("keydown", onKeyDown))

  // Re-attach when open changes
  createMemo(() => {
    if (props.open) {
      setQuery("")
      setIndex(0)
      window.addEventListener("keydown", onKeyDown)
    } else {
      window.removeEventListener("keydown", onKeyDown)
    }
  })

  return (
    <Show when={props.open}>
      <div
        style={{
          position: "fixed",
          inset: "0",
          background: "rgba(0,0,0,0.7)",
          display: "flex",
          "align-items": "flex-start",
          "justify-content": "center",
          "padding-top": "20vh",
          "z-index": "1000",
        }}
        onClick={props.onClose}
      >
        <div
          style={{
            width: "min(560px, 92vw)",
            "border-radius": "12px",
            background: "#0f1117",
            border: "1px solid rgba(255,255,255,0.12)",
            "box-shadow": "0 16px 48px rgba(0,0,0,0.55)",
            overflow: "hidden",
            color: "#e5e7eb",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "10px",
              padding: "12px 14px",
              border: "1px solid rgba(255,255,255,0.08)",
              "border-left": "none",
              "border-right": "none",
              background: "rgba(255,255,255,0.02)",
            }}
          >
            <span style={{ "font-size": "16px" }}>⌘</span>
            <input
              autofocus
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value)
                setIndex(0)
              }}
              placeholder="Type a command… /cost /undo /queue /jobs /fork /export"
              style={{
                flex: "1",
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#e5e7eb",
                "font-size": "14px",
              }}
            />
            <span style={{ "font-size": "11px", opacity: "0.5" }}>ESC to close</span>
          </div>

          <div style={{ "max-height": "320px", overflow: "auto", padding: "6px" }}>
            <For each={filtered()}>
              {(cmd, i) => {
                const active = () => index() === i()
                return (
                  <div
                    onMouseEnter={() => setIndex(i())}
                    onClick={() => execute(cmd.id)}
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "10px",
                      padding: "10px 12px",
                      "border-radius": "8px",
                      cursor: "pointer",
                      background: active() ? "rgba(99,102,241,0.18)" : "transparent",
                      border: active() ? "1px solid rgba(99,102,241,0.35)" : "1px solid transparent",
                    }}
                  >
                    <span style={{ "font-family": "ui-monospace, monospace", "font-weight": "700", color: "#a5b4fc", "min-width": "80px" }}>
                      {cmd.label}
                    </span>
                    <span style={{ flex: "1", "font-size": "13px" }}>{cmd.desc}</span>
                    <span style={{ "font-size": "11px", opacity: "0.45", "font-family": "ui-monospace" }}>
                      {i() + 1}
                    </span>
                  </div>
                )
              }}
            </For>
            <Show when={filtered().length === 0}>
              <div style={{ padding: "20px", "text-align": "center", opacity: "0.5", "font-size": "13px" }}>
                No commands match “{query()}”
              </div>
            </Show>
          </div>

          <div
            style={{
              padding: "8px 12px",
              "border-top": "1px solid rgba(255,255,255,0.06)",
              "font-size": "11px",
              opacity: "0.55",
              display: "flex",
              "justify-content": "space-between",
            }}
          >
            <span>↑↓ navigate · Enter execute · 1-9 quick pick</span>
            <span>⌘K to open</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
