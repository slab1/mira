import { For, Show, createSignal, createEffect, createMemo, onMount, onCleanup, createResource } from 'solid-js'
import type { AppStore } from '../stores/app'
import type { SettingsStore } from '../stores/settings'
import type { Message, Part, Job, JsonValue } from '../api/client'
import { api } from '../api/client'
import { SlashAutocomplete, filterCommands } from './CommandPalette'
import { toast } from './Toast'

const EXAMPLE_PROMPTS = [
  "Explain this repo's architecture",
  'Write tests for the utils module',
  'Find and fix TODO comments',
]

const contentOf = (m: Message) => m.content || (m.parts?.map((p) => p.text || '').join('\n') ?? '')

// ── Code fence ────────────────────────────────────────────────────────

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
        margin: '8px 0',
        padding: '0',
        overflow: 'hidden',
        border: '1px solid var(--border-strong)',
        'border-radius': 'var(--r-md)',
        background: 'var(--bg-surface)',
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '6px 10px',
          background: 'var(--bg-app)',
          'border-bottom': '1px solid var(--border)',
          gap: '8px',
        }}
      >
        <span
          style={{
            'font-size': 'var(--fs-2xs)',
            color: 'var(--fg-faint)',
            'font-family': 'var(--font-mono)',
            'text-transform': 'uppercase',
            'letter-spacing': '0.04em',
          }}
        >
          {props.lang || 'code'}
        </span>
        <button
          type="button"
          class="btn btn-ghost"
          onClick={() => {
            void copy().then(() => toast.success('Copied to clipboard'))
          }}
          title="Copy code"
          aria-label="Copy code to clipboard"
          aria-live="polite"
          style={{
            padding: '2px 8px',
            'font-size': 'var(--fs-xs)',
            border: '1px solid var(--border)',
            'border-radius': 'var(--r-full)',
            'min-height': '28px',
          }}
        >
          {copied() ? '✓ copied' : '⧉ copy'}
        </button>
      </div>
      <pre
        style={{
          margin: '0',
          padding: '10px 12px',
          'white-space': 'pre',
          overflow: 'auto',
          'font-family': 'var(--font-mono)',
          'font-size': 'var(--fs-xs)',
          'line-height': '1.6',
          color: 'var(--fg)',
        }}
      >
        <code>{props.code}</code>
      </pre>
    </div>
  )
}

