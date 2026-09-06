/**
 * Inspector — TUI port of web/src/components/ToolView.tsx
 *
 * 320px aside, 6 tabs: Todos/Tools/Events/History/Findings/Jobs
 * Vertical tabs with Tab cycle, collapsed toggle + badge counts.
 * TUI dark styling, no stubs.
 */

import { For, Show, createSignal, createEffect, onCleanup, createMemo } from 'solid-js'
import { rpc, type Todo, type ToolInfo, type Job, type Finding } from '../rpc/client'
import type { SessionStore } from '../stores/session'

type Tab = 'todos' | 'tools' | 'events' | 'history' | 'findings' | 'jobs'

const TABS: { id: Tab; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'tools', label: 'Tools' },
  { id: 'events', label: 'Events' },
  { id: 'history', label: 'History' },
  { id: 'findings', label: 'Findings' },
  { id: 'jobs', label: 'Jobs' },
]

type Snapshot = {
  id: string
  sessionID: string
  messageID: string | null
  path: string
  existedBefore: boolean
  createdAt: number
}

export default function Inspector(props: {
  store: SessionStore
  collapsed?: boolean
  onCollapsedChange?: (v: boolean) => void
}) {
  const s = () => props.store.state
  const [tab, setTab] = createSignal<Tab>('todos')
  const [internalCollapsed, setInternalCollapsed] = createSignal(false)
  const collapsed = () => props.collapsed ?? internalCollapsed()
  const setCollapsed = (v: boolean) => {
    if (props.onCollapsedChange) props.onCollapsedChange(v)
    else setInternalCollapsed(v)
  }

  // Tools
  const [tools, setTools] = createSignal<ToolInfo[]>([])
  const [toolsLoading, setToolsLoading] = createSignal(false)
  const [toolsError, setToolsError] = createSignal<string | null>(null)

  const loadTools = async () => {
    setToolsLoading(true)
    setToolsError(null)
    try {
      const data = await rpc.listTools()
      setTools(data ?? [])
    } catch (e) {
      setToolsError((e as Error).message ?? String(e))
    } finally {
      setToolsLoading(false)
    }
  }

  // Snapshots (History)
  const [snapshots, setSnapshots] = createSignal<Snapshot[]>([])
  const [snapsLoading, setSnapsLoading] = createSignal(false)
  const [snapsError, setSnapsError] = createSignal<string | null>(null)

  const loadSnapshots = async () => {
    const id = s().currentId
    if (!id) {
      setSnapshots([])
      return
    }
    setSnapsLoading(true)
    setSnapsError(null)
    try {
      const data = await rpc.listSnapshots(id)
      setSnapshots((data as Snapshot[]) ?? [])
    } catch (e) {
      setSnapsError((e as Error).message ?? String(e))
    } finally {
      setSnapsLoading(false)
    }
  }

  // Findings
  const [findings, setFindings] = createSignal<Finding[]>([])
  const [findingsLoading, setFindingsLoading] = createSignal(false)

  const loadFindings = async () => {
    setFindingsLoading(true)
    try {
      const data = await rpc.listFindings({ status: 'open', limit: 50 })
      setFindings(data ?? [])
    } catch {
      setFindings([])
    } finally {
      setFindingsLoading(false)
    }
  }

  // Jobs
  const [jobs, setJobs] = createSignal<Job[]>([])
  const [jobsLoading, setJobsLoading] = createSignal(false)

  const loadJobs = async () => {
    const id = s().currentId
    if (!id) {
      setJobs([])
      return
    }
    setJobsLoading(true)
    try {
      const data = await rpc.listJobs(id)
      setJobs(data ?? [])
    } catch {
      setJobs([])
    } finally {
      setJobsLoading(false)
    }
  }

  // Lazy load per tab
  createEffect(() => {
    const t = tab()
    if (t === 'tools' && tools().length === 0 && !toolsLoading()) void loadTools()
    if (t === 'history') void loadSnapshots()
    if (t === 'findings') void loadFindings()
    if (t === 'jobs') void loadJobs()
  })

  // Also reload when session changes for history/jobs
  createEffect(() => {
    const id = s().currentId
    if (!id) return
    if (tab() === 'history') void loadSnapshots()
    if (tab() === 'jobs') void loadJobs()
  })

  const doneCount = createMemo(() => s().todos.filter((t) => t.status === 'completed').length)
  const progress = createMemo(() =>
    s().todos.length === 0 ? 0 : Math.round((doneCount() / s().todos.length) * 100),
  )

  const badgeCount = (id: Tab): number | null => {
    switch (id) {
      case 'todos':
        return s().todos.length > 0
          ? s().todos.filter((t) => t.status !== 'completed').length
          : null
      case 'tools':
        return tools().length || null
      case 'history':
        return snapshots().length || null
      case 'findings':
        return findings().length || null
      case 'jobs':
        return jobs().length || null
      default:
        return null
    }
  }

  const cycleTab = (dir: number) => {
    const idx = TABS.findIndex((t) => t.id === tab())
    const next = (idx + dir + TABS.length) % TABS.length
    setTab(TABS[next].id)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (collapsed()) return
    // Tab cycles inspector tabs when inspector is expanded (Shift+Tab reverse)
    const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase()
    const isTyping =
      targetTag === 'input' ||
      targetTag === 'textarea' ||
      (e.target as HTMLElement)?.isContentEditable
    if (isTyping) return
    if (e.key === 'Tab') {
      // Only cycle if inspector panel is focused or no input is focused
      const inspectorEl = document.getElementById('inspector-panel')
      const activeInside = inspectorEl?.contains(document.activeElement)
      if (activeInside || document.activeElement === document.body) {
        e.preventDefault()
        cycleTab(e.shiftKey ? -1 : 1)
        return
      }
    }
    if (e.key === '[') {
      e.preventDefault()
      cycleTab(-1)
    }
    if (e.key === ']') {
      e.preventDefault()
      cycleTab(1)
    }
  }

  createEffect(() => {
    if (!collapsed()) window.addEventListener('keydown', onKeyDown)
    else window.removeEventListener('keydown', onKeyDown)
  })
  onCleanup(() => window.removeEventListener('keydown', onKeyDown))

  return (
    <aside
      style={{
        width: collapsed() ? '44px' : '320px',
        'flex-shrink': '0',
        display: 'flex',
        'flex-direction': 'column',
        border: '1px solid rgba(255,255,255,0.08)',
        'border-radius': '10px',
        background: 'rgba(255,255,255,0.02)',
        height: '100%',
        overflow: 'hidden',
        transition: 'width 0.2s ease',
      }}
      aria-label="Inspector"
    >
      <Show
        when={!collapsed()}
        fallback={
          <div
            style={{
              flex: '1',
              display: 'flex',
              'flex-direction': 'column',
              'align-items': 'center',
              gap: '8px',
              padding: '12px 0',
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              title="Expand inspector"
              aria-expanded="false"
              aria-controls="inspector-panel"
              style={{
                display: 'flex',
                'flex-direction': 'column',
                'align-items': 'center',
                gap: '6px',
                padding: '6px 0',
                background: 'transparent',
                border: 'none',
                color: '#9ca3af',
                cursor: 'pointer',
              }}
            >
              <span style={{ 'font-size': '13px', color: '#9ca3af' }}>«</span>
              <span
                style={{
                  'writing-mode': 'vertical-rl',
                  transform: 'rotate(180deg)',
                  'font-size': '10px',
                  'letter-spacing': '0.08em',
                  color: '#6b7280',
                }}
              >
                Inspector
              </span>
            </button>
            {/* Collapsed rail: vertical tabs with badge counts */}
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '6px',
                'align-items': 'center',
                flex: '1',
                overflow: 'auto',
              }}
            >
              <For each={TABS}>
                {(t) => {
                  const count = () => badgeCount(t.id)
                  const active = () => tab() === t.id
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        setTab(t.id)
                        setCollapsed(false)
                      }}
                      title={`${t.label}${count() !== null ? ` · ${count()}` : ''}`}
                      aria-label={`${t.label} tab`}
                      style={{
                        width: '32px',
                        height: '32px',
                        display: 'flex',
                        'flex-direction': 'column',
                        'align-items': 'center',
                        'justify-content': 'center',
                        gap: '1px',
                        'border-radius': '6px',
                        border: active()
                          ? '1px solid rgba(99,102,241,0.35)'
                          : '1px solid transparent',
                        background: active() ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.04)',
                        color: active() ? '#a5b4fc' : '#9ca3af',
                        cursor: 'pointer',
                        'font-size': '10px',
                        'font-weight': '600',
                        position: 'relative',
                      }}
                    >
                      <span>{t.label.slice(0, 2)}</span>
                      <Show when={count() !== null}>
                        <span
                          style={{
                            'font-size': '8px',
                            'font-weight': '700',
                            padding: '0 3px',
                            'border-radius': '999px',
                            background: active()
                              ? 'rgba(99,102,241,0.30)'
                              : 'rgba(99,102,241,0.18)',
                            color: '#c4b5fd',
                            'line-height': '1.2',
                          }}
                        >
                          {count()}
                        </span>
                      </Show>
                    </button>
                  )
                }}
              </For>
            </div>
          </div>
        }
      >
        {/* Tab bar */}
        <div
          style={{ display: 'flex', 'align-items': 'center', gap: '6px', padding: '8px 8px 0 8px' }}
        >
          <div
            role="tablist"
            aria-label="Inspector panels"
            style={{
              flex: '1',
              display: 'flex',
              gap: '2px',
              padding: '3px',
              'border-radius': '8px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.06)',
              overflow: 'auto',
            }}
          >
            <For each={TABS}>
              {(t) => {
                const active = () => tab() === t.id
                const count = () => badgeCount(t.id)
                return (
                  <button
                    type="button"
                    role="tab"
                    id={`tab-${t.id}`}
                    aria-selected={active() ? 'true' : 'false'}
                    aria-controls="inspector-panel"
                    onClick={() => setTab(t.id)}
                    style={{
                      flex: '1',
                      padding: '5px 6px',
                      'border-radius': '6px',
                      border: active()
                        ? '1px solid rgba(99,102,241,0.35)'
                        : '1px solid transparent',
                      background: active() ? 'rgba(99,102,241,0.18)' : 'transparent',
                      color: active() ? '#a5b4fc' : '#9ca3af',
                      cursor: 'pointer',
                      'font-size': '11px',
                      'font-weight': active() ? '700' : '500',
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'center',
                      gap: '4px',
                      'white-space': 'nowrap',
                    }}
                  >
                    {t.label}
                    <Show when={count() !== null}>
                      <span
                        style={{
                          padding: '1px 5px',
                          'border-radius': '999px',
                          background: active() ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.08)',
                          color: active() ? '#c4b5fd' : '#9ca3af',
                          'font-size': '10px',
                          'font-weight': '700',
                        }}
                      >
                        {count()}
                      </span>
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Collapse inspector"
            aria-expanded="true"
            aria-controls="inspector-panel"
            style={{
              width: '26px',
              height: '28px',
              padding: '0',
              'border-radius': '6px',
              flex: 'none',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#9ca3af',
              cursor: 'pointer',
            }}
          >
            »
          </button>
        </div>

        {/* Panel */}
        <div
          id="inspector-panel"
          role="tabpanel"
          aria-labelledby={`tab-${tab()}`}
          style={{
            flex: '1',
            padding: '10px',
            overflow: 'auto',
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
          }}
        >
          {/* ── Todos ── */}
          <Show when={tab() === 'todos'}>
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
                'margin-bottom': '6px',
                gap: '8px',
              }}
            >
              <span
                style={{
                  'font-size': '11px',
                  'font-weight': '700',
                  color: '#9ca3af',
                  'letter-spacing': '0.05em',
                  'text-transform': 'uppercase',
                }}
              >
                Todos
              </span>
              <Show when={s().todos.length > 0}>
                <span
                  style={{
                    'font-size': '10px',
                    color: '#6b7280',
                    'font-family': 'ui-monospace, monospace',
                  }}
                  role="status"
                >
                  {doneCount()}/{s().todos.length}
                </span>
              </Show>
              <Show when={s().currentId}>
                <button
                  type="button"
                  onClick={() => {
                    const id = s().currentId
                    if (id) void props.store.loadTodos(id)
                  }}
                  title="Refresh todos"
                  style={{
                    padding: '2px 7px',
                    'font-size': '11px',
                    border: '1px solid rgba(255,255,255,0.12)',
                    'border-radius': '999px',
                    background: 'rgba(255,255,255,0.06)',
                    color: '#9ca3af',
                    cursor: 'pointer',
                  }}
                >
                  ↻
                </button>
              </Show>
            </div>
            <Show when={s().todos.length > 0}>
              <div
                style={{
                  height: '6px',
                  'border-radius': '999px',
                  background: 'rgba(255,255,255,0.08)',
                  overflow: 'hidden',
                  'margin-bottom': '8px',
                }}
                aria-hidden="true"
              >
                <div
                  style={{
                    width: `${progress()}%`,
                    height: '100%',
                    background: 'rgba(99,102,241,0.9)',
                    transition: 'width 0.2s',
                  }}
                />
              </div>
            </Show>
            <Show
              when={s().currentId}
              fallback={
                <div style={{ color: '#6b7280', 'font-size': '12px', padding: '4px 0' }}>
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
                      border: '1px dashed rgba(255,255,255,0.12)',
                      'border-radius': '8px',
                      color: '#6b7280',
                      'font-size': '11px',
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
                          style={{
                            padding: '9px 11px',
                            display: 'flex',
                            gap: '9px',
                            'align-items': 'flex-start',
                            'border-radius': '8px',
                            background: 'rgba(255,255,255,0.03)',
                            border: wip
                              ? '1px solid rgba(251,191,36,0.25)'
                              : '1px solid rgba(255,255,255,0.08)',
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              width: '18px',
                              height: '18px',
                              'border-radius': '50%',
                              border: `1px solid ${done ? 'rgba(52,211,153,0.35)' : wip ? 'rgba(251,191,36,0.35)' : 'rgba(255,255,255,0.15)'}`,
                              background: done
                                ? 'rgba(52,211,153,0.15)'
                                : wip
                                  ? 'rgba(251,191,36,0.15)'
                                  : 'transparent',
                              color: done ? '#6ee7b7' : wip ? '#fbbf24' : '#6b7280',
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
                                'font-size': '12px',
                                color: done || cancelled ? '#9ca3af' : '#e5e7eb',
                                'text-decoration': done || cancelled ? 'line-through' : 'none',
                                'line-height': '1.45',
                              }}
                            >
                              {t.content}
                            </div>
                            <div
                              style={{ 'font-size': '10px', color: '#6b7280', 'margin-top': '2px' }}
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

          {/* ── Tools ── */}
          <Show when={tab() === 'tools'}>
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                'margin-bottom': '6px',
              }}
            >
              <span
                style={{
                  'font-size': '11px',
                  'font-weight': '700',
                  color: '#9ca3af',
                  'letter-spacing': '0.05em',
                  'text-transform': 'uppercase',
                }}
              >
                Tools
              </span>
              <span
                style={{
                  'font-size': '10px',
                  padding: '1px 7px',
                  'border-radius': '999px',
                  background: 'rgba(99,102,241,0.15)',
                  color: '#a5b4fc',
                  border: '1px solid rgba(99,102,241,0.25)',
                }}
              >
                {toolsLoading() ? '…' : tools().length}
              </span>
              <button
                type="button"
                onClick={() => void loadTools()}
                title="Refresh tools"
                style={{
                  padding: '2px 7px',
                  'font-size': '11px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  'border-radius': '999px',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#9ca3af',
                  cursor: 'pointer',
                  'margin-left': 'auto',
                }}
              >
                ↻
              </button>
            </div>
            <Show when={toolsError()}>
              <div
                style={{
                  padding: '8px 10px',
                  'border-radius': '8px',
                  background: 'rgba(239,68,68,0.10)',
                  border: '1px solid rgba(239,68,68,0.22)',
                  color: '#fecaca',
                  'font-size': '11px',
                }}
              >
                {toolsError()}
              </div>
            </Show>
            <Show
              when={!toolsLoading()}
              fallback={
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                  <For each={[0, 1, 2]}>
                    {() => (
                      <div
                        style={{
                          height: '48px',
                          'border-radius': '8px',
                          background: 'rgba(255,255,255,0.06)',
                        }}
                      />
                    )}
                  </For>
                </div>
              }
            >
              <Show
                when={tools().length > 0}
                fallback={
                  <div
                    style={{
                      padding: '14px',
                      border: '1px dashed rgba(255,255,255,0.12)',
                      'border-radius': '8px',
                      color: '#6b7280',
                      'font-size': '11px',
                      'text-align': 'center',
                      'line-height': '1.5',
                    }}
                  >
                    No tools reported. Is the Mira server running on :4096?
                  </div>
                }
              >
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                  <For each={tools()}>
                    {(tool) => (
                      <div
                        style={{
                          padding: '9px 11px',
                          'border-radius': '8px',
                          background: 'rgba(255,255,255,0.03)',
                          border: '1px solid rgba(255,255,255,0.08)',
                        }}
                      >
                        <div
                          style={{
                            'font-size': '12px',
                            'font-weight': '600',
                            color: '#e5e7eb',
                            'font-family': 'ui-monospace, monospace',
                          }}
                        >
                          {tool.name}
                        </div>
                        <div
                          style={{
                            'font-size': '11px',
                            color: '#9ca3af',
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

          {/* ── Events ── */}
          <Show when={tab() === 'events'}>
            <div
              style={{
                'font-size': '11px',
                'font-weight': '700',
                color: '#9ca3af',
                'letter-spacing': '0.05em',
                'text-transform': 'uppercase',
                'margin-bottom': '8px',
              }}
            >
              Connection
            </div>
            <div
              style={{
                padding: '10px 12px',
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                'border-radius': '8px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <span
                style={{
                  width: '7px',
                  height: '7px',
                  'border-radius': '50%',
                  background: s().connected ? '#34d399' : '#f87171',
                  display: 'inline-block',
                  flex: 'none',
                }}
              />
              <span
                style={{
                  'font-size': '12px',
                  color: s().connected ? '#e5e7eb' : '#9ca3af',
                  'font-weight': '600',
                }}
              >
                {s().connected ? 'Live event socket connected' : 'Event socket offline — retrying'}
              </span>
            </div>
            <div
              style={{
                'margin-top': '8px',
                color: '#6b7280',
                'font-size': '10px',
                'line-height': '1.55',
              }}
            >
              Updates arrive over the server's event bus — sessions, todos, and questions refresh
              automatically, no polling.
            </div>
            <Show when={s().streaming}>
              <div
                style={{
                  'margin-top': '8px',
                  padding: '9px 11px',
                  'border-radius': '8px',
                  background: 'rgba(251,191,36,0.10)',
                  border: '1px solid rgba(251,191,36,0.25)',
                  color: '#fbbf24',
                  'font-size': '11px',
                }}
              >
                ◷ Streaming turn for{' '}
                <code style={{ 'font-family': 'ui-monospace, monospace', color: '#e5e7eb' }}>
                  {s().currentId?.slice(0, 8)}
                </code>
                …
              </div>
            </Show>
            <Show when={s().queued.length > 0}>
              <div
                style={{
                  'margin-top': '8px',
                  padding: '9px 11px',
                  'border-radius': '8px',
                  background: 'rgba(99,102,241,0.10)',
                  border: '1px solid rgba(99,102,241,0.25)',
                  color: '#a5b4fc',
                  'font-size': '11px',
                }}
              >
                ⏳ {s().queued.length} queued — will run after current turn
              </div>
            </Show>
            <Show when={s().streamEvents.length > 0}>
              <div
                style={{
                  'margin-top': '10px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '4px',
                }}
              >
                <span
                  style={{
                    'font-size': '10px',
                    'font-weight': '600',
                    color: '#6b7280',
                    'letter-spacing': '0.04em',
                  }}
                >
                  RECENT EVENTS ({s().streamEvents.length})
                </span>
                <For each={s().streamEvents.slice(-8).reverse()}>
                  {(ev) => (
                    <div
                      style={{
                        padding: '6px 8px',
                        'border-radius': '6px',
                        background: 'rgba(0,0,0,0.25)',
                        border: '1px solid rgba(255,255,255,0.06)',
                        'font-size': '11px',
                        display: 'flex',
                        gap: '6px',
                      }}
                    >
                      <span
                        style={{
                          color: '#a5b4fc',
                          'font-family': 'ui-monospace, monospace',
                          'font-size': '10px',
                        }}
                      >
                        {ev.type}
                      </span>
                      <span style={{ color: '#6b7280', 'font-size': '10px' }}>
                        {new Date(ev.at).toLocaleTimeString()}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          {/* ── History ── */}
          <Show when={tab() === 'history'}>
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
                'margin-bottom': '6px',
                gap: '8px',
              }}
            >
              <span
                style={{
                  'font-size': '11px',
                  'font-weight': '700',
                  color: '#9ca3af',
                  'letter-spacing': '0.05em',
                  'text-transform': 'uppercase',
                }}
              >
                History · {snapsLoading() ? '…' : snapshots().length}
              </span>
              <Show when={s().currentId}>
                <button
                  type="button"
                  onClick={() => void loadSnapshots()}
                  title="Refresh snapshots"
                  style={{
                    padding: '2px 7px',
                    'font-size': '11px',
                    border: '1px solid rgba(255,255,255,0.12)',
                    'border-radius': '999px',
                    background: 'rgba(255,255,255,0.06)',
                    color: '#9ca3af',
                    cursor: 'pointer',
                  }}
                >
                  ↻
                </button>
              </Show>
            </div>
            <Show when={snapsError()}>
              <div
                style={{
                  padding: '8px 10px',
                  'border-radius': '8px',
                  background: 'rgba(239,68,68,0.10)',
                  border: '1px solid rgba(239,68,68,0.22)',
                  color: '#fecaca',
                  'font-size': '11px',
                }}
              >
                {snapsError()}
              </div>
            </Show>
            <Show
              when={s().currentId}
              fallback={
                <div style={{ color: '#6b7280', 'font-size': '12px', padding: '4px 0' }}>
                  Select a session to see its file history.
                </div>
              }
            >
              <Show
                when={!snapsLoading()}
                fallback={
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                    <For each={[0, 1]}>
                      {() => (
                        <div
                          style={{
                            height: '52px',
                            'border-radius': '8px',
                            background: 'rgba(255,255,255,0.06)',
                          }}
                        />
                      )}
                    </For>
                  </div>
                }
              >
                <Show
                  when={snapshots().length > 0}
                  fallback={
                    <div
                      style={{
                        padding: '14px',
                        border: '1px dashed rgba(255,255,255,0.12)',
                        'border-radius': '8px',
                        color: '#6b7280',
                        'font-size': '11px',
                        'text-align': 'center',
                        'line-height': '1.5',
                      }}
                    >
                      No file mutations yet — edits are snapshotted before they land.
                    </div>
                  }
                >
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                    <For each={snapshots()}>
                      {(snap) => {
                        const [detail, setDetail] = createSignal<{
                          path: string
                          snapshotContent: string | null
                          currentContent: string | null
                          existedBefore: boolean
                        } | null>(null)
                        const [loadingDetail, setLoadingDetail] = createSignal(false)
                        const [reverting, setReverting] = createSignal(false)
                        return (
                          <div
                            style={{
                              padding: '9px 11px',
                              'border-radius': '8px',
                              background: 'rgba(255,255,255,0.03)',
                              border: '1px solid rgba(255,255,255,0.08)',
                              display: 'flex',
                              'flex-direction': 'column',
                              gap: '6px',
                            }}
                          >
                            <div style={{ display: 'flex', gap: '9px', 'align-items': 'center' }}>
                              <div style={{ flex: '1', 'min-width': '0' }}>
                                <div
                                  style={{
                                    'font-size': '12px',
                                    'font-weight': '600',
                                    color: '#e5e7eb',
                                    'font-family': 'ui-monospace, monospace',
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
                                    'font-size': '10px',
                                    color: '#6b7280',
                                    'margin-top': '2px',
                                    'font-family': 'ui-monospace, monospace',
                                  }}
                                >
                                  {new Date(snap.createdAt).toLocaleTimeString()} ·{' '}
                                  {snap.existedBefore ? 'edit' : 'new file'}
                                  {snap.messageID ? ` · ${snap.messageID.slice(0, 8)}` : ''}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() =>
                                  void (async () => {
                                    const id = s().currentId
                                    if (!id) return
                                    setLoadingDetail(true)
                                    try {
                                      const d = await rpc.getSnapshot(id, snap.id)
                                      setDetail(d)
                                    } catch (e) {
                                      setSnapsError((e as Error).message ?? String(e))
                                    } finally {
                                      setLoadingDetail(false)
                                    }
                                  })()
                                }
                                title="Preview diff"
                                style={{
                                  padding: '4px 8px',
                                  'font-size': '11px',
                                  border: '1px solid rgba(255,255,255,0.12)',
                                  'border-radius': '999px',
                                  background: 'rgba(255,255,255,0.06)',
                                  color: '#9ca3af',
                                  cursor: 'pointer',
                                  flex: 'none',
                                }}
                              >
                                {loadingDetail() ? '…' : 'diff'}
                              </button>
                              <button
                                type="button"
                                disabled={reverting()}
                                onClick={() =>
                                  void (async () => {
                                    const id = s().currentId
                                    if (!id) return
                                    setReverting(true)
                                    try {
                                      await rpc.revertSession(id, snap.messageID ?? undefined)
                                      await loadSnapshots()
                                      await props.store.loadMessages(id)
                                    } catch (e) {
                                      setSnapsError((e as Error).message ?? String(e))
                                    } finally {
                                      setReverting(false)
                                    }
                                  })()
                                }
                                title={
                                  snap.messageID
                                    ? `Rewind to message ${snap.messageID.slice(0, 8)}`
                                    : 'Undo last mutation'
                                }
                                style={{
                                  padding: '4px 8px',
                                  'font-size': '11px',
                                  border: '1px solid rgba(255,255,255,0.12)',
                                  'border-radius': '999px',
                                  background: 'rgba(255,255,255,0.06)',
                                  color: '#e5e7eb',
                                  cursor: reverting() ? 'not-allowed' : 'pointer',
                                  flex: 'none',
                                  opacity: reverting() ? '0.5' : '1',
                                }}
                              >
                                {reverting() ? '…' : '↩ revert'}
                              </button>
                            </div>
                            <Show when={detail()}>
                              {(d) => (
                                <div
                                  style={{
                                    'margin-top': '4px',
                                    'font-family': 'ui-monospace, monospace',
                                    'font-size': '10px',
                                    'white-space': 'pre-wrap',
                                    background: 'rgba(0,0,0,0.25)',
                                    padding: '8px',
                                    'border-radius': '6px',
                                    border: '1px solid rgba(255,255,255,0.06)',
                                  }}
                                >
                                  <div
                                    style={{
                                      'font-weight': '600',
                                      'margin-bottom': '4px',
                                      color: '#e5e7eb',
                                    }}
                                  >
                                    Diff preview for {d().path}
                                  </div>
                                  <div style={{ color: '#9ca3af' }}>
                                    Snapshot ({d().existedBefore ? 'edit' : 'new file'}):
                                  </div>
                                  <pre
                                    style={{
                                      margin: '4px 0',
                                      'white-space': 'pre-wrap',
                                      color: '#d1d5db',
                                    }}
                                  >
                                    {d().snapshotContent ?? '(empty)'}
                                  </pre>
                                  <div style={{ color: '#9ca3af' }}>Current:</div>
                                  <pre
                                    style={{
                                      margin: '4px 0',
                                      'white-space': 'pre-wrap',
                                      color: '#d1d5db',
                                    }}
                                  >
                                    {d().currentContent ?? '(file missing)'}
                                  </pre>
                                </div>
                              )}
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>

          {/* ── Findings ── */}
          <Show when={tab() === 'findings'}>
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
                'margin-bottom': '6px',
                gap: '8px',
              }}
            >
              <span
                style={{
                  'font-size': '11px',
                  'font-weight': '700',
                  color: '#9ca3af',
                  'letter-spacing': '0.05em',
                  'text-transform': 'uppercase',
                }}
              >
                Findings · {findingsLoading() ? '…' : findings().length} open
              </span>
              <button
                type="button"
                onClick={() => void loadFindings()}
                title="Refresh findings"
                style={{
                  padding: '2px 7px',
                  'font-size': '11px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  'border-radius': '999px',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#9ca3af',
                  cursor: 'pointer',
                }}
              >
                ↻
              </button>
            </div>
            <Show
              when={!findingsLoading()}
              fallback={
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                  <For each={[0, 1]}>
                    {() => (
                      <div
                        style={{
                          height: '52px',
                          'border-radius': '8px',
                          background: 'rgba(255,255,255,0.06)',
                        }}
                      />
                    )}
                  </For>
                </div>
              }
            >
              <Show
                when={findings().length > 0}
                fallback={
                  <div
                    style={{
                      padding: '14px',
                      border: '1px dashed rgba(255,255,255,0.12)',
                      'border-radius': '8px',
                      color: '#6b7280',
                      'font-size': '11px',
                      'text-align': 'center',
                      'line-height': '1.5',
                    }}
                  >
                    No open findings — team memory is clear.
                  </div>
                }
              >
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                  <For each={findings()}>
                    {(f) => {
                      const [resolving, setResolving] = createSignal(false)
                      return (
                        <div
                          style={{
                            padding: '9px 11px',
                            'border-radius': '8px',
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid rgba(255,255,255,0.08)',
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
                                  'font-size': '10px',
                                  'font-weight': '700',
                                  padding: '1px 6px',
                                  'border-radius': '999px',
                                  background:
                                    f.severity === 'critical'
                                      ? 'rgba(239,68,68,0.15)'
                                      : f.severity === 'major'
                                        ? 'rgba(251,191,36,0.15)'
                                        : f.severity === 'minor'
                                          ? 'rgba(99,102,241,0.15)'
                                          : 'rgba(255,255,255,0.06)',
                                  color:
                                    f.severity === 'critical'
                                      ? '#fca5a5'
                                      : f.severity === 'major'
                                        ? '#fbbf24'
                                        : f.severity === 'minor'
                                          ? '#a5b4fc'
                                          : '#9ca3af',
                                  border: `1px solid ${f.severity === 'critical' ? 'rgba(239,68,68,0.25)' : f.severity === 'major' ? 'rgba(251,191,36,0.25)' : 'rgba(255,255,255,0.08)'}`,
                                }}
                              >
                                {f.severity}
                              </span>
                              <span
                                style={{
                                  'font-size': '10px',
                                  color: '#6b7280',
                                  'font-family': 'ui-monospace, monospace',
                                }}
                              >
                                {new Date(f.createdAt).toLocaleDateString()} · {f.source}
                              </span>
                            </div>
                            <div
                              style={{
                                'font-size': '12px',
                                'font-weight': '600',
                                color: '#e5e7eb',
                                'line-height': '1.4',
                              }}
                            >
                              {f.title}
                            </div>
                            <Show when={f.evidence}>
                              <div
                                style={{
                                  'font-size': '11px',
                                  color: '#9ca3af',
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
                            disabled={resolving()}
                            onClick={() =>
                              void (async () => {
                                setResolving(true)
                                try {
                                  await rpc.resolveFinding(f.id)
                                  await loadFindings()
                                } catch (e) {
                                  setResolving(false)
                                } finally {
                                  setResolving(false)
                                }
                              })()
                            }
                            title="Mark resolved"
                            style={{
                              padding: '4px 8px',
                              'font-size': '11px',
                              border: '1px solid rgba(255,255,255,0.12)',
                              'border-radius': '999px',
                              background: 'rgba(255,255,255,0.06)',
                              color: '#9ca3af',
                              cursor: resolving() ? 'not-allowed' : 'pointer',
                              flex: 'none',
                              opacity: resolving() ? '0.5' : '1',
                            }}
                          >
                            {resolving() ? '…' : '✓ resolve'}
                          </button>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>

          {/* ── Jobs ── */}
          <Show when={tab() === 'jobs'}>
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
                'margin-bottom': '6px',
                gap: '8px',
              }}
            >
              <span
                style={{
                  'font-size': '11px',
                  'font-weight': '700',
                  color: '#9ca3af',
                  'letter-spacing': '0.05em',
                  'text-transform': 'uppercase',
                }}
              >
                Jobs · {jobsLoading() ? '…' : jobs().length}
              </span>
              <button
                type="button"
                onClick={() => void loadJobs()}
                title="Refresh jobs"
                style={{
                  padding: '2px 7px',
                  'font-size': '11px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  'border-radius': '999px',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#9ca3af',
                  cursor: 'pointer',
                }}
              >
                ↻
              </button>
            </div>
            <Show
              when={s().currentId}
              fallback={
                <div style={{ color: '#6b7280', 'font-size': '12px', padding: '4px 0' }}>
                  Select a session to see its jobs.
                </div>
              }
            >
              <Show
                when={!jobsLoading()}
                fallback={
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                    <For each={[0, 1]}>
                      {() => (
                        <div
                          style={{
                            height: '52px',
                            'border-radius': '8px',
                            background: 'rgba(255,255,255,0.06)',
                          }}
                        />
                      )}
                    </For>
                  </div>
                }
              >
                <Show
                  when={jobs().length > 0}
                  fallback={
                    <div
                      style={{
                        padding: '14px',
                        border: '1px dashed rgba(255,255,255,0.12)',
                        'border-radius': '8px',
                        color: '#6b7280',
                        'font-size': '11px',
                        'text-align': 'center',
                        'line-height': '1.5',
                      }}
                    >
                      No background jobs —{' '}
                      <code
                        style={{
                          background: 'rgba(255,255,255,0.08)',
                          padding: '1px 5px',
                          'border-radius': '4px',
                        }}
                      >
                        task
                      </code>{' '}
                      tool spawns appear here.
                    </div>
                  }
                >
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                    <For each={jobs()}>
                      {(job) => {
                        const [cancelling, setCancelling] = createSignal(false)
                        return (
                          <div
                            style={{
                              padding: '9px 11px',
                              'border-radius': '8px',
                              background: 'rgba(255,255,255,0.03)',
                              border: '1px solid rgba(255,255,255,0.08)',
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
                                    ? '#fbbf24'
                                    : job.status === 'completed'
                                      ? '#34d399'
                                      : job.status === 'failed'
                                        ? '#f87171'
                                        : '#9ca3af',
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
                                    'font-size': '10px',
                                    'font-weight': '700',
                                    padding: '1px 6px',
                                    'border-radius': '999px',
                                    background:
                                      job.status === 'running'
                                        ? 'rgba(251,191,36,0.15)'
                                        : job.status === 'completed'
                                          ? 'rgba(52,211,153,0.15)'
                                          : 'rgba(255,255,255,0.06)',
                                    color:
                                      job.status === 'running'
                                        ? '#fbbf24'
                                        : job.status === 'completed'
                                          ? '#6ee7b7'
                                          : job.status === 'failed'
                                            ? '#fca5a5'
                                            : '#9ca3af',
                                    border: `1px solid ${job.status === 'running' ? 'rgba(251,191,36,0.25)' : 'rgba(255,255,255,0.08)'}`,
                                  }}
                                >
                                  {job.status}
                                </span>
                                <span
                                  style={{
                                    'font-size': '10px',
                                    color: '#6b7280',
                                    'font-family': 'ui-monospace, monospace',
                                  }}
                                >
                                  {job.agent ?? 'general'} ·{' '}
                                  {new Date(job.createdAt).toLocaleTimeString()}
                                </span>
                              </div>
                              <div
                                style={{
                                  'font-size': '11px',
                                  color: '#e5e7eb',
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
                                    'font-size': '10px',
                                    color: '#9ca3af',
                                    'margin-top': '4px',
                                    'white-space': 'pre-wrap',
                                    'word-break': 'break-word',
                                    background: 'rgba(0,0,0,0.25)',
                                    padding: '4px 6px',
                                    'border-radius': '4px',
                                    border: '1px solid rgba(255,255,255,0.06)',
                                  }}
                                >
                                  {String(job.result).slice(0, 200)}
                                  {String(job.result ?? '').length > 200 ? '…' : ''}
                                </div>
                              </Show>
                              <Show when={job.status === 'failed' && job.error}>
                                <div
                                  style={{
                                    'font-size': '10px',
                                    color: '#fca5a5',
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
                                disabled={cancelling()}
                                onClick={() =>
                                  void (async () => {
                                    setCancelling(true)
                                    try {
                                      await rpc.cancelJob(job.id)
                                      await loadJobs()
                                    } catch {
                                    } finally {
                                      setCancelling(false)
                                    }
                                  })()
                                }
                                title="Cancel job"
                                style={{
                                  padding: '4px 8px',
                                  'font-size': '11px',
                                  border: '1px solid rgba(255,255,255,0.12)',
                                  'border-radius': '999px',
                                  background: 'rgba(255,255,255,0.06)',
                                  color: '#e5e7eb',
                                  cursor: cancelling() ? 'not-allowed' : 'pointer',
                                  flex: 'none',
                                  opacity: cancelling() ? '0.5' : '1',
                                }}
                              >
                                {cancelling() ? '…' : '✕ cancel'}
                              </button>
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>
        </div>

        {/* Footer hint */}
        <div
          style={{
            padding: '6px 10px',
            'border-top': '1px solid rgba(255,255,255,0.06)',
            'font-size': '10px',
            opacity: '0.45',
            display: 'flex',
            'justify-content': 'space-between',
          }}
        >
          <span>[ ] cycle tabs</span>
          <span>{TABS.find((t) => t.id === tab())?.label}</span>
        </div>
      </Show>
    </aside>
  )
}
