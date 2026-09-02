import { For, Show, createSignal, createEffect, onMount, onCleanup, createResource } from "solid-js"
import type { AppStore } from "../stores/app"
import type { SettingsStore } from "../stores/settings"
import type { Message, Part, Job } from "../api/client"
import { api } from "../api/client"
import { SlashAutocomplete, filterCommands } from "./CommandPalette"
import { ModelPicker, MentionPicker, mentionFlat } from "./ComposerPickers"

const EXAMPLE_PROMPTS = [
  "Explain this repo's architecture",
  "Write tests for the utils module",
  "Find and fix TODO comments",
]

const contentOf = (m: Message) => m.content || (m.parts?.map((p) => p.text || "").join("\n") ?? "")

/** Fenced code block with copy button — minimal markdownish (```lang blocks only). */
function CodeFence(props: { lang: string; code: string }) {
  const [copied, setCopied] = createSignal(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {}
  }
  return (
    <div
      class="card"
      style={{
        margin: "8px 0",
        padding: "0",
        overflow: "hidden",
        border: "1px solid var(--border-strong)",
        "border-radius": "var(--r-md)",
        background: "var(--bg-surface)",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", padding: "6px 10px", background: "var(--bg-app)", "border-bottom": "1px solid var(--border)", gap: "8px" }}>
        <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "font-family": "var(--font-mono)", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>
          {props.lang || "code"}
        </span>
        <button
          type="button"
          class="btn btn-ghost"
          onClick={copy}
          title="Copy code"
          style={{ padding: "2px 8px", "font-size": "var(--fs-xs)", border: "1px solid var(--border)", "border-radius": "var(--r-full)" }}
        >
          {copied() ? "✓ copied" : "⧉ copy"}
        </button>
      </div>
      <pre
        style={{
          margin: "0",
          padding: "10px 12px",
          "white-space": "pre",
          overflow: "auto",
          "font-family": "var(--font-mono)",
          "font-size": "var(--fs-xs)",
          "line-height": "1.6",
          color: "var(--fg)",
        }}
      >
        <code>{props.code}</code>
      </pre>
    </div>
  )
}

function FencedContent(props: { text: string; isUser?: boolean }) {
  const segments = () => {
    const text = props.text ?? ""
    if (!text.includes("```")) return [{ type: "text" as const, content: text }]
    const re = /```(\w*)\n([\s\S]*?)```/g
    const out: Array<{ type: "text" | "code"; content: string; lang?: string }> = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ type: "text", content: text.slice(last, m.index) })
      out.push({ type: "code", content: m[2], lang: m[1] || "" })
      last = re.lastIndex
    }
    if (last < text.length) out.push({ type: "text", content: text.slice(last) })
    if (out.length === 0) out.push({ type: "text", content: text })
    return out
  }
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "0" }}>
      <For each={segments()}>
        {(seg) =>
          seg.type === "code" ? (
            <CodeFence lang={seg.lang ?? ""} code={seg.content} />
          ) : (
            <div
              style={{
                "white-space": "pre-wrap",
                "word-break": "break-word",
                "font-size": "var(--fs-md)",
                "line-height": props.isUser ? "1.6" : "1.65",
                color: "var(--fg)",
              }}
            >
              {seg.content}
            </div>
          )
        }
      </For>
    </div>
  )
}

