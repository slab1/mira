import { For, Show, createSignal, createResource } from 'solid-js'
import type { AppStore } from '../stores/app'
import { api, type ToolInfo, type Snapshot, type Finding, type Job } from '../api/client'
import { toast } from './Toast'
import { DiffViewer } from './MessagePart'

type Tab = 'todos' | 'tools' | 'events' | 'history' | 'findings' | 'jobs'

const TABS: { id: Tab; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'tools', label: 'Tools' },
  { id: 'events', label: 'Events' },
  { id: 'history', label: 'History' },
  { id: 'findings', label: 'Findings' },
  { id: 'jobs', label: 'Jobs' },
]

export function ToolView(props: { store: AppStore }) {
  const s = () => props.store.state
  const [tools] = createResource(() => api.listToolsCached().catch(() => [] as ToolInfo[]))
  const [tab, setTab] = createSignal<Tab>('todos')
  const [collapsed, setCollapsed] = createSignal(false)
  const snapshotsSource = () => (tab() === 'history' ? (s().currentId ?? null) : null)
  const [snapshots, { refetch: refetchSnaps }] = createResource(snapshotsSource, (id) =>
    api.listSnapshots(id).catch(() => [] as Snapshot[]),
  )
  const findingsSource = () => (tab() === 'findings' ? 'open' : null)
  const [findings, { refetch: refetchFindings }] = createResource(findingsSource, () =>
    api.listFindings({ status: 'open', limit: 50 }).catch(() => [] as Finding[]),
  )
  const jobsSource = () => (tab() === 'jobs' ? (s().currentId ?? null) : null)
  const [jobs, { refetch: refetchJobs }] = createResource(jobsSource, (id) =>
    api.listJobs(id).catch(() => [] as Job[]),
  )

  const doneCount = () => s().todos.filter((t) => t.status === 'completed').length
  const progress = () =>
    s().todos.length === 0 ? 0 : Math.round((doneCount() / s().todos.length) * 100)

  return (
    <aside
      style={{
        width: collapsed() ? '44px' : '320px',
        'flex-shrink': '0',
        display: 'flex',
        'flex-direction': 'column',
        'border-left': '1px solid var(--border)',
        background: 'var(--bg-app)',
        height: '100%',
        overflow: 'hidden',
        transition: 'width var(--dur-med) var(--ease)',
      }}
      aria-label="Inspector"
    >
      <Show
        when={!collapsed()}
        fallback={
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => setCollapsed(false)}
            title="Expand inspector"
            aria-expanded="false"
            aria-controls="inspector-panel"
            style={{
              flex: '1',
              display: 'flex',
              'flex-direction': 'column',
              'align-items': 'center',
              gap: '10px',
              padding: '12px 0',
              'border-radius': '0',
            }}
          >
            <span style={{ 'font-size': '13px', color: 'var(--fg-muted)' }}>«</span>
            <span
              style={{
                'writing-mode': 'vertical-rl',
                transform: 'rotate(180deg)',
                'font-size': 'var(--fs-2xs)',
                'letter-spacing': '0.08em',
                color: 'var(--fg-subtle)',
              }}
            >
              Inspector
            </span>
          </button>
        }
      >
        <div
          style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '10px 10px 0' }}
        >
          <div class="seg" role="tablist" aria-label="Inspector panels" style={{ flex: '1' }}>
            <For each={TABS}>
              {(t) => (
                <button
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={tab() === t.id ? 'true' : 'false'}
                  aria-controls="inspector-panel"
                  class="seg-tab"
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              )}
            </For>
          </div>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => setCollapsed(true)}
            title="Collapse inspector"
            aria-label="Collapse inspector"
            aria-expanded="true"
            aria-controls="inspector-panel"
            style={{
              width: '28px',
              height: '28px',
              padding: '0',
              'border-radius': 'var(--r-sm)',
              flex: 'none',
              'min-height': '28px',
            }}
          >
            »
          </button>
        </div>

        <div
          id="inspector-panel"
          role="tabpanel"
          aria-labelledby={`tab-${tab()}`}
          class="scroll"
          style={{ flex: '1', padding: 'var(--sp-3)' }}
        >
          {/* ── Todos ─────────────────────────────────────────────── */}
          <Show when={tab() === 'todos'}>
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
                'margin-bottom': '10px',
                gap: '8px',
              }}
            >
              <span
                style={{
                  'font-size': 'var(--fs-xs)',
                  'font-weight': '700',
                  color: 'var(--fg-muted)',
                  'letter-spacing': '0.05em',
                  'text-transform': 'uppercase',
                }}
              >
                Todos
              </span>
              <Show when={s().todos.length > 0}>
                <span
                  style={{
                    'font-size': 'var(--fs-2xs)',
                    color: 'var(--fg-subtle)',
                    'font-family': 'var(--font-mono)',
                  }}
                  role="status"
                >
                  {doneCount()}/{s().todos.length}
                </span>
              </Show>
              <Show when={s().currentId}>
                <button
                  type="button"
                  class="btn btn-ghost"
                  onClick={() => {
                    const id = s().currentId
                    if (id) {
                      void props.store.loadTodos(id)
                      toast.info('Todos refreshed')
                    }
                  }}
                  title="Refresh todos"
                  aria-label="Refresh todos"
                  style={{
                    padding: '2px 7px',
                    'font-size': 'var(--fs-xs)',
                    border: '1px solid var(--border)',
                    'border-radius': 'var(--r-full)',
                    'min-height': '28px',
                  }}
                >
                  ↻
                </button>
              </Show>
            </div>
            <Show when={s().todos.length > 0}>
              <div class="progress-track" style={{ 'margin-bottom': '12px' }} aria-hidden="true">
                <div class="progress-fill" style={{ width: `${progress()}%` }} />
              </div>
            </Show>

            <Show
              when={s().currentId}
              fallback={
                <div
                  style={{
                    color: 'var(--fg-faint)',
                    'font-size': 'var(--fs-sm)',
                    padding: '4px 0',
                  }}
                >
                  Select a session to see its todos.
                </div>
              }
            >
              <Show
                when={s().todos.length > 0}
                fallback={
                  <div
                    style={{
                      padding: '14px',
                      border: '1px dashed var(--border-strong)',
                      'border-radius': 'var(--r-md)',
                      color: 'var(--fg-faint)',
                      'font-size': 'var(--fs-xs)',
                      'text-align': 'center',
                    }}
                  >
                    No todos yet — the agent creates them for multi-step tasks.
                  </div>
                }
              >
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                  <For each={s().todos}>
                    {(t) => {
                      const done = t.status === 'completed'
                      const wip = t.status === 'in_progress'
                      const cancelled = t.status === 'cancelled'
                      return (
                        <div
                          class="card"
                          style={{
                            padding: '9px 11px',
                            display: 'flex',
                            gap: '9px',
                            'align-items': 'flex-start',
                            ...(wip ? { 'border-color': 'var(--warn-border)' } : {}),
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              width: '18px',
                              height: '18px',
                              'border-radius': '50%',
                              border: `1px solid ${done ? 'var(--ok-border)' : wip ? 'var(--warn-border)' : 'var(--border-strong)'}`,
                              background: done
                                ? 'var(--ok-soft)'
                                : wip
                                  ? 'var(--warn-soft)'
                                  : 'transparent',
                              color: done ? 'var(--ok)' : wip ? 'var(--warn)' : 'var(--fg-faint)',
                              display: 'grid',
                              'place-items': 'center',
                              'font-size': '10px',
                              flex: 'none',
                              'margin-top': '1px',
                            }}
                          >
                            {done ? '✓' : wip ? '◷' : cancelled ? '×' : '○'}
                          </span>
                          <div style={{ flex: '1', 'min-width': '0' }}>
                            <div
                              style={{
                                'font-size': 'var(--fs-sm)',
                                color: done || cancelled ? 'var(--fg-subtle)' : 'var(--fg)',
                                'text-decoration': done || cancelled ? 'line-through' : 'none',
                                'line-height': '1.45',
                              }}
                            >
                              {t.content}
                            </div>
                            <div
                              style={{
                                'font-size': 'var(--fs-2xs)',
                                color: 'var(--fg-faint)',
                                'margin-top': '2px',
                              }}
                            >
                              {t.status}
                              {t.priority ? ` · ${t.priority}` : ''}
                            </div>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>

          {/* ── Tools ─────────────────────────────────────────────── */}
          <Show when={tab() === 'tools'}>
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                'margin-bottom': '10px',
              }}
            >
              <span
                style={{
                  'font-size': 'var(--fs-xs)',
                  'font-weight': '700',
                  color: 'var(--fg-muted)',
                  'letter-spacing': '0.05em',
                  'text-transform': 'uppercase',
                }}
              >
                Tools
              </span>
              <span
                class="pill"
                style={{
                  'font-size': 'var(--fs-2xs)',
                  padding: '1px 7px',
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  border: '1px solid var(--accent-border)',
                }}
              >
                {tools.loading ? '…' : (tools()?.length ?? 0)}
              </span>
              <button
                type="button"
                class="btn btn-ghost"
                onClick={() => {
                  api.invalidateToolCache()
                  toast.info('Refreshing tools…')
                  location.reload()
                }}
                title="Refresh tools (bypass 30s cache)"
                aria-label="Refresh tools"
                disabled={tools.loading}
                style={{
                  padding: '2px 7px',
                  'font-size': 'var(--fs-xs)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-full)',
                  'margin-left': 'auto',
                  'min-height': '28px',
                }}
              >
                ↻
              </button>
            </div>
            <Show
              when={!tools.loading}
              fallback={
                <div
                  style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
                  aria-label="Loading tools"
                >
                  {[0, 1, 2].map(() => (
                    <div
                      class="skeleton"
                      style={{ height: '48px', 'border-radius': 'var(--r-md)' }}
                    />
                  ))}
                </div>
              }
            >
              <Show
                when={(tools()?.length ?? 0) > 0}
                fallback={
                  <div
                    style={{
                      padding: '14px',
                      border: '1px dashed var(--border-strong)',
                      'border-radius': 'var(--r-md)',
                      color: 'var(--fg-faint)',
                      'font-size': 'var(--fs-xs)',
                      'text-align': 'center',
                      'line-height': '1.5',
                    }}
                  >
                    No tools reported. Is the Mira server running on :4096?
                  </div>
                }
              >
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                  <For each={tools() ?? []}>
                    {(tool) => (
                      <div class="card" style={{ padding: '9px 11px' }}>
                        <div
                          style={{
                            'font-size': '12px',
                            'font-weight': '600',
                            color: 'var(--fg)',
                            'font-family': 'var(--font-mono)',
                          }}
                        >
                          {tool.name}
                        </div>
                        <div
                          class="clamp-2"
                          style={{
                            'font-size': 'var(--fs-xs)',
                            color: 'var(--fg-subtle)',
                            'margin-top': '3px',
                            'line-height': '1.45',
                          }}
                        >
                          {tool.description || 'No description'}
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>

          {/* ── Events ────────────────────────────────────────────── */}
          <Show when={tab() === 'events'}>
            <div
              style={{
                'font-size': 'var(--fs-xs)',
                'font-weight': '700',
                color: 'var(--fg-muted)',
                'letter-spacing': '0.05em',
                'text-transform': 'uppercase',
                'margin-bottom': '10px',
              }}
            >
              Connection
            </div>
            <div
              class="card"
              style={{ padding: '10px 12px', display: 'flex', 'align-items': 'center', gap: '8px' }}
            >
              <span
                class={`dot ${s().connected ? 'dot-pulse' : ''}`}
                style={{
                  background: s().connected ? 'var(--ok)' : 'var(--danger)',
                  width: '7px',
                  height: '7px',
                }}
              />
              <span
                style={{
                  'font-size': 'var(--fs-sm)',
                  color: s().connected ? 'var(--fg)' : 'var(--fg-muted)',
                  'font-weight': '600',
                }}
              >
                {s().connected ? 'Live event socket connected' : 'Event socket offline — retrying'}
              </span>
            </div>
            <div
              style={{
                'margin-top': '10px',
                color: 'var(--fg-faint)',
                'font-size': 'var(--fs-2xs)',
                'line-height': '1.55',
              }}
            >
              Updates arrive over the server's event bus — sessions, todos, and questions refresh
              automatically, no polling.
            </div>
            <Show when={s().streaming}>
              <div
                class="card"
                style={{
                  'margin-top': '10px',
                  padding: '9px 11px',
                  background: 'var(--warn-soft)',
                  'border-color': 'var(--warn-border)',
                  color: 'var(--warn)',
                  'font-size': 'var(--fs-xs)',
                }}
              >
                ◷ Streaming turn for{' '}
                <code style={{ 'font-family': 'var(--font-mono)', color: 'var(--fg)' }}>
                  {s().currentId?.slice(0, 8)}
                </code>
                …
              </div>
            </Show>
          </Show>

          {/* ── History (snapshots / rewind) ────────────────────────── */}
          <Show when={tab() === 'history'}>
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
                'margin-bottom': '10px',
                gap: '8px',
              }}
            >
              <span
                style={{
                  'font-size': 'var(--fs-xs)',
                  'font-weight': '700',
                  color: 'var(--fg-muted)',
                  'letter-spacing': '0.05em',
                  'text-transform': 'uppercase',
                }}
              >
                History · {snapshots.loading ? '…' : (snapshots()?.length ?? 0)}
              </span>
              <Show when={s().currentId}>
                <button
                  type="button"
                  class="btn btn-ghost"
                  onClick={() => refetchSnaps()}
                  title="Refresh snapshots"
                  aria-label="Refresh snapshots"
                  disabled={snapshots.loading}
                  aria-busy={snapshots.loading ? 'true' : 'false'}
                  style={{
                    padding: '2px 7px',
                    'font-size': 'var(--fs-xs)',
                    border: '1px solid var(--border)',
                    'border-radius': 'var(--r-full)',
                    'min-height': '28px',
                  }}
                >
                  {snapshots.loading ? '…' : '↻'}
                </button>
              </Show>
            </div>
            <Show
              when={s().currentId}
              fallback={
                <div
                  style={{
                    color: 'var(--fg-faint)',
                    'font-size': 'var(--fs-sm)',
                    padding: '4px 0',
                  }}
                >
                  Select a session to see its file history.
                </div>
              }
            >
              <Show
                when={!snapshots.loading}
                fallback={
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                    {[0, 1].map(() => (
                      <div
                        class="skeleton"
                        style={{ height: '52px', 'border-radius': 'var(--r-md)' }}
                      />
                    ))}
                  </div>
                }
              >
                <Show
                  when={(snapshots()?.length ?? 0) > 0}
                  fallback={
                    <div
                      style={{
                        padding: '14px',
                        border: '1px dashed var(--border-strong)',
                        'border-radius': 'var(--r-md)',
                        color: 'var(--fg-faint)',
                        'font-size': 'var(--fs-xs)',
                        'text-align': 'center',
                        'line-height': '1.5',
                      }}
                    >
                      No file mutations yet — edits are snapshotted before they land.
                    </div>
                  }
                >
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                    {(() => {
                      const grouped = () => {
                        const snaps = snapshots() ?? []
                        const map = new Map<string, Snapshot[]>()
                        const order: string[] = []
                        for (const sn of snaps) {
                          const key = sn.messageID ?? '__no_message__'
                          if (!map.has(key)) {
                            map.set(key, [])
                            order.push(key)
                          }
                          map.get(key)!.push(sn)
                        }
                        return order.map((k) => ({
                          messageID: k === '__no_message__' ? null : k,
                          snaps: map.get(k)!,
                        }))
                      }
                      return (
                        <For each={grouped()}>
                          {(group) => (
                            <div
                              class="card"
                              data-slot="snapshot-group"
                              style={{
                                padding: '8px',
                                display: 'flex',
                                'flex-direction': 'column',
                                gap: '6px',
                                background: 'var(--bg-surface)',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  'align-items': 'center',
                                  gap: '8px',
                                  'flex-wrap': 'wrap',
                                }}
                              >
                                <span
                                  style={{
                                    'font-size': 'var(--fs-2xs)',
                                    'font-weight': '700',
                                    color: 'var(--fg-muted)',
                                    'font-family': 'var(--font-mono)',
                                    'letter-spacing': '0.04em',
                                    'text-transform': 'uppercase',
                                  }}
                                >
                                  {group.messageID
                                    ? `msg ${group.messageID.slice(0, 8)}`
                                    : 'no message'}
                                </span>
                                <span
                                  style={{
                                    'font-size': 'var(--fs-2xs)',
                                    color: 'var(--fg-faint)',
                                    'font-family': 'var(--font-mono)',
                                  }}
                                >
                                  {new Date(
                                    Math.min(...group.snaps.map((s) => s.createdAt)),
                                  ).toLocaleTimeString()}{' '}
                                  · {group.snaps.length} file{group.snaps.length === 1 ? '' : 's'}
                                </span>
                                <button
                                  type="button"
                                  class="btn btn-ghost"
                                  onClick={() =>
                                    void (async () => {
                                      const id = s().currentId
                                      if (!id) return
                                      try {
                                        await api.revertSession(id, group.messageID ?? undefined)
                                        await refetchSnaps()
                                        await props.store.loadMessages(id)
                                        toast.success(
                                          group.messageID
                                            ? `Rewound to ${group.messageID.slice(0, 8)} — ${group.snaps.length} file(s) restored`
                                            : `Reverted last mutation`,
                                        )
                                      } catch (e) {
                                        toast.error(`Rewind failed: ${(e as Error).message}`)
                                      }
                                    })()
                                  }
                                  title={
                                    group.messageID
                                      ? `↩ rewind to here — reverts this message and all later ones`
                                      : 'Undo last mutation'
                                  }
                                  aria-label={
                                    group.messageID
                                      ? `Rewind to message ${group.messageID.slice(0, 8)}`
                                      : 'Undo last mutation'
                                  }
                                  style={{
                                    padding: '4px 10px',
                                    'font-size': 'var(--fs-xs)',
                                    border: '1px solid var(--border)',
                                    'border-radius': 'var(--r-full)',
                                    'margin-left': 'auto',
                                    flex: 'none',
                                    'min-height': '28px',
                                    background: group.messageID ? 'var(--accent-soft)' : undefined,
                                    color: group.messageID ? 'var(--accent)' : undefined,
                                    'border-color': group.messageID
                                      ? 'var(--accent-border)'
                                      : undefined,
                                    'font-weight': '600',
                                  }}
                                >
                                  ↩ rewind to here
                                </button>
                              </div>
                              <For each={group.snaps}>
                                {(snap) => {
                                  const [detail, setDetail] = createSignal<{
                                    path: string
                                    snapshotContent: string | null
                                    currentContent: string | null
                                    existedBefore: boolean
                                  } | null>(null)
                                  const [loadingDetail, setLoadingDetail] = createSignal(false)
                                  return (
                                    <div
                                      class="card"
                                      data-slot="snapshot-card"
                                      style={{
                                        padding: '9px 11px',
                                        display: 'flex',
                                        gap: '9px',
                                        'align-items': 'center',
                                        'flex-wrap': 'wrap',
                                        background: 'var(--bg-app)',
                                      }}
                                    >
                                      <div style={{ flex: '1', 'min-width': '0' }}>
                                        <div
                                          style={{
                                            'font-size': '12px',
                                            'font-weight': '600',
                                            color: 'var(--fg)',
                                            'font-family': 'var(--font-mono)',
                                            'white-space': 'nowrap',
                                            overflow: 'hidden',
                                            'text-overflow': 'ellipsis',
                                          }}
                                          title={snap.path}
                                        >
                                          {snap.path}
                                        </div>
                                        <div
                                          style={{
                                            'font-size': 'var(--fs-2xs)',
                                            color: 'var(--fg-faint)',
                                            'margin-top': '2px',
                                            'font-family': 'var(--font-mono)',
                                          }}
                                        >
                                          {new Date(snap.createdAt).toLocaleTimeString()} ·{' '}
                                          {snap.existedBefore ? 'edit' : 'new file'}
                                        </div>
                                      </div>
                                      <button
                                        type="button"
                                        class="btn btn-ghost"
                                        onClick={() =>
                                          void (async () => {
                                            const id = s().currentId
                                            if (!id) return
                                            setLoadingDetail(true)
                                            try {
                                              const d = await api.getSnapshot(id, snap.id)
                                              setDetail(d)
                                            } catch (e) {
                                              toast.error(
                                                `Snapshot detail failed: ${(e as Error).message}`,
                                              )
                                            } finally {
                                              setLoadingDetail(false)
                                            }
                                          })()
                                        }
                                        title="Preview diff"
                                        aria-label="Preview diff"
                                        disabled={loadingDetail()}
                                        aria-busy={loadingDetail() ? 'true' : 'false'}
                                        style={{
                                          padding: '4px 8px',
                                          'font-size': 'var(--fs-xs)',
                                          border: '1px solid var(--border)',
                                          'border-radius': 'var(--r-full)',
                                          flex: 'none',
                                          'min-height': '28px',
                                        }}
                                      >
                                        {loadingDetail() ? '…' : 'diff'}
                                      </button>
                                      <Show when={detail()}>
                                        {(d) => {
                                          const snapLines = () =>
                                            (d().snapshotContent ?? '').split('\n').length
                                          const currLines = () =>
                                            (d().currentContent ?? '').split('\n').length
                                          const added = () => Math.max(0, currLines() - snapLines())
                                          const removed = () =>
                                            Math.max(0, snapLines() - currLines())
                                          return (
                                            <div
                                              data-slot="snapshot-diff"
                                              style={{
                                                'margin-top': '8px',
                                                display: 'flex',
                                                'flex-direction': 'column',
                                                gap: '8px',
                                                width: '100%',
                                              }}
                                            >
                                              <div
                                                style={{
                                                  display: 'flex',
                                                  gap: '6px',
                                                  'align-items': 'center',
                                                  'font-size': 'var(--fs-2xs)',
                                                  color: 'var(--fg-faint)',
                                                  'font-family': 'var(--font-mono)',
                                                }}
                                              >
                                                <span>{d().path}</span>
                                                <span
                                                  style={{
                                                    'margin-left': 'auto',
                                                    display: 'inline-flex',
                                                    gap: '6px',
                                                  }}
                                                >
                                                  <Show when={added() > 0}>
                                                    <span
                                                      style={{
                                                        color: 'var(--ok)',
                                                        'font-weight': '600',
                                                      }}
                                                    >
                                                      +{added()} lines
                                                    </span>
                                                  </Show>
                                                  <Show when={removed() > 0}>
                                                    <span
                                                      style={{
                                                        color: 'var(--danger)',
                                                        'font-weight': '600',
                                                      }}
                                                    >
                                                      -{removed()} lines
                                                    </span>
                                                  </Show>
                                                  <span>
                                                    {snapLines()} → {currLines()} lines
                                                  </span>
                                                </span>
                                              </div>
                                              <DiffViewer
                                                path={d().path}
                                                before={d().snapshotContent ?? '(empty)'}
                                                after={d().currentContent ?? '(file missing)'}
                                              />
                                            </div>
                                          )
                                        }}
                                      </Show>
                                    </div>
                                  )
                                }}
                              </For>
                            </div>
                          )}
                        </For>
                      )
                    })()}
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>

          {/* ── Findings (cross-agent memory) ─────────────────────── */}
          <Show when={tab() === 'findings'}>
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
                'margin-bottom': '10px',
                gap: '8px',
              }}
            >
              <span
                style={{
                  'font-size': 'var(--fs-xs)',
                  'font-weight': '700',
                  color: 'var(--fg-muted)',
                  'letter-spacing': '0.05em',
                  'text-transform': 'uppercase',
                }}
              >
                Findings · {findings.loading ? '…' : (findings()?.length ?? 0)} open
              </span>
              <button
                type="button"
                class="btn btn-ghost"
                onClick={() => refetchFindings()}
                title="Refresh findings"
                aria-label="Refresh findings"
                disabled={findings.loading}
                aria-busy={findings.loading ? 'true' : 'false'}
                style={{
                  padding: '2px 7px',
                  'font-size': 'var(--fs-xs)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-full)',
                  'min-height': '28px',
                }}
              >
                {findings.loading ? '…' : '↻'}
              </button>
            </div>
            <Show
              when={!findings.loading}
              fallback={
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                  {[0, 1].map(() => (
                    <div
                      class="skeleton"
                      style={{ height: '52px', 'border-radius': 'var(--r-md)' }}
                    />
                  ))}
                </div>
              }
            >
              <Show
                when={(findings()?.length ?? 0) > 0}
                fallback={
                  <div
                    style={{
                      padding: '14px',
                      border: '1px dashed var(--border-strong)',
                      'border-radius': 'var(--r-md)',
                      color: 'var(--fg-faint)',
                      'font-size': 'var(--fs-xs)',
                      'text-align': 'center',
                      'line-height': '1.5',
                    }}
                  >
                    No open findings — team memory is clear.
                  </div>
                }
              >
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                  <For each={findings() ?? []}>
                    {(f) => (
                      <div
                        class="card"
                        style={{
                          padding: '9px 11px',
                          display: 'flex',
                          gap: '9px',
                          'align-items': 'flex-start',
                        }}
                      >
                        <div style={{ flex: '1', 'min-width': '0' }}>
                          <div
                            style={{
                              display: 'flex',
                              gap: '6px',
                              'align-items': 'center',
                              'margin-bottom': '3px',
                            }}
                          >
                            <span
                              style={{
                                'font-size': 'var(--fs-2xs)',
                                'font-weight': '700',
                                padding: '1px 6px',
                                'border-radius': 'var(--r-full)',
                                background:
                                  f.severity === 'critical'
                                    ? 'var(--danger-soft)'
                                    : f.severity === 'major'
                                      ? 'var(--warn-soft)'
                                      : f.severity === 'minor'
                                        ? 'var(--accent-soft)'
                                        : 'var(--bg-surface)',
                                color:
                                  f.severity === 'critical'
                                    ? 'var(--danger)'
                                    : f.severity === 'major'
                                      ? 'var(--warn)'
                                      : f.severity === 'minor'
                                        ? 'var(--accent)'
                                        : 'var(--fg-faint)',
                                border: `1px solid ${f.severity === 'critical' ? 'var(--danger-border)' : f.severity === 'major' ? 'var(--warn-border)' : 'var(--border)'}`,
                              }}
                            >
                              {f.severity}
                            </span>
                            <span
                              style={{
                                'font-size': 'var(--fs-2xs)',
                                color: 'var(--fg-faint)',
                                'font-family': 'var(--font-mono)',
                              }}
                            >
                              {new Date(f.createdAt).toLocaleDateString()} · {f.source}
                            </span>
                          </div>
                          <div
                            style={{
                              'font-size': 'var(--fs-sm)',
                              'font-weight': '600',
                              color: 'var(--fg)',
                              'line-height': '1.4',
                            }}
                          >
                            {f.title}
                          </div>
                          <Show when={f.evidence}>
                            <div
                              style={{
                                'font-size': 'var(--fs-xs)',
                                color: 'var(--fg-subtle)',
                                'margin-top': '3px',
                                'line-height': '1.4',
                                'white-space': 'pre-wrap',
                                'word-break': 'break-word',
                              }}
                            >
                              {String(f.evidence).slice(0, 240)}
                            </div>
                          </Show>
                        </div>
                        <button
                          type="button"
                          class="btn btn-ghost"
                          onClick={() =>
                            void (async () => {
                              try {
                                await api.resolveFinding(f.id)
                                await refetchFindings()
                                toast.success('Finding resolved')
                              } catch (e) {
                                toast.error(`Resolve failed: ${(e as Error).message}`)
                              }
                            })()
                          }
                          title="Mark resolved"
                          aria-label="Mark finding resolved"
                          style={{
                            padding: '4px 8px',
                            'font-size': 'var(--fs-xs)',
                            'min-height': '28px',
                            border: '1px solid var(--border)',
                            'border-radius': 'var(--r-full)',
                            flex: 'none',
                          }}
                        >
                          ✓ resolve
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>

          {/* ── Jobs (background subagents) ───────────────────────── */}
          <Show when={tab() === 'jobs'}>
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
                'margin-bottom': '10px',
                gap: '8px',
              }}
            >
              <span
                style={{
                  'font-size': 'var(--fs-xs)',
                  'font-weight': '700',
                  color: 'var(--fg-muted)',
                  'letter-spacing': '0.05em',
                  'text-transform': 'uppercase',
                }}
              >
                Jobs · {jobs.loading ? '…' : (jobs()?.length ?? 0)}
              </span>
              <button
                type="button"
                class="btn btn-ghost"
                onClick={() => refetchJobs()}
                title="Refresh jobs"
                aria-label="Refresh jobs"
                disabled={jobs.loading}
                aria-busy={jobs.loading ? 'true' : 'false'}
                style={{
                  padding: '2px 7px',
                  'font-size': 'var(--fs-xs)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-full)',
                  'min-height': '28px',
                }}
              >
                {jobs.loading ? '…' : '↻'}
              </button>
            </div>
            <Show
              when={s().currentId}
              fallback={
                <div
                  style={{
                    color: 'var(--fg-faint)',
                    'font-size': 'var(--fs-sm)',
                    padding: '4px 0',
                  }}
                >
                  Select a session to see its jobs.
                </div>
              }
            >
              <Show
                when={!jobs.loading}
                fallback={
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                    {[0, 1].map(() => (
                      <div
                        class="skeleton"
                        style={{ height: '52px', 'border-radius': 'var(--r-md)' }}
                      />
                    ))}
                  </div>
                }
              >
                <Show
                  when={(jobs()?.length ?? 0) > 0}
                  fallback={
                    <div
                      style={{
                        padding: '14px',
                        border: '1px dashed var(--border-strong)',
                        'border-radius': 'var(--r-md)',
                        color: 'var(--fg-faint)',
                        'font-size': 'var(--fs-xs)',
                        'text-align': 'center',
                        'line-height': '1.5',
                      }}
                    >
                      No background jobs — `task` tool spawns appear here.
                    </div>
                  }
                >
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                    <For each={jobs() ?? []}>
                      {(job) => (
                        <div
                          class="card"
                          style={{
                            padding: '9px 11px',
                            display: 'flex',
                            gap: '9px',
                            'align-items': 'flex-start',
                          }}
                        >
                          <span
                            style={{
                              width: '8px',
                              height: '8px',
                              'border-radius': '50%',
                              background:
                                job.status === 'running'
                                  ? 'var(--warn)'
                                  : job.status === 'completed'
                                    ? 'var(--ok)'
                                    : job.status === 'failed'
                                      ? 'var(--danger)'
                                      : 'var(--fg-faint)',
                              flex: 'none',
                              'margin-top': '6px',
                            }}
                          />
                          <div style={{ flex: '1', 'min-width': '0' }}>
                            <div
                              style={{
                                display: 'flex',
                                gap: '6px',
                                'align-items': 'center',
                                'margin-bottom': '2px',
                              }}
                            >
                              <span
                                style={{
                                  'font-size': 'var(--fs-2xs)',
                                  'font-weight': '700',
                                  padding: '1px 6px',
                                  'border-radius': 'var(--r-full)',
                                  background:
                                    job.status === 'running'
                                      ? 'var(--warn-soft)'
                                      : job.status === 'completed'
                                        ? 'var(--ok-soft)'
                                        : 'var(--bg-surface)',
                                  color:
                                    job.status === 'running'
                                      ? 'var(--warn)'
                                      : job.status === 'completed'
                                        ? 'var(--ok)'
                                        : job.status === 'failed'
                                          ? 'var(--danger)'
                                          : 'var(--fg-faint)',
                                  border: `1px solid ${job.status === 'running' ? 'var(--warn-border)' : 'var(--border)'}`,
                                }}
                              >
                                {job.status}
                              </span>
                              <span
                                style={{
                                  'font-size': 'var(--fs-2xs)',
                                  color: 'var(--fg-faint)',
                                  'font-family': 'var(--font-mono)',
                                }}
                              >
                                {job.agent ?? 'general'} ·{' '}
                                {new Date(job.createdAt).toLocaleTimeString()}
                              </span>
                            </div>
                            <div
                              style={{
                                'font-size': 'var(--fs-xs)',
                                color: 'var(--fg)',
                                'line-height': '1.4',
                                'white-space': 'pre-wrap',
                                'word-break': 'break-word',
                              }}
                            >
                              {job.prompt.slice(0, 160)}
                              {job.prompt.length > 160 ? '…' : ''}
                            </div>
                            <Show when={job.status === 'completed' && job.result}>
                              <div
                                style={{
                                  'font-size': 'var(--fs-2xs)',
                                  color: 'var(--fg-subtle)',
                                  'margin-top': '4px',
                                  'white-space': 'pre-wrap',
                                  'word-break': 'break-word',
                                  background: 'var(--bg-app)',
                                  padding: '4px 6px',
                                  'border-radius': '4px',
                                  border: '1px solid var(--border)',
                                }}
                              >
                                {String(job.result).slice(0, 200)}
                                {String(job.result ?? '').length > 200 ? '…' : ''}
                              </div>
                            </Show>
                            <Show when={job.status === 'failed' && job.error}>
                              <div
                                style={{
                                  'font-size': 'var(--fs-2xs)',
                                  color: 'var(--danger)',
                                  'margin-top': '4px',
                                }}
                              >
                                {String(job.error).slice(0, 200)}
                              </div>
                            </Show>
                          </div>
                          <Show when={job.status === 'running'}>
                            <button
                              type="button"
                              class="btn btn-ghost"
                              onClick={() =>
                                void (async () => {
                                  try {
                                    await api.cancelJob(job.id)
                                    await refetchJobs()
                                    toast.success('Job cancelled')
                                  } catch (e) {
                                    toast.error(`Cancel failed: ${(e as Error).message}`)
                                  }
                                })()
                              }
                              title="Cancel job"
                              aria-label="Cancel job"
                              style={{
                                padding: '4px 8px',
                                'font-size': 'var(--fs-xs)',
                                border: '1px solid var(--border)',
                                'border-radius': 'var(--r-full)',
                                flex: 'none',
                                'min-height': '28px',
                              }}
                            >
                              ✕ cancel
                            </button>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </aside>
  )
}
