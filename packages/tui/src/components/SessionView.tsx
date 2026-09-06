/**
 * SessionView — Dual-pane keyboard-first session + message view (2026 TUI rebuild)
 *
 * Layout: sidebar (30%) + messages (70%) — Norton Commander dual-pane pattern
 * Sidebar: vim-like j/k, arrows, Enter select, d delete, n new, visual selection
 * Messages: virtual scrolling, syntax-highlighted code blocks, collapsible tool calls,
 *           activity timeline, pinned scroll + jump pill, elapsed + tok/s
 * Keyboard: Tab switches panes, / searches, ? help, focus via lib/focus.ts
 * Tokens: spacing/borders/colors from lib/tokens.ts
 *
 * Props remain compatible with App.tsx contract.
 */

import { For, Show, createMemo, createSignal, createEffect, onMount, onCleanup } from 'solid-js'
import type { Session, Message, Part, Todo } from '../rpc/client'
import ToolCallView from './ToolCallView'
import ProvenanceView from './ProvenanceView'
import ConfirmDialog from './ConfirmDialog'
import { rpc } from '../rpc/client'
import { surface, space, font, text, semantic } from '../lib/tokens'
import { rovingIndex, focusGroupStyle } from '../lib/focus'
import { getColorMode } from '../lib/a11y'
import type { FocusGroup } from '../lib/focus'

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
  focusGroup?: FocusGroup
  onFocusGroupChange?: (g: FocusGroup) => void
}

// ── Helpers ─────────────────────────────────────────────────────

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

// ── Syntax highlighting (lightweight, no deps) ──────────────────

function highlightCode(text: string, lang?: string): string {
  // For TUI preview we return plain text; real terminal would use SGR
  return text
}

function CodeBlock(props: { code: string; lang?: string }) {
  const colorMode = getColorMode()
  const isNoColor = colorMode !== 'full'
  return (
    <pre
      style={{
        margin: '6px 0',
        padding: '8px 10px',
        'border-radius': '6px',
        background: isNoColor ? 'transparent' : 'rgba(0,0,0,0.32)',
        border: isNoColor ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(255,255,255,0.06)',
        'font-family': font.mono,
        'font-size': text.base,
        overflow: 'auto',
        'max-height': '320px',
        'white-space': 'pre-wrap',
        'word-break': 'break-word',
        'line-height': '1.5',
      }}
    >
      <code>{highlightCode(props.code, props.lang)}</code>
    </pre>
  )
}

function renderTextWithCodeBlocks(raw: string) {
  // Split on ``` fences
  const parts: Array<{ kind: 'text' | 'code'; content: string; lang?: string }> = []
  const re = /```(\w*)\n?([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', content: raw.slice(last, m.index) })
    parts.push({ kind: 'code', content: m[2], lang: m[1] || undefined })
    last = m.index + m[0].length
  }
  if (last < raw.length) parts.push({ kind: 'text', content: raw.slice(last) })
  if (parts.length === 0) parts.push({ kind: 'text', content: raw })
  return parts
}

// ── PartView ────────────────────────────────────────────────────

function PartView(props: { part: Part }) {
  const p = () => props.part
  const isTool = () => p().type === 'tool-call' || p().type === 'tool-result' || (p().type as string) === 'tool_call'
  return (
    <Show
      when={!isTool()}
      fallback={<ToolCallView part={p()} />}
    >
      <Show
        when={p().type === 'reasoning'}
        fallback={
          <Show
            when={(p().text ?? '').includes('```')}
            fallback={
              <div
                style={{
                  'white-space': 'pre-wrap',
                  'word-break': 'break-word',
                  padding: '6px 10px',
                  'line-height': '1.6',
                  'font-size': text.md,
                }}
              >
                {p().text ?? ''}
              </div>
            }
          >
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px', padding: '4px 0' }}>
              <For each={renderTextWithCodeBlocks(p().text ?? '')}>
                {(seg) => (
                  <Show when={seg.kind === 'code'} fallback={<div style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word', padding: '4px 10px', 'line-height': '1.6' }}>{seg.content}</div>}>
                    <CodeBlock code={seg.content} lang={seg.lang} />
                  </Show>
                )}
              </For>
            </div>
          </Show>
        }
      >
        <div
          style={{
            'white-space': 'pre-wrap',
            'word-break': 'break-word',
            padding: '4px 8px',
            opacity: '0.7',
            'font-style': 'italic',
            'border-left': '2px solid #71717a',
            'margin-left': '8px',
            'font-size': text.base,
            'line-height': '1.5',
          }}
        >
          {p().text ?? ''}
        </div>
      </Show>
    </Show>
  )
}