/** Inline tool-call chip — special-cases edit/write/patch as unified diff (red/green). */
function ToolChip(props: { part: Part }) {
  const [open, setOpen] = createSignal(false)
  const isCall = () => props.part.type === "tool_call"
  const tool = () => props.part.tool ?? ""
  const input = () => (props.part.input as Record<string, string> | undefined)
  const isDiffTool = () => isCall() && ["edit", "write", "patch"].includes(tool())

  const detail = () => {
    const src = isCall() ? props.part.input : props.part.output
    if (src === undefined) return ""
    try {
      return JSON.stringify(src, null, 2)
    } catch {
      return String(src)
    }
  }

  const diffPreview = () => {
    const inp = input()
    if (!inp) return ""
    if (tool() === "edit" && inp.path) {
      const oldS = String(inp.oldString ?? "").slice(0, 240)
      const newS = String(inp.newString ?? "").slice(0, 240)
      return `${inp.path}: ${oldS.length > 40 ? oldS.slice(0, 40) + "…" : oldS} → ${newS.length > 40 ? newS.slice(0, 40) + "…" : newS}`
    }
    if (tool() === "write" && inp.path) return `${inp.path} (${String(inp.content ?? "").length} chars)`
    if (tool() === "patch" && inp.patch) return `patch ${String(inp.patch).split("\n").length} lines`
    return ""
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
        <span class="chip-name">{tool() || props.part.type}</span>
        <Show when={isDiffTool() && diffPreview()}>
          <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "margin-left": "6px", "font-family": "var(--font-mono)", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "max-width": "28ch" }}>
            {diffPreview()}
          </span>
        </Show>
        <span class="chip-chevron">▶</span>
      </button>
      <Show when={open()}>
        <Show
          when={isDiffTool()}
          fallback={<Show when={detail()}><pre class="chip-detail">{detail()}</pre></Show>}
        >
          <div class="card" style={{ margin: "6px 0 0", padding: "8px 10px", background: "var(--bg-surface)", border: "1px solid var(--border)", "border-radius": "var(--r-md)", "font-family": "var(--font-mono)", "font-size": "var(--fs-xs)", "line-height": "1.5", overflow: "auto", "max-height": "260px" }}>
            <Show when={tool() === "edit"}>
              <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "margin-bottom": "6px" }}>{String(input()?.path ?? "")}</div>
              <Show when={String(input()?.oldString ?? "").length > 0}>
                <div style={{ background: "color-mix(in srgb, var(--danger) 12%, transparent)", color: "var(--danger)", padding: "4px 6px", "border-radius": "4px", "white-space": "pre-wrap", "word-break": "break-word", "margin-bottom": "4px" }}>
                  − {String(input()?.oldString ?? "").slice(0, 800)}
                </div>
              </Show>
              <div style={{ background: "color-mix(in srgb, var(--ok) 14%, transparent)", color: "var(--ok)", padding: "4px 6px", "border-radius": "4px", "white-space": "pre-wrap", "word-break": "break-word" }}>
                + {String(input()?.newString ?? "").slice(0, 800)}
              </div>
              <Show when={String(input()?.oldString ?? "").length > 800 || String(input()?.newString ?? "").length > 800}>
                <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "margin-top": "4px" }}>… truncated, expand JSON for full</div>
              </Show>
            </Show>
            <Show when={tool() === "write"}>
              <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "margin-bottom": "6px" }}>{String(input()?.path ?? "")} · new file</div>
              <pre style={{ margin: "0", "white-space": "pre-wrap", "word-break": "break-word", color: "var(--fg)", background: "var(--bg-app)", padding: "6px 8px", "border-radius": "4px", border: "1px solid var(--border)" }}>{String(input()?.content ?? "").slice(0, 1200)}</pre>
              <Show when={String(input()?.content ?? "").length > 1200}><div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "margin-top": "4px" }}>… truncated</div></Show>
            </Show>
            <Show when={tool() === "patch"}>
              <pre style={{ margin: "0", "white-space": "pre", overflow: "auto", color: "var(--fg)" }}>{String(input()?.patch ?? "").slice(0, 2000)}</pre>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}

