import { For, Show, createSignal } from "solid-js"
import type { AppStore } from "../stores/app"

/**
 * HITL question prompt — rendered when the agent asks a question via the
 * `question` tool. Replies over WebSocket as question.reply.
 */
export function QuestionPrompt(props: { store: AppStore }) {
  const [selections, setSelections] = createSignal<Record<string, string[]>>({})

  const q = () => props.store.state.pendingQuestion
  if (!q()) return null

  const toggle = (header: string, label: string, multiple: boolean) => {
    setSelections((prev) => {
      const cur = prev[header] ?? []
      if (multiple) {
        return { ...prev, [header]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
      }
      return { ...prev, [header]: [label] }
    })
  }

  const submit = () => {
    const question = q()
    if (!question) return
    const answers = question.questions.map((qq) => ({
      header: qq.header,
      selections: selections()[qq.header] ?? [],
    }))
    props.store.answerQuestion(question.questionID, answers)
  }

  return (
    <div
      style={{
        position: "fixed",
        bottom: "90px",
        left: "50%",
        transform: "translateX(-50%)",
        "max-width": "520px",
        width: "calc(100% - 32px)",
        background: "#18181b",
        border: "1px solid #7c3aed",
        "border-radius": "14px",
        padding: "16px",
        "box-shadow": "0 8px 32px rgba(0,0,0,0.6)",
        "z-index": "100",
      }}
    >
      <For each={q()?.questions ?? []}>
        {(question) => (
          <div style={{ "margin-bottom": "12px" }}>
            <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "8px" }}>
              <span
                style={{
                  "font-size": "10px",
                  "font-weight": "700",
                  color: "#c4b5fd",
                  background: "#2e1065",
                  padding: "2px 7px",
                  "border-radius": "999px",
                  "text-transform": "uppercase",
                }}
              >
                {question.header}
              </span>
              <span style={{ "font-size": "13.5px", color: "#fafafa", "font-weight": "600" }}>
                {question.question}
              </span>
            </div>
            <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
              <For each={question.options}>
                {(opt) => {
                  const selected = () => (selections()[question.header] ?? []).includes(opt.label)
                  return (
                    <button
                      onClick={() => toggle(question.header, opt.label, !!question.multiple)}
                      style={{
                        "text-align": "left",
                        padding: "9px 12px",
                        "border-radius": "10px",
                        border: selected() ? "1px solid #7c3aed" : "1px solid #3f3f46",
                        background: selected() ? "#2e1065" : "#09090b",
                        color: "#e4e4e7",
                        cursor: "pointer",
                        transition: "all 120ms ease",
                      }}
                    >
                      <span style={{ "font-size": "13px", "font-weight": "600" }}>{opt.label}</span>
                      <span style={{ "font-size": "11.5px", color: "#a1a1aa", "margin-left": "8px" }}>{opt.description}</span>
                    </button>
                  )
                }}
              </For>
            </div>
          </div>
        )}
      </For>
      <button
        onClick={submit}
        style={{
          width: "100%",
          padding: "9px",
          "border-radius": "10px",
          border: "none",
          background: "linear-gradient(135deg,#7c3aed,#ec4899)",
          color: "#fff",
          "font-size": "13px",
          "font-weight": "700",
          cursor: "pointer",
        }}
      >
        Answer
      </button>
      <Show when={!q()}>
        <span />
      </Show>
    </div>
  )
}
