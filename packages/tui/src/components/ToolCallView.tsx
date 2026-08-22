/**
 * ToolCallView — Renders a single tool-call / tool-result part
 *
 * Shows tool name, args, result, status, timing. Compact + readable in TUI.
 * Colors: success (teal), error (red), pending (amber).
 */

import { Show, createMemo } from "solid-js"
import type { Part } from "../rpc/client"

type Props = {
  part: Part
  expanded?: boolean
}

function pretty(obj: unknown): string {
  if (obj === undefined || obj === null) return ""
  if (typeof obj === "string") return obj
  try {
    return JSON.stringify(obj, null, 2)
  } catch {
    return String(obj)
  }
}

function truncate(s: string, n = 1200): string {
  if (s.length <= n) return s
  return s.slice(0, n) + ` … (+${s.length - n} chars)`
}

const TOOL_ICON: Record<string, string> = {
  bash: "⌁",
  read: "▤",
  write: "✎",
  edit: "✎",
  patch: "⬢",
  glob: "◎",
  grep: "⌕",
  lsp: "◈",
  task: "⬡",
  todowrite: "☑",
  question: "？",
  websearch: "⌕",
  webfetch: "⬇",
  memory_search: "◐",
  memory_write: "◑",
  skill: "⬔",
}

export default function ToolCallView(props: Props) {
  const part = () => props.part
  const isCall = createMemo(() => part().type === "tool-call")
  const isError = createMemo(() => Boolean(part().isError))
  const icon = createMemo(() => TOOL_ICON[part().tool ?? ""] ?? "▸")
  const title = createMemo(() => part().tool ?? "tool")

  const argsText = createMemo(() => {
    const a = part().args
    if (!a) return ""
    return truncate(pretty(a))
  })

  const resultText = createMemo(() => {
    const r = part().result
    if (r === undefined) return ""
    // result is often { error } or plain string/object
    return truncate(pretty(r))
  })

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "6px",
        padding: "8px 10px",
        "border-radius": "8px",
        background: isError() ? "rgba(239,68,68,0.08)" : isCall() ? "rgba(251,191,36,0.07)" : "rgba(16,185,129,0.08)",
        border: isError()
          ? "1px solid rgba(239,68,68,0.22)"
          : isCall()
            ? "1px solid rgba(251,191,36,0.18)"
            : "1px solid rgba(16,185,129,0.18)",
        "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
        "font-size": "12px",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "8px", "justify-content": "space-between" }}>
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <span
            style={{
              display: "inline-flex",
              "align-items": "center",
              "justify-content": "center",
              width: "22px",
              height: "22px",
              "border-radius": "6px",
              background: isError() ? "rgba(239,68,68,0.18)" : "rgba(255,255,255,0.06)",
              "font-size": "13px",
            }}
          >
            {icon()}
          </span>
          <span style={{ "font-weight": "700", "letter-spacing": "0.02em" }}>{title()}</span>
          <span
            style={{
              "font-size": "11px",
              padding: "2px 6px",
              "border-radius": "999px",
              background: isCall() ? "rgba(251,191,36,0.18)" : isError() ? "rgba(239,68,68,0.18)" : "rgba(16,185,129,0.18)",
              color: isCall() ? "#fcd34d" : isError() ? "#fca5a5" : "#6ee7b7",
            }}
          >
            {isCall() ? "call" : isError() ? "error" : "result"}
          </span>
        </div>
        <Show when={part().toolCallID}>
          <span style={{ "font-size": "10px", opacity: "0.45" }} title={part().toolCallID}>
            {part().toolCallID!.slice(0, 8)}
          </span>
        </Show>
      </div>

      <Show when={argsText()}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
          <span style={{ "font-size": "10px", opacity: "0.5", "letter-spacing": "0.04em", "font-weight": "600" }}>ARGS</span>
          <pre
            style={{
              margin: "0",
              padding: "6px 8px",
              "border-radius": "6px",
              background: "rgba(0,0,0,0.28)",
              overflow: "auto",
              "max-height": "180px",
              "white-space": "pre-wrap",
              "word-break": "break-word",
            }}
          >
            {argsText()}
          </pre>
        </div>
      </Show>

      <Show when={!isCall() && resultText()}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
          <span style={{ "font-size": "10px", opacity: "0.5", "letter-spacing": "0.04em", "font-weight": "600" }}>
            {isError() ? "ERROR" : "RESULT"}
          </span>
          <pre
            style={{
              margin: "0",
              padding: "6px 8px",
              "border-radius": "6px",
              background: isError() ? "rgba(239,68,68,0.12)" : "rgba(0,0,0,0.28)",
              overflow: "auto",
              "max-height": "260px",
              "white-space": "pre-wrap",
              "word-break": "break-word",
            }}
          >
            {resultText()}
          </pre>
        </div>
      </Show>
    </div>
  )
}