export function ChatView(props: { store: AppStore; settings?: SettingsStore; onPaletteOpen?: () => void; onOpenSettings?: () => void }) {
  const s = () => props.store.state
  let scrollRef: HTMLDivElement | undefined
  let inputRef: HTMLTextAreaElement | undefined

  // Slash autocomplete state
  const slashQuery = () => {
    const v = props.store.input()
    return v.startsWith("/") ? v : ""
  }
  const slashCommands = () => props.settings?.allCommands() ?? []
  const slashFiltered = () => filterCommands(slashQuery(), slashCommands())
  const [slashIndex, setSlashIndex] = createSignal(0)
  const [slashDismissed, setSlashDismissed] = createSignal(false)
  let lastSlashQ = ""
  createEffect(() => {
    const q = slashQuery()
    if (q !== lastSlashQ) {
      lastSlashQ = q
      setSlashIndex(0)
      setSlashDismissed(false)
    }
  })
  const slashActive = () => !mentionActive() && !slashDismissed() && slashQuery().startsWith("/") && slashFiltered().length > 0
  const handleSlashSelect = (name: string) => {
    props.store.setInput(name + " ")
    inputRef?.focus()
    autoGrow()
  }

  // @mention autocomplete state — "@" at the start of a token (start or after whitespace)
  const mentionQuery = (): { at: number; q: string } | null => {
    const v = props.store.input()
    const el = inputRef
    const pos = el?.selectionStart ?? v.length
    const before = v.slice(0, pos)
    const at = before.lastIndexOf("@")
    if (at === -1) return null
    if (at > 0 && !/\s/.test(before[at - 1])) return null
    const q = before.slice(at + 1)
    if (/\s/.test(q)) return null
    return { at, q }
  }
  const [mentionIndex, setMentionIndex] = createSignal(0)
  const [mentionDismissed, setMentionDismissed] = createSignal(false)
  const [showHints, setShowHints] = createSignal(false)
  let lastMentionQ = ""
  createEffect(() => {
    const m = mentionQuery()
    const q = m?.q ?? ""
    if (q !== lastMentionQ) {
      lastMentionQ = q
      setMentionIndex(0)
      setMentionDismissed(false)
    }
  })
  const mentionActive = () => !mentionDismissed() && mentionQuery() !== null
  const [tree] = createResource(() => (mentionActive() ? api.getWorkspaceTree().catch(() => null) : null))
  const mentionAgents = () => props.settings?.state.agents ?? []
  const mentionFiles = () => tree()?.files ?? []
  const mentionItems = () => {
    const m = mentionQuery()
    if (!m) return []
    return mentionFlat(mentionAgents(), mentionFiles(), m.q)
  }
  const insertMention = (token: string) => {
    const m = mentionQuery()
    if (!m) return
    const v = props.store.input()
    const next = v.slice(0, m.at) + "@" + token + " " + v.slice(m.at + 1 + m.q.length)
    props.store.setInput(next)
    inputRef?.focus()
    autoGrow()
  }

  // No provider keys configured yet (loaded once, still empty) → onboarding card
  const noProviders = () => props.settings?.state.loaded === true && props.settings.state.providers.length === 0

  // pinned = stick to bottom; unpins the moment the user scrolls up to read,
  // and a "jump to latest" pill appears instead of yanking them down.
  const [pinned, setPinned] = createSignal(true)

  // background jobs — poll while session active, show spinner cards in chat
  const [jobs, { refetch: refetchJobs }] = createResource(() => s().currentId, (id) => api.listJobs(id).catch(() => [] as Job[]))
  let jobsTimer: number | undefined
  createEffect(() => {
    const id = s().currentId
    if (jobsTimer) { clearInterval(jobsTimer); jobsTimer = undefined }
    if (!id) return
    jobsTimer = window.setInterval(() => refetchJobs(), 4000)
    onCleanup(() => { if (jobsTimer) clearInterval(jobsTimer) })
  })
  const runningJobs = () => (jobs() ?? []).filter((j) => j.status === "running")

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
    // @mention autocomplete navigation (takes priority over slash)
    const mq = mentionQuery()
    const mItems = mq ? mentionFlat(mentionAgents(), mentionFiles(), mq.q) : []
    const hasMention = !mentionDismissed() && mq !== null && mItems.length > 0
    if (hasMention) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setMentionIndex((i) => Math.min(i + 1, mItems.length - 1))
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setMentionIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        const pick = mItems[mentionIndex()]
        if (pick) {
          e.preventDefault()
          insertMention(pick.token)
          return
        }
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setMentionDismissed(true)
        return
      }
    }
    // Slash autocomplete navigation
    const q = slashQuery()
    const filtered = slashFiltered()
    const hasSlash = slashActive()
    if (hasSlash) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSlashIndex((i) => Math.min(i + 1, filtered.length - 1))
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setSlashIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && q.trim().split(/\s/).length === 1)) {
        // Tab or Enter on single-token slash query → autocomplete first match
        const pick = filtered[slashIndex()]
        if (pick && q.trim() !== pick.name) {
          e.preventDefault()
          handleSlashSelect(pick.name)
          return
        }
        if (e.key === "Tab" && pick) {
          e.preventDefault()
          handleSlashSelect(pick.name)
          return
        }
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      props.store.sendPrompt()
    }
    // "/" at start when empty → ensure commands loaded
    if (e.key === "/" && !props.store.input()) {
      void props.settings?.loadAll()
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
                  <Show
                    when={s().messagesLoading}
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
                  {/* loading skeleton while switching sessions / fetching messages */}
                  <div
                    aria-label="Loading conversation"
                    role="status"
                    style={{
                      flex: "1",
                      display: "flex",
                      "flex-direction": "column",
                      "justify-content": "center",
                      gap: "var(--sp-4)",
                      padding: "var(--sp-2) 0",
                      "max-width": "60ch",
                      margin: "0 auto",
                    }}
                  >
                    {[0, 1, 2, 3].map((i) => (
                      <div style={{ display: "flex", gap: "10px", "align-items": "flex-start" }}>
                        <div class="skeleton" style={{ width: "28px", height: "28px", "border-radius": "var(--r-md)", "flex-shrink": "0" }} />
                        <div style={{ flex: "1", display: "flex", "flex-direction": "column", gap: "6px" }}>
                          <div class="skeleton" style={{ height: "12px", width: "38%", "border-radius": "var(--r-sm)" }} />
                          <div class="skeleton" style={{ height: "12px", width: "72%", "border-radius": "var(--r-sm)" }} />
                          <div class="skeleton" style={{ height: "12px", width: "54%", "border-radius": "var(--r-sm)" }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  </Show>
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
                                        <FencedContent text={contentOf(m)} isUser={true} />
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
                                      <FencedContent text={contentOf(m)} />
                                      <Show when={showCaretHere()}>
                                        <span class="caret" aria-hidden="true" style={{ display: "inline-block", width: "8px", height: "14px", background: "var(--accent)", "margin-left": "2px", "vertical-align": "text-bottom" }} />
                                      </Show>
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
          <Show when={runningJobs().length > 0}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "margin-bottom": "8px" }}>
              <For each={runningJobs()}>
                {(job) => (
                  <div class="card" style={{ display: "flex", "align-items": "center", gap: "8px", padding: "8px 10px", background: "var(--warn-soft)", border: "1px solid var(--warn-border)" }}>
                    <span class="dot dot-pulse" style={{ background: "var(--warn)", width: "8px", height: "8px", flex: "none" }} />
                    <span style={{ flex: "1", "min-width": "0", "font-size": "var(--fs-xs)", color: "var(--fg)", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
                      {job.agent ? `${job.agent}: ` : ""}
                      {job.prompt.slice(0, 100)}
                      {job.prompt.length > 100 ? "…" : ""}
                    </span>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      onClick={() => void api.cancelJob(job.id).then(() => refetchJobs()).catch(() => {})}
                      title="Cancel background job"
                      style={{ padding: "3px 8px", "font-size": "var(--fs-xs)", border: "1px solid var(--border)", "border-radius": "var(--r-full)", flex: "none" }}
                    >
                      ✕ cancel
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={s().doomLoop}>
            {(dl) => {
              const d = dl()
              return (
              <div role="alert" style={{ display: "flex", "align-items": "center", gap: "8px", padding: "8px 10px", "margin-bottom": "8px", background: "var(--warn-soft)", border: "1px solid var(--warn-border)", "border-radius": "var(--r-md)", "font-size": "var(--fs-xs)", color: "var(--fg)" }}>
                <span style={{ flex: "1", "min-width": "0" }}>
                  ⚠ Doom-loop detected: {d.reason} — tool "{d.tool}"{d.pattern ? ` · ${d.pattern.slice(0, 3).join(" → ")}` : ""}
                </span>
                <button type="button" class="btn btn-warn-ghost" onClick={() => void props.store.rewindDoomLoop()} style={{ padding: "4px 10px", "font-size": "var(--fs-xs)", "border-radius": "var(--r-md)", flex: "none" }}>
                  ↩ Rewind
                </button>
                <button type="button" class="btn btn-ghost" onClick={() => props.store.clearDoomLoop()} style={{ padding: "4px 8px", "font-size": "var(--fs-xs)", flex: "none" }}>
                  ✕
                </button>
              </div>
              )
            }}
          </Show>
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
          <Show
            when={noProviders()}
            fallback={
              <form onSubmit={handleSubmit} class="composer" style={{ display: "flex", "flex-direction": "column", padding: "10px 12px 9px", gap: "8px", position: "relative" }}>
                <Show when={mentionActive()}>
                  <MentionPicker
                    query={mentionQuery()?.q ?? ""}
                    agents={mentionAgents()}
                    files={mentionFiles()}
                    selected={mentionIndex()}
                    onSelect={insertMention}
                    onClose={() => setMentionDismissed(true)}
                  />
                </Show>
                <Show when={slashActive()}>
                  <SlashAutocomplete query={slashQuery()} commands={slashCommands()} selected={slashIndex()} onSelect={handleSlashSelect} onClose={() => setSlashDismissed(true)} />
                </Show>
                <textarea
                  ref={inputRef}
                  value={props.store.input()}
                  onKeyDown={onKeyDown}
                  onInput={(e) => {
                    props.store.setInput(e.currentTarget.value)
                    autoGrow()
                    // Lazy load commands when user types "/"
                    if (e.currentTarget.value.startsWith("/")) void props.settings?.loadAll()
                  }}
                  placeholder="Message Mira…  ( / for commands · @ to mention · Ctrl+P palette )"
                  aria-label="Message Mira"
                  aria-autocomplete="list"
                  aria-expanded={slashActive() || mentionActive() ? "true" : "false"}
                  rows={1}
                  style={{ "min-height": "24px", "max-height": "160px" }}
                />
                <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "10px" }}>
                  <span class="sr-only">
                    Press Enter to send, Shift+Enter for a newline.
                  </span>
                  <span style={{ display: "flex", gap: "8px", "align-items": "center", "min-width": "0" }}>
                    <Show when={props.settings}>
                      {(settings) => <ModelPicker settings={settings()} onOpenSettings={props.onOpenSettings} />}
                    </Show>
                    <span aria-hidden="true" style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", display: "flex", gap: "5px", "align-items": "center" }}>
                      <span class="kbd">Enter</span> send
                      <span style={{ opacity: 0.5 }}>·</span>
                      <span class="kbd">Shift+Enter</span> newline
                    </span>
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
            }
          >
            {/* No provider keys yet — onboarding card instead of the composer */}
            <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
              <div class="card" style={{ padding: "14px 16px", display: "flex", "align-items": "center", gap: "12px", background: "var(--accent-soft)", border: "1px solid var(--accent-border)" }}>
                <div style={{ flex: "1", "min-width": "0" }}>
                  <div style={{ "font-size": "var(--fs-sm)", "font-weight": "600", color: "var(--fg)" }}>Add an API key to start chatting</div>
                  <div style={{ "font-size": "var(--fs-xs)", color: "var(--fg-muted)", "margin-top": "2px", "line-height": "1.5" }}>
                    Mira works with any OpenAI-compatible provider. Keys stay on your server.
                  </div>
                </div>
                <button
                  type="button"
                  class="btn btn-solid"
                  onClick={() => props.onOpenSettings?.()}
                  style={{ padding: "7px 14px", "font-size": "var(--fs-sm)", "border-radius": "var(--r-md)", flex: "none" }}
                >
                  Add key →
                </button>
              </div>
              <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                <button
                  type="button"
                  class="btn btn-ghost"
                  onClick={() => setShowHints((v) => !v)}
                  aria-expanded={showHints() ? "true" : "false"}
                  style={{ padding: "6px 12px", "font-size": "var(--fs-xs)", "border-radius": "var(--r-md)" }}
                >
                  {showHints() ? "Hide shortcuts" : "Explore shortcuts"}
                </button>
                <button
                  type="button"
                  class="btn btn-ghost"
                  title="Placeholder — coming soon"
                  style={{ padding: "6px 12px", "font-size": "var(--fs-xs)", "border-radius": "var(--r-md)", opacity: 0.7 }}
                >
                  Load example session
                </button>
              </div>
              <Show when={showHints()}>
                <div class="card" style={{ padding: "12px 14px", "font-size": "var(--fs-xs)", color: "var(--fg-muted)", "line-height": "1.8", "max-height": "150px", overflow: "auto" }}>
                  <div style={{ "font-weight": "600", color: "var(--fg)", "margin-bottom": "4px" }}>Shortcuts</div>
                  <div>
                    <span class="kbd">/</span> commands — run built-in actions
                  </div>
                  <div>
                    <span class="kbd">@</span> files / agents — reference workspace files or agent lanes
                  </div>
                  <div>
                    <span class="kbd">Ctrl+P</span> palette — jump anywhere
                  </div>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  )
}