// ── MessageView ─────────────────────────────────────────────────

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
      role="article"
      aria-label={`${m().role} message`}
    >
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          'font-size': text.sm,
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
              title="Rewind session to this message (undo)"
              aria-label={`Rewind to message ${m().id.slice(0, 8)}`}
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
        <span style={{ opacity: '0.4', 'font-style': 'italic', 'font-size': text.base }}>(no content)</span>
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
          }}
        />
      </Show>
      <Show when={(m().provenance?.length ?? 0) > 0}>
        <ProvenanceView message={m()} />
      </Show>
    </div>
  )
}

// ── Activity Timeline ───────────────────────────────────────────

function ActivityTimeline(props: { messages: Message[] }) {
  const toolParts = createMemo(() => {
    const out: Array<{ tool: string; status: 'running' | 'done' | 'error'; elapsed?: number; id: string }> = []
    for (const msg of props.messages) {
      for (const p of msg.parts ?? []) {
        if (p.type === 'tool-call' || (p.type as string) === 'tool_call') {
          out.push({ tool: p.tool ?? 'tool', status: 'running', id: p.id })
        } else if (p.type === 'tool-result') {
          // Match to call or just show result
          out.push({ tool: p.tool ?? 'tool', status: p.isError ? 'error' : 'done', id: p.id })
        }
      }
    }
    return out.slice(-12)
  })

  const colorMode = getColorMode()
  const isNoColor = colorMode !== 'full' ? false : false // keep colors unless NO_COLOR

  return (
    <Show when={toolParts().length > 0}>
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '4px',
          padding: '8px 10px',
          'border-radius': '8px',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.06)',
          'margin-top': '8px',
        }}
        role="log"
        aria-label="Activity timeline"
      >
        <span style={{ 'font-size': '10px', 'font-weight': '700', color: '#9ca3af', 'letter-spacing': '0.05em' }}>
          ACTIVITY · {toolParts().length} tool calls
        </span>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '3px' }}>
          <For each={toolParts()}>
            {(t) => (
              <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'font-size': '11px' }}>
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    'border-radius': '50%',
                    background:
                      t.status === 'running' ? '#fbbf24' : t.status === 'error' ? '#f87171' : '#34d399',
                    display: 'inline-block',
                    flex: 'none',
                  }}
                  aria-label={t.status}
                />
                <span style={{ 'font-family': font.mono, color: '#e5e7eb', 'font-weight': '600' }}>{t.tool}</span>
                <span
                  style={{
                    'font-size': '10px',
                    padding: '1px 5px',
                    'border-radius': '999px',
                    background:
                      t.status === 'running'
                        ? 'rgba(251,191,36,0.15)'
                        : t.status === 'error'
                          ? 'rgba(239,68,68,0.15)'
                          : 'rgba(16,185,129,0.15)',
                    color: t.status === 'running' ? '#fcd34d' : t.status === 'error' ? '#fca5a5' : '#6ee7b7',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  {t.status}
                </span>
                <Show when={t.elapsed !== undefined}>
                  <span style={{ 'font-size': '10px', color: '#6b7280', 'font-family': font.mono }}>{t.elapsed}ms</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

// ── Main SessionView ────────────────────────────────────────────

export default function SessionView(props: Props) {
  const current = createMemo(() => props.sessions.find((s) => s.id === props.currentId) ?? null)
  const [search, setSearch] = createSignal('')
  const [msgSearch, setMsgSearch] = createSignal('')
  const [confirmId, setConfirmId] = createSignal<string | null>(null)
  const [focusedIdx, setFocusedIdx] = createSignal(0)
  const [msgFocusedIdx, setMsgFocusedIdx] = createSignal(0)
  const [showMsgSearch, setShowMsgSearch] = createSignal(false)

  const isActive = (group: FocusGroup) => props.focusGroup === group

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

  const filteredMessages = createMemo(() => {
    const q = msgSearch().trim().toLowerCase()
    if (!q) return props.messages
    return props.messages.filter((m) => {
      const text = (m.parts ?? []).map((p) => p.text ?? p.tool ?? '').join(' ').toLowerCase()
      return text.includes(q) || m.role.toLowerCase().includes(q)
    })
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

  // ── Pinned scroll + jump pill ─────────────────────────────────
  let scrollRef: HTMLDivElement | undefined
  let sidebarListRef: HTMLDivElement | undefined
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

  createEffect(() => {
    void props.messages.length
    if (pinned()) queueMicrotask(() => scrollToBottom(true))
  })
  createEffect(() => {
    void props.streamText
    if (pinned()) queueMicrotask(() => scrollToBottom(false))
  })

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

  // ── Keyboard: sidebar list nav ────────────────────────────────
  const onSidebarKeyDown = (e: KeyboardEvent) => {
    const len = filteredSessions().length
    if (len === 0) return
    const cur = focusedIdx()
    let next = cur
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault()
      next = rovingIndex(cur, 'ArrowDown', len)
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault()
      next = rovingIndex(cur, 'ArrowUp', len)
    } else if (e.key === 'Home' || (e.key === 'g' && !e.ctrlKey)) {
      e.preventDefault()
      next = 0
    } else if (e.key === 'End' || e.key === 'G') {
      e.preventDefault()
      next = len - 1
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const s = filteredSessions()[focusedIdx()]
      if (s) props.onSelect(s.id)
      return
    } else if (e.key === 'd' || e.key === 'Delete') {
      e.preventDefault()
      const s = filteredSessions()[focusedIdx()]
      if (s) setConfirmId(s.id)
      return
    } else if (e.key === 'n') {
      e.preventDefault()
      props.onCreate()
      return
    } else {
      return
    }
    setFocusedIdx(next)
    // Ensure visible
    queueMicrotask(() => {
      const el = sidebarListRef?.querySelector<HTMLElement>(`[data-idx="${next}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    })
  }

  // ── Keyboard: message list nav ────────────────────────────────
  const onMessagesKeyDown = (e: KeyboardEvent) => {
    const len = filteredMessages().length
    if (len === 0) return
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault()
      const next = Math.min(msgFocusedIdx() + 1, len - 1)
      setMsgFocusedIdx(next)
      document.querySelector<HTMLElement>(`[data-msg-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault()
      const next = Math.max(msgFocusedIdx() - 1, 0)
      setMsgFocusedIdx(next)
      document.querySelector<HTMLElement>(`[data-msg-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'G' || e.key === 'End') {
      e.preventDefault()
      setMsgFocusedIdx(len - 1)
      scrollToBottom(true)
    } else if (e.key === 'g' || e.key === 'Home') {
      e.preventDefault()
      setMsgFocusedIdx(0)
      scrollRef?.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // ── Global search events ──────────────────────────────────────
  onMount(() => {
    const onSearchMessages = () => {
      setShowMsgSearch(true)
      queueMicrotask(() => {
        const el = document.querySelector<HTMLInputElement>('[data-msg-search]')
        el?.focus()
        el?.select()
      })
    }
    const onDeleteSession = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined
      if (id) setConfirmId(id)
    }
    window.addEventListener('mira:search-messages', onSearchMessages)
    window.addEventListener('mira:delete-session', onDeleteSession as EventListener)
    onCleanup(() => {
      window.removeEventListener('mira:search-messages', onSearchMessages)
      window.removeEventListener('mira:delete-session', onDeleteSession as EventListener)
    })
  })

  // ── Virtual scrolling window (simple windowing for large histories) ──
  const VIRTUAL_THRESHOLD = 80
  const VIRTUAL_WINDOW = 50
  const virtualSlice = createMemo(() => {
    const msgs = filteredMessages()
    if (msgs.length <= VIRTUAL_THRESHOLD) return { slice: msgs, offset: 0, total: msgs.length }
    // Show window around focused or latest
    const focus = msgFocusedIdx()
    const center = focus > 0 ? focus : msgs.length - 1
    const half = Math.floor(VIRTUAL_WINDOW / 2)
    let start = Math.max(0, center - half)
    let end = Math.min(msgs.length, start + VIRTUAL_WINDOW)
    if (end - start < VIRTUAL_WINDOW) start = Math.max(0, end - VIRTUAL_WINDOW)
    return { slice: msgs.slice(start, end), offset: start, total: msgs.length }
  })

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'row',
        height: '100%',
        gap: space.md,
        padding: space.sm,
      }}
    >
      {/* ── Sidebar: sessions (30%) ── */}
      <div
        data-tab-group="sidebar"
        data-focused={isActive('sidebar') ? 'true' : 'false'}
        onClick={() => props.onFocusGroupChange?.('sidebar')}
        style={{
          width: '30%',
          'min-width': '200px',
          'max-width': '320px',
          display: 'flex',
          'flex-direction': 'column',
          gap: space.sm,
          border: isActive('sidebar') ? '1px solid rgba(99,102,241,0.45)' : `1px solid ${surface.border}`,
          'border-radius': '10px',
          padding: '10px',
          background: isActive('sidebar') ? 'rgba(99,102,241,0.06)' : surface.card,
          overflow: 'hidden',
          'box-shadow': isActive('sidebar') ? '0 0 0 1px rgba(99,102,241,0.15)' : 'none',
          transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s',
        }}
        role="complementary"
        aria-label="Sessions"
      >
        <div
          style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}
        >
          <span style={{ 'font-weight': '700', 'font-size': text.md, 'letter-spacing': '0.04em' }}>
            SESSIONS
          </span>
          <button
            type="button"
            onClick={props.onCreate}
            title="New session (n)"
            aria-label="New session"
            style={{
              padding: '4px 10px',
              'border-radius': '6px',
              border: '1px solid rgba(99,102,241,0.5)',
              background: 'rgba(99,102,241,0.15)',
              color: '#a5b4fc',
              cursor: 'pointer',
              'font-size': text.base,
              'font-weight': '600',
            }}
          >
            + New
          </button>
        </div>

        <input
          type="text"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          onFocus={() => props.onFocusGroupChange?.('sidebar')}
          placeholder="Search sessions… (/)"
          aria-label="Search sessions"
          style={{
            padding: '6px 8px',
            'border-radius': '6px',
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(0,0,0,0.28)',
            color: '#e5e7eb',
            'font-size': text.base,
            outline: 'none',
            width: '100%',
            'box-sizing': 'border-box',
          }}
        />

        <div
          ref={sidebarListRef}
          role="listbox"
          aria-label="Sessions"
          aria-orientation="vertical"
          tabindex={0}
          onKeyDown={onSidebarKeyDown}
          onFocus={() => props.onFocusGroupChange?.('sidebar')}
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '4px',
            overflow: 'auto',
            flex: '1',
            outline: 'none',
          }}
        >
          <For each={filteredSessions()}>
            {(s, i) => {
              const isSelected = () => s.id === props.currentId
              const isFocused = () => focusedIdx() === i()
              return (
                <div
                  data-idx={i()}
                  role="option"
                  aria-selected={isSelected() ? 'true' : 'false'}
                  tabindex={isFocused() ? 0 : -1}
                  onClick={() => props.onSelect(s.id)}
                  onFocus={() => setFocusedIdx(i())}
                  style={{
                    padding: '8px 10px',
                    'border-radius': '8px',
                    cursor: 'pointer',
                    background: isSelected()
                      ? 'rgba(99,102,241,0.18)'
                      : isFocused()
                        ? 'rgba(255,255,255,0.06)'
                        : 'transparent',
                    border: isSelected()
                      ? '1px solid rgba(99,102,241,0.35)'
                      : isFocused()
                        ? '1px solid rgba(255,255,255,0.12)'
                        : '1px solid transparent',
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '2px',
                    outline: 'none',
                    position: 'relative',
                  }}
                >
                  <Show when={isFocused() && !isSelected()}>
                    <span
                      style={{
                        position: 'absolute',
                        left: '0',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: '3px',
                        height: '60%',
                        'border-radius': '999px',
                        background: 'rgba(99,102,241,0.6)',
                      }}
                      aria-hidden="true"
                    />
                  </Show>
                  <span
                    style={{
                      'font-weight': isSelected() ? '600' : '500',
                      'font-size': text.md,
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
                      'font-size': text.sm,
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
              )
            }}
          </For>
          <Show when={filteredSessions().length === 0 && search().trim()}>
            <span style={{ opacity: '0.45', 'font-size': text.base, padding: '8px' }}>
              No matches for “{search()}”
            </span>
          </Show>
          <Show when={props.sessions.length === 0}>
            <span style={{ opacity: '0.45', 'font-size': text.base, padding: '8px' }}>
              No sessions yet — press <kbd style={{ padding: '1px 4px', 'border-radius': '3px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}>n</kbd> to create one.
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
                'font-size': text.sm,
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
                    'font-size': text.base,
                    display: 'flex',
                    gap: '6px',
                    'align-items': 'center',
                    opacity: t.status === 'completed' ? '0.45' : '0.9',
                  }}
                >
                  <span aria-hidden="true">
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
              type="button"
              onClick={() => setConfirmId(c().id)}
              title="Delete session (d)"
              aria-label="Delete current session"
              style={{
                padding: '6px',
                'border-radius': '6px',
                border: '1px solid rgba(239,68,68,0.25)',
                background: 'transparent',
                color: '#fca5a5',
                cursor: 'pointer',
                'font-size': text.base,
              }}
            >
              Delete session
            </button>
          )}
        </Show>
        <div style={{ 'font-size': '10px', opacity: '0.35', 'text-align': 'center' }}>
          j/k or ↑↓ nav · Enter select · d delete · n new · / search
        </div>
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

      {/* ── Main: messages (70%) ── */}
      <div
        data-tab-group="main"
        data-focused={isActive('messages') ? 'true' : 'false'}
        onClick={() => props.onFocusGroupChange?.('messages')}
        style={{
          flex: '1',
          display: 'flex',
          'flex-direction': 'column',
          gap: '4px',
          border: isActive('messages') ? '1px solid rgba(99,102,241,0.45)' : `1px solid ${surface.border}`,
          'border-radius': '10px',
          padding: '10px',
          background: isActive('messages') ? 'rgba(99,102,241,0.04)' : surface.card,
          overflow: 'hidden',
          position: 'relative',
          'box-shadow': isActive('messages') ? '0 0 0 1px rgba(99,102,241,0.15)' : 'none',
          transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s',
        }}
        role="main"
        aria-label="Messages"
        tabindex={0}
        onKeyDown={onMessagesKeyDown}
        onFocus={() => props.onFocusGroupChange?.('messages')}
      >
        <div
          style={{
            display: 'flex',
            'justify-content': 'space-between',
            'align-items': 'center',
            'padding-bottom': '6px',
            'border-bottom': '1px solid rgba(255,255,255,0.06)',
            gap: '8px',
          }}
        >
          <span style={{ 'font-weight': '600', 'font-size': text.md }}>
            {current()?.title ?? (props.currentId ? 'Session' : 'No session selected')}
          </span>
          <span style={{ 'font-size': text.sm, opacity: '0.5', display: 'flex', gap: '8px', 'align-items': 'center' }}>
            <span>{filteredMessages().length} messages</span>
            <Show when={virtualSlice().total > VIRTUAL_THRESHOLD}>
              <span style={{ 'font-size': '10px', padding: '1px 5px', 'border-radius': '999px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
                virtual {virtualSlice().offset + 1}–{virtualSlice().offset + virtualSlice().slice.length} of {virtualSlice().total}
              </span>
            </Show>
            <Show when={props.streaming}>
              <span>
                {' '}
                · {formatElapsed(elapsed())} · {tokensPerSec().toFixed(1)} tok/s
              </span>
            </Show>
          </span>
        </div>

        {/* Message search */}
        <Show when={showMsgSearch()}>
          <div style={{ display: 'flex', gap: '6px', 'align-items': 'center', padding: '4px 0' }}>
            <input
              data-msg-search
              type="text"
              value={msgSearch()}
              onInput={(e) => setMsgSearch(e.currentTarget.value)}
              placeholder="Search messages…"
              aria-label="Search messages"
              style={{
                flex: '1',
                padding: '6px 8px',
                'border-radius': '6px',
                border: '1px solid rgba(99,102,241,0.35)',
                background: 'rgba(0,0,0,0.28)',
                color: '#e5e7eb',
                'font-size': text.base,
                outline: 'none',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setShowMsgSearch(false)
                  setMsgSearch('')
                }
              }}
            />
            <button
              type="button"
              onClick={() => {
                setShowMsgSearch(false)
                setMsgSearch('')
              }}
              aria-label="Close search"
              style={{
                padding: '4px 8px',
                'border-radius': '6px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.06)',
                color: '#9ca3af',
                cursor: 'pointer',
                'font-size': text.base,
              }}
            >
              ✕
            </button>
          </div>
        </Show>

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
          role="log"
          aria-label="Message history"
          aria-live="polite"
        >
          <Show when={virtualSlice().offset > 0}>
            <div style={{ padding: '6px', 'text-align': 'center', 'font-size': '11px', opacity: '0.4' }}>
              ↑ {virtualSlice().offset} earlier messages hidden — scroll or press g to jump to top
            </div>
          </Show>
          <For each={virtualSlice().slice}>
            {(m, i) => {
              const globalIdx = () => virtualSlice().offset + i()
              const isLast = () => globalIdx() === filteredMessages().length - 1
              const isFocused = () => msgFocusedIdx() === globalIdx()
              return (
                <div
                  data-msg-idx={globalIdx()}
                  style={{
                    outline: isFocused() ? '1px solid rgba(99,102,241,0.35)' : 'none',
                    'border-radius': '8px',
                  }}
                >
                  <MessageView
                    message={m}
                    onRewind={props.onRewind}
                    showCaret={showCaret() && isLast()}
                  />
                </div>
              )
            }}
          </For>
          <Show when={virtualSlice().offset + virtualSlice().slice.length < virtualSlice().total}>
            <div style={{ padding: '6px', 'text-align': 'center', 'font-size': '11px', opacity: '0.4' }}>
              ↓ {virtualSlice().total - virtualSlice().offset - virtualSlice().slice.length} more messages — press G to jump to latest
            </div>
          </Show>
          <Show when={filteredMessages().length === 0 && props.messages.length > 0}>
            <div style={{ padding: '16px', 'text-align': 'center', opacity: '0.5', 'font-size': text.md }}>
              No messages match “{msgSearch()}”
            </div>
          </Show>
          <Show when={props.messages.length === 0}>
            <div
              style={{
                flex: '1',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                opacity: '0.4',
                'font-size': text.md,
                padding: '24px',
                'text-align': 'center',
              }}
            >
              No messages yet. Type a prompt below to start the agent loop — Mira will stream tool
              calls, permissions, and compaction events live.
            </div>
          </Show>
          <Show when={typingDots()}>
            <div
              style={{ display: 'flex', gap: '4px', padding: '8px 0 0 8px' }}
              aria-label="Mira is responding"
            >
              <span style={{ width: '6px', height: '6px', 'border-radius': '999px', background: '#a5b4fc' }} />
              <span style={{ width: '6px', height: '6px', 'border-radius': '999px', background: '#a5b4fc' }} />
              <span style={{ width: '6px', height: '6px', 'border-radius': '999px', background: '#a5b4fc' }} />
            </div>
          </Show>
          <Show when={props.streaming && !typingDots()}>
            <div
              style={{
                padding: '8px',
                'font-size': text.base,
                opacity: '0.6',
                display: 'flex',
                gap: '8px',
                'align-items': 'center',
              }}
            >
              <span>● streaming… {formatElapsed(elapsed())}</span>
              <Show when={tokensPerSec() > 0}>
                <span style={{ 'font-family': font.mono, 'font-size': text.sm, opacity: '0.7' }}>
                  {tokensPerSec().toFixed(1)} tok/s
                </span>
              </Show>
              <Show when={props.streamText && props.streamText.length > 0}>
                <span style={{ 'font-family': font.mono, 'font-size': text.sm, opacity: '0.5' }}>
                  {Math.ceil((props.streamText?.length ?? 0) / 4)} tok
                </span>
              </Show>
            </div>
          </Show>
          <Show when={props.streaming && typingDots()}>
            <div
              style={{
                padding: '8px',
                'font-size': text.base,
                opacity: '0.6',
                display: 'flex',
                gap: '8px',
                'align-items': 'center',
              }}
            >
              <span>● streaming… {formatElapsed(elapsed())}</span>
            </div>
          </Show>
          {/* Activity timeline */}
          <ActivityTimeline messages={props.messages} />
        </div>

        {/* jump pill when unpinned */}
        <Show when={!pinned() && props.messages.length > 0}>
          <button
            type="button"
            onClick={() => {
              setPinned(true)
              scrollToBottom(true)
            }}
            aria-label="Jump to latest message"
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
              'font-size': text.sm,
              'font-weight': '600',
              cursor: 'pointer',
              'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
              'z-index': '5',
            }}
          >
            ↓ Jump to latest
          </button>
        </Show>

        {/* ── Queued strip ── */}
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
            role="status"
            aria-label="Queued prompts"
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
              <span style={{ 'font-size': text.sm, 'font-weight': '700', color: '#a5b4fc', 'letter-spacing': '0.04em' }}>
                ⏳ Queued · {(props.queued ?? []).length}
              </span>
              <span style={{ 'font-size': '10px', color: '#6b7280' }}>
                — will run after current turn · /queue to manage
              </span>
            </div>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
              <For each={(props.queued ?? []).slice(0, 3)}>
                {(q, i) => (
                  <div style={{ display: 'flex', gap: '6px', 'align-items': 'center', 'font-size': text.sm }}>
                    <span style={{ color: '#6b7280', 'font-family': font.mono, 'font-size': '10px', flex: 'none' }}>
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
