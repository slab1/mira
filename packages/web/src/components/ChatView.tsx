import { For, Show, createSignal, createEffect, onMount } from "solid-js"
import type { AppStore } from "../stores/app"
import type { Message, Part } from "../api/client"

const EXAMPLE_PROMPTS = [
  "Explain this repo's architecture",
  "Write tests for the utils module",
  "Find and fix TODO comments",
]

const contentOf = (m: Message) => m.content || (m.parts?.map((p) => p.text || "").join("\n") ?? "")

/** Inline tool-call chip with expandable input/output detail. */
function ToolChip(props: { part: Part }) {
  const [open, setOpen] = createSignal(false)
  const isCall = () => props.part.type === "tool_call"
  const detail = () => {
    const src = isCall() ? props.part.input : props.part.output
    if (src === undefined) return ""
    try {
      return JSON.stringify(src, null, 2)
    } catch {
      return String(src)
    }
  }

  return (
    <div>
      <button
        type="button"
        class="chip"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen(!open())}
        title={isCall() ? "Show tool input" : "Show tool output"}
      >
        <span style={{ color: isCall() ? "var(--warn)" : "var(--ok)", "font-size": "10px", flex: "none" }}>
          {isCall() ? "◷" : "✓"}
        </span>
        <span class="chip-name">{props.part.tool ?? props.part.type}</span>
        <span class="chip-chevron">▶</span>
      </button>
      <Show when={open() && detail()}>
        <pre class="chip-detail">{detail()}</pre>
      </Show>
    </div>
  )
}

