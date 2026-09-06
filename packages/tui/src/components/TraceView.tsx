/**
 * TraceView — TUI port of web/src/components/TraceViewer.tsx (1119 lines)
 *
 * Modal drawer showing: score hero, meta grid, IDs, badge, spans timeline,
 * DAG runs (jobs), tool metrics. Fetches via rpc.getScore / getTrace / listJobs.
 * Dark TUI styling (rgba, no CSS vars) to match Inspector/SettingsView.
 */

import { createSignal, createEffect, Show, For, onCleanup } from 'solid-js'
import { rpc, type Job } from '../rpc/client'
import type { ScoreData, TraceData } from '../rpc/client'

function scoreColor(score: number): string {
  if (score >= 80) return '#34d399'
  if (score >= 60) return '#fbbf24'
  if (score >= 40) return '#f87171'
  return '#f87171'
}

function scoreBg(score: number): string {
  if (score >= 80) return 'rgba(52,211,153,0.15)'
  if (score >= 60) return 'rgba(251,191,36,0.15)'
  return 'rgba(248,113,113,0.15)'
}

export default function TraceView(props: {
  sessionID: string | null
  open: boolean
  onClose: () => void
}) {
  const [score, setScore] = createSignal<ScoreData | null>(null)
  const [trace, setTrace] = createSignal<TraceData | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal<string | null>(null)

  // DAG / jobs
  const [jobs, setJobs] = createSignal<Job[] | null>(null)
  const [jobsLoaded, setJobsLoaded] = createSignal(false)
  const [cancelling, setCancelling] = createSignal<string | null>(null)

  let drawerRef: HTMLDivElement | undefined

  // Focus trap + Escape
  createEffect(() => {
    if (!props.open) return
    queueMicrotask(() => drawerRef?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
      }
      // Tab trap
      if (e.key === 'Tab' && drawerRef) {
        const focusable = drawerRef.querySelectorAll<HTMLElement>(
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
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    onCleanup(() => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    })
  })

  // Fetch jobs while open
  createEffect(() => {
    const id = props.sessionID
    if (!props.open || !id) {
      setJobs(null)
      setJobsLoaded(false)
      return
    }
    let stopped = false
    let timer: number | undefined
    const fetchJobs = async () => {
      try {
        const list = await rpc.listJobs(id)
        if (stopped) return
        setJobs(list)
        setJobsLoaded(true)
        if (!list.some((j) => j.status === 'running') && timer !== undefined) {
          clearInterval(timer)
          timer = undefined
        }
      } catch {
        if (!stopped) setJobsLoaded(true)
      }
    }
    void fetchJobs()
    timer = window.setInterval(fetchJobs, 3000)
    onCleanup(() => {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
    })
  })

  const runningJobs = () => (jobs() ?? []).filter((j) => j.status === 'running')

  function taskIDOf(job: Job): string {
    const m = /\[.*::\s*([^\]]+)\]/.exec(job.prompt ?? '')
    return m?.[1]?.trim() || job.id.slice(0, 8)
  }

  function previewOf(job: Job): string {
    const text =
      job.status === 'completed'
        ? (job.result ?? '')
        : job.status === 'failed'
          ? (job.error ?? '')
          : job.prompt
    return (text ?? '').slice(0, 120)
  }

  function dagDot(status: Job['status']): string {
    if (status === 'running') return '#fbbf24'
    if (status === 'completed') return '#34d399'
    if (status === 'failed') return '#f87171'
    return '#6b7280'
  }

  async function cancelOne(jobID: string) {
    setCancelling(jobID)
    try {
      const updated = await rpc.cancelJob(jobID)
      setJobs((js) => (js ?? []).map((j) => (j.id === jobID ? updated : j)))
    } catch {
      // ignore
    } finally {
      setCancelling(null)
    }
  }

  async function cancelAll() {
    const running = runningJobs()
    if (running.length === 0) return
    setCancelling('all')
    try {
      await Promise.all(running.map((j) => rpc.cancelJob(j.id).catch(() => null)))
      const id = props.sessionID
      if (id) {
        const list = await rpc.listJobs(id).catch(() => null)
        if (list) setJobs(list)
      }
    } finally {
      setCancelling(null)
    }
  }

  // Fetch score + trace
  createEffect(() => {
    const id = props.sessionID
    const isOpen = props.open
    if (!isOpen || !id) {
      setScore(null)
      setTrace(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    Promise.all([
      rpc.getScore(id).catch((e) => {
        throw new Error(`score: ${String((e as Error).message)}`)
      }),
      rpc.getTrace(id).catch(() => null),
    ])
      .then(([s, t]) => {
        setScore(s as ScoreData)
        if (t) setTrace(t as TraceData)
      })
      .catch((e) => setError(String((e as Error).message)))
      .finally(() => setLoading(false))
  })

  function copy(text: string, label: string) {
    try {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(label)
          setTimeout(() => setCopied(null), 1500)
        })
        .catch(() => {})
    } catch {}
  }

  return (
    <Show when={props.open}>
      {/* scrim */}
      <div
        onClick={props.onClose}
        style={{
          position: 'fixed',
          inset: '0',
          background: 'rgba(0,0,0,0.55)',
          'z-index': '50',
        }}
        aria-hidden="true"
      />
      {/* drawer */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-label="Trace viewer"
        aria-modal="true"
        tabindex="-1"
        style={{
          position: 'fixed',
          top: '0',
          right: '0',
          bottom: '0',
          width: 'min(560px, 92vw)',
          background: '#0f1117',
          'border-left': '1px solid rgba(255,255,255,0.12)',
          'box-shadow': '-8px 0 32px rgba(0,0,0,0.45)',
          'z-index': '51',
          display: 'flex',
          'flex-direction': 'column',
          overflow: 'hidden',
          color: '#e5e7eb',
          outline: 'none',
        }}
      >
        {/* header */}
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            padding: '12px 16px',
            'border-bottom': '1px solid rgba(255,255,255,0.08)',
            'flex-shrink': '0',
          }}
        >
          <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
            <span style={{ 'font-weight': '700', 'font-size': '14px' }}>Trace</span>
            <Show when={props.sessionID}>
              <span
                style={{
                  'font-family': 'ui-monospace, monospace',
                  'font-size': '10px',
                  color: '#6b7280',
                  'max-width': '14ch',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                }}
              >
                {props.sessionID}
              </span>
            </Show>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close trace viewer"
            style={{
              padding: '4px 8px',
              border: '1px solid rgba(255,255,255,0.12)',
              'border-radius': '6px',
              background: 'rgba(255,255,255,0.06)',
              color: '#9ca3af',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        {/* body */}
        <div
          style={{
            flex: '1',
            overflow: 'auto',
            padding: '16px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '16px',
          }}
        >
          <Show when={loading()}>
            <div style={{ color: '#9ca3af', 'font-size': '12px' }}>Loading trace…</div>
          </Show>
          <Show when={error()}>
            <div
              role="alert"
              style={{
                color: '#fecaca',
                'font-size': '12px',
                padding: '8px',
                border: '1px solid rgba(248,113,113,0.35)',
                'border-radius': '6px',
                background: 'rgba(248,113,113,0.10)',
              }}
            >
              {error()}
            </div>
          </Show>

          <Show when={score()}>
            {(s) => (
              <>
                {/* score hero */}
                <div
                  style={{
                    display: 'flex',
                    gap: '12px',
                    'align-items': 'center',
                    padding: '12px',
                    border: '1px solid rgba(255,255,255,0.08)',
                    'border-radius': '10px',
                    background: 'rgba(255,255,255,0.03)',
                  }}
                >
                  <div
                    style={{
                      width: '56px',
                      height: '56px',
                      'border-radius': '50%',
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'center',
                      'font-weight': '800',
                      'font-size': '18px',
                      color: 'white',
                      background: scoreColor(s().score),
                      'flex-shrink': '0',
                    }}
                  >
                    {s().score}
                  </div>
                  <div style={{ flex: '1', 'min-width': '0' }}>
                    <div style={{ 'font-weight': '700', 'font-size': '12px' }}>
                      Mira Score — {s().score}/100
                    </div>
                    <div
                      style={{
                        'font-size': '11px',
                        color: '#9ca3af',
                        'line-height': '1.5',
                      }}
                    >
                      {s().success ? '✓ success' : '✗ failed'} · {s().toolCalls} tool calls ·{' '}
                      {s().toolErrors} errors · {s().doomLoops} doom loops · {s().memoryHits} memory
                      hits
                    </div>
                    <div style={{ 'font-size': '11px', color: '#6b7280' }}>
                      ${Number(s().costUSD ?? s().cost ?? 0).toFixed(4)} · {s().model} ·{' '}
                      {s().durationMs}ms · {s().steps} steps
                    </div>
                  </div>
                </div>

                {/* meta grid */}
                <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '8px' }}>
                  <div
                    style={{
                      padding: '8px 10px',
                      border: '1px solid rgba(255,255,255,0.08)',
                      'border-radius': '8px',
                      background: 'rgba(255,255,255,0.03)',
                    }}
                  >
                    <div
                      style={{
                        'font-size': '10px',
                        color: '#6b7280',
                        'text-transform': 'uppercase',
                        'letter-spacing': '0.04em',
                      }}
                    >
                      Cost
                    </div>
                    <div
                      style={{
                        'font-family': 'ui-monospace, monospace',
                        'font-size': '12px',
                        'font-weight': '600',
                      }}
                    >
                      ${Number(s().costUSD ?? s().cost ?? 0).toFixed(4)}
                    </div>
                    <div style={{ 'font-size': '10px', color: '#9ca3af' }}>
                      {s().totalTokensIn} in / {s().totalTokensOut} out
                    </div>
                  </div>
                  <div
                    style={{
                      padding: '8px 10px',
                      border: '1px solid rgba(255,255,255,0.08)',
                      'border-radius': '8px',
                      background: 'rgba(255,255,255,0.03)',
                    }}
                  >
                    <div
                      style={{
                        'font-size': '10px',
                        color: '#6b7280',
                        'text-transform': 'uppercase',
                        'letter-spacing': '0.04em',
                      }}
                    >
                      Latency
                    </div>
                    <div
                      style={{
                        'font-family': 'ui-monospace, monospace',
                        'font-size': '12px',
                        'font-weight': '600',
                      }}
                    >
                      {s().durationMs}ms
                    </div>
                    <div style={{ 'font-size': '10px', color: '#9ca3af' }}>{s().model}</div>
                  </div>
                  <div
                    style={{
                      padding: '8px 10px',
                      border: '1px solid rgba(255,255,255,0.08)',
                      'border-radius': '8px',
                      background: 'rgba(255,255,255,0.03)',
                    }}
                  >
                    <div
                      style={{
                        'font-size': '10px',
                        color: '#6b7280',
                        'text-transform': 'uppercase',
                        'letter-spacing': '0.04em',
                      }}
                    >
                      Tool calls
                    </div>
                    <div
                      style={{
                        'font-family': 'ui-monospace, monospace',
                        'font-size': '12px',
                        'font-weight': '600',
                      }}
                    >
                      {s().toolCalls}{' '}
                      <span
                        style={{
                          color: s().toolErrors ? '#fca5a5' : '#9ca3af',
                          'font-weight': '400',
                        }}
                      >
                        ({s().toolErrors} errors)
                      </span>
                    </div>
                    <div style={{ 'font-size': '10px', color: '#9ca3af' }}>
                      {s().doomLoops} doom loops
                    </div>
                  </div>
                  <div
                    style={{
                      padding: '8px 10px',
                      border: '1px solid rgba(255,255,255,0.08)',
                      'border-radius': '8px',
                      background: 'rgba(255,255,255,0.03)',
                    }}
                  >
                    <div
                      style={{
                        'font-size': '10px',
                        color: '#6b7280',
                        'text-transform': 'uppercase',
                        'letter-spacing': '0.04em',
                      }}
                    >
                      Memory
                    </div>
                    <div
                      style={{
                        'font-family': 'ui-monospace, monospace',
                        'font-size': '12px',
                        'font-weight': '600',
                      }}
                    >
                      {s().memoryHits} hits
                    </div>
                    <div style={{ 'font-size': '10px', color: '#9ca3af' }}>knowledge graph</div>
                  </div>
                </div>

                {/* IDs */}
                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '6px',
                    padding: '10px',
                    border: '1px solid rgba(255,255,255,0.08)',
                    'border-radius': '8px',
                    background: 'rgba(255,255,255,0.03)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      'font-size': '11px',
                    }}
                  >
                    <span style={{ color: '#6b7280', 'min-width': '72px' }}>Trace ID</span>
                    <code
                      style={{
                        flex: '1',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                        'white-space': 'nowrap',
                        'font-size': '10px',
                        background: 'rgba(0,0,0,0.25)',
                        padding: '2px 6px',
                        'border-radius': '4px',
                        border: '1px solid rgba(255,255,255,0.08)',
                      }}
                    >
                      {s().traceId}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(s().traceId, 'traceId')}
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
                      {copied() === 'traceId' ? '✓' : 'copy'}
                    </button>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      'font-size': '11px',
                    }}
                  >
                    <span style={{ color: '#6b7280', 'min-width': '72px' }}>Span ID</span>
                    <code
                      style={{
                        flex: '1',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                        'white-space': 'nowrap',
                        'font-size': '10px',
                        background: 'rgba(0,0,0,0.25)',
                        padding: '2px 6px',
                        'border-radius': '4px',
                        border: '1px solid rgba(255,255,255,0.08)',
                      }}
                    >
                      {s().spanId}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(s().spanId, 'spanId')}
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
                      {copied() === 'spanId' ? '✓' : 'copy'}
                    </button>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      'font-size': '11px',
                    }}
                  >
                    <span style={{ color: '#6b7280', 'min-width': '72px' }}>Request ID</span>
                    <code
                      style={{
                        flex: '1',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                        'white-space': 'nowrap',
                        'font-size': '10px',
                        background: 'rgba(0,0,0,0.25)',
                        padding: '2px 6px',
                        'border-radius': '4px',
                        border: '1px solid rgba(255,255,255,0.08)',
                      }}
                    >
                      {s().requestId || '—'}
                    </code>
                    <Show when={s().requestId}>
                      <button
                        type="button"
                        onClick={() => copy(s().requestId, 'requestId')}
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
                        {copied() === 'requestId' ? '✓' : 'copy'}
                      </button>
                    </Show>
                  </div>
                </div>

                {/* badge */}
                <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    'align-items': 'center',
                    'flex-wrap': 'wrap',
                  }}
                >
                  <span style={{ 'font-size': '11px', color: '#9ca3af' }}>PR badge:</span>
                  <img
                    src={rpc.getScoreBadgeUrl(s().sessionID)}
                    alt={`Mira Score ${s().score}/100`}
                    style={{ height: '20px', 'border-radius': '3px' }}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      copy(`![Mira Score](${rpc.getScoreBadgeUrl(s().sessionID)})`, 'badge')
                    }
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
                    {copied() === 'badge' ? '✓ copied' : 'copy markdown'}
                  </button>
                </div>
              </>
            )}
          </Show>

          {/* spans timeline */}
          <Show when={trace()}>
            {(t) => (
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                <div style={{ 'font-weight': '600', 'font-size': '12px' }}>
                  Spans · {t().spans.length}{' '}
                  <span
                    style={{
                      color: '#6b7280',
                      'font-weight': '400',
                      'font-size': '11px',
                    }}
                  >
                    (OTel + tool timeline)
                  </span>
                </div>
                <Show when={t().spans.length === 0}>
                  <div
                    style={{
                      color: '#9ca3af',
                      'font-size': '11px',
                      padding: '8px',
                      border: '1px dashed rgba(255,255,255,0.12)',
                      'border-radius': '6px',
                    }}
                  >
                    No spans yet — run a prompt to generate a trace.
                  </div>
                </Show>
                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '6px',
                    'max-height': '220px',
                    overflow: 'auto',
                    padding: '2px',
                  }}
                >
                  <For each={t().spans.slice(0, 50)}>
                    {(sp) => (
                      <div
                        style={{
                          display: 'flex',
                          gap: '8px',
                          'align-items': 'center',
                          padding: '6px 8px',
                          border: '1px solid rgba(255,255,255,0.08)',
                          'border-radius': '6px',
                          background:
                            sp.status === 'error'
                              ? 'rgba(248,113,113,0.08)'
                              : 'rgba(255,255,255,0.03)',
                          'font-size': '11px',
                        }}
                      >
                        <span
                          style={{
                            width: '8px',
                            height: '8px',
                            'border-radius': '50%',
                            background: sp.status === 'error' ? '#f87171' : '#34d399',
                            'flex-shrink': '0',
                          }}
                        />
                        <span
                          style={{
                            'font-family': 'ui-monospace, monospace',
                            'font-weight': '600',
                            'min-width': '0',
                            flex: '1',
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                            'white-space': 'nowrap',
                          }}
                        >
                          {sp.name}
                        </span>
                        <span
                          style={{
                            color: '#9ca3af',
                            'font-family': 'ui-monospace, monospace',
                            'font-size': '10px',
                          }}
                        >
                          {sp.durationMs ?? (sp.endMs && sp.startMs ? sp.endMs - sp.startMs : 0)}ms
                        </span>
                        <span
                          style={{
                            color: sp.status === 'error' ? '#fca5a5' : '#6b7280',
                            'font-size': '10px',
                          }}
                        >
                          {sp.status}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>

          {/* DAG / wave timeline */}
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'space-between',
                gap: '8px',
              }}
            >
              <div style={{ 'font-weight': '600', 'font-size': '12px' }}>
                DAG runs · {(jobs() ?? []).length}{' '}
                <span
                  style={{
                    color: '#6b7280',
                    'font-weight': '400',
                    'font-size': '11px',
                  }}
                >
                  (waves + nodes)
                </span>
              </div>
              <Show when={runningJobs().length > 0}>
                <button
                  type="button"
                  onClick={() => void cancelAll()}
                  disabled={cancelling() === 'all'}
                  aria-label={`Cancel all running DAG nodes (${runningJobs().length} running)`}
                  style={{
                    padding: '4px 10px',
                    'font-size': '11px',
                    border: '1px solid rgba(248,113,113,0.25)',
                    'border-radius': '999px',
                    background: 'rgba(248,113,113,0.10)',
                    color: '#fca5a5',
                    cursor: cancelling() === 'all' ? 'not-allowed' : 'pointer',
                  }}
                >
                  {cancelling() === 'all' ? 'Cancelling…' : `Cancel all (${runningJobs().length})`}
                </button>
              </Show>
            </div>
            <Show when={jobsLoaded() && (jobs() ?? []).length === 0}>
              <div
                style={{
                  color: '#9ca3af',
                  'font-size': '11px',
                  padding: '8px',
                  border: '1px dashed rgba(255,255,255,0.12)',
                  'border-radius': '6px',
                }}
              >
                No DAG runs yet.
              </div>
            </Show>
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '6px',
                'max-height': '220px',
                overflow: 'auto',
                padding: '2px',
              }}
              role="list"
              aria-label="DAG nodes"
            >
              <For each={jobs() ?? []}>
                {(job) => (
                  <div
                    role="listitem"
                    style={{
                      display: 'flex',
                      gap: '8px',
                      'align-items': 'center',
                      padding: '6px 8px',
                      border: '1px solid rgba(255,255,255,0.08)',
                      'border-radius': '6px',
                      background:
                        job.status === 'failed'
                          ? 'rgba(248,113,113,0.08)'
                          : 'rgba(255,255,255,0.03)',
                      'font-size': '11px',
                    }}
                  >
                    <span
                      style={{
                        width: '8px',
                        height: '8px',
                        'border-radius': '50%',
                        background: dagDot(job.status),
                        'flex-shrink': '0',
                      }}
                      aria-hidden="true"
                    />
                    <span style={{ 'min-width': '0', flex: '1', overflow: 'hidden' }}>
                      <span
                        style={{
                          display: 'flex',
                          gap: '6px',
                          'align-items': 'center',
                          'min-width': '0',
                        }}
                      >
                        <span
                          style={{
                            'font-family': 'ui-monospace, monospace',
                            'font-weight': '600',
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                            'white-space': 'nowrap',
                          }}
                        >
                          {taskIDOf(job)}
                        </span>
                        <span
                          style={{
                            color: '#6b7280',
                            'font-size': '10px',
                            'flex-shrink': '0',
                          }}
                        >
                          {job.agent ?? 'general'}
                        </span>
                        <span
                          style={{
                            padding: '1px 6px',
                            'border-radius': '999px',
                            'font-size': '10px',
                            'font-weight': '600',
                            background:
                              job.status === 'running'
                                ? 'rgba(251,191,36,0.15)'
                                : job.status === 'completed'
                                  ? 'rgba(52,211,153,0.15)'
                                  : job.status === 'failed'
                                    ? 'rgba(248,113,113,0.15)'
                                    : 'rgba(255,255,255,0.06)',
                            color:
                              job.status === 'running'
                                ? '#fbbf24'
                                : job.status === 'completed'
                                  ? '#6ee7b7'
                                  : job.status === 'failed'
                                    ? '#fca5a5'
                                    : '#9ca3af',
                            border: `1px solid ${job.status === 'running' ? 'rgba(251,191,36,0.25)' : job.status === 'completed' ? 'rgba(52,211,153,0.25)' : 'rgba(255,255,255,0.08)'}`,
                            'flex-shrink': '0',
                          }}
                        >
                          {job.status}
                        </span>
                      </span>
                      <span
                        style={{
                          display: 'block',
                          color: '#9ca3af',
                          overflow: 'hidden',
                          'text-overflow': 'ellipsis',
                          'white-space': 'nowrap',
                          'font-size': '10px',
                          'margin-top': '2px',
                        }}
                      >
                        {previewOf(job)}
                      </span>
                    </span>
                    <Show when={job.status === 'running'}>
                      <button
                        type="button"
                        onClick={() => void cancelOne(job.id)}
                        disabled={cancelling() === job.id}
                        aria-label={`Cancel DAG node ${taskIDOf(job)}`}
                        style={{
                          padding: '4px 8px',
                          'font-size': '11px',
                          border: '1px solid rgba(248,113,113,0.25)',
                          'border-radius': '999px',
                          background: 'rgba(248,113,113,0.10)',
                          color: '#fca5a5',
                          cursor: cancelling() === job.id ? 'not-allowed' : 'pointer',
                          'flex-shrink': '0',
                        }}
                      >
                        {cancelling() === job.id ? '…' : '✕ cancel'}
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>

          {/* tool metrics table */}
          <Show
            when={
              (score()?.toolMetrics?.length ?? 0) > 0 || (trace()?.toolMetrics?.length ?? 0) > 0
            }
          >
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
              <div style={{ 'font-weight': '600', 'font-size': '12px' }}>Tool calls</div>
              <div
                style={{
                  overflow: 'auto',
                  border: '1px solid rgba(255,255,255,0.08)',
                  'border-radius': '6px',
                }}
              >
                <table
                  style={{
                    width: '100%',
                    'border-collapse': 'collapse',
                    'font-size': '11px',
                  }}
                >
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.03)', 'text-align': 'left' }}>
                      <th
                        style={{
                          padding: '6px 8px',
                          'border-bottom': '1px solid rgba(255,255,255,0.08)',
                          color: '#6b7280',
                          'font-weight': '600',
                        }}
                      >
                        Tool
                      </th>
                      <th
                        style={{
                          padding: '6px 8px',
                          'border-bottom': '1px solid rgba(255,255,255,0.08)',
                          color: '#6b7280',
                          'font-weight': '600',
                        }}
                      >
                        Latency
                      </th>
                      <th
                        style={{
                          padding: '6px 8px',
                          'border-bottom': '1px solid rgba(255,255,255,0.08)',
                          color: '#6b7280',
                          'font-weight': '600',
                        }}
                      >
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={(score()?.toolMetrics ?? trace()?.toolMetrics ?? []).slice(0, 20)}>
                      {(m) => (
                        <tr style={{ 'border-bottom': '1px solid rgba(255,255,255,0.06)' }}>
                          <td
                            style={{ padding: '6px 8px', 'font-family': 'ui-monospace, monospace' }}
                          >
                            {m.tool}
                          </td>
                          <td
                            style={{ padding: '6px 8px', 'font-family': 'ui-monospace, monospace' }}
                          >
                            {m.durationMs}ms
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            <span
                              style={{
                                padding: '1px 6px',
                                'border-radius': '999px',
                                'font-size': '10px',
                                'font-weight': '600',
                                background: m.isError
                                  ? 'rgba(248,113,113,0.15)'
                                  : 'rgba(52,211,153,0.15)',
                                color: m.isError ? '#fca5a5' : '#6ee7b7',
                                border: `1px solid ${m.isError ? 'rgba(248,113,113,0.25)' : 'rgba(52,211,153,0.25)'}`,
                              }}
                            >
                              {m.isError ? `error${m.errorKind ? `: ${m.errorKind}` : ''}` : 'ok'}
                            </span>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>
          </Show>

          <Show when={!loading() && !score() && !error()}>
            <div
              style={{
                color: '#9ca3af',
                'font-size': '12px',
                padding: '12px',
                border: '1px dashed rgba(255,255,255,0.12)',
                'border-radius': '6px',
                'text-align': 'center',
              }}
            >
              No trace for this session yet. Send a prompt to generate a score.
            </div>
          </Show>
        </div>

        {/* footer */}
        <div
          style={{
            padding: '10px 16px',
            'border-top': '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            gap: '8px',
            'justify-content': 'flex-end',
            'flex-shrink': '0',
          }}
        >
          <button
            type="button"
            onClick={props.onClose}
            style={{
              padding: '6px 12px',
              border: '1px solid rgba(255,255,255,0.12)',
              'border-radius': '6px',
              background: 'rgba(255,255,255,0.06)',
              color: '#e5e7eb',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </Show>
  )
}
