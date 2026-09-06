/**
 * AutopilotView — TUI port of web/src/components/AutopilotPanel.tsx
 *
 * Shows scheduler status, next/last run, eval delta, pending patches with Approve.
 * Dark TUI styling (rgba, no CSS vars) to match TraceView/SettingsView.
 * Exposed via /autopilot command and Settings → Autopilot tab.
 */

import { createSignal, onMount, Show, For } from 'solid-js'
import { rpc, type SchedulerStatus, type EvalDelta, type Patch } from '../rpc/client'

export default function AutopilotView(props: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = createSignal<SchedulerStatus | null>(null)
  const [delta, setDelta] = createSignal<EvalDelta | null>(null)
  const [patches, setPatches] = createSignal<Patch[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [approving, setApproving] = createSignal<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, d, p] = await Promise.all([
        rpc.getLearningSchedulerStatus().catch(() => ({ status: 'idle' }) as SchedulerStatus),
        rpc.getLearningLastEvalDelta().catch(() => ({ delta: 0, sessionID: '' }) as EvalDelta),
        rpc.listPendingPatches().catch(() => [] as Patch[]),
      ])
      setStatus(s as SchedulerStatus)
      setDelta(d as EvalDelta)
      setPatches(p as Patch[])
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load autopilot')
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    if (props.open) void load()
  })

  // reload when opened
  const isOpen = () => props.open
  // trigger load on open
  let prevOpen = false
  const checkOpen = () => {
    const o = isOpen()
    if (o && !prevOpen) void load()
    prevOpen = o
  }
  // use effect via polling open state — simpler: createEffect
  import('solid-js').then(({ createEffect }) => {
    createEffect(() => {
      void props.open
      checkOpen()
    })
  })

  const approve = async (id: string) => {
    setApproving(id)
    try {
      await rpc.approvePatch(id)
      setPatches((ps) => ps.filter((p) => p.id !== id))
    } catch (e) {
      setError((e as Error).message ?? 'Failed to approve patch')
    } finally {
      setApproving(null)
    }
  }

  const fmt = (iso?: string | number | null) => {
    if (iso == null || iso === '') return '—'
    try {
      if (typeof iso === 'number') return new Date(iso).toLocaleString()
      return new Date(iso).toLocaleString()
    } catch {
      return String(iso)
    }
  }

  const statusLabel = () => {
    const s = status()
    if (!s) return 'idle'
    if (typeof s.status === 'string') return s.status
    if (s.started) return s.running && s.running.length ? 'running' : 'idle'
    return 'idle'
  }

  const isRunning = () => statusLabel() === 'running'

  const nextRun = () => {
    const s = status()
    if (!s) return null
    if (s.nextRunAt) return s.nextRunAt
    if (s.lastRun && typeof s.lastRun === 'object') {
      // derive from intervals if available
      const last =
        (s.lastRun as Record<string, number | null>).patching ??
        (s.lastRun as Record<string, number | null>).improvement ??
        null
      const interval = s.intervals?.patchingMs ?? s.intervals?.improvementMs ?? null
      if (last && interval) return new Date(last + interval).toISOString()
    }
    return null
  }

  const lastRun = () => {
    const s = status()
    if (!s) return null
    if (s.lastRunAt) return s.lastRunAt
    if (s.lastRun && typeof s.lastRun === 'object') {
      const vals = Object.values(s.lastRun as Record<string, number | null>).filter(
        (v): v is number => typeof v === 'number' && v > 0,
      )
      if (vals.length) return Math.max(...vals)
    }
    return null
  }

  return (
    <Show when={props.open}>
      <div
        style={{
          position: 'fixed',
          inset: '0',
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          'z-index': '1000',
          padding: '16px',
        }}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="autopilot-title"
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 'min(720px, 96vw)',
            'max-height': '90vh',
            display: 'flex',
            'flex-direction': 'column',
            'border-radius': '12px',
            background: '#0f1117',
            border: '1px solid rgba(255,255,255,0.12)',
            'box-shadow': '0 16px 48px rgba(0,0,0,0.55)',
            overflow: 'hidden',
            color: '#e5e7eb',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              padding: '14px 16px',
              'border-bottom': '1px solid rgba(255,255,255,0.08)',
              'flex-shrink': '0',
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
              <span id="autopilot-title" style={{ 'font-weight': '700', 'font-size': '15px' }}>
                Autopilot
              </span>
              <span
                style={{
                  padding: '2px 8px',
                  'border-radius': '999px',
                  'font-size': '11px',
                  'font-weight': '600',
                  background: isRunning() ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.06)',
                  border: isRunning()
                    ? '1px solid rgba(52,211,153,0.25)'
                    : '1px solid rgba(255,255,255,0.08)',
                  color: isRunning() ? '#6ee7b7' : '#9ca3af',
                }}
              >
                {statusLabel()}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading()}
                title="Refresh autopilot"
                style={{
                  padding: '5px 10px',
                  'border-radius': '6px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#9ca3af',
                  cursor: loading() ? 'not-allowed' : 'pointer',
                  'font-size': '11px',
                }}
              >
                {loading() ? '…' : '↻ Refresh'}
              </button>
              <button
                type="button"
                onClick={props.onClose}
                aria-label="Close autopilot"
                style={{
                  padding: '5px 10px',
                  'border-radius': '6px',
                  border: '1px solid rgba(255,255,255,0.10)',
                  background: 'transparent',
                  color: '#9ca3af',
                  cursor: 'pointer',
                  'font-size': '14px',
                }}
              >
                ×
              </button>
            </div>
          </div>

          {/* Body */}
          <div
            style={{
              flex: '1',
              overflow: 'auto',
              padding: '14px 16px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '12px',
            }}
          >
            <Show when={loading()}>
              <div
                style={{
                  padding: '12px',
                  'border-radius': '8px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  color: '#9ca3af',
                  'font-size': '12px',
                }}
                aria-live="polite"
              >
                Loading autopilot…
              </div>
            </Show>

            <Show when={error()}>
              <div
                role="alert"
                style={{
                  padding: '8px 10px',
                  'border-radius': '8px',
                  background: 'rgba(239,68,68,0.10)',
                  border: '1px solid rgba(239,68,68,0.22)',
                  color: '#fecaca',
                  'font-size': '12px',
                }}
              >
                ⚠ {error()}
              </div>
            </Show>

            <Show when={!loading() && !error()}>
              <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}>
                <div
                  style={{
                    padding: '12px',
                    'border-radius': '8px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '8px',
                  }}
                >
                  <div
                    style={{
                      'font-size': '11px',
                      'font-weight': '700',
                      color: '#9ca3af',
                      'letter-spacing': '0.04em',
                      'text-transform': 'uppercase',
                    }}
                  >
                    Schedule
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '6px',
                      'font-size': '12px',
                    }}
                  >
                    <div
                      style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px' }}
                    >
                      <span style={{ color: '#6b7280' }}>Next run</span>
                      <span
                        style={{
                          color: '#e5e7eb',
                          'font-family': 'ui-monospace, monospace',
                          'font-size': '11px',
                        }}
                      >
                        {fmt(nextRun())}
                      </span>
                    </div>
                    <div
                      style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px' }}
                    >
                      <span style={{ color: '#6b7280' }}>Last run</span>
                      <span
                        style={{
                          color: '#e5e7eb',
                          'font-family': 'ui-monospace, monospace',
                          'font-size': '11px',
                        }}
                      >
                        {fmt(lastRun())}
                      </span>
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    padding: '12px',
                    'border-radius': '8px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '8px',
                  }}
                >
                  <div
                    style={{
                      'font-size': '11px',
                      'font-weight': '700',
                      color: '#9ca3af',
                      'letter-spacing': '0.04em',
                      'text-transform': 'uppercase',
                    }}
                  >
                    Last eval delta
                  </div>
                  <Show
                    when={delta()}
                    fallback={
                      <div style={{ 'font-size': '12px', color: '#6b7280' }}>No eval data yet</div>
                    }
                  >
                    <div>
                      <div
                        style={{
                          'font-size': '18px',
                          'font-weight': '700',
                          color: (delta()?.delta ?? 0) >= 0 ? '#6ee7b7' : '#fca5a5',
                          'font-family': 'ui-monospace, monospace',
                        }}
                      >
                        {(delta()?.delta ?? 0) >= 0 ? '+' : ''}
                        {(delta()?.delta ?? 0).toFixed(2)}
                      </div>
                      <div
                        style={{
                          'font-size': '11px',
                          color: '#6b7280',
                          'font-family': 'ui-monospace, monospace',
                        }}
                      >
                        Session {(delta()?.sessionID ?? '').slice(0, 8) || '—'}
                      </div>
                    </div>
                  </Show>
                </div>
              </div>

              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                <div style={{ 'font-size': '12px', 'font-weight': '700', color: '#e5e7eb' }}>
                  Pending self-improvement patches
                </div>
                <Show when={patches().length === 0}>
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
                    No pending patches
                  </div>
                </Show>
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                  <For each={patches()}>
                    {(p) => (
                      <div
                        style={{
                          padding: '10px 12px',
                          'border-radius': '8px',
                          background: 'rgba(255,255,255,0.03)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          display: 'flex',
                          gap: '10px',
                          'align-items': 'flex-start',
                          'justify-content': 'space-between',
                        }}
                      >
                        <div
                          style={{
                            flex: '1',
                            'min-width': '0',
                            display: 'flex',
                            'flex-direction': 'column',
                            gap: '4px',
                          }}
                        >
                          <span
                            style={{
                              display: 'inline-flex',
                              padding: '1px 6px',
                              'border-radius': '999px',
                              background: 'rgba(99,102,241,0.15)',
                              border: '1px solid rgba(99,102,241,0.25)',
                              color: '#a5b4fc',
                              'font-size': '10px',
                              'font-weight': '600',
                              'font-family': 'ui-monospace, monospace',
                              'align-self': 'flex-start',
                            }}
                          >
                            {p.painPointId}
                          </span>
                          <div
                            style={{
                              'font-size': '11px',
                              color: '#9ca3af',
                              'line-height': '1.4',
                              'word-break': 'break-word',
                            }}
                          >
                            {p.reason}
                          </div>
                          <pre
                            style={{
                              margin: '0',
                              padding: '6px 8px',
                              'border-radius': '6px',
                              background: 'rgba(0,0,0,0.28)',
                              border: '1px solid rgba(255,255,255,0.06)',
                              'font-size': '10px',
                              'font-family': 'ui-monospace, monospace',
                              'white-space': 'pre-wrap',
                              'word-break': 'break-word',
                              color: '#d1d5db',
                              'max-height': '80px',
                              overflow: 'auto',
                            }}
                          >
                            {p.change.slice(0, 300)}
                          </pre>
                        </div>
                        <button
                          type="button"
                          disabled={approving() === p.id}
                          onClick={() => void approve(p.id)}
                          style={{
                            padding: '6px 12px',
                            'border-radius': '6px',
                            border: '1px solid rgba(99,102,241,0.5)',
                            background:
                              approving() === p.id
                                ? 'rgba(255,255,255,0.06)'
                                : 'rgba(99,102,241,0.85)',
                            color: approving() === p.id ? 'rgba(255,255,255,0.5)' : 'white',
                            cursor: approving() === p.id ? 'not-allowed' : 'pointer',
                            'font-size': '11px',
                            'font-weight': '600',
                            'flex-shrink': '0',
                          }}
                        >
                          {approving() === p.id ? 'Approving…' : 'Approve'}
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>

          {/* Footer */}
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
                'font-size': '12px',
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