export function ChatView(props: { store: AppStore }) {
  const s = () => props.store.state
  let scrollRef: HTMLDivElement | undefined
  let inputRef: HTMLTextAreaElement | undefined

  // pinned = stick to bottom; unpins the moment the user scrolls up to read,
  // and a "jump to latest" pill appears instead of yanking them down.
  const [pinned, setPinned] = createSignal(true)

  const scrollToBottom = (smooth: boolean) => {
    const el = scrollRef
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
  }

  // new message → smooth glide (if pinned)
  createEffect(() => {
    void s().messages.length
    if (pinned()) queueMicrotask(() => scrollToBottom(true))
  })
  // streaming deltas → instant catch-up (smooth every token is nauseating)
  createEffect(() => {
    void s().streamText
    if (pinned()) queueMicrotask(() => scrollToBottom(false))
  })

  const onScroll = () => {
    const el = scrollRef
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  onMount(() => inputRef?.focus())

  const lastMsg = () => s().messages[s().messages.length - 1]
  const typingDots = () => {
    const lm = lastMsg()
    return s().streaming && (!lm || (lm.role === "assistant" && !lm.content))
  }
  const showCaret = () => {
    const lm = lastMsg()
    return s().streaming && !!lm && lm.role === "assistant" && !!lm.content
  }

  const handleSubmit = (e: Event) => {
    e.preventDefault()
    props.store.sendPrompt()
    inputRef?.focus()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      props.store.sendPrompt()
    }
  }

  const autoGrow = () => {
    const el = inputRef
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 160) + "px"
  }

  const useExample = (text: string) => {
    props.store.setInput(text)
    queueMicrotask(() => {
      inputRef?.focus()
      autoGrow()
    })
  }

  const timeOf = (m: Message) => new Date(m.createdAt).toLocaleTimeString()

  return (
    <section
      style={{
        flex: "1",
        display: "flex",
        "flex-direction": "column",
        background: "var(--bg-canvas)",
        "min-width": "0",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* messages — relative wrapper hosts the jump pill over the scroller */}
      <div style={{ flex: "1", position: "relative", "min-height": "0" }}>
        <div class="scroll" ref={scrollRef} onScroll={onScroll} style={{ position: "absolute", inset: "0" }}>
          <div
            style={{
              "max-width": "calc(68ch + 48px)",
              margin: "0 auto",
              padding: "var(--sp-5) var(--sp-6)",
              display: "flex",
              "flex-direction": "column",
              gap: "var(--sp-4)",
              "min-height": "100%",
            }}
          >
            <Show
              when={s().currentId}
              fallback={
                /* no session selected — designed welcome + exit */
                <div
                  style={{
                    flex: "1",
                    display: "grid",
                    "place-items": "center",
                    "text-align": "center",
                    padding: "var(--sp-6)",
                  }}
                >
                  <div style={{ display: "flex", "flex-direction": "column", "align-items": "center", gap: "12px" }}>
                    <div
                      style={{
                        width: "46px",
                        height: "46px",
                        "border-radius": "var(--r-md)",
                        background: "var(--grad-brand)",
                        display: "grid",
                        "place-items": "center",
                        color: "var(--on-accent)",
                        "font-size": "20px",
                        "box-shadow": "var(--shadow-card)",
                      }}
                    >
                      ✦
                    </div>
                    <div style={{ "font-weight": "700", color: "var(--fg)", "font-size": "var(--fs-lg)" }}>
                      Welcome to Mira
                    </div>
                    <div style={{ "font-size": "var(--fs-sm)", color: "var(--fg-subtle)", "max-width": "44ch", "line-height": "1.6" }}>
                      A self-hosted coding agent with streaming answers, tool execution, and snapshot undo. Create a
                      session to start.
                    </div>
                    <button
                      type="button"
                      class="btn btn-solid"
                      onClick={() => void props.store.createSession().catch(() => {})}
                      style={{ padding: "8px 14px", "font-size": "var(--fs-sm)", "margin-top": "4px" }}
                    >
                      ＋ New session
                    </button>
                  </div>
                </div>
              }
            >
              <Show
                when={s().messages.length > 0}
                fallback={
                  /* empty conversation — offer concrete first steps */
                  <div
                    style={{
                      flex: "1",
                      display: "grid",
                      "place-items": "center",
                      "text-align": "center",
                      padding: "var(--sp-6)",
                    }}
                  >
                    <div style={{ display: "flex", "flex-direction": "column", "align-items": "center", gap: "10px" }}>
                      <div
                        aria-hidden="true"
                        style={{
                          width: "38px",
                          height: "38px",
                          "border-radius": "var(--r-md)",
                          background: "var(--accent-soft)",
                          border: "1px solid var(--accent-border)",
                          display: "grid",
                          "place-items": "center",
                          color: "var(--accent)",
                          "font-size": "16px",
                        }}
                      >
                        ✦
                      </div>
                      <div style={{ "font-weight": "600", color: "var(--fg)", "font-size": "var(--fs-md)" }}>
                        Start the conversation
                      </div>
                      <div style={{ "font-size": "var(--fs-sm)", color: "var(--fg-subtle)", "max-width": "42ch", "line-height": "1.55" }}>
                        Ask anything — Mira streams the answer, runs tools, and edits files with undo.
                      </div>
                      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px", "justify-content": "center", "margin-top": "6px" }}>
                        <For each={EXAMPLE_PROMPTS}>
                          {(ex) => (
                            <button type="button" class="chip" onClick={() => useExample(ex)}>
                              {ex}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </div>
                }
              >
                <For each={s().messages}>
                  {(m, i) => {
                    const isUser = m.role === "user"
                    const isLast = () => i() === s().messages.length - 1
                    const showCaretHere = () => showCaret() && isLast()

                    // system / tool roles get compact treatments; user and
                    // assistant are structurally distinct, not just recolored
                    return (
                      <Show
                        when={m.role === "system"}
                        fallback={
                          <Show
                            when={m.role === "tool"}
                            fallback={
                              /* ── user: right-aligned bubble / assistant: open block ── */
                              <div
                                class="msg-in"
                                style={{
                                  display: "flex",
                                  "flex-direction": "column",
                                  "align-items": isUser ? "flex-end" : "stretch",
                                }}
                              >
                                <Show
                                  when={!isUser}
                                  fallback={
                                    <>
                                      <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "margin-bottom": "3px" }}>
                                        You · {timeOf(m)}
                                        {m.queued ? " · ⏳ queued" : ""}
                                      </span>
                                      <div
                                        style={{
                                          "max-width": "min(100%, 56ch)",
                                          background: "var(--accent-soft)",
                                          border: "1px solid var(--accent-border)",
                                          "border-radius": "var(--r-lg)",
                                          "border-top-right-radius": "var(--r-sm)",
                                          padding: "9px 13px",
                                        }}
                                      >
                                        <div
                                          style={{
                                            "white-space": "pre-wrap",
                                            "word-break": "break-word",
                                            "font-size": "var(--fs-md)",
                                            "line-height": "1.6",
                                            color: "var(--fg)",
                                          }}
                                        >
                                          {contentOf(m)}
                                        </div>
                                      </div>
                                    </>
                                  }
                                >
                                  <div style={{ display: "flex", gap: "10px", "align-items": "flex-start" }}>
                                    <div
                                      aria-hidden="true"
                                      style={{
                                        width: "22px",
                                        height: "22px",
                                        "border-radius": "7px",
                                        background: "var(--grad-brand)",
                                        display: "grid",
                                        "place-items": "center",
                                        color: "var(--on-accent)",
                                        "font-size": "11px",
                                        flex: "none",
                                        "margin-top": "2px",
                                      }}
                                    >
                                      ✦
                                    </div>
                                    <div style={{ flex: "1", "min-width": "0" }}>
                                      <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "margin-bottom": "3px" }}>
                                        Mira · {timeOf(m)}
                                      </div>
                                      <div
                                        style={{
                                          "white-space": "pre-wrap",
                                          "word-break": "break-word",
                                          "font-size": "var(--fs-md)",
                                          "line-height": "1.65",
                                          color: "var(--fg)",
                                        }}
                                      >
                                        {contentOf(m)}
                                        <Show when={showCaretHere()}>
                                          <span class="caret" aria-hidden="true" />
                                        </Show>
                                      </div>
                                      <Show when={m.parts && m.parts.some((p) => p.type === "tool_call" || p.type === "tool_result")}>
                                        <div style={{ "margin-top": "8px", display: "flex", "flex-direction": "column", gap: "5px", "align-items": "flex-start" }}>
                                          <For each={m.parts}>
                                            {(p) => (
                                              <Show when={p.type === "tool_call" || p.type === "tool_result"}>
                                                <ToolChip part={p} />
                                              </Show>
                                            )}
                                          </For>
                                        </div>
                                      </Show>
                                    </div>
                                  </div>
                                </Show>
                              </div>
                            }
                          >
                            {/* tool-role message */}
                            <div class="msg-in" style={{ display: "flex", gap: "10px", "align-items": "flex-start" }}>
                              <div
                                aria-hidden="true"
                                style={{
                                  width: "22px",
                                  height: "22px",
                                  "border-radius": "7px",
                                  background: "var(--bg-surface)",
                                  border: "1px solid var(--border-strong)",
                                  display: "grid",
                                  "place-items": "center",
                                  color: "var(--fg-muted)",
                                  "font-size": "11px",
                                  flex: "none",
                                  "margin-top": "2px",
                                }}
                              >
                                ⚙
                              </div>
                              <div style={{ flex: "1", "min-width": "0" }}>
                                <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "margin-bottom": "3px" }}>
                                  Tool · {timeOf(m)}
                                </div>
                                <pre
                                  style={{
                                    margin: "0",
                                    "white-space": "pre-wrap",
                                    "word-break": "break-word",
                                    "font-family": "var(--font-mono)",
                                    "font-size": "var(--fs-xs)",
                                    "line-height": "1.55",
                                    color: "var(--fg-muted)",
                                  }}
                                >
                                  {contentOf(m)}
                                </pre>
                              </div>
                            </div>
                          </Show>
                        }
                      >
                        {/* system-role message */}
                        <div
                          class="msg-in"
                          role="note"
                          style={{
                            "align-self": "center",
                            "max-width": "60ch",
                            "font-size": "var(--fs-xs)",
                            color: "var(--fg-subtle)",
                            "text-align": "center",
                            padding: "2px 0",
                          }}
                        >
                          {contentOf(m)}
                        </div>
                      </Show>
                    )
                  }}
                </For>

                {/* typing dots while the first tokens are in flight */}
                <Show when={typingDots()}>
                  <div class="msg-in" style={{ display: "flex", gap: "4px", padding: "4px 0 0 32px" }} aria-label="Mira is responding">
                    {[0, 150, 300].map((d) => (
                      <span
                        class="dot dot-pulse"
                        style={{ background: "var(--accent)", "animation-delay": `${d}ms` }}
                      />
                    ))}
                  </div>
                </Show>
              </Show>
              <div style={{ height: "4px", "flex-shrink": "0" }} />
            </Show>
          </div>
        </div>

        {/* autoscroll paused — hand control back to the reader */}
        <Show when={!pinned()}>
          <button
            type="button"
            class="jump-pill"
            onClick={() => {
              setPinned(true)
              scrollToBottom(true)
            }}
          >
            ↓ Jump to latest
          </button>
        </Show>
      </div>

      {/* composer */}
      <Show when={s().currentId}>
        <div style={{ padding: "0 var(--sp-4) var(--sp-3)" }}>
          <Show when={s().queued.length > 0}>
            <div style={{ padding: "0 2px 6px", "font-size": "var(--fs-xs)", color: "var(--warn)" }} role="status">
              ⏳ {s().queued.length} message{s().queued.length === 1 ? "" : "s"} queued — will run after the current turn
            </div>
          </Show>
          <Show when={s().error}>
            <div class="alert" role="alert" style={{ "margin-bottom": "8px", "font-size": "var(--fs-xs)" }}>
              ⚠ {s().error}
            </div>
          </Show>
          <form onSubmit={handleSubmit} class="composer" style={{ display: "flex", "flex-direction": "column", padding: "10px 12px 9px", gap: "8px" }}>
            <textarea
              ref={inputRef}
              value={props.store.input()}
              onKeyDown={onKeyDown}
              onInput={(e) => {
                props.store.setInput(e.currentTarget.value)
                autoGrow()
              }}
              placeholder="Message Mira…"
              aria-label="Message Mira"
              rows={1}
              style={{ "min-height": "24px", "max-height": "160px" }}
            />
            <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "10px" }}>
              <span class="sr-only">
                Press Enter to send, Shift+Enter for a newline.
              </span>
              <span aria-hidden="true" style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", display: "flex", gap: "5px", "align-items": "center" }}>
                <span class="kbd">Enter</span> send
                <span style={{ opacity: 0.5 }}>·</span>
                <span class="kbd">Shift+Enter</span> newline
              </span>
              <Show
                when={!s().streaming}
                fallback={
                  <div style={{ display: "flex", gap: "8px", flex: "none" }}>
                    <button
                      type="submit"
                      class="btn btn-warn-ghost"
                      disabled={!props.store.input().trim()}
                      title="Queue this message — it runs after the current turn"
                      style={{ padding: "7px 12px", "font-size": "var(--fs-sm)", "border-radius": "var(--r-md)" }}
                    >
                      Queue ↵
                    </button>
                    <button
                      type="button"
                      class="btn btn-danger-ghost"
                      onClick={() => props.store.stopStream()}
                      title="Stop the current response"
                      style={{ padding: "7px 12px", "font-size": "var(--fs-sm)", "border-radius": "var(--r-md)" }}
                    >
                      ■ Stop
                    </button>
                  </div>
                }
              >
                <button
                  type="submit"
                  class="btn btn-solid"
                  disabled={!props.store.input().trim()}
                  style={{ padding: "7px 16px", "font-size": "var(--fs-sm)", flex: "none" }}
                >
                  Send ↵
                </button>
              </Show>
            </div>
          </form>
        </div>
      </Show>
    </section>
  )
}
