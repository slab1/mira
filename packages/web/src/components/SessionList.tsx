import { For, Show, createSignal, createMemo } from 'solid-js'
import type { AppStore } from '../stores/app'
import { getApiUrl } from '../api/client'
import { ConfirmDialog } from './ConfirmDialog'
import { toast } from './Toast'

function serverHost(): string {
  try {
    const u = getApiUrl()
    if (u) return new URL(u).host
    return window.location.host
  } catch {
    return 'unknown'
  }
}

type StatusInfo = { label: string; color: string; bg: string; border: string; icon: string }

function sessionStatus(session: { id: string }, store: AppStore): StatusInfo {
  const s = store.state
  const isActive = s.currentId === session.id
  const isStreaming = isActive && s.streaming
  const isQueued = s.queued.length > 0 && isActive
  if (isStreaming) return { label: 'streaming', color: 'var(--warn)', bg: 'var(--warn-soft)', border: 'var(--warn-border)', icon: '◷' }
  if (isQueued) return { label: 'queued', color: 'var(--warn)', bg: 'var(--warn-soft)', border: 'var(--warn-border)', icon: '⏳' }
  if (s.error && isActive) return { label: 'error', color: 'var(--danger)', bg: 'var(--danger-soft)', border: 'var(--danger-border)', icon: '⚠' }
  if (isActive) return { label: 'active', color: 'var(--ok)', bg: 'var(--ok-soft)', border: 'var(--ok-border)', icon: '●' }
  return { label: 'idle', color: 'var(--fg-faint)', bg: 'transparent', border: 'var(--border)', icon: '○' }
}

