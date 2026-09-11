import { For, Show, createSignal, createMemo, onMount } from 'solid-js'
import type { AppStore } from '../stores/app'
import { api, getApiUrl, type WorkspaceEntry } from '../api/client'
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
  if (isStreaming)
    return {
      label: 'streaming',
      color: 'var(--warn)',
      bg: 'var(--warn-soft)',
      border: 'var(--warn-border)',
      icon: '◷',
    }
  if (isQueued)
    return {
      label: 'queued',
      color: 'var(--warn)',
      bg: 'var(--warn-soft)',
      border: 'var(--warn-border)',
      icon: '⏳',
    }
  if (s.error && isActive)
    return {
      label: 'error',
      color: 'var(--danger)',
      bg: 'var(--danger-soft)',
      border: 'var(--danger-border)',
      icon: '⚠',
    }
  if (isActive)
    return {
      label: 'active',
      color: 'var(--ok)',
      bg: 'var(--ok-soft)',
      border: 'var(--ok-border)',
      icon: '●',
    }
  return {
    label: 'idle',
    color: 'var(--fg-faint)',
    bg: 'transparent',
    border: 'var(--border)',
    icon: '○',
  }
}

function projectLabel(sess: { projectId?: string | null; cwd?: string | null }): string {
  if (sess.projectId) return sess.projectId
  if (sess.cwd) {
    const parts = sess.cwd.replace(/\/$/, '').split('/')
    return parts[parts.length - 1] || sess.cwd
  }
  return 'default'
}