/** Streaming-aware fenced content: defers code block rendering until closing fence arrives. */
function FencedContent(props: { text: string; isUser?: boolean; streaming?: boolean }) {
  const segments = createMemo(() => {
    const text = props.text ?? ''
    // While streaming, don't render an unclosed fence as code — show as plain text until ``` closes
    if (props.streaming) {
      const openCount = (text.match(/```/g) || []).length
      if (openCount % 2 === 1) {
        // Unclosed fence: split at last ``` and render tail as text
        const lastFence = text.lastIndexOf('```')
        const before = text.slice(0, lastFence)
        const tail = text.slice(lastFence)
        // Parse completed fences in `before` normally, tail stays as text
        const re = /```(\w*)\n([\s\S]*?)```/g
        const out: Array<{ type: 'text' | 'code'; content: string; lang?: string }> = []
        let last = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(before)) !== null) {
          if (m.index > last) out.push({ type: 'text', content: before.slice(last, m.index) })
          out.push({ type: 'code', content: m[2], lang: m[1] || '' })
          last = re.lastIndex
        }
        if (last < before.length) out.push({ type: 'text', content: before.slice(last) })
        out.push({ type: 'text', content: tail })
        if (out.length === 0) out.push({ type: 'text', content: text })
        return out
      }
    }
    if (!text.includes('```')) return [{ type: 'text' as const, content: text }]
    const re = /```(\w*)\n([\s\S]*?)```/g
    const out: Array<{ type: 'text' | 'code'; content: string; lang?: string }> = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ type: 'text', content: text.slice(last, m.index) })
      out.push({ type: 'code', content: m[2], lang: m[1] || '' })
      last = re.lastIndex
    }
    if (last < text.length) out.push({ type: 'text', content: text.slice(last) })
    if (out.length === 0) out.push({ type: 'text', content: text })
    return out
  })

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '0' }}>
      <For each={segments()}>
        {(seg) =>
          seg.type === 'code' ? (
            <CodeFence lang={seg.lang ?? ''} code={seg.content} />
          ) : (
            <div
              style={{
                'white-space': 'pre-wrap',
                'word-break': 'break-word',
                'font-size': 'var(--fs-md)',
                'line-height': props.isUser ? '1.6' : '1.65',
                color: 'var(--fg)',
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

// ── Citation ──────────────────────────────────────────────────────────

function CitationChip(props: { label: string; source?: string; onClick?: () => void }) {
  return (
    <button type="button" class="citation" onClick={props.onClick} title={props.source ?? props.label} aria-label={`Source: ${props.label}`}>
      ◈ {props.label}
    </button>
  )
}

// ── Confidence ────────────────────────────────────────────────────────

function ConfidenceIndicator(props: { value?: number }) {
  const v = () => props.value ?? 0.75
  const level = () => (v() >= 0.8 ? 'high' : v() >= 0.5 ? 'med' : 'low')
  const color = () => (level() === 'high' ? 'var(--confidence-high)' : level() === 'med' ? 'var(--confidence-med)' : 'var(--confidence-low)')
  const label = () => (level() === 'high' ? 'High confidence' : level() === 'med' ? 'Medium confidence' : 'Low confidence')
  return (
    <span class="confidence-bar" title={label()} aria-label={label()}>
      <span class="confidence-dot" style={{ background: color() }} />
      <span style={{ color: color(), 'font-size': 'var(--fs-2xs)' }}>{label()}</span>
    </span>
  )
}

// ── Feedback ──────────────────────────────────────────────────────────

function FeedbackRow(props: { messageId: string }) {
  const [vote, setVote] = createSignal<'up' | 'down' | null>(null)
  return (
    <div class="feedback-row" role="group" aria-label="Feedback">
      <button
        type="button"
        class={`feedback-btn ${vote() === 'up' ? 'active-up' : ''}`}
        onClick={() => setVote(vote() === 'up' ? null : 'up')}
        title="Helpful"
        aria-label="Mark as helpful"
        aria-pressed={vote() === 'up' ? 'true' : 'false'}
      >
        👍
      </button>
      <button
        type="button"
        class={`feedback-btn ${vote() === 'down' ? 'active-down' : ''}`}
        onClick={() => setVote(vote() === 'down' ? null : 'down')}
        title="Not helpful"
        aria-label="Mark as not helpful"
        aria-pressed={vote() === 'down' ? 'true' : 'false'}
      >
        👎
      </button>
    </div>
  )
}

// ── Reasoning block (collapsible) ─────────────────────────────────────

function ReasoningBlock(props: { text: string }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div style={{ margin: '6px 0' }}>
      <button
        type="button"
        class="btn btn-ghost"
        onClick={() => setOpen(!open())}
        aria-expanded={open() ? 'true' : 'false'}
        style={{
          padding: '4px 8px',
          'font-size': 'var(--fs-xs)',
          border: '1px solid var(--border)',
          'border-radius': 'var(--r-md)',
          color: 'var(--fg-subtle)',
          gap: '6px',
        }}
      >
        <span style={{ 'font-size': '10px' }}>{open() ? '▼' : '▶'}</span> Reasoning
      </button>
      <Show when={open()}>
        <div
          style={{
            margin: '6px 0 0',
            padding: '10px 12px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            'border-radius': 'var(--r-md)',
            'font-size': 'var(--fs-sm)',
            'line-height': '1.6',
            color: 'var(--fg-muted)',
            'white-space': 'pre-wrap',
            'word-break': 'break-word',
          }}
        >
          {props.text}
        </div>
      </Show>
    </div>
  )
}

// ── Error recovery card ───────────────────────────────────────────────

function ErrorCard(props: { message: string; onRetry?: () => void; onDismiss: () => void }) {
  return (
    <div class="error-card" role="alert">
      <div class="error-card-title">Something went wrong</div>
      <div class="error-card-why">
        <strong>What happened:</strong> {props.message}
      </div>
      <div class="error-card-why">
        <strong>Why:</strong> The request failed or the agent encountered an error. Check your connection and try again.
      </div>
      <div class="error-card-next">
        <Show when={props.onRetry}>
          <button type="button" class="btn btn-solid" onClick={props.onRetry} style={{ padding: '6px 12px', 'font-size': 'var(--fs-xs)' }}>
            Retry
          </button>
        </Show>
        <button type="button" class="btn btn-ghost" onClick={props.onDismiss} style={{ padding: '6px 12px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)' }}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

// ── Main ChatView ─────────────────────────────────────────────────────

export function ChatView(props: {
  store: AppStore
  settings?: SettingsStore
  onPaletteOpen?: () => void
}) {
  const s = () => props.store.state
  let scrollRef: HTMLDivElement | undefined
  let inputRef: HTMLTextAreaElement | undefined

  // Pinned messages
  const [pinnedIds, setPinnedIds] = createSignal<Set<string>>(new Set())
  const togglePin = (id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Slash autocomplete
  const slashQuery = () => {
    const v = props.store.input()
    return v.startsWith('/') ? v : ''
  }
  const slashCommands = () => props.settings?.allCommands() ?? []
  const slashFiltered = () => filterCommands(slashQuery(), slashCommands())
  const [slashIndex, setSlashIndex] = createSignal(0)
  const [slashDismissed, setSlashDismissed] = createSignal(false)
  const slashVisible = () => slashQuery().startsWith('/') && slashFiltered().length > 0 && !slashDismissed()
  createEffect(() => {
    void slashQuery()
    setSlashIndex(0)
    setSlashDismissed(false)
  })
  const handleSlashSelect = (name: string) => {
    props.store.setInput(name + ' ')
    inputRef?.focus()
    autoGrow()
  }

  // Auto-scroll pinning
  const [pinned, setPinned] = createSignal(true)

  // Background jobs
  const [jobs, { refetch: refetchJobs }] = createResource(
    () => s().currentId,
    (id) => api.listJobs(id).catch(() => [] as Job[]),
  )
  let jobsTimer: number | undefined
  createEffect(() => {
    const id = s().currentId
    if (jobsTimer) {
      clearInterval(jobsTimer)
      jobsTimer = undefined
    }
    if (!id) return
    jobsTimer = window.setInterval(() => refetchJobs(), 4000)
    onCleanup(() => {
      if (jobsTimer) clearInterval(jobsTimer)
    })
  })
  const runningJobs = () => (jobs() ?? []).filter((j) => j.status === 'running')

  const scrollToBottom = (smooth: boolean) => {
    const el = scrollRef
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  createEffect(() => {
    void s().messages.length
    if (pinned()) queueMicrotask(() => scrollToBottom(true))
  })
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

  // Keyboard shortcuts
  const onGlobalKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
    const isInput = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      props.onPaletteOpen?.()
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isInput) {
      e.preventDefault()
      props.store.sendPrompt()
    }
    if (e.key === 'Escape' && s().streaming) {
      // Don't auto-stop; user must click Stop explicitly
    }
  }
  onMount(() => {
    window.addEventListener('keydown', onGlobalKey)
    onCleanup(() => window.removeEventListener('keydown', onGlobalKey))
  })

  const lastMsg = () => s().messages[s().messages.length - 1]
  const typingDots = () => {
    const lm = lastMsg()
    return s().streaming && (!lm || (lm.role === 'assistant' && !lm.content))
  }
  const showCaret = () => {
    const lm = lastMsg()
    return s().streaming && !!lm && lm.role === 'assistant' && !!lm.content
  }

  const handleSubmit = (e: Event) => {
    e.preventDefault()
    props.store.sendPrompt()
    inputRef?.focus()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const q = slashQuery()
    const filtered = slashFiltered()
    const hasSlash = slashVisible()
    if (hasSlash) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => Math.min(i + 1, filtered.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && q.trim().split(/\s/).length === 1)) {
        const pick = filtered[slashIndex()]
        if (pick && q.trim() !== pick.name) {
          e.preventDefault()
          handleSlashSelect(pick.name)
          return
        }
        if (e.key === 'Tab' && pick) {
          e.preventDefault()
          handleSlashSelect(pick.name)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      props.store.sendPrompt()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      props.store.sendPrompt()
    }
    if (e.key === '/' && !props.store.input()) {
      void props.settings?.loadAll()
    }
  }

  const autoGrow = () => {
    const el = inputRef
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  const useExample = (text: string) => {
    props.store.setInput(text)
    queueMicrotask(() => {
      inputRef?.focus()
      autoGrow()
    })
  }

  const timeOf = (m: Message) => new Date(m.createdAt).toLocaleTimeString()

  // Branch: create new session from a message
  const branchFrom = (m: Message) => {
    const text = contentOf(m).slice(0, 200)
    void props.store.createSession(`Branch: ${text.slice(0, 40)}…`).catch(() => {})
  }

  return (
    <section
      style={{
        flex: '1',
        display: 'flex',
        'flex-direction': 'column',
        background: 'var(--bg-canvas)',
        'min-width': '0',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* messages */}
      <div style={{ flex: '1', position: 'relative', 'min-height': '0' }}>
        <div class="scroll" ref={scrollRef} onScroll={onScroll} style={{ position: 'absolute', inset: '0' }}>
          <div
            style={{
              'max-width': 'calc(68ch + 48px)',
              margin: '0 auto',
              padding: 'var(--sp-5) var(--sp-6)',
              display: 'flex',
              'flex-direction': 'column',
              gap: 'var(--sp-4)',
              'min-height': '100%',
            }}
          >
            <Show
              when={s().currentId}
              fallback={
                <div
                  style={{
                    flex: '1',
                    display: 'grid',
                    'place-items': 'center',
                    'text-align': 'center',
                    padding: 'var(--sp-6)',
                  }}
                >
                  <div style={{ display: 'flex', 'flex-direction': 'column', 'align-items': 'center', gap: '12px' }}>
                    <div
                      style={{
                        width: '46px',
                        height: '46px',
                        'border-radius': 'var(--r-md)',
                        background: 'var(--grad-brand)',
                        display: 'grid',
                        'place-items': 'center',
                        color: 'var(--on-accent)',
                        'font-size': '20px',
                        'box-shadow': 'var(--shadow-card)',
                      }}
                    >
                      ✦
                    </div>
                    <div style={{ 'font-weight': '700', color: 'var(--fg)', 'font-size': 'var(--fs-lg)' }}>Welcome to Mira</div>
                    <div style={{ 'font-size': 'var(--fs-sm)', color: 'var(--fg-subtle)', 'max-width': '44ch', 'line-height': '1.6' }}>
                      A self-hosted coding agent with streaming answers, tool execution, and snapshot undo. Create a session to start.
                    </div>
                    <button type="button" class="btn btn-solid" onClick={() => void props.store.createSession().catch(() => {})} style={{ padding: '8px 14px', 'font-size': 'var(--fs-sm)', 'margin-top': '4px' }}>
                      ＋ New session
                    </button>
                  </div>
                </div>
              }
            >
              <Show
                when={s().messages.length > 0}
                fallback={
                  <div
                    style={{
                      flex: '1',
                      display: 'grid',
                      'place-items': 'center',
                      'text-align': 'center',
                      padding: 'var(--sp-6)',
                    }}
                  >
                    <div style={{ display: 'flex', 'flex-direction': 'column', 'align-items': 'center', gap: '10px' }}>
                      <div
                        aria-hidden="true"
                        style={{
                          width: '38px',
                          height: '38px',
                          'border-radius': 'var(--r-md)',
                          background: 'var(--accent-soft)',
                          border: '1px solid var(--accent-border)',
                          display: 'grid',
                          'place-items': 'center',
                          color: 'var(--accent)',
                          'font-size': '16px',
                        }}
                      >
                        ✦
                      </div>
                      <div style={{ 'font-weight': '600', color: 'var(--fg)', 'font-size': 'var(--fs-md)' }}>Start the conversation</div>
                      <div style={{ 'font-size': 'var(--fs-sm)', color: 'var(--fg-subtle)', 'max-width': '42ch', 'line-height': '1.55' }}>
                        Ask anything — Mira streams the answer, runs tools, and edits files with undo.
                      </div>
                      <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '6px', 'justify-content': 'center', 'margin-top': '6px' }}>
                        <For each={EXAMPLE_PROMPTS}>{(ex) => <button type="button" class="chip" onClick={() => useExample(ex)}>{ex}</button>}</For>
                      </div>
                    </div>
                  </div>
                }
              >
                {/* Pinned messages strip */}
                <Show when={pinnedIds().size > 0}>
                  <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap', 'align-items': 'center', padding: '6px 0', 'border-bottom': '1px solid var(--border)', 'margin-bottom': '4px' }}>
                    <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'font-weight': '600', 'letter-spacing': '0.04em', 'text-transform': 'uppercase' }}>Pinned</span>
                    <For each={s().messages.filter((m) => pinnedIds().has(m.id))}>
                      {(m) => (
                        <span class="msg-pinned-badge">
                          {m.role === 'user' ? 'You' : 'Mira'}: {contentOf(m).slice(0, 40)}…
                          <button type="button" onClick={() => togglePin(m.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', 'font-size': '10px', padding: '0 2px' }} aria-label="Unpin">
                            ✕
                          </button>
                        </span>
                      )}
                    </For>
                  </div>
                </Show>

                <For each={s().messages}>
                  {(m, i) => {
                    const isUser = m.role === 'user'
                    const isLast = () => i() === s().messages.length - 1
                    const showCaretHere = () => showCaret() && isLast()
                    const isPinned = () => pinnedIds().has(m.id)
                    const reasoningParts = () => m.parts?.filter((p) => p.type === 'reasoning') ?? []
                    const toolCount = () => m.parts?.filter((p) => p.type === 'tool_call' || p.type === 'tool_result').length ?? 0

                    return (
                      <Show
                        when={m.role === 'system'}
                        fallback={
                          <Show
                            when={m.role === 'tool'}
                            fallback={
                              <div
                                class="msg-in"
                                style={{
                                  display: 'flex',
                                  'flex-direction': 'column',
                                  'align-items': isUser ? 'flex-end' : 'stretch',
                                }}
                              >
                                <Show
                                  when={!isUser}
                                  fallback={
                                    <>
                                      <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'margin-bottom': '3px' }}>
                                        You · {timeOf(m)}
                                        {m.queued ? ' · ⏳ queued' : ''}
                                        <Show when={isPinned()}>
                                          <span class="msg-pinned-badge" style={{ 'margin-left': '6px' }}>
                                            📌 pinned
                                          </span>
                                        </Show>
                                      </span>
                                      <div
                                        style={{
                                          'max-width': 'min(100%, 56ch)',
                                          background: 'var(--accent-soft)',
                                          border: '1px solid var(--accent-border)',
                                          'border-radius': 'var(--r-lg)',
                                          'border-top-right-radius': 'var(--r-sm)',
                                          padding: '9px 13px',
                                        }}
                                      >
                                        <FencedContent text={contentOf(m)} isUser={true} />
                                      </div>
                                      <div class="msg-actions">
                                        <button type="button" class="msg-action-btn" onClick={() => togglePin(m.id)} aria-label={isPinned() ? 'Unpin message' : 'Pin message'}>
                                          {isPinned() ? 'Unpin' : '📌 Pin'}
                                        </button>
                                        <button type="button" class="msg-action-btn" onClick={() => branchFrom(m)} aria-label="Branch conversation">
                                          ⎇ Branch
                                        </button>
                                        <button
                                          type="button"
                                          class="msg-action-btn"
                                          onClick={() => {
                                            void navigator.clipboard.writeText(contentOf(m))
                                            toast.success('Copied')
                                          }}
                                          aria-label="Copy message"
                                        >
                                          ⧉ Copy
                                        </button>
                                      </div>
                                    </>
                                  }
                                >
                                  <div style={{ display: 'flex', gap: '10px', 'align-items': 'flex-start' }}>
                                    <div
                                      aria-hidden="true"
                                      style={{
                                        width: '22px',
                                        height: '22px',
                                        'border-radius': '7px',
                                        background: 'var(--grad-brand)',
                                        display: 'grid',
                                        'place-items': 'center',
                                        color: 'var(--on-accent)',
                                        'font-size': '11px',
                                        flex: 'none',
                                        'margin-top': '2px',
                                      }}
                                    >
                                      ✦
                                    </div>
                                    <div style={{ flex: '1', 'min-width': '0' }}>
                                      <div
                                        style={{
                                          'font-size': 'var(--fs-2xs)',
                                          color: 'var(--fg-faint)',
                                          'margin-bottom': '3px',
                                          display: 'flex',
                                          'align-items': 'center',
                                          gap: '8px',
                                          'flex-wrap': 'wrap',
                                        }}
                                      >
                                        <span>Mira · {timeOf(m)}</span>
                                        <Show when={isPinned()}>
                                          <span class="msg-pinned-badge">📌 pinned</span>
                                        </Show>
                                        <Show when={toolCount() > 0}>
                                          <span style={{ 'font-family': 'var(--font-mono)', color: 'var(--fg-subtle)' }}>
                                            {toolCount()} tool call{toolCount() === 1 ? '' : 's'} → Activity
                                          </span>
                                        </Show>
                                      </div>

                                      {/* Reasoning (collapsible, not conflated with tool calls) */}
                                      <For each={reasoningParts()}>{(rp) => <ReasoningBlock text={rp.text ?? ''} />}</For>

                                      <FencedContent text={contentOf(m)} streaming={showCaretHere()} />

                                      <Show when={showCaretHere()}>
                                        <span class="caret" aria-hidden="true" style={{ display: 'inline-block', width: '8px', height: '14px', background: 'var(--accent)', 'margin-left': '2px', 'vertical-align': 'text-bottom' }} />
                                      </Show>

                                      {/* Citations / provenance */}
                                      <Show when={m.provenance && m.provenance.length > 0}>
                                        <div style={{ display: 'flex', gap: '4px', 'flex-wrap': 'wrap', 'margin-top': '8px' }}>
                                          <For each={m.provenance ?? []}>
                                            {(prov) => <CitationChip label={prov.label} source={prov.source} />}
                                          </For>
                                        </div>
                                      </Show>

                                      {/* Message actions */}
                                      <div class="msg-actions">
                                        <button type="button" class="msg-action-btn" onClick={() => togglePin(m.id)} aria-label={isPinned() ? 'Unpin message' : 'Pin message'}>
                                          {isPinned() ? 'Unpin' : '📌 Pin'}
                                        </button>
                                        <button type="button" class="msg-action-btn" onClick={() => branchFrom(m)} aria-label="Branch conversation">
                                          ⎇ Branch
                                        </button>
                                        <button
                                          type="button"
                                          class="msg-action-btn"
                                          onClick={() => {
                                            void navigator.clipboard.writeText(contentOf(m))
                                            toast.success('Copied')
                                          }}
                                          aria-label="Copy message"
                                        >
                                          ⧉ Copy
                                        </button>
                                        <button
                                          type="button"
                                          class="msg-action-btn"
                                          onClick={() => {
                                            const sessionId = props.store.state.currentId
                                            const messageId = m.id
                                            if (!sessionId || !messageId) return
                                            void api
                                              .revertSession(sessionId, messageId)
                                              .then(() => {
                                                props.store.loadMessages(sessionId)
                                                toast.success('Rewound to message')
                                              })
                                              .catch((e) => toast.error(`Rewind failed: ${(e as Error).message}`))
                                          }}
                                          aria-label="Rewind to this message"
                                        >
                                          ↩ Rewind
                                        </button>
                                      </div>

                                      {/* Feedback */}
                                      <FeedbackRow messageId={m.id} />
                                    </div>
                                  </div>
                                </Show>
                              </div>
                            }
                          >
                            {/* tool-role message — compact, since ActivityPanel is primary */}
                            <div class="msg-in" style={{ display: 'flex', gap: '10px', 'align-items': 'flex-start', opacity: '0.7' }}>
                              <div
                                aria-hidden="true"
                                style={{
                                  width: '22px',
                                  height: '22px',
                                  'border-radius': '7px',
                                  background: 'var(--bg-surface)',
                                  border: '1px solid var(--border-strong)',
                                  display: 'grid',
                                  'place-items': 'center',
                                  color: 'var(--fg-muted)',
                                  'font-size': '11px',
                                  flex: 'none',
                                  'margin-top': '2px',
                                }}
                              >
                                ⚙
                              </div>
                              <div style={{ flex: '1', 'min-width': '0' }}>
                                <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'margin-bottom': '3px' }}>Tool · {timeOf(m)} → see Activity</div>
                                <pre
                                  style={{
                                    margin: '0',
                                    'white-space': 'pre-wrap',
                                    'word-break': 'break-word',
                                    'font-family': 'var(--font-mono)',
                                    'font-size': 'var(--fs-xs)',
                                    'line-height': '1.55',
                                    color: 'var(--fg-muted)',
                                  }}
                                >
                                  {contentOf(m).slice(0, 300)}
                                  {contentOf(m).length > 300 ? '…' : ''}
                                </pre>
                              </div>
                            </div>
                          </Show>
                        }
                      >
                        <div class="msg-in" role="note" style={{ 'align-self': 'center', 'max-width': '60ch', 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'text-align': 'center', padding: '2px 0' }}>
                          {contentOf(m)}
                        </div>
                      </Show>
                    )
                  }}
                </For>

                {/* ARIA live region for streaming */}
                <div aria-live="polite" aria-atomic="false" class="sr-only">
                  <Show when={s().streaming}>{s().streamText.slice(-200)}</Show>
                </div>

                {/* Typing indicator */}
                <Show when={typingDots()}>
                  <div class="msg-in" style={{ display: 'flex', gap: '4px', padding: '4px 0 0 32px' }} aria-label="Mira is responding">
                    <div class="streaming-indicator">
                      <span class="streaming-dot" />
                      <span class="streaming-dot" />
                      <span class="streaming-dot" />
                    </div>
                  </div>
                </Show>
              </Show>
              <div style={{ height: '4px', 'flex-shrink': '0' }} />
            </Show>
          </div>
        </div>

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
        <div style={{ padding: '0 var(--sp-4) var(--sp-3)' }}>
          <Show when={runningJobs().length > 0}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', 'margin-bottom': '8px' }}>
              <For each={runningJobs()}>
                {(job) => (
                  <div class="card" style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '8px 10px', background: 'var(--warn-soft)', border: '1px solid var(--warn-border)' }}>
                    <span class="dot dot-pulse" style={{ background: 'var(--warn)', width: '8px', height: '8px', flex: 'none' }} />
                    <span style={{ flex: '1', 'min-width': '0', 'font-size': 'var(--fs-xs)', color: 'var(--fg)', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                      {job.agent ? `${job.agent}: ` : ''}
                      {job.prompt.slice(0, 100)}
                      {job.prompt.length > 100 ? '…' : ''}
                    </span>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      onClick={() =>
                        void api
                          .cancelJob(job.id)
                          .then(() => {
                            void refetchJobs()
                            toast.success('Job cancelled')
                          })
                          .catch((e) => toast.error(`Cancel failed: ${(e as Error).message}`))
                      }
                      title="Cancel background job"
                      aria-label="Cancel background job"
                      style={{ padding: '3px 8px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-full)', flex: 'none', 'min-height': '28px' }}
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
                <div role="alert" style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '8px 10px', 'margin-bottom': '8px', background: 'var(--warn-soft)', border: '1px solid var(--warn-border)', 'border-radius': 'var(--r-md)', 'font-size': 'var(--fs-xs)', color: 'var(--fg)' }}>
                  <span style={{ flex: '1', 'min-width': '0' }}>
                    ⚠ Doom-loop detected: {d.reason} — tool "{d.tool}"
                    {d.pattern ? ` · ${d.pattern.slice(0, 3).join(' → ')}` : ''}
                  </span>
                  <button type="button" class="btn btn-warn-ghost" onClick={() => void props.store.rewindDoomLoop()} aria-label="Rewind doom-loop" style={{ padding: '4px 10px', 'font-size': 'var(--fs-xs)', 'border-radius': 'var(--r-md)', flex: 'none', 'min-height': '28px' }}>
                    ↩ Rewind
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost"
                    onClick={async () => {
                      const tool = d.tool
                      try {
                        const { addPermissionRule } = await import('../api/client')
                        await addPermissionRule(tool, '*', 'deny')
                        toast.success(`Will never repeat ${tool}`)
                        props.store.clearDoomLoop()
                      } catch (e) {
                        toast.error(`Failed to add deny rule: ${(e as Error).message}`)
                      }
                    }}
                    style={{ padding: '4px 10px', 'font-size': 'var(--fs-xs)', 'border-radius': 'var(--r-md)', flex: 'none', 'min-height': '28px' }}
                    title="Never repeat this pattern — add deny rule"
                    aria-label="Never repeat this tool"
                  >
                    ⛔ Never repeat
                  </button>
                  <button type="button" class="btn btn-ghost" onClick={() => props.store.clearDoomLoop()} aria-label="Dismiss doom-loop warning" style={{ padding: '4px 8px', 'font-size': 'var(--fs-xs)', flex: 'none', 'min-height': '28px' }}>
                    ✕
                  </button>
                </div>
              )
            }}
          </Show>
          <Show when={s().budgetWarning}>
            {(msg) => (
              <div role="alert" style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '8px 10px', 'margin-bottom': '8px', background: 'var(--warn-soft)', border: '1px solid var(--warn-border)', 'border-radius': 'var(--r-md)', 'font-size': 'var(--fs-xs)', color: 'var(--fg)' }}>
                <span style={{ flex: '1', 'min-width': '0' }}>⚠ {msg()}</span>
                <button type="button" class="btn btn-ghost" onClick={() => props.store.clearBudgetWarning()} aria-label="Dismiss budget warning" style={{ padding: '4px 8px', 'font-size': 'var(--fs-xs)', flex: 'none', 'min-height': '28px' }}>
                  ✕
                </button>
              </div>
            )}
          </Show>
          <Show when={s().queued.length > 0}>
            <div style={{ padding: '0 2px 6px', 'font-size': 'var(--fs-xs)', color: 'var(--warn)' }} role="status">
              ⏳ {s().queued.length} message{s().queued.length === 1 ? '' : 's'} queued — will run after the current turn
            </div>
          </Show>
          <Show when={s().error}>
            <div style={{ 'margin-bottom': '8px' }}>
              <ErrorCard message={s().error!} onDismiss={() => props.store.clearError()} onRetry={() => { props.store.clearError(); }} />
            </div>
          </Show>
          <form
            onSubmit={handleSubmit}
            class="composer"
            style={{ display: 'flex', 'flex-direction': 'column', padding: '10px 12px 9px', gap: '8px', position: 'relative' }}
          >
            <Show when={slashVisible()}>
              <SlashAutocomplete query={slashQuery()} commands={slashCommands()} selected={slashIndex()} onSelect={handleSlashSelect} onClose={() => setSlashDismissed(true)} />
            </Show>
            <textarea
              ref={inputRef}
              value={props.store.input()}
              onKeyDown={onKeyDown}
              onInput={(e) => {
                props.store.setInput(e.currentTarget.value)
                autoGrow()
                if (e.currentTarget.value.startsWith('/')) void props.settings?.loadAll()
              }}
              placeholder="Message Mira…  ( / for commands · ⌘K palette · ⌘↵ send )"
              aria-label="Message Mira"
              aria-autocomplete="list"
              aria-expanded={slashQuery().startsWith('/') && slashFiltered().length > 0 ? 'true' : 'false'}
              rows={1}
              style={{ 'min-height': '24px', 'max-height': '160px' }}
            />
            <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '10px' }}>
              <span class="sr-only">Press Enter to send, Shift+Enter for a newline.</span>
              <span aria-hidden="true" style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', display: 'flex', gap: '5px', 'align-items': 'center' }}>
                <span class="kbd">↵</span> send <span style={{ opacity: '0.5' }}>·</span> <span class="kbd">⇧↵</span> newline <span style={{ opacity: '0.5' }}>·</span> <span class="kbd">⌘↵</span> send
              </span>
              <Show
                when={!s().streaming}
                fallback={
                  <div style={{ display: 'flex', gap: '8px', flex: 'none' }}>
                    <button
                      type="submit"
                      class="btn btn-warn-ghost"
                      disabled={!props.store.input().trim()}
                      title="Queue this message — it runs after the current turn"
                      aria-label="Queue message"
                      style={{ padding: '7px 12px', 'font-size': 'var(--fs-sm)', 'border-radius': 'var(--r-md)', 'min-height': '36px' }}
                    >
                      Queue ↵
                    </button>
                    <button
                      type="button"
                      class="btn btn-danger-ghost"
                      onClick={() => props.store.stopStream()}
                      title="Stop the current response"
                      aria-label="Stop response"
                      style={{ padding: '7px 12px', 'font-size': 'var(--fs-sm)', 'border-radius': 'var(--r-md)', 'min-height': '36px' }}
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
                  aria-label="Send message"
                  style={{ padding: '7px 16px', 'font-size': 'var(--fs-sm)', flex: 'none', 'min-height': '36px' }}
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
