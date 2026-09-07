import { For, Show, createSignal, createMemo } from 'solid-js'
import type { Message, Part } from '../api/client'
import { MessagePartView } from './MessagePart'

// ── Types ────────────────────────────────────────────────────────────

export type Turn = {
  id: string
  userMessage: Message | null
  assistantMessages: Message[]
  toolMessages: Message[]
  systemMessages: Message[]
  isStreaming: boolean
  error?: string | null
}

// Group flat messages into turns: each user message starts a new turn,
// subsequent assistant/tool/system messages belong to that turn until next user.
export function groupIntoTurns(messages: Message[], streaming: boolean): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  let turnIdx = 0

  const flush = () => {
    if (current) turns.push(current)
    current = null
  }

  for (const m of messages) {
    if (m.role === 'user') {
      flush()
      current = {
        id: `turn-${turnIdx++}-${m.id}`,
        userMessage: m,
        assistantMessages: [],
        toolMessages: [],
        systemMessages: [],
        isStreaming: false,
      }
    } else if (m.role === 'assistant') {
      if (!current) {
        current = { id: `turn-${turnIdx++}-orphan`, userMessage: null, assistantMessages: [], toolMessages: [], systemMessages: [], isStreaming: false }
      }
      current.assistantMessages.push(m)
    } else if (m.role === 'tool') {
      if (!current) {
        current = { id: `turn-${turnIdx++}-orphan`, userMessage: null, assistantMessages: [], toolMessages: [], systemMessages: [], isStreaming: false }
      }
      current.toolMessages.push(m)
    } else if (m.role === 'system') {
      if (!current) {
        current = { id: `turn-${turnIdx++}-orphan`, userMessage: null, assistantMessages: [], toolMessages: [], systemMessages: [], isStreaming: false }
      }
      current.systemMessages.push(m)
    }
  }
  if (current) {
    // Mark last turn as streaming if global streaming is true
    if (streaming) current.isStreaming = true
    turns.push(current)
  }
  return turns
}

// ── Sub-components ───────────────────────────────────────────────────

function TurnProgress(props: { streaming: boolean }) {
  return (
    <Show when={props.streaming}>
      <div
        data-slot="turn-progress"
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          padding: '6px 0',
          'font-size': 'var(--fs-xs)',
          color: 'var(--fg-subtle)',
        }}
      >
        <div class="streaming-indicator" aria-label="Generating">
          <span class="streaming-dot" />
          <span class="streaming-dot" />
          <span class="streaming-dot" />
        </div>
        <span>Generating…</span>
      </div>
    </Show>
  )
}

function TurnError(props: { message: string; onDismiss?: () => void; onRetry?: () => void }) {
  return (
    <div
      data-slot="turn-error"
      role="alert"
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
        padding: '10px 12px',
        background: 'var(--danger-soft)',
        border: '1px solid var(--danger-border)',
        'border-radius': 'var(--r-md)',
        'font-size': 'var(--fs-sm)',
        color: 'var(--danger)',
      }}
    >
      <span style={{ 'font-weight': '600' }}>⚠ {props.message}</span>
      <div style={{ display: 'flex', gap: '6px' }}>
        <Show when={props.onRetry}>
          <button type="button" class="btn btn-solid" onClick={props.onRetry} style={{ padding: '4px 10px', 'font-size': 'var(--fs-xs)' }}>
            Retry
          </button>
        </Show>
        <Show when={props.onDismiss}>
          <button type="button" class="btn btn-ghost" onClick={props.onDismiss} style={{ padding: '4px 10px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)' }}>
            Dismiss
          </button>
        </Show>
      </div>
    </div>
  )
}

function CollapsibleTools(props: { parts: Part[]; defaultOpen?: boolean }) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  const count = () => props.parts.length
  return (
    <div data-slot="turn-tools" style={{ margin: '6px 0' }}>
      <button
        type="button"
        data-slot="turn-tools-trigger"
        onClick={() => setOpen(!open())}
        aria-expanded={open() ? 'true' : 'false'}
        style={{
          display: 'inline-flex',
          'align-items': 'center',
          gap: '6px',
          padding: '4px 8px',
          'font-size': 'var(--fs-xs)',
          border: '1px solid var(--border)',
          'border-radius': 'var(--r-md)',
          background: open() ? 'var(--bg-surface)' : 'transparent',
          color: 'var(--fg-subtle)',
          cursor: 'pointer',
          'font-family': 'inherit',
        }}
      >
        <span style={{ 'font-size': '10px', transform: open() ? 'rotate(90deg)' : 'none', transition: 'transform var(--dur-fast) var(--ease)', display: 'inline-block' }}>▶</span>
        {open() ? 'Hide' : 'Show'} details
        <span
          style={{
            'font-size': 'var(--fs-2xs)',
            padding: '1px 6px',
            'border-radius': 'var(--r-full)',
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            border: '1px solid var(--accent-border)',
            'font-family': 'var(--font-mono)',
          }}
        >
          {count()} tool{count() === 1 ? '' : 's'}
        </span>
      </button>
      <Show when={open()}>
        <div data-slot="turn-tools-content" style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', 'margin-top': '8px' }}>
          <For each={props.parts}>{(part) => <MessagePartView part={part} />}</For>
        </div>
      </Show>
    </div>
  )
}

