/**
 * PermissionView — HITL permission prompt for Mira TUI
 *
 * Rendered when GlobalBus emits `permission.ask` (tool-layer guardrail).
 * User picks Allow / Deny → `permission.reply` sent via WebSocket → SessionPrompt resumes.
 * BashArity level 2 shows a destructive warning.
 */

import { Show, createMemo, onMount, onCleanup } from "solid-js"
import type { PendingPermission } from "../stores/session"

type Props = {
  request: PendingPermission | null
  onAllow: () => void
  onDeny: () => void
}

function prettyArgs(args: unknown): string {
  if (!args) return "{}"
  if (typeof args === "string") return args
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

function isDestructive(tool: string, args: unknown): boolean {
  if (tool !== "bash") return false
  const cmd = (args as { command?: string })?.command ?? ""
  return /rm\s+-rf|sudo|DROP|DELETE\s+FROM|TRUNCATE|git\s+reset\s+--hard|curl.*\|\s*bash/i.test(cmd)
}

export default function PermissionView(props: Props) {
  const req = () => props.request
  const destructive = createMemo(() => (req() ? isDestructive(req()!.tool, req()!.args) : false))

  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (!req()) return
      if (e.key === "1") {
        e.preventDefault()
        props.onAllow()
      } else if (e.key === "2") {
        e.preventDefault()
        props.onDeny()
      }
    }
    window.addEventListener("keydown", handler)
    onCleanup(() => window.removeEventListener("keydown", handler))
  })

  return (
    <Show when={req()}>
      {(r) => (
        <div
          style={{
            position: "relative",
            display: "flex",
            "flex-direction": "column",
            gap: "10px",
            padding: "14px",
            "border-radius": "12px",
            background: destructive() ? "rgba(239,68,68,0.10)" : "rgba(251,191,36,0.08)",
            border: destructive() ? "1px solid rgba(239,68,68,0.30)" : "1px solid rgba(251,191,36,0.25)",
            "box-shadow": "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <span
              style={{
                width: "28px",
                height: "28px",
                display: "inline-flex",
                "align-items": "center",
                "justify-content": "center",
                "border-radius": "8px",
                background: destructive() ? "rgba(239,68,68,0.18)" : "rgba(251,191,36,0.18)",
                "font-size": "16px",
              }}
            >
              {destructive() ? "⚠" : "◐"}
            </span>
            <div style={{ display: "flex", "flex-direction": "column" }}>
              <span style={{ "font-weight": "700", "font-size": "13px", "letter-spacing": "0.02em" }}>
                {destructive() ? "Destructive action requires approval" : "Permission required"}
              </span>
              <span style={{ "font-size": "11px", opacity: "0.6" }}>
                Tool <b style={{ opacity: "1" }}>{r().tool}</b> wants to run — allow or deny?
              </span>
            </div>
          </div>

          <Show when={destructive()}>
            <div
              style={{
                padding: "8px 10px",
                "border-radius": "8px",
                background: "rgba(239,68,68,0.12)",
                border: "1px solid rgba(239,68,68,0.20)",
                "font-size": "11px",
                "font-weight": "600",
                "letter-spacing": "0.02em",
              }}
            >
              This command looks destructive (BashArity level 2). Review carefully before allowing.
            </div>
          </Show>

          <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <span style={{ "font-size": "10px", opacity: "0.5", "letter-spacing": "0.05em", "font-weight": "700" }}>ARGS</span>
            <pre
              style={{
                margin: "0",
                padding: "8px 10px",
                "border-radius": "8px",
                background: "rgba(0,0,0,0.32)",
                "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
                "font-size": "11px",
                overflow: "auto",
                "max-height": "160px",
                "white-space": "pre-wrap",
                "word-break": "break-word",
              }}
            >
              {prettyArgs(r().args)}
            </pre>
          </div>

          <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
            <button
              onClick={props.onDeny}
              style={{
                padding: "7px 14px",
                "border-radius": "8px",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "#e5e7eb",
                cursor: "pointer",
                "font-weight": "600",
                "font-size": "12px",
              }}
            >
              2 Deny
            </button>
            <button
              onClick={props.onAllow}
              autofocus
              style={{
                padding: "7px 16px",
                "border-radius": "8px",
                border: destructive() ? "1px solid rgba(239,68,68,0.5)" : "1px solid rgba(99,102,241,0.5)",
                background: destructive() ? "rgba(239,68,68,0.18)" : "rgba(99,102,241,0.85)",
                color: "white",
                cursor: "pointer",
                "font-weight": "700",
                "font-size": "12px",
              }}
            >
              1 Allow{destructive() ? " anyway" : ""}
            </button>
          </div>

          <span style={{ "font-size": "10px", opacity: "0.45" }}>
            Tip: <kbd style={{ padding: "1px 5px", "border-radius": "4px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)" }}>1</kbd> allow · <kbd style={{ padding: "1px 5px", "border-radius": "4px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)" }}>2</kbd> deny · <kbd style={{ padding: "1px 5px", "border-radius": "4px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)" }}>a</kbd> allow · <kbd style={{ padding: "1px 5px", "border-radius": "4px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)" }}>d</kbd> deny
          </span>
        </div>
      )}
    </Show>
  )
}