export function SessionList(props: { store: AppStore; open?: boolean }) {
  const s = () => props.store.state
  const [confirmDelete, setConfirmDelete] = createSignal<{ id: string; title: string } | null>(null)
  const [search, setSearch] = createSignal('')
  const [statusFilter, setStatusFilter] = createSignal<'all' | 'active' | 'idle'>('all')
  const [projectFilter, setProjectFilter] = createSignal<string>('all')
  const [groupByProject, setGroupByProject] = createSignal(false)
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

  // ── Workspace switcher (P2-2) ──────────────────────────────────
  const [workspaces, setWorkspaces] = createSignal<WorkspaceEntry[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = createSignal<string>(
    (() => {
      try {
        return localStorage.getItem('mira.selectedWorkspace') ?? ''
      } catch {
        return ''
      }
    })(),
  )
  const [workspaceLoading, setWorkspaceLoading] = createSignal(false)
  const [showAddWorkspace, setShowAddWorkspace] = createSignal(false)
  const [newWorkspacePath, setNewWorkspacePath] = createSignal('')

  const loadWorkspaces = async () => {
    setWorkspaceLoading(true)
    try {
      const list = await api.listWorkspaces()
      setWorkspaces(list)
      // Auto-select first if none selected and list non-empty
      if (!selectedWorkspace() && list.length > 0) {
        // keep empty = default, don't auto-select
      }
    } catch {
      // ignore — workspaces optional
    } finally {
      setWorkspaceLoading(false)
    }
  }
  onMount(() => void loadWorkspaces())

  const handleWorkspaceChange = (path: string) => {
    setSelectedWorkspace(path)
    try {
      if (path) localStorage.setItem('mira.selectedWorkspace', path)
      else localStorage.removeItem('mira.selectedWorkspace')
    } catch {}
  }

  const handleAddWorkspace = async () => {
    const p = newWorkspacePath().trim()
    if (!p) return
    try {
      const res = await api.addWorkspace(p)
      setWorkspaces(res.workspaces)
      handleWorkspaceChange(res.workspace.path)
      setNewWorkspacePath('')
      setShowAddWorkspace(false)
      toast.success(`Workspace added: ${res.workspace.path}`)
    } catch (e) {
      toast.error(`Add workspace failed: ${(e as Error).message}`)
    }
  }

  const handleCreateSession = () => {
    const cwd = selectedWorkspace() || undefined
    void props.store.createSession(undefined, cwd ? { cwd } : {}).catch(() => {})
  }

  const availableProjects = createMemo(() => {
    const set = new Set<string>()
    for (const sess of s().sessions) set.add(projectLabel(sess as { projectId?: string | null; cwd?: string | null }))
    return [...set].sort()
  })

  const filtered = createMemo(() => {
    const q = search().toLowerCase().trim()
    const sf = statusFilter()
    const pf = projectFilter()
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
        if (sf === 'active')
          return st.label === 'active' || st.label === 'streaming' || st.label === 'queued'
        return st.label === 'idle'
      })
    }
    if (pf !== 'all') {
      list = list.filter((sess) => projectLabel(sess as { projectId?: string | null; cwd?: string | null }) === pf)
    }
    // Pinned first, then by updatedAt desc
    const pinSet = pinned()
    return [...list].sort((a, b) => {
      const aPinned = pinSet.has(a.id)
      const bPinned = pinSet.has(b.id)
      if (aPinned && !bPinned) return -1
      if (!aPinned && bPinned) return 1
      return (
        new Date(b.updatedAt || b.createdAt).getTime() -
        new Date(a.updatedAt || a.createdAt).getTime()
      )
    })
  })

  const grouped = createMemo(() => {
    if (!groupByProject()) return null
    const map = new Map<string, typeof filtered extends () => infer T ? T extends Array<infer U> ? U[] : never : never>()
    for (const sess of filtered()) {
      const key = projectLabel(sess as { projectId?: string | null; cwd?: string | null })
      const arr = map.get(key) ?? []
      arr.push(sess as never)
      map.set(key, arr)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  })

  const costLabel = (sess: {
    costUsd?: number | null
    tokensIn?: number | null
    tokensOut?: number | null
  }) => {
    if (sess.costUsd != null && sess.costUsd > 0) return `$${sess.costUsd.toFixed(4)}`
    if (sess.tokensIn != null || sess.tokensOut != null)
      return `${sess.tokensIn ?? 0}in/${sess.tokensOut ?? 0}out`
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
          <span
            style={{
              'font-weight': '700',
              'font-size': 'var(--fs-md)',
              'letter-spacing': '-0.02em',
            }}
          >
            Mira
          </span>
          <span class="pill">web</span>
        </div>
        <span
          title={s().connected ? 'WebSocket connected' : 'Disconnected — retrying'}
          aria-label={s().connected ? 'Connected' : 'Disconnected'}
          style={{ display: 'inline-flex' }}
        >
          <span
            class={`dot ${s().connected ? 'dot-pulse' : ''}`}
            style={{
              width: '8px',
              height: '8px',
              background: s().connected ? 'var(--ok)' : 'var(--danger)',
              'box-shadow': s().connected ? '0 0 8px var(--ok-soft)' : 'none',
            }}
          />
        </span>
      </div>

      {/* actions */}
      <div
        style={{
          padding: 'var(--sp-3)',
          'border-bottom': '1px solid var(--border)',
          display: 'flex',
          'flex-direction': 'column',
          gap: '8px',
        }}
      >
        {/* Workspace switcher (P2-2) */}
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <label
            style={{
              'font-size': 'var(--fs-2xs)',
              'font-weight': '600',
              color: 'var(--fg-subtle)',
              'text-transform': 'uppercase',
              'letter-spacing': '0.04em',
            }}
          >
            Workspace
          </label>
          <div style={{ display: 'flex', gap: '4px', 'align-items': 'center' }}>
            <select
              value={selectedWorkspace()}
              onChange={(e) => handleWorkspaceChange(e.currentTarget.value)}
              aria-label="Select workspace"
              style={{
                flex: '1',
                padding: '6px 8px',
                'font-size': 'var(--fs-xs)',
                border: '1px solid var(--border)',
                'border-radius': 'var(--r-md)',
                background: 'var(--bg-surface)',
                color: 'var(--fg)',
                'min-width': '0',
              }}
            >
              <option value="">Default (cwd)</option>
              <For each={workspaces()}>{(w) => <option value={w.path}>{w.name} — {w.path}</option>}</For>
            </select>
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => void loadWorkspaces()}
              disabled={workspaceLoading()}
              title="Refresh workspaces"
              aria-label="Refresh workspaces"
              style={{ padding: '4px 6px', 'font-size': 'var(--fs-xs)', 'min-height': '28px' }}
            >
              ↻
            </button>
          </div>
          <Show when={showAddWorkspace()}>
            <div style={{ display: 'flex', gap: '4px' }}>
              <input
                type="text"
                placeholder="/path/to/repo"
                value={newWorkspacePath()}
                onInput={(e) => setNewWorkspacePath(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAddWorkspace()
                  if (e.key === 'Escape') setShowAddWorkspace(false)
                }}
                aria-label="New workspace path"
                style={{
                  flex: '1',
                  padding: '4px 8px',
                  'font-size': 'var(--fs-xs)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-md)',
                  background: 'var(--bg-surface)',
                  color: 'var(--fg)',
                }}
              />
              <button
                type="button"
                class="btn btn-solid"
                onClick={() => void handleAddWorkspace()}
                style={{ padding: '4px 8px', 'font-size': 'var(--fs-xs)' }}
              >
                Add
              </button>
              <button
                type="button"
                class="btn btn-ghost"
                onClick={() => setShowAddWorkspace(false)}
                style={{ padding: '4px 6px', 'font-size': 'var(--fs-xs)' }}
              >
                ✕
              </button>
            </div>
          </Show>
          <Show when={!showAddWorkspace()}>
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => setShowAddWorkspace(true)}
              style={{
                padding: '4px 8px',
                'font-size': 'var(--fs-2xs)',
                border: '1px dashed var(--border)',
                'border-radius': 'var(--r-md)',
                color: 'var(--fg-subtle)',
              }}
            >
              ＋ Add workspace
            </button>
          </Show>
          <Show when={selectedWorkspace()}>
            <span
              style={{
                'font-size': 'var(--fs-2xs)',
                color: 'var(--fg-faint)',
                'font-family': 'var(--font-mono)',
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
                'white-space': 'nowrap',
              }}
              title={selectedWorkspace()}
            >
              cwd: {selectedWorkspace()}
            </span>
          </Show>
        </div>

        <button
          type="button"
          class="btn btn-solid"
          onClick={handleCreateSession}
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
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              style={{ padding: '2px 6px', 'font-size': 'var(--fs-xs)', 'min-height': '24px' }}
            >
              ✕
            </button>
          </Show>
        </div>

        {/* Status filter */}
        <div style={{ display: 'flex', gap: '4px' }} role="tablist" aria-label="Filter by status">
          <For each={['all', 'active', 'idle'] as const}>
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

        {/* Project filter */}
        <Show when={availableProjects().length > 1}>
          <div style={{ display: 'flex', gap: '4px', 'align-items': 'center' }}>
            <select
              value={projectFilter()}
              onChange={(e) => setProjectFilter(e.currentTarget.value)}
              aria-label="Filter by project"
              style={{
                flex: '1',
                padding: '4px 8px',
                'font-size': 'var(--fs-xs)',
                border: '1px solid var(--border)',
                'border-radius': 'var(--r-md)',
                background: 'var(--bg-surface)',
                color: 'var(--fg)',
              }}
            >
              <option value="all">All projects</option>
              <For each={availableProjects()}>{(p) => <option value={p}>{p}</option>}</For>
            </select>
          </div>
        </Show>

        {/* Group by project toggle */}
        <label
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            'font-size': 'var(--fs-xs)',
            color: 'var(--fg-subtle)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={groupByProject()}
            onChange={(e) => setGroupByProject(e.currentTarget.checked)}
          />
          Group by project
        </label>

        <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => void props.store.loadSessions()}
            disabled={s().loading}
            aria-busy={s().loading ? 'true' : 'false'}
            title="Refresh sessions"
            style={{
              flex: '1',
              padding: '5px 8px',
              'font-size': 'var(--fs-xs)',
              border: '1px solid var(--border)',
              'border-radius': 'var(--r-md)',
            }}
          >
            {s().loading ? '…' : '↻ Refresh'}
          </button>
          <span
            style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', padding: '0 4px' }}
            role="status"
          >
            {filtered().length}/{s().sessions.length}
          </span>
        </div>
      </div>

      {/* list */}
      <div class="scroll" style={{ flex: '1', padding: 'var(--sp-2)' }}>
        <Show
          when={!s().loading}
          fallback={
            <div
              style={{ display: 'flex', 'flex-direction': 'column', gap: '8px', padding: '4px' }}
              aria-label="Loading sessions"
            >
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
                      <div
                        style={{
                          'font-size': 'var(--fs-sm)',
                          'font-weight': '600',
                          color: 'var(--fg)',
                        }}
                      >
                        No sessions yet
                      </div>
                      <div
                        style={{
                          'font-size': 'var(--fs-xs)',
                          color: 'var(--fg-subtle)',
                          'margin-top': '3px',
                        }}
                      >
                        Spin up your first chat to start working with the agent.
                      </div>
                    </div>
                    <button
                      type="button"
                      class="btn btn-outline"
                      onClick={handleCreateSession}
                      disabled={s().loading}
                      aria-busy={s().loading ? 'true' : 'false'}
                      style={{ padding: '6px 12px', 'font-size': 'var(--fs-sm)' }}
                    >
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
                  No sessions match "{search()}"
                  {statusFilter() !== 'all' ? ` · ${statusFilter()}` : ''}.
                </div>
              </Show>
            }
          >
            <Show
              when={grouped()}
              fallback={
                <div role="list" style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                  <For each={filtered()}>
                    {(sess) => {
                      const active = () => s().currentId === sess.id
                      const isPinned = () => pinned().has(sess.id)
                      const st = () => sessionStatus(sess, props.store)
                      const cost = () => costLabel(sess)
                      const proj = () => projectLabel(sess as { projectId?: string | null; cwd?: string | null })
                      return (
                        <div class={`session-row ${active() ? 'active' : ''}`} role="listitem">
                          <button
                            type="button"
                            class="session-main"
                            aria-current={active() ? 'true' : undefined}
                            onClick={() => props.store.selectSession(sess.id)}
                          >
                            {/* Status + pin row */}
                            <div
                              style={{
                                display: 'flex',
                                'align-items': 'center',
                                gap: '6px',
                                'margin-bottom': '4px',
                                'flex-wrap': 'wrap',
                              }}
                            >
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
                                <span
                                  class={`dot ${st().label === 'streaming' ? 'dot-pulse' : ''}`}
                                  style={{ background: st().color, width: '6px', height: '6px' }}
                                />
                                {st().label}
                              </span>
                              <span
                                class="pill"
                                title={(sess as { cwd?: string | null }).cwd ?? proj()}
                                style={{
                                  'font-size': 'var(--fs-2xs)',
                                  padding: '1px 6px',
                                  'font-family': 'var(--font-mono)',
                                  background: 'var(--bg-surface)',
                                  border: '1px solid var(--border)',
                                }}
                              >
                                {proj()}
                              </span>
                              <Show when={sess.agent}>
                                <span
                                  class="pill"
                                  style={{
                                    'font-size': 'var(--fs-2xs)',
                                    padding: '1px 6px',
                                    'font-family': 'var(--font-mono)',
                                  }}
                                >
                                  {sess.agent}
                                </span>
                              </Show>
                              <Show when={isPinned()}>
                                <span
                                  style={{ 'font-size': '10px', color: 'var(--accent)' }}
                                  title="Pinned"
                                >
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
                        <span
                          style={{
                            display: 'block',
                            'margin-top': '3px',
                            'font-size': 'var(--fs-2xs)',
                            color: 'var(--fg-subtle)',
                          }}
                        >
                          {sess.model || 'default'} ·{' '}
                          {new Date(sess.updatedAt || sess.createdAt).toLocaleString()}
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
                          {(() => {
                            const cap = props.store.state.costCap?.perSession
                            const over = cap != null && (sess.costUsd ?? 0) >= cap
                            return (
                              <span
                                title={
                                  over
                                    ? `Budget cap $${cap} exceeded`
                                    : cap
                                      ? `Cap $${cap}`
                                      : undefined
                                }
                                style={{
                                  display: 'inline-flex',
                                  'align-items': 'center',
                                  gap: '4px',
                                  'margin-top': '4px',
                                  'font-family': 'var(--font-mono)',
                                  'font-size': 'var(--fs-2xs)',
                                  color: over ? 'var(--danger)' : 'var(--fg-subtle)',
                                  background: over
                                    ? 'color-mix(in srgb, var(--danger) 10%, var(--bg-surface))'
                                    : 'var(--bg-surface)',
                                  border: `1px solid ${over ? 'var(--danger-border)' : 'var(--border)'}`,
                                  'border-radius': 'var(--r-full)',
                                  padding: '1px 6px',
                                }}
                              >
                                {cost()}
                                {over ? ' ⚠' : ''}
                              </span>
                            )
                          })()}
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
                          setConfirmDelete({
                            id: sess.id,
                            title: sess.title || sess.id.slice(0, 6),
                          })
                        }}
                        title="Delete session"
                        aria-label={`Delete session ${sess.title || sess.id.slice(0, 6)}`}
                        style={{
                          width: '28px',
                          height: '28px',
                          'min-height': '28px',
                          'min-width': '28px',
                        }}
                      >
                        ×
                      </button>
                    </div>
                  )
                }}
              </For>
                </div>
              }
            >
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
                <For each={grouped()!}>
                  {([project, sessions]) => (
                    <div>
                      <div
                        style={{
                          'font-size': 'var(--fs-2xs)',
                          'font-weight': '700',
                          color: 'var(--fg-subtle)',
                          'text-transform': 'uppercase',
                          'letter-spacing': '0.04em',
                          padding: '4px 4px 6px',
                          'border-bottom': '1px solid var(--border)',
                          'margin-bottom': '6px',
                        }}
                      >
                        {project} · {sessions.length}
                      </div>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                        <For each={sessions}>
                          {(sess) => {
                            const active = () => s().currentId === sess.id
                            const isPinned = () => pinned().has(sess.id)
                            const st = () => sessionStatus(sess, props.store)
                            const cost = () => costLabel(sess)
                            const proj = () =>
                              projectLabel(sess as { projectId?: string | null; cwd?: string | null })
                            return (
                              <div class={`session-row ${active() ? 'active' : ''}`} role="listitem">
                                <button
                                  type="button"
                                  class="session-main"
                                  aria-current={active() ? 'true' : undefined}
                                  onClick={() => props.store.selectSession(sess.id)}
                                >
                                  <div
                                    style={{
                                      display: 'flex',
                                      'align-items': 'center',
                                      gap: '6px',
                                      'margin-bottom': '4px',
                                      'flex-wrap': 'wrap',
                                    }}
                                  >
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
                                      <span
                                        class={`dot ${st().label === 'streaming' ? 'dot-pulse' : ''}`}
                                        style={{ background: st().color, width: '6px', height: '6px' }}
                                      />
                                      {st().label}
                                    </span>
                                    <span
                                      class="pill"
                                      title={(sess as { cwd?: string | null }).cwd ?? proj()}
                                      style={{
                                        'font-size': 'var(--fs-2xs)',
                                        padding: '1px 6px',
                                        'font-family': 'var(--font-mono)',
                                        background: 'var(--bg-surface)',
                                        border: '1px solid var(--border)',
                                      }}
                                    >
                                      {proj()}
                                    </span>
                                    <Show when={sess.agent}>
                                      <span
                                        class="pill"
                                        style={{
                                          'font-size': 'var(--fs-2xs)',
                                          padding: '1px 6px',
                                          'font-family': 'var(--font-mono)',
                                        }}
                                      >
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
                                  <span
                                    style={{
                                      display: 'block',
                                      'margin-top': '3px',
                                      'font-size': 'var(--fs-2xs)',
                                      color: 'var(--fg-subtle)',
                                    }}
                                  >
                                    {sess.model || 'default'} ·{' '}
                                    {new Date(sess.updatedAt || sess.createdAt).toLocaleString()}
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
                                    {(() => {
                                      const cap = props.store.state.costCap?.perSession
                                      const over = cap != null && (sess.costUsd ?? 0) >= cap
                                      return (
                                        <span
                                          title={
                                            over
                                              ? `Budget cap $${cap} exceeded`
                                              : cap
                                                ? `Cap $${cap}`
                                                : undefined
                                          }
                                          style={{
                                            display: 'inline-flex',
                                            'align-items': 'center',
                                            gap: '4px',
                                            'margin-top': '4px',
                                            'font-family': 'var(--font-mono)',
                                            'font-size': 'var(--fs-2xs)',
                                            color: over ? 'var(--danger)' : 'var(--fg-subtle)',
                                            background: over
                                              ? 'color-mix(in srgb, var(--danger) 10%, var(--bg-surface))'
                                              : 'var(--bg-surface)',
                                            border: `1px solid ${over ? 'var(--danger-border)' : 'var(--border)'}`,
                                            'border-radius': 'var(--r-full)',
                                            padding: '1px 6px',
                                          }}
                                        >
                                          {cost()}
                                          {over ? ' ⚠' : ''}
                                        </span>
                                      )
                                    })()}
                                  </Show>
                                </button>
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
                                    setConfirmDelete({
                                      id: sess.id,
                                      title: sess.title || sess.id.slice(0, 6),
                                    })
                                  }}
                                  title="Delete session"
                                  aria-label={`Delete session ${sess.title || sess.id.slice(0, 6)}`}
                                  style={{
                                    width: '28px',
                                    height: '28px',
                                    'min-height': '28px',
                                    'min-width': '28px',
                                  }}
                                >
                                  ×
                                </button>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>

      <Show when={s().error}>
        <div
          class="alert"
          role="alert"
          style={{
            margin: '0 var(--sp-3) var(--sp-2)',
            padding: '8px 10px',
            'font-size': 'var(--fs-xs)',
          }}
        >
          ⚠ {s().error}
          <button
            type="button"
            onClick={() => props.store.clearError()}
            class="alert-close btn btn-ghost"
            aria-label="Dismiss error"
            style={{
              'margin-left': '8px',
              padding: '2px 6px',
              'font-size': 'var(--fs-xs)',
              'min-height': '28px',
            }}
          >
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
          title={
            s().connected
              ? `Connected to ${serverHost()}`
              : `Offline — cannot reach ${serverHost()}`
          }
          style={{
            color: s().connected ? 'var(--fg-faint)' : 'var(--danger)',
            'text-decoration': s().connected ? 'none' : 'line-through',
            display: 'inline-flex',
            'align-items': 'center',
            gap: '4px',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: '6px',
              height: '6px',
              'border-radius': '50%',
              background: s().connected ? 'var(--ok)' : 'var(--danger)',
            }}
          />
          {serverHost()}
        </span>
      </div>
      <ConfirmDialog
        open={() => confirmDelete() !== null}
        title="Delete session?"
        message={
          confirmDelete()
            ? `This will permanently delete "${confirmDelete()!.title}" and all its messages. This cannot be undone.`
            : ''
        }
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
