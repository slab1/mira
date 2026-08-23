/**
 * QuestionView — HITL question prompt for Mira TUI
 *
 * Rendered when GlobalBus emits `question.ask` (from the `question` tool).
 * User selects options → `question.reply` sent via WebSocket → SessionPrompt resumes.
 * Click an option to select (toggle for multiple), then Submit.
 */

import { Show, For, createSignal } from "solid-js"
import type { PendingQuestion } from "../stores/session"

type Props = {
  request: PendingQuestion | null
  onSubmit: (answers: Array<{ header: string; selections: string[] }>) => void
}

export default function QuestionView(props: Props) {
  const q = () => props.request
  const [selections, setSelections] = createSignal<Record<string, string[]>>({})

  const toggle = (header: string, label: string, multiple?: boolean) => {
    setSelections((prev) => {
      const cur = prev[header] ?? []
      if (multiple) {
        return { ...prev, [header]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
      }
      return { ...prev, [header]: cur.includes(label) ? [] : [label] }
    })
  }

  const submit = () => {
    const req = q()
    if (!req) return
    props.onSubmit(
      req.questions.map((qq) => ({ header: qq.header, selections: selections()[qq.header] ?? [] })),
    )
    setSelections({})
  }

  return (
    <Show when={q()}>
      {(req) => (
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "10px",
            padding: "14px",
            "border-radius": "12px",
            background: "rgba(124,58,237,0.10)",
            border: "1px solid rgba(124,58,237,0.35)",
            "box-shadow": "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          <For each={req().questions}>
            {(question) => (
              <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                  <span
                    style={{
                      "font-size": "11px",
                      "font-weight": "700",
                      color: "#c4b5fd",
                      background: "#2e1065",
                      padding: "2px 7px",
                      "border-radius": "999px",
                    }}
                  >
                    {question.header}
                  </span>
                  <span style={{ "font-size": "13px", color: "#fafafa", "font-weight": "600" }}>
                    {question.question}
                  </span>
                </div>
                <For each={question.options}>
                  {(opt) => {
                    const selected = () => (selections()[question.header] ?? []).includes(opt.label)
                    return (
                      <div
                        onClick={() => toggle(question.header, opt.label, question.multiple)}
                        style={{
                          cursor: "pointer",
                          padding: "7px 10px",
                          "border-radius": "8px",
                          border: selected() ? "1px solid #7c3aed" : "1px solid rgba(255,255,255,0.12)",
                          background: selected() ? "#2e1065" : "transparent",
                          "font-size": "12.5px",
                          color: "#e4e4e7",
                        }}
                      >
                        <strong>{selected() ? "◉" : "○"} {opt.label}</strong>
                        <span style={{ color: "#a1a1aa", "margin-left": "8px", "font-size": "11.5px" }}>
                          {opt.description}
                        </span>
                      </div>
                    )
                  }}
                </For>
              </div>
            )}
          </For>

          <button
            onClick={submit}
            style={{
              cursor: "pointer",
              padding: "7px 12px",
              "border-radius": "8px",
              border: "none",
              background: "linear-gradient(135deg,#7c3aed,#ec4899)",
              color: "#fff",
              "font-size": "12.5px",
              "font-weight": "700",
            }}
          >
            Submit answer
          </button>
        </div>
      )}
    </Show>
  )
}