export function SessionList(props: { store: AppStore; open?: boolean }) {
  const s = () => props.store.state
  const [confirmDelete, setConfirmDelete] = createSignal<{ id: string; title: string } | null>(null)
  const [search, setSearch] = createSignal('')
  const [statusFilter, setStatusFilter] = createSignal<'all' | 'active' | 'idle'>('all')
  const [pinned, setPinned] = createSignal<Set<string>>(
    (() => {
      try {
        const raw = localStorage.getItem('mira.pinnedSessions')
        return new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
      } catch {
        return new Set<string>()
      }
    })(),
  )

  const togglePin = (id: string) => {
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem('mira.pinnedSessions', JSON.stringify([...next]))
      } catch {}
      return next
    })
  }

  const filtered = createMemo(() => {
    const q = search().toLowerCase().trim()
    const sf = statusFilter()
    let list = s().sessions
    if (q) {
      list = list.filter(
        (sess) =>
          (sess.title ?? '').toLowerCase().includes(q) ||
          sess.id.toLowerCase().includes(q) ||
          (sess.model ?? '').toLowerCase().includes(q) ||
          (sess.agent ?? '').toLowerCase().includes(q),
      )
    }
    if (sf !== 'all') {
      list = list.filter((sess) => {
        const st = sessionStatus(sess, props.store)
        if (sf === 'active') return st.label === 'active' || st.label === 'streaming' || st.label === 'queued'
        return st.label === 'idle'
      })
    }
    // Pinned first, then by updatedAt desc
    const pinSet = pinned()
    return [...list].sort((a, b) => {
      const aPinned = pinSet.has(a.id)
      const bPinned = pinSet.has(b.id)
      if (aPinned && !bPinned) return -1
      if (!aPinned && bPinned) return 1
      return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    })
  })

  const costLabel = (sess: { costUsd?: number | null; tokensIn?: number | null; tokensOut?: number | null }) => {
    if (sess.costUsd != null && sess.costUsd > 0) return `$${sess.costUsd.toFixed(4)}`
    if (sess.tokensIn != null || sess.tokensOut != null) return `${sess.tokensIn ?? 0}in/${sess.tokensOut ?? 0}out`
    return null
  }

  return (
    <aside
      class={`mira-sidebar${props.open ? ' mira-sidebar-open' : ''}`}
      style={{
        width: '280px',
        'flex-shrink': '0',
        display: 'flex',
        'flex-direction': 'column',
        'border-right': '1px solid var(--border)',
        background: 'var(--bg-app)',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* header */}
      <div
        style={{
          padding: 'var(--sp-3) var(--sp-4)',
          'border-bottom': '1px solid var(--border)',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          gap: 'var(--sp-2)',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '9px' }}>
          <div class="logo-tile">M</div>
          <span style={{ 'font-weight': '700', 'font-size': 'var(--fs-md)', 'letter-spacing': '-0.02em' }}>Mira</span>
          <span class="pill">web</span>
        </div>
        <span title={s().connected ? 'WebSocket connected' : 'Disconnected — retrying'} aria-label={s().connected ? 'Connected' : 'Disconnected'} style={{ display: 'inline-flex' }}>
          <span
            class={`dot ${s().connected ? 'dot-pulse' : ''}`}
            style={{ width: '8px', height: '8px', background: s().connected ? 'var(--ok)' : 'var(--danger)', 'box-shadow': s().connected ? '0 0 8px var(--ok-soft)' : 'none' }}
          />
        </span>
      </div>

      {/* actions */}
      <div style={{ padding: 'var(--sp-3)', 'border-bottom': '1px solid var(--border)', display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
        <button
          type="button"
          class="btn btn-solid"
          onClick={() => void props.store.createSession().catch(() => {})}
          disabled={s().loading}
          aria-busy={s().loading ? 'true' : 'false'}
          style={{ width: '100%', padding: '8px 12px', 'font-size': 'var(--fs-sm)' }}
        >
          {s().loading ? 'Creating…' : '＋ New session'}
        </button>

        {/* Search */}
        <div class="session-search" role="search">
          <span aria-hidden="true" style={{ color: 'var(--fg-faint)', 'font-size': '12px' }}>
            ⌕
          </span>
          <input
            type="search"
            placeholder="Search sessions…"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
            aria-label="Search sessions"
          />
          <Show when={search()}>
            <button type="button" class="btn btn-ghost" onClick={() => setSearch('')} aria-label="Clear search" style={{ padding: '2px 6px', 'font-size': 'var(--fs-xs)', 'min-height': '24px' }}>
              ✕
            </button>
          </Show>
        </div>

        {/* Status filter */}
        <div style={{ display: 'flex', gap: '4px' }} role="tablist" aria-label="Filter by status">
          <For each={(['all', 'active', 'idle'] as const)}>
            {(f) => (
              <button
                type="button"
                role="tab"
                aria-selected={statusFilter() === f ? 'true' : 'false'}
                class="btn btn-ghost"
                onClick={() => setStatusFilter(f)}
                style={{
                  flex: '1',
                  padding: '4px 6px',
                  'font-size': 'var(--fs-2xs)',
                  'font-weight': '600',
                  'text-transform': 'capitalize',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-full)',
                  background: statusFilter() === f ? 'var(--accent-soft)' : 'transparent',
                  color: statusFilter() === f ? 'var(--accent)' : 'var(--fg-subtle)',
                  'border-color': statusFilter() === f ? 'var(--accent-border)' : 'var(--border)',
                }}
              >
                {f}
              </button>
            )}
          </For>
        </div>

        <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => void props.store.loadSessions()}
            disabled={s().loading}
            aria-busy={s().loading ? 'true' : 'false'}
            title="Refresh sessions"
            style={{ flex: '1', padding: '5px 8px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)' }}
          >
            {s().loading ? '…' : '↻ Refresh'}
          </button>
          <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', padding: '0 4px' }} role="status">
            {filtered().length}/{s().sessions.length}
          </span>
        </div>
      </div>

      {/* list */}
      <div class="scroll" style={{ flex: '1', padding: 'var(--sp-2)' }}>
        <Show
          when={!s().loading}
          fallback={
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px', padding: '4px' }} aria-label="Loading sessions">
              {[0, 1, 2, 3].map(() => (
                <div class="skeleton" style={{ height: '64px', 'border-radius': 'var(--r-md)' }} />
              ))}
            </div>
          }
        >
          <Show
            when={filtered().length > 0}
            fallback={
              <Show
                when={s().sessions.length > 0}
                fallback={
                  <div
                    style={{
                      margin: 'var(--sp-4) var(--sp-2)',
                      padding: 'var(--sp-5) var(--sp-4)',
                      border: '1px dashed var(--border-strong)',
                      'border-radius': 'var(--r-lg)',
                      'text-align': 'center',
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '10px',
                      'align-items': 'center',
                    }}
                  >
                    <div
                      style={{
                        width: '36px',
                        height: '36px',
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
                    <div>
                      <div style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', color: 'var(--fg)' }}>No sessions yet</div>
                      <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'margin-top': '3px' }}>Spin up your first chat to start working with the agent.</div>
                    </div>
                    <button type="button" class="btn btn-outline" onClick={() => void props.store.createSession().catch(() => {})} disabled={s().loading} aria-busy={s().loading ? 'true' : 'false'} style={{ padding: '6px 12px', 'font-size': 'var(--fs-sm)' }}>
                      {s().loading ? 'Creating…' : '＋ New session'}
                    </button>
                  </div>
                }
              >
                <div
                  style={{
                    padding: '12px',
                    'text-align': 'center',
                    'font-size': 'var(--fs-sm)',
                    color: 'var(--fg-faint)',
                    'line-height': '1.5',
                  }}
                >
                  No sessions match "{search()}"{statusFilter() !== 'all' ? ` · ${statusFilter()}` : ''}.
                </div>
              </Show>
            }
          >
            <div role="list" style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
              <For each={filtered()}>
                {(sess) => {
                  const active = () => s().currentId === sess.id
                  const isPinned = () => pinned().has(sess.id)
                  const st = () => sessionStatus(sess, props.store)
                  const cost = () => costLabel(sess)
                  return (
                    <div class={`session-row ${active() ? 'active' : ''}`} role="listitem">
                      <button type="button" class="session-main" aria-current={active() ? 'true' : undefined} onClick={() => props.store.selectSession(sess.id)}>
                        {/* Status + pin row */}
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'margin-bottom': '4px' }}>
                          <span
                            class="pill"
                            style={{
                              'font-size': 'var(--fs-2xs)',
                              padding: '1px 6px',
                              background: st().bg,
                              color: st().color,
                              border: `1px solid ${st().border}`,
                              gap: '4px',
                            }}
                          >
                            <span class={`dot ${st().label === 'streaming' ? 'dot-pulse' : ''}`} style={{ background: st().color, width: '6px', height: '6px' }} />
                            {st().label}
                          </span>
                          <Show when={sess.agent}>
                            <span class="pill" style={{ 'font-size': 'var(--fs-2xs)', padding: '1px 6px', 'font-family': 'var(--font-mono)' }}>
                              {sess.agent}
                            </span>
                          </Show>
                          <Show when={isPinned()}>
                            <span style={{ 'font-size': '10px', color: 'var(--accent)' }} title="Pinned">
                              📌
                            </span>
                          </Show>
                        </div>
                        <span
                          style={{
                            display: 'block',
                            'font-size': 'var(--fs-sm)',
                            'font-weight': active() ? '600' : '500',
                            color: active() ? 'var(--fg)' : 'var(--fg-muted)',
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                            'white-space': 'nowrap',
                          }}
                        >
                          {sess.title || `Session ${sess.id.slice(0, 6)}`}
                        </span>
                        <span style={{ display: 'block', 'margin-top': '3px', 'font-size': 'var(--fs-2xs)', color: 'var(--fg-subtle)' }}>
                          {sess.model || 'default'} · {new Date(sess.updatedAt || sess.createdAt).toLocaleString()}
                        </span>
                        <span
                          style={{
                            display: 'block',
                            'margin-top': '2px',
                            'font-family': 'var(--font-mono)',
                            'font-size': 'var(--fs-2xs)',
                            color: 'var(--fg-faint)',
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                            'white-space': 'nowrap',
                          }}
                        >
                          {sess.id}
                        </span>
                        <Show when={cost()}>
                          <span
                            style={{
                              display: 'inline-flex',
                              'margin-top': '4px',
                              'font-family': 'var(--font-mono)',
                              'font-size': 'var(--fs-2xs)',
                              color: 'var(--fg-subtle)',
                              background: 'var(--bg-surface)',
                              border: '1px solid var(--border)',
                              'border-radius': 'var(--r-full)',
                              padding: '1px 6px',
                            }}
                          >
                            {cost()}
                          </span>
                        </Show>
                      </button>
                      {/* Pin button */}
                      <button
                        type="button"
                        class={`session-pin-btn ${isPinned() ? 'pinned' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          togglePin(sess.id)
                        }}
                        title={isPinned() ? 'Unpin session' : 'Pin session'}
                        aria-label={isPinned() ? 'Unpin session' : 'Pin session'}
                        aria-pressed={isPinned() ? 'true' : 'false'}
                        style={{ position: 'absolute', top: '8px', right: '32px' }}
                      >
                        📌
                      </button>
                      <button
                        type="button"
                        class="session-del btn btn-ghost"
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmDelete({ id: sess.id, title: sess.title || sess.id.slice(0, 6) })
                        }}
                        title="Delete session"
                        aria-label={`Delete session ${sess.title || sess.id.slice(0, 6)}`}
                        style={{ width: '28px', height: '28px', 'min-height': '28px', 'min-width': '28px' }}
                      >
                        ×
                      </button>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={s().error}>
        <div class="alert" role="alert" style={{ margin: '0 var(--sp-3) var(--sp-2)', padding: '8px 10px', 'font-size': 'var(--fs-xs)' }}>
          ⚠ {s().error}
          <button type="button" onClick={() => props.store.clearError()} class="alert-close btn btn-ghost" aria-label="Dismiss error" style={{ 'margin-left': '8px', padding: '2px 6px', 'font-size': 'var(--fs-xs)', 'min-height': '28px' }}>
            ×
          </button>
        </div>
      </Show>

      <div
        style={{
          padding: '9px var(--sp-3)',
          'border-top': '1px solid var(--border)',
          color: 'var(--fg-faint)',
          'font-size': 'var(--fs-2xs)',
          display: 'flex',
          'justify-content': 'space-between',
          'font-family': 'var(--font-mono)',
        }}
      >
        <span>Mira Web · SolidJS</span>
        <span
          title={s().connected ? `Connected to ${serverHost()}` : `Offline — cannot reach ${serverHost()}`}
          style={{ color: s().connected ? 'var(--fg-faint)' : 'var(--danger)', 'text-decoration': s().connected ? 'none' : 'line-through', display: 'inline-flex', 'align-items': 'center', gap: '4px' }}
        >
          <span aria-hidden="true" style={{ width: '6px', height: '6px', 'border-radius': '50%', background: s().connected ? 'var(--ok)' : 'var(--danger)' }} />
          {serverHost()}
        </span>
      </div>
      <ConfirmDialog
        open={() => confirmDelete() !== null}
        title="Delete session?"
        message={confirmDelete() ? `This will permanently delete "${confirmDelete()!.title}" and all its messages. This cannot be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          const item = confirmDelete()
          setConfirmDelete(null)
          if (item) {
            void props.store
              .deleteSession(item.id)
              .then(() => toast.success('Session deleted'))
              .catch((e) => toast.error(`Delete failed: ${(e as Error).message}`))
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </aside>
  )
}