// ── Fenced content (streaming-aware) ─────────────────────────────────

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
      data-slot="code-fence"
      style={{ margin: '8px 0', padding: '0', overflow: 'hidden', border: '1px solid var(--border-strong)', 'border-radius': 'var(--r-md)', background: 'var(--bg-surface)' }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', padding: '6px 10px', background: 'var(--bg-app)', 'border-bottom': '1px solid var(--border)', gap: '8px' }}>
        <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'font-family': 'var(--font-mono)', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' }}>{props.lang || 'code'}</span>
        <button type="button" class="btn btn-ghost" onClick={() => void copy()} title="Copy code" aria-label="Copy code" style={{ padding: '2px 8px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-full)', 'min-height': '28px' }}>
          {copied() ? '✓ copied' : '⧉ copy'}
        </button>
      </div>
      <pre style={{ margin: '0', padding: '10px 12px', 'white-space': 'pre', overflow: 'auto', 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-xs)', 'line-height': '1.6', color: 'var(--fg)' }}>
        <code>{props.code}</code>
      </pre>
    </div>
  )
}

function FencedContent(props: { text: string; isUser?: boolean; streaming?: boolean }) {
  const segments = createMemo(() => {
    const text = props.text ?? ''
    if (props.streaming) {
      const openCount = (text.match(/```/g) || []).length
      if (openCount % 2 === 1) {
        const lastFence = text.lastIndexOf('```')
        const before = text.slice(0, lastFence)
        const tail = text.slice(lastFence)
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
    <div data-slot="fenced-content" style={{ display: 'flex', 'flex-direction': 'column', gap: '0' }}>
      <For each={segments()}>
        {(seg) =>
          seg.type === 'code' ? (
            <CodeFence lang={seg.lang ?? ''} code={seg.content} />
          ) : (
            <div style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word', 'font-size': 'var(--fs-md)', 'line-height': props.isUser ? '1.6' : '1.65', color: 'var(--fg)' }}>{seg.content}</div>
          )
        }
      </For>
    </div>
  )
}

// ── SessionTurn ──────────────────────────────────────────────────────

export function SessionTurn(props: {
  turn: Turn
  onCopy?: (text: string) => void
  onBranch?: (msg: Message) => void
  onRewind?: (msg: Message) => void
  onPin?: (id: string) => void
  pinnedIds?: Set<string>
}) {
  const turn = () => props.turn
  const userMsg = () => turn().userMessage
  const assistantMsgs = () => turn().assistantMessages
  const toolMsgs = () => turn().toolMessages

  // Collect all tool/reasoning parts from assistant messages
  const toolParts = createMemo(() => {
    const parts: Part[] = []
    for (const m of assistantMsgs()) {
      if (!m.parts) continue
      for (const p of m.parts) {
        if (p.type === 'tool_call' || p.type === 'tool_result' || p.type === 'reasoning') parts.push(p)
      }
    }
    // Also include tool-role messages as synthetic parts
    for (const m of toolMsgs()) {
      parts.push({ type: 'tool_result', tool: 'tool', output: m.content } as Part)
    }
    return parts
  })

  const textParts = createMemo(() => {
    const parts: Part[] = []
    for (const m of assistantMsgs()) {
      if (!m.parts) continue
      for (const p of m.parts) {
        if (p.type === 'text' || (p.type as string) === 'text_delta') parts.push(p)
      }
    }
    return parts
  })

  const assistantText = createMemo(() => {
    // Prefer content field, fallback to text parts
    const texts = assistantMsgs().map((m) => m.content || m.parts?.map((p) => p.text || '').join('\n') || '')
    const joined = texts.join('\n').trim()
    if (joined) return joined
    return textParts()
      .map((p) => p.text || '')
      .join('\n')
      .trim()
  })

  const timeOf = (m: Message) => new Date(m.createdAt).toLocaleTimeString()
  const contentOf = (m: Message) => m.content || m.parts?.map((p) => p.text || '').join('\n') || ''

  return (
    <div
      data-slot="turn"
      data-turn-id={turn().id}
      data-streaming={turn().isStreaming ? 'true' : 'false'}
      style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--sp-3)', animation: 'fade-up var(--dur-med) var(--ease) both' }}
    >
      {/* User message */}
      <Show when={userMsg()}>
        {(um) => {
          const m = um()
          const isPinned = () => props.pinnedIds?.has(m.id) ?? false
          return (
            <div
              data-slot="turn-user"
              class="msg-in"
              style={{ display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-end' }}
            >
              <span data-slot="turn-user-meta" style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'margin-bottom': '3px' }}>
                You · {timeOf(m)}
                {m.queued ? ' · ⏳ queued' : ''}
                <Show when={isPinned()}>
                  <span class="msg-pinned-badge" style={{ 'margin-left': '6px' }}>📌 pinned</span>
                </Show>
              </span>
              <div
                data-slot="turn-user-bubble"
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
              <div class="msg-actions" data-slot="turn-user-actions">
                <Show when={props.onPin}>
                  <button type="button" class="msg-action-btn" onClick={() => props.onPin?.(m.id)} aria-label={isPinned() ? 'Unpin' : 'Pin'}>
                    {isPinned() ? 'Unpin' : '📌 Pin'}
                  </button>
                </Show>
                <Show when={props.onBranch}>
                  <button type="button" class="msg-action-btn" onClick={() => props.onBranch?.(m)} aria-label="Branch">⎇ Branch</button>
                </Show>
                <button type="button" class="msg-action-btn" onClick={() => { void navigator.clipboard.writeText(contentOf(m)); props.onCopy?.(contentOf(m)) }} aria-label="Copy">⧉ Copy</button>
              </div>
            </div>
          )
        }}
      </Show>

      {/* Assistant messages */}
      <For each={assistantMsgs()}>
        {(m) => {
          const isPinned = () => props.pinnedIds?.has(m.id) ?? false
          const hasText = () => !!(m.content || m.parts?.some((p) => p.text))
          const msgToolParts = () => m.parts?.filter((p) => p.type === 'tool_call' || p.type === 'tool_result' || p.type === 'reasoning') ?? []
          const msgText = () => contentOf(m)
          return (
            <div
              data-slot="turn-assistant"
              class="msg-in"
              style={{ display: 'flex', gap: '10px', 'align-items': 'flex-start' }}
            >
              <div
                data-slot="turn-avatar"
                aria-hidden="true"
                style={{
                  width: '22px', height: '22px', 'border-radius': '7px', background: 'var(--grad-brand)', display: 'grid', 'place-items': 'center', color: 'var(--on-accent)', 'font-size': '11px', flex: 'none', 'margin-top': '2px',
                }}
              >
                ✦
              </div>
              <div style={{ flex: '1', 'min-width': '0' }}>
                <div
                  data-slot="turn-assistant-meta"
                  style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'margin-bottom': '3px', display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}
                >
                  <span>Mira · {timeOf(m)}</span>
                  <Show when={isPinned()}>
                    <span class="msg-pinned-badge">📌 pinned</span>
                  </Show>
                  <Show when={msgToolParts().length > 0}>
                    <span style={{ 'font-family': 'var(--font-mono)', color: 'var(--fg-subtle)' }}>{msgToolParts().length} tool call{msgToolParts().length === 1 ? '' : 's'} → Activity</span>
                  </Show>
                </div>

                {/* Text content */}
                <Show when={hasText()}>
                  <FencedContent text={msgText()} streaming={turn().isStreaming} />
                </Show>

                {/* Streaming caret */}
                <Show when={turn().isStreaming && hasText()}>
                  <span class="caret" aria-hidden="true" style={{ display: 'inline-block', width: '8px', height: '14px', background: 'var(--accent)', 'margin-left': '2px', 'vertical-align': 'text-bottom' }} />
                </Show>

                {/* Tool parts inline (collapsible) */}
                <Show when={msgToolParts().length > 0}>
                  <CollapsibleTools parts={msgToolParts()} defaultOpen={false} />
                </Show>

                {/* Citations */}
                <Show when={m.provenance && m.provenance.length > 0}>
                  <div data-slot="turn-citations" style={{ display: 'flex', gap: '4px', 'flex-wrap': 'wrap', 'margin-top': '8px' }}>
                    <For each={m.provenance ?? []}>
                      {(prov) => (
                        <button type="button" class="citation" title={prov.source ?? prov.label} aria-label={`Source: ${prov.label}`}>
                          ◈ {prov.label}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                {/* Actions */}
                <div class="msg-actions" data-slot="turn-assistant-actions">
                  <Show when={props.onPin}>
                    <button type="button" class="msg-action-btn" onClick={() => props.onPin?.(m.id)} aria-label={isPinned() ? 'Unpin' : 'Pin'}>
                      {isPinned() ? 'Unpin' : '📌 Pin'}
                    </button>
                  </Show>
                  <Show when={props.onBranch}>
                    <button type="button" class="msg-action-btn" onClick={() => props.onBranch?.(m)} aria-label="Branch">⎇ Branch</button>
                  </Show>
                  <button type="button" class="msg-action-btn" onClick={() => { void navigator.clipboard.writeText(msgText()); props.onCopy?.(msgText()) }} aria-label="Copy">⧉ Copy</button>
                  <Show when={props.onRewind}>
                    <button type="button" class="msg-action-btn" onClick={() => props.onRewind?.(m)} aria-label="Rewind">↩ Rewind</button>
                  </Show>
                </div>
              </div>
            </div>
          )
        }}
      </For>

      {/* Tool-role messages (compact) */}
      <Show when={toolMsgs().length > 0 && assistantMsgs().length === 0}>
        <For each={toolMsgs()}>
          {(m) => (
            <div data-slot="turn-tool" class="msg-in" style={{ display: 'flex', gap: '10px', 'align-items': 'flex-start', opacity: '0.7' }}>
              <div aria-hidden="true" style={{ width: '22px', height: '22px', 'border-radius': '7px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', display: 'grid', 'place-items': 'center', color: 'var(--fg-muted)', 'font-size': '11px', flex: 'none', 'margin-top': '2px' }}>
                ⚙
              </div>
              <div style={{ flex: '1', 'min-width': '0' }}>
                <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'margin-bottom': '3px' }}>Tool · {timeOf(m)} → see Activity</div>
                <pre style={{ margin: '0', 'white-space': 'pre-wrap', 'word-break': 'break-word', 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-xs)', 'line-height': '1.55', color: 'var(--fg-muted)' }}>
                  {contentOf(m).slice(0, 300)}
                  {contentOf(m).length > 300 ? '…' : ''}
                </pre>
              </div>
            </div>
          )}
        </For>
      </Show>

      {/* System messages */}
      <For each={turn().systemMessages}>
        {(m) => (
          <div data-slot="turn-system" class="msg-in" role="note" style={{ 'align-self': 'center', 'max-width': '60ch', 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'text-align': 'center', padding: '2px 0' }}>
            {contentOf(m)}
          </div>
        )}
      </For>

      {/* Progress indicator */}
      <TurnProgress streaming={turn().isStreaming} />

      {/* Error */}
      <Show when={turn().error}>
        <TurnError message={turn().error!} />
      </Show>
    </div>
  )
}

// ── Turn list ────────────────────────────────────────────────────────

export function TurnList(props: {
  messages: Message[]
  streaming: boolean
  error?: string | null
  onCopy?: (text: string) => void
  onBranch?: (msg: Message) => void
  onRewind?: (msg: Message) => void
  onPin?: (id: string) => void
  pinnedIds?: Set<string>
  onClearError?: () => void
}) {
  const turns = createMemo(() => groupIntoTurns(props.messages, props.streaming))

  // Attach error to last turn if present
  const turnsWithError = createMemo(() => {
    const t = turns()
    if (!props.error || t.length === 0) return t
    const last = t[t.length - 1]!
    return [...t.slice(0, -1), { ...last, error: props.error }]
  })

  return (
    <div data-slot="turn-list" style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--sp-5)' }}>
      <For each={turnsWithError()}>
        {(turn) => (
          <SessionTurn
            turn={turn}
            onCopy={props.onCopy}
            onBranch={props.onBranch}
            onRewind={props.onRewind}
            onPin={props.onPin}
            pinnedIds={props.pinnedIds}
          />
        )}
      </For>
      {/* Typing indicator when streaming but no assistant message yet */}
      <Show when={props.streaming && turns().length > 0 && turns()[turns().length - 1]!.assistantMessages.length === 0}>
        <div data-slot="turn-typing" class="msg-in" style={{ display: 'flex', gap: '4px', padding: '4px 0 0 32px' }} aria-label="Mira is responding">
          <div class="streaming-indicator">
            <span class="streaming-dot" />
            <span class="streaming-dot" />
            <span class="streaming-dot" />
          </div>
        </div>
      </Show>
    </div>
  )
}
