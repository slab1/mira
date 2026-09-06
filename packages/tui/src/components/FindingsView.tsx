/**
 * FindingsView — TUI Findings tab, ported from web/src/components/ToolView.tsx:718-900
 * Standalone view + Inspector tab already covers it; this is the dedicated component.
 */

import { For, Show, createSignal, createEffect, onCleanup } from 'solid-js'
import { rpc, type Finding } from '../rpc/client'
import { toast } from './Toast'

type Props = {
  open?: boolean
  onClose?: () => void
  embedded?: boolean
}

export function FindingsList() {
  const [findings, setFindings] = createSignal<Finding[]>([])
  const [loading, setLoading] = createSignal(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await rpc.listFindings({ status: 'open', limit: 50 })
      setFindings(data ?? [])
    } catch {
      setFindings([])
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    void load()
  })

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          'margin-bottom': '4px',
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
          Findings · {loading() ? '…' : findings().length} open
        </span>
        <button
          type="button"
          onClick={() => void load()}
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
        when={!loading()}
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
                            await load()
                            toast.success('Finding resolved')
                          } catch (e) {
                            toast.error(`Resolve failed: ${(e as Error).message}`)
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
    </div>
  )
}

export default function FindingsView(props: Props) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose?.()
    }
  }

  createEffect(() => {
    if (props.open) window.addEventListener('keydown', onKeyDown)
    else window.removeEventListener('keydown', onKeyDown)
  })
  onCleanup(() => window.removeEventListener('keydown', onKeyDown))

  if (props.embedded) {
    return <FindingsList />
  }

  return (
    <Show when={props.open}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Findings"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose?.()
        }}
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
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 'min(640px, 94vw)',
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
        >
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
            <span style={{ 'font-weight': '700', 'font-size': '15px' }}>Findings</span>
            <button
              type="button"
              onClick={() => props.onClose?.()}
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
          <div style={{ flex: '1', overflow: 'auto', padding: '12px' }}>
            <FindingsList />
          </div>
        </div>
      </div>
    </Show>
  )
}
