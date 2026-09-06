/**
 * JobsView — TUI background jobs list for Mira
 *
 * Lists jobs from session, shows status, allows abort, opens child session.
 * Mirrors web/src/components/JobRow.tsx behavior for TUI.
 */

import { For, Show, createSignal, createEffect, onCleanup } from 'solid-js'
import { rpc, type Job } from '../rpc/client'

type Props = {
  open: boolean
  onClose: () => void
  sessionId: string | null
  onSelectSession: (id: string) => void
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function statusColor(status: Job['status']): string {
  switch (status) {
    case 'running':
      return '#fbbf24'
    case 'completed':
      return '#34d399'
    case 'failed':
      return '#f87171'
    case 'cancelled':
      return '#9ca3af'
    default:
      return '#6b7280'
  }
}

function badgeStyle(status: Job['status']): Record<string, string> {
  switch (status) {
    case 'running':
      return {
        background: 'rgba(251,191,36,0.15)',
        border: '1px solid rgba(251,191,36,0.30)',
        color: '#fbbf24',
      }
    case 'completed':
      return {
        background: 'rgba(52,211,153,0.15)',
        border: '1px solid rgba(52,211,153,0.30)',
        color: '#6ee7b7',
      }
    case 'failed':
      return {
        background: 'rgba(248,113,113,0.15)',
        border: '1px solid rgba(248,113,113,0.30)',
        color: '#fca5a5',
      }
    case 'cancelled':
      return {
        background: 'rgba(156,163,175,0.12)',
        border: '1px solid rgba(156,163,175,0.25)',
        color: '#9ca3af',
      }
    default:
      return {
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        color: '#9ca3af',
      }
  }
}

export default function JobsView(props: Props) {
  const [jobs, setJobs] = createSignal<Job[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [cancelling, setCancelling] = createSignal<string | null>(null)
  const [now, setNow] = createSignal(Date.now())

  // tick for elapsed time
  let tickIv: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    if (props.open) {
      setNow(Date.now())
      tickIv = setInterval(() => setNow(Date.now()), 1000)
    } else {
      if (tickIv) clearInterval(tickIv)
      tickIv = undefined
    }
  })
  onCleanup(() => {
    if (tickIv) clearInterval(tickIv)
  })

  const fetchJobs = async () => {
    const sid = props.sessionId
    if (!sid) {
      setJobs([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await rpc.listJobs(sid)
      setJobs(data)
    } catch (e) {
      setError((e as Error).message ?? String(e))
    } finally {
      setLoading(false)
    }
  }

  // fetch when opened or session changes, poll every 4s while open
  let pollIv: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    const isOpen = props.open
    const sid = props.sessionId
    if (isOpen && sid) {
      void fetchJobs()
      if (pollIv) clearInterval(pollIv)
      pollIv = setInterval(() => {
        void fetchJobs()
      }, 4000)
    } else {
      if (pollIv) clearInterval(pollIv)
      pollIv = undefined
      if (!isOpen) {
        setJobs([])
        setError(null)
      }
    }
  })
  onCleanup(() => {
    if (pollIv) clearInterval(pollIv)
  })

  const handleCancel = async (jobId: string) => {
    setCancelling(jobId)
    setError(null)
    try {
      await rpc.cancelJob(jobId)
      await fetchJobs()
    } catch (e) {
      setError((e as Error).message ?? String(e))
    } finally {
      setCancelling(null)
    }
  }

  const handleOpenChild = (childId: string) => {
    try {
      props.onSelectSession(childId)
      props.onClose()
    } catch (e) {
      setError((e as Error).message ?? String(e))
    }
  }

  let dialogRef: HTMLDivElement | undefined
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
      return
    }
    if (e.key === 'Tab' && dialogRef) {
      const focusable = dialogRef.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  createEffect(() => {
    if (props.open) {
      window.addEventListener('keydown', onKeyDown)
      queueMicrotask(() => {
        const el = dialogRef?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        el?.focus()
      })
    } else window.removeEventListener('keydown', onKeyDown)
  })
  onCleanup(() => window.removeEventListener('keydown', onKeyDown))

  return (
    <Show when={props.open}>
      <div
        style={{
          position: 'fixed',
          inset: '0',
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          'align-items': 'flex-start',
          'justify-content': 'center',
          'padding-top': '8vh',
          'z-index': '1000',
        }}
        onClick={props.onClose}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Jobs"
          tabindex="-1"
          style={{
            width: 'min(720px, 94vw)',
            'max-height': '80vh',
            display: 'flex',
            'flex-direction': 'column',
            'border-radius': '12px',
            background: '#0f1117',
            border: '1px solid rgba(255,255,255,0.12)',
            'box-shadow': '0 16px 48px rgba(0,0,0,0.55)',
            overflow: 'hidden',
            color: '#e5e7eb',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              'justify-content': 'space-between',
              'align-items': 'center',
              padding: '14px 16px',
              'border-bottom': '1px solid rgba(255,255,255,0.08)',
              'flex-shrink': '0',
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
              <span
                style={{ 'font-weight': '700', 'font-size': '15px', 'letter-spacing': '0.02em' }}
              >
                Jobs
              </span>
              <Show when={props.sessionId}>
                <span
                  style={{
                    'font-size': '11px',
                    opacity: '0.5',
                    'font-family': 'ui-monospace, monospace',
                  }}
                >
                  {props.sessionId?.slice(0, 8)}
                </span>
              </Show>
              <Show when={!loading() && jobs().length > 0}>
                <span
                  style={{
                    padding: '2px 7px',
                    'border-radius': '999px',
                    background: 'rgba(99,102,241,0.15)',
                    border: '1px solid rgba(99,102,241,0.25)',
                    color: '#a5b4fc',
                    'font-size': '11px',
                    'font-weight': '600',
                  }}
                >
                  {jobs().length}
                </span>
              </Show>
            </div>
            <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
              <button
                onClick={() => void fetchJobs()}
                disabled={loading()}
                title="Refresh jobs"
                style={{
                  padding: '5px 10px',
                  'border-radius': '6px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#e5e7eb',
                  cursor: loading() ? 'not-allowed' : 'pointer',
                  'font-size': '12px',
                  opacity: loading() ? '0.5' : '1',
                }}
              >
                ↻ Refresh
              </button>
              <button
                onClick={props.onClose}
                style={{
                  padding: '5px 10px',
                  'border-radius': '6px',
                  border: '1px solid rgba(255,255,255,0.10)',
                  background: 'transparent',
                  color: '#9ca3af',
                  cursor: 'pointer',
                  'font-size': '12px',
                }}
              >
                ✕ Close
              </button>
            </div>
          </div>

          {/* Error banner */}
          <Show when={error()}>
            <div
              style={{
                margin: '10px 12px 0 12px',
                padding: '8px 10px',
                'border-radius': '8px',
                background: 'rgba(239,68,68,0.10)',
                border: '1px solid rgba(239,68,68,0.22)',
                color: '#fecaca',
                'font-size': '12px',
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
                gap: '8px',
              }}
            >
              <span style={{ flex: '1', 'word-break': 'break-word' }}>{error()}</span>
              <button
                onClick={() => setError(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#fecaca',
                  cursor: 'pointer',
                  'font-size': '12px',
                  'flex-shrink': '0',
                }}
              >
                ✕
              </button>
            </div>
          </Show>

          {/* Body */}
          <div
            style={{
              flex: '1',
              overflow: 'auto',
              padding: '12px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '8px',
            }}
          >
            <Show when={!props.sessionId}>
              <div
                style={{
                  padding: '24px',
                  'text-align': 'center',
                  color: '#9ca3af',
                  'font-size': '13px',
                  border: '1px dashed rgba(255,255,255,0.12)',
                  'border-radius': '8px',
                }}
              >
                No session selected — create or pick a session to see its jobs.
              </div>
            </Show>

            <Show when={props.sessionId && loading() && jobs().length === 0}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                <div
                  style={{
                    height: '52px',
                    'border-radius': '8px',
                    background: 'rgba(255,255,255,0.06)',
                  }}
                />
                <div
                  style={{
                    height: '52px',
                    'border-radius': '8px',
                    background: 'rgba(255,255,255,0.04)',
                  }}
                />
              </div>
            </Show>

            <Show when={props.sessionId && !loading() && jobs().length === 0 && !error()}>
              <div
                style={{
                  padding: '20px',
                  'text-align': 'center',
                  color: '#9ca3af',
                  'font-size': '13px',
                  border: '1px dashed rgba(255,255,255,0.12)',
                  'border-radius': '8px',
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
            </Show>

            <For each={jobs()}>
              {(job) => {
                const isRunning = () => job.status === 'running'
                const canOpen = () => !!job.childSessionID
                const elapsed = () => formatElapsed(now() - job.createdAt)
                const preview = () => {
                  const p = job.prompt ?? ''
                  return p.length > 160 ? p.slice(0, 157) + '…' : p
                }
                return (
                  <div
                    style={{
                      padding: '10px 12px',
                      display: 'flex',
                      gap: '10px',
                      'align-items': 'flex-start',
                      'border-radius': '8px',
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      cursor: canOpen() ? 'pointer' : 'default',
                    }}
                    onClick={() => {
                      if (canOpen()) handleOpenChild(job.childSessionID!)
                    }}
                    title={canOpen() ? 'Open child session' : undefined}
                  >
                    <span
                      style={{
                        width: '8px',
                        height: '8px',
                        'border-radius': '50%',
                        background: statusColor(job.status),
                        flex: 'none',
                        'margin-top': '6px',
                      }}
                    />
                    <div
                      style={{
                        flex: '1',
                        'min-width': '0',
                        display: 'flex',
                        'flex-direction': 'column',
                        gap: '4px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          gap: '6px',
                          'align-items': 'center',
                          'flex-wrap': 'wrap',
                        }}
                      >
                        <span
                          style={{
                            'font-size': '11px',
                            'font-weight': '700',
                            padding: '1px 6px',
                            'border-radius': '999px',
                            ...badgeStyle(job.status),
                          }}
                        >
                          {job.status}
                        </span>
                        <span
                          style={{
                            'font-size': '11px',
                            color: '#9ca3af',
                            'font-family': 'ui-monospace, monospace',
                          }}
                        >
                          {job.agent ?? 'general'} · {new Date(job.createdAt).toLocaleTimeString()}
                        </span>
                        <span
                          style={{
                            'font-size': '11px',
                            color: '#6b7280',
                            'font-family': 'ui-monospace, monospace',
                          }}
                        >
                          {elapsed()}
                        </span>
                        <Show when={canOpen()}>
                          <span
                            style={{ 'font-size': '11px', color: '#a5b4fc', 'font-weight': '600' }}
                          >
                            child →
                          </span>
                        </Show>
                      </div>
                      <div
                        style={{
                          'font-size': '12px',
                          color: '#e5e7eb',
                          'line-height': '1.4',
                          'white-space': 'pre-wrap',
                          'word-break': 'break-word',
                        }}
                      >
                        {preview()}
                      </div>
                      <Show when={job.status === 'completed' && job.result}>
                        <div
                          style={{
                            'font-size': '11px',
                            color: '#9ca3af',
                            'margin-top': '2px',
                            'white-space': 'pre-wrap',
                            'word-break': 'break-word',
                            background: 'rgba(0,0,0,0.25)',
                            padding: '5px 7px',
                            'border-radius': '6px',
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
                            'font-size': '11px',
                            color: '#fca5a5',
                            'margin-top': '2px',
                            'word-break': 'break-word',
                          }}
                        >
                          {String(job.error).slice(0, 200)}
                        </div>
                      </Show>
                    </div>
                    <Show when={isRunning()}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleCancel(job.id)
                        }}
                        disabled={cancelling() === job.id}
                        title="Cancel job"
                        style={{
                          padding: '4px 8px',
                          'font-size': '11px',
                          border: '1px solid rgba(255,255,255,0.12)',
                          'border-radius': '999px',
                          background: 'rgba(255,255,255,0.06)',
                          color: '#e5e7eb',
                          cursor: cancelling() === job.id ? 'not-allowed' : 'pointer',
                          flex: 'none',
                          opacity: cancelling() === job.id ? '0.5' : '1',
                        }}
                      >
                        {cancelling() === job.id ? '…' : '✕ cancel'}
                      </button>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>

          {/* Footer */}
          <div
            style={{
              padding: '8px 12px',
              'border-top': '1px solid rgba(255,255,255,0.06)',
              'font-size': '11px',
              opacity: '0.5',
              display: 'flex',
              'justify-content': 'space-between',
              'flex-shrink': '0',
            }}
          >
            <span>Click child → to open · ✕ cancel to abort running jobs</span>
            <span>Esc to close</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
