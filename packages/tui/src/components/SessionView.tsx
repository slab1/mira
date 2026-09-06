/**
 * SessionView — Sidebar + message list for Mira TUI
 *
 * Shows sessions in a scrollable list, current session messages with parts,
 * and delegates tool-call parts to ToolCallView.
 * Built with @opentui/solid primitives (Box/Text) — falls back to div/span
 * if the runtime is DOM (vite preview).
 *
 * P1-8 Streaming Telemetry:
 *  - pinned scroll + ↓ Jump to latest pill (port from web ChatView 443-458)
 *  - elapsed timer + tokens/sec in streaming indicator
 *  - typingDots + caret while streaming
 *  - debounced loadMessages / incremental patch (handled in session store)
 */

import { For, Show, createMemo, createSignal, createEffect, onMount, onCleanup } from 'solid-js'
import type { Session, Message, Part, Todo } from '../rpc/client'
import ToolCallView from './ToolCallView'
import ProvenanceView from './ProvenanceView'
import ConfirmDialog from './ConfirmDialog'
import { rpc } from '../rpc/client'

type Props = {
  sessions: Session[]
  currentId: string | null
  messages: Message[]
  todos: Todo[]
  streaming?: boolean
  streamText?: string
  streamStartAt?: number | null
  queued?: string[]
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onRewind?: (messageID: string) => void
}

// Try to use @opentui/solid if available; otherwise render plain JSX.
// This keeps `tsc --noEmit` happy even before `npm install`.
let TuiBox: unknown = null
let TuiText: unknown = null
try {
  // dynamic import hint for bundler — not executed at top-level in SSR
} catch {}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return String(ts)
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

function PartView(props: { part: Part }) {
  const p = () => props.part
  return (
    <Show
      when={p().type !== 'tool-call' && p().type !== 'tool-result'}
      fallback={<ToolCallView part={p()} />}
    >
      <div
        style={{
          'white-space': 'pre-wrap',
          'word-break': 'break-word',
          padding: p().type === 'reasoning' ? '4px 8px' : '6px 10px',
          opacity: p().type === 'reasoning' ? '0.7' : '1',
          'font-style': p().type === 'reasoning' ? 'italic' : 'normal',
          'border-left': p().type === 'reasoning' ? '2px solid #888' : 'none',
          'margin-left': p().type === 'reasoning' ? '8px' : '0',
        }}
      >
        {p().text ?? ''}
      </div>
    </Show>
  )
}

function MessageView(props: {
  message: Message
  onRewind?: (messageID: string) => void
  showCaret?: boolean
}) {
  const m = () => props.message
  const isUser = createMemo(() => m().role === 'user')
  const parts = createMemo(() => m().parts ?? [])

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '4px',
        padding: '8px 10px',
        'border-radius': '8px',
        background: isUser() ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.04)',
        border: isUser() ? '1px solid rgba(99,102,241,0.25)' : '1px solid rgba(255,255,255,0.08)',
        margin: '6px 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          'font-size': '11px',
          opacity: '0.6',
        }}
      >
        <span
          style={{
            'font-weight': '600',
            'text-transform': 'uppercase',
            'letter-spacing': '0.05em',
          }}
        >
          {m().role}
        </span>
        <span style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <span>{formatTime(m().createdAt)}</span>
          <Show when={props.onRewind}>
            <button
              type="button"
              onClick={() => props.onRewind?.(m().id)}
              title="Rewind session to this message"
              style={{
                padding: '2px 6px',
                'font-size': '10px',
                border: '1px solid rgba(255,255,255,0.12)',
                'border-radius': '999px',
                background: 'rgba(255,255,255,0.06)',
                color: '#a5b4fc',
                cursor: 'pointer',
              }}
            >
              ↩ Rewind to here
            </button>
          </Show>
        </span>
      </div>
      <For each={parts()}>{(part) => <PartView part={part} />}</For>
      <Show when={parts().length === 0}>
        <span style={{ opacity: '0.4', 'font-style': 'italic' }}>(no content)</span>
      </Show>
      <Show when={props.showCaret}>
        <span
          class="caret"
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: '8px',
            height: '14px',
            background: '#a5b4fc',
            'margin-left': '2px',
            'vertical-align': 'text-bottom',
            animation: 'blink 1s step-end infinite',
          }}
        />
      </Show>
      <Show when={(m().provenance?.length ?? 0) > 0}>
        <ProvenanceView message={m()} />
      </Show>
    </div>
  )
}

