import { For, Show, createSignal, createEffect } from "solid-js"
import type { AppStore } from "../stores/app"

/**
 * HITL question prompt — rendered when the agent asks a question via the
 * `question` tool. Replies over WebSocket as question.reply.
 *
 * NOTE: rendering is wrapped in <Show when={q()}> — an early `if (!q()) return null`
 * would run once at setup (when pendingQuestion is still null) and the prompt
 * would never appear when a question arrives later.
 */
export function QuestionPrompt(props: { store: AppStore }) {
  const [selections, setSelections] = createSignal<Record<string, string[]>>({})
  let firstOption: HTMLButtonElement | undefined

  const q = () => props.store.state.pendingQuestion

  // move keyboard focus into the dialog when a question arrives
  createEffect(() => {
    if (q()) queueMicrotask(() => firstOption?.focus())
  })

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
    <Show when={q()}>
      {(question) => (
        <div
          role="dialog"
          aria-label="The agent needs your input"
          style={{
            position: "fixed",
            bottom: "96px",
            left: "50%",
            transform: "translateX(-50%)",
            width: "min(560px, calc(100vw - 32px))",
            background: "var(--bg-surface)",
            border: "1px solid var(--accent-border)",
            "border-radius": "var(--r-lg)",
            padding: "var(--sp-4)",
            "box-shadow": "var(--shadow-pop)",
            "z-index": "100",
            display: "flex",
            "flex-direction": "column",
            gap: "var(--sp-4)",
            animation: "fade-up var(--dur-med) var(--ease) both",
          }}
        >
          {/* header */}
          <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" }}>
            <span style={{ display: "inline-flex", "align-items": "center", gap: "7px", "font-size": "var(--fs-xs)", "font-weight": "700", color: "var(--accent)" }}>
              <span
                aria-hidden="true"
                style={{
                  width: "18px",
                  height: "18px",
                  "border-radius": "6px",
                  background: "var(--accent-soft)",
                  border: "1px solid var(--accent-border)",
                  display: "grid",
                  "place-items": "center",
                  "font-size": "10px",
                }}
              >
                ?
              </span>
              Mira needs your input
            </span>
            <span title={question().questionID} style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "font-family": "var(--font-mono)" }}>
              {question().questionID.slice(0, 8)}
            </span>
          </div>

          {/* questions */}
          <For each={question().questions}>
            {(qq) => (
              <div>
                <div style={{ display: "flex", "align-items": "baseline", gap: "8px", "margin-bottom": "8px", "flex-wrap": "wrap" }}>
                  <span
                    style={{
                      "font-size": "var(--fs-2xs)",
                      "font-weight": "700",
                      color: "var(--accent)",
                      background: "var(--accent-soft)",
                      border: "1px solid var(--accent-border)",
                      padding: "1px 7px",
                      "border-radius": "var(--r-full)",
                      "text-transform": "uppercase",
                      "letter-spacing": "0.04em",
                    }}
                  >
                    {qq.header}
                  </span>
                  <span style={{ "font-size": "var(--fs-base)", color: "var(--fg)", "font-weight": "600" }}>{qq.question}</span>
                  <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)" }}>
                    {qq.multiple ? "select all that apply" : "select one"}
                  </span>
                </div>
                <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }} role="group" aria-label={qq.header}>
                  <For each={qq.options}>
                    {(opt, i) => {
                      const selected = () => (selections()[qq.header] ?? []).includes(opt.label)
                      return (
                        <button
                          type="button"
                          ref={i() === 0 && qq === question().questions[0] ? (el) => (firstOption = el) : undefined}
                          onClick={() => toggle(qq.header, opt.label, !!qq.multiple)}
                          aria-pressed={selected() ? "true" : "false"}
                          style={{
                            display: "flex",
                            gap: "10px",
                            "align-items": "flex-start",
                            "text-align": "left",
                            padding: "9px 12px",
                            "border-radius": "var(--r-md)",
                            border: selected() ? "1px solid var(--accent-border)" : "1px solid var(--border-strong)",
                            background: selected() ? "var(--accent-soft)" : "var(--bg-app)",
                            color: "var(--fg)",
                            cursor: "pointer",
                            transition:
                              "background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)",
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              width: "15px",
                              height: "15px",
                              "border-radius": qq.multiple ? "4px" : "50%",
                              border: selected() ? "1px solid var(--accent)" : "1px solid var(--border-strong)",
                              background: selected() ? "var(--accent)" : "transparent",
                              display: "grid",
                              "place-items": "center",
                              color: "var(--on-accent)",
                              "font-size": "9px",
                              flex: "none",
                              "margin-top": "2px",
                              transition: "background var(--dur-fast) var(--ease)",
                            }}
                          >
                            {selected() ? "✓" : ""}
                          </span>
                          <span style={{ flex: "1", "min-width": "0" }}>
                            <span style={{ display: "block", "font-size": "var(--fs-sm)", "font-weight": "600" }}>{opt.label}</span>
                            <Show when={opt.description}>
                              <span style={{ display: "block", "font-size": "var(--fs-xs)", color: "var(--fg-subtle)", "margin-top": "2px", "line-height": "1.45" }}>
                                {opt.description}
                              </span>
                            </Show>
                          </span>
                        </button>
                      )
                    }}
                  </For>
                </div>
              </div>
            )}
          </For>

          <button type="button" class="btn btn-solid" onClick={submit} style={{ padding: "9px", "font-size": "var(--fs-sm)" }}>
            Reply →
          </button>
        </div>
      )}
    </Show>
  )
}