export default function SessionView(props: Props) {
  const current = createMemo(() => props.sessions.find((s) => s.id === props.currentId) ?? null)
  const [search, setSearch] = createSignal('')
  const [confirmId, setConfirmId] = createSignal<string | null>(null)
  const [focusedIdx, setFocusedIdx] = createSignal(0)
  const filteredSessions = createMemo(() => {
    const q = search().trim().toLowerCase()
    if (!q) return props.sessions
    return props.sessions.filter(
      (s) =>
        (s.title || '').toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        (s.model || '').toLowerCase().includes(q),
    )
  })
  // keep focusedIdx in bounds
  createEffect(() => {
    const len = filteredSessions().length
    if (len === 0) setFocusedIdx(0)
    else if (focusedIdx() >= len) setFocusedIdx(len - 1)
  })
  // sync focusedIdx to currentId
  createEffect(() => {
    const id = props.currentId
    if (!id) return
    const idx = filteredSessions().findIndex((s) => s.id === id)
    if (idx >= 0) setFocusedIdx(idx)
  })

  // ── Pinned scroll + jump pill (port from web ChatView 443-458) ───────
  let scrollRef: HTMLDivElement | undefined
  const [pinned, setPinned] = createSignal(true)
  const [elapsed, setElapsed] = createSignal(0)

  const scrollToBottom = (smooth: boolean) => {
    const el = scrollRef
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  const onScroll = () => {
    const el = scrollRef
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  // new message → smooth glide (if pinned)
  createEffect(() => {
    void props.messages.length
    if (pinned()) queueMicrotask(() => scrollToBottom(true))
  })
  // streaming deltas → instant catch-up (if pinned)
  createEffect(() => {
    void props.streamText
    if (pinned()) queueMicrotask(() => scrollToBottom(false))
  })

  // elapsed timer while streaming
  createEffect(() => {
    if (!props.streaming) {
      setElapsed(0)
      return
    }
    const start = props.streamStartAt ?? Date.now()
    const tick = () => setElapsed(Date.now() - start)
    tick()
    const iv = setInterval(tick, 250)
    onCleanup(() => clearInterval(iv))
  })

  const tokensPerSec = createMemo(() => {
    if (!props.streaming || !props.streamText) return 0
    const ms = elapsed()
    if (ms < 200) return 0
    // rough token estimate: ~4 chars per token
    const tokens = Math.ceil(props.streamText.length / 4)
    return tokens / (ms / 1000)
  })

  const lastMsg = createMemo(() => props.messages[props.messages.length - 1] ?? null)
  const typingDots = createMemo(() => {
    const lm = lastMsg()
    return (
      !!props.streaming &&
      (!lm || (lm.role === 'assistant' && !lm.parts?.some((p) => (p.text ?? '').length > 0)))
    )
  })
  const showCaret = createMemo(() => {
    const lm = lastMsg()
    return (
      !!props.streaming &&
      !!lm &&
      lm.role === 'assistant' &&
      !!lm.parts?.some((p) => (p.text ?? '').length > 0)
    )
  })

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'row',
        height: '100%',
        gap: '12px',
        padding: '8px',
      }}
    >
      {/* ── Sidebar: sessions ── */}
      <div
        style={{
          width: '260px',
          'min-width': '200px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '8px',
          border: '1px solid rgba(255,255,255,0.08)',
          'border-radius': '10px',
          padding: '10px',
          background: 'rgba(255,255,255,0.02)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}
        >
          <span style={{ 'font-weight': '700', 'font-size': '13px', 'letter-spacing': '0.04em' }}>
            SESSIONS
          </span>
          <button
            onClick={props.onCreate}
            style={{
              padding: '4px 10px',
              'border-radius': '6px',
              border: '1px solid rgba(99,102,241,0.5)',
              background: 'rgba(99,102,241,0.15)',
              color: '#a5b4fc',
              cursor: 'pointer',
              'font-size': '12px',
            }}
          >
            + New
          </button>
        </div>

        <input
          type="text"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          placeholder="Search sessions…"
          aria-label="Search sessions"
          style={{
            padding: '6px 8px',
            'border-radius': '6px',
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(0,0,0,0.28)',
            color: '#e5e7eb',
            'font-size': '12px',
            outline: 'none',
            width: '100%',
            'box-sizing': 'border-box',
          }}
        />

        <div
          role="listbox"
          aria-label="Sessions"
          aria-orientation="vertical"
          tabindex="0"
          onKeyDown={(e) => {
            const len = filteredSessions().length
            if (len === 0) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setFocusedIdx((i) => Math.min(i + 1, len - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setFocusedIdx((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const s = filteredSessions()[focusedIdx()]
              if (s) props.onSelect(s.id)
            } else if (e.key === 'Home') {
              e.preventDefault()
              setFocusedIdx(0)
            } else if (e.key === 'End') {
              e.preventDefault()
              setFocusedIdx(len - 1)
            }
          }}
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '4px',
            overflow: 'auto',
            flex: '1',
          }}
        >
          <For each={filteredSessions()}>
            {(s, i) => (
              <div
                role="option"
                aria-selected={s.id === props.currentId ? 'true' : 'false'}
                tabindex={focusedIdx() === i() ? 0 : -1}
                onClick={() => props.onSelect(s.id)}
                onFocus={() => setFocusedIdx(i())}
                style={{
                  padding: '8px 10px',
                  'border-radius': '8px',
                  cursor: 'pointer',
                  background:
                    s.id === props.currentId
                      ? 'rgba(99,102,241,0.18)'
                      : focusedIdx() === i()
                        ? 'rgba(255,255,255,0.06)'
                        : 'transparent',
                  border:
                    s.id === props.currentId
                      ? '1px solid rgba(99,102,241,0.35)'
                      : focusedIdx() === i()
                        ? '1px solid rgba(255,255,255,0.12)'
                        : '1px solid transparent',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '2px',
                  outline: 'none',
                }}
              >
                <span
                  style={{
                    'font-weight': s.id === props.currentId ? '600' : '500',
                    'font-size': '13px',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                  }}
                  title={s.title}
                >
                  {s.title || 'Untitled'}
                </span>
                <span
                  style={{
                    'font-size': '11px',
                    opacity: '0.55',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                  }}
                >
                  {s.model} · {formatTime(s.updatedAt)}
                </span>
                <div style={{ display: 'flex', gap: '4px', 'margin-top': '4px' }}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void (async () => {
                        try {
                          const text = await rpc.exportSession(s.id, 'md')
                          const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = `mira-${s.id.slice(0, 8)}.md`
                          a.click()
                          URL.revokeObjectURL(url)
                        } catch {}
                      })()
                    }}
                    title="Export session"
                    aria-label={`Export ${s.title || s.id}`}
                    style={{
                      padding: '2px 6px',
                      'font-size': '10px',
                      border: '1px solid rgba(255,255,255,0.12)',
                      'border-radius': '4px',
                      background: 'rgba(255,255,255,0.06)',
                      color: '#9ca3af',
                      cursor: 'pointer',
                    }}
                  >
                    ⤓ export
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void rpc
                        .createSession({ parentID: s.id })
                        .then((ns) => props.onSelect(ns.id))
                        .catch(() => {})
                    }}
                    title="Fork session"
                    aria-label={`Fork ${s.title || s.id}`}
                    style={{
                      padding: '2px 6px',
                      'font-size': '10px',
                      border: '1px solid rgba(255,255,255,0.12)',
                      'border-radius': '4px',
                      background: 'rgba(255,255,255,0.06)',
                      color: '#9ca3af',
                      cursor: 'pointer',
                    }}
                  >
                    ⎘ fork
                  </button>
                </div>
              </div>
            )}
          </For>
          <Show when={filteredSessions().length === 0 && search().trim()}>
            <span style={{ opacity: '0.45', 'font-size': '12px', padding: '8px' }}>
              No matches for “{search()}”
            </span>
          </Show>
          <Show when={props.sessions.length === 0}>
            <span style={{ opacity: '0.45', 'font-size': '12px', padding: '8px' }}>
              No sessions yet — create one.
            </span>
          </Show>
        </div>

        {/* Todos summary */}
        <Show when={props.todos.length > 0}>
          <div
            style={{
              'border-top': '1px solid rgba(255,255,255,0.06)',
              'padding-top': '8px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '4px',
            }}
          >
            <span
              style={{
                'font-size': '11px',
                'font-weight': '600',
                opacity: '0.6',
                'letter-spacing': '0.04em',
              }}
            >
              TODOS ({props.todos.filter((t) => t.status !== 'completed').length}/
              {props.todos.length})
            </span>
            <For each={props.todos.slice(0, 5)}>
              {(t) => (
                <div
                  style={{
                    'font-size': '12px',
                    display: 'flex',
                    gap: '6px',
                    'align-items': 'center',
                    opacity: t.status === 'completed' ? '0.45' : '0.9',
                  }}
                >
                  <span>
                    {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}
                  </span>
                  <span
                    style={{
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                      'white-space': 'nowrap',
                    }}
                  >
                    {t.content}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={current()}>
          {(c) => (
            <button
              onClick={() => setConfirmId(c().id)}
              style={{
                padding: '6px',
                'border-radius': '6px',
                border: '1px solid rgba(239,68,68,0.25)',
                background: 'transparent',
                color: '#fca5a5',
                cursor: 'pointer',
                'font-size': '12px',
              }}
            >
              Delete session
            </button>
          )}
        </Show>
      </div>
      <ConfirmDialog
        open={confirmId() !== null}
        title="Delete session?"
        message={`Delete "${current()?.title || current()?.id?.slice(0, 8) || 'this session'}"? This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          const id = confirmId()
          if (id) props.onDelete(id)
          setConfirmId(null)
        }}
        onCancel={() => setConfirmId(null)}
      />

      {/* ── Main: messages ── */}
      <div
        style={{
          flex: '1',
          display: 'flex',
          'flex-direction': 'column',
          gap: '4px',
          border: '1px solid rgba(255,255,255,0.08)',
          'border-radius': '10px',
          padding: '10px',
          background: 'rgba(255,255,255,0.02)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          style={{
            display: 'flex',
            'justify-content': 'space-between',
            'align-items': 'center',
            'padding-bottom': '6px',
            'border-bottom': '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <span style={{ 'font-weight': '600', 'font-size': '13px' }}>
            {current()?.title ?? (props.currentId ? 'Session' : 'No session selected')}
          </span>
          <span style={{ 'font-size': '11px', opacity: '0.5' }}>
            {props.messages.length} messages
            <Show when={props.streaming}>
              <span>
                {' '}
                · {formatElapsed(elapsed())} · {tokensPerSec().toFixed(1)} tok/s
              </span>
            </Show>
          </span>
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            display: 'flex',
            'flex-direction': 'column',
            flex: '1',
            overflow: 'auto',
            position: 'relative',
          }}
        >
          <For each={props.messages}>
            {(m, i) => {
              const isLast = () => i() === props.messages.length - 1
              return (
                <MessageView
                  message={m}
                  onRewind={props.onRewind}
                  showCaret={showCaret() && isLast()}
                />
              )
            }}
          </For>
          <Show when={props.messages.length === 0}>
            <div
              style={{
                flex: '1',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                opacity: '0.4',
                'font-size': '13px',
                padding: '24px',
                'text-align': 'center',
              }}
            >
              No messages yet. Type a prompt below to start the agent loop — Mira will stream tool
              calls, permissions, and compaction events live.
            </div>
          </Show>
          {/* typing dots while first tokens in flight */}
          <Show when={typingDots()}>
            <div
              style={{ display: 'flex', gap: '4px', padding: '8px 0 0 8px' }}
              aria-label="Mira is responding"
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  'border-radius': '999px',
                  background: '#a5b4fc',
                  animation: 'pulse 1s infinite',
                  'animation-delay': '0ms',
                }}
              />
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  'border-radius': '999px',
                  background: '#a5b4fc',
                  animation: 'pulse 1s infinite',
                  'animation-delay': '150ms',
                }}
              />
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  'border-radius': '999px',
                  background: '#a5b4fc',
                  animation: 'pulse 1s infinite',
                  'animation-delay': '300ms',
                }}
              />
            </div>
          </Show>
          <Show when={props.streaming && !typingDots()}>
            <div
              style={{
                padding: '8px',
                'font-size': '12px',
                opacity: '0.6',
                display: 'flex',
                gap: '8px',
                'align-items': 'center',
              }}
            >
              <span>● streaming… {formatElapsed(elapsed())}</span>
              <Show when={tokensPerSec() > 0}>
                <span
                  style={{
                    'font-family': 'ui-monospace, monospace',
                    'font-size': '11px',
                    opacity: '0.7',
                  }}
                >
                  {tokensPerSec().toFixed(1)} tok/s
                </span>
              </Show>
              <Show when={props.streamText && props.streamText.length > 0}>
                <span
                  style={{
                    'font-family': 'ui-monospace, monospace',
                    'font-size': '11px',
                    opacity: '0.5',
                  }}
                >
                  {Math.ceil((props.streamText?.length ?? 0) / 4)} tok
                </span>
              </Show>
            </div>
          </Show>
          <Show when={props.streaming && typingDots()}>
            <div
              style={{
                padding: '8px',
                'font-size': '12px',
                opacity: '0.6',
                display: 'flex',
                gap: '8px',
                'align-items': 'center',
              }}
            >
              <span>● streaming… {formatElapsed(elapsed())}</span>
            </div>
          </Show>
        </div>

        {/* jump pill when unpinned */}
        <Show when={!pinned() && props.messages.length > 0}>
          <button
            type="button"
            onClick={() => {
              setPinned(true)
              scrollToBottom(true)
            }}
            style={{
              position: 'absolute',
              bottom: '12px',
              left: '50%',
              transform: 'translateX(-50%)',
              padding: '6px 12px',
              'border-radius': '999px',
              background: 'rgba(99,102,241,0.9)',
              color: 'white',
              border: '1px solid rgba(99,102,241,0.5)',
              'font-size': '11px',
              'font-weight': '600',
              cursor: 'pointer',
              'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
              'z-index': '5',
            }}
          >
            ↓ Jump to latest
          </button>
        </Show>

        {/* ── Queued strip (composer area) ── */}
        <Show when={(props.queued ?? []).length > 0}>
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '6px',
              padding: '8px 10px',
              'border-radius': '8px',
              background: 'rgba(99,102,241,0.08)',
              border: '1px solid rgba(99,102,241,0.18)',
              'margin-top': '8px',
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
              <span
                style={{
                  'font-size': '11px',
                  'font-weight': '700',
                  color: '#a5b4fc',
                  'letter-spacing': '0.04em',
                }}
              >
                ⏳ Queued · {(props.queued ?? []).length}
              </span>
              <span style={{ 'font-size': '10px', color: '#6b7280' }}>
                — will run after current turn · /queue to manage
              </span>
            </div>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
              <For each={(props.queued ?? []).slice(0, 3)}>
                {(q, i) => (
                  <div
                    style={{
                      display: 'flex',
                      gap: '6px',
                      'align-items': 'center',
                      'font-size': '11px',
                    }}
                  >
                    <span
                      style={{
                        color: '#6b7280',
                        'font-family': 'ui-monospace, monospace',
                        'font-size': '10px',
                        flex: 'none',
                      }}
                    >
                      {i() + 1}.
                    </span>
                    <span
                      style={{
                        color: '#d1d5db',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                        'white-space': 'nowrap',
                        flex: '1',
                      }}
                    >
                      {q.length > 80 ? q.slice(0, 77) + '…' : q}
                    </span>
                  </div>
                )}
              </For>
              <Show when={(props.queued ?? []).length > 3}>
                <span style={{ 'font-size': '10px', color: '#6b7280' }}>
                  +{(props.queued ?? []).length - 3} more — open /queue to see all
                </span>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
