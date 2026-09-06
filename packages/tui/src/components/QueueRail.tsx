/**
 * QueueRail — TUI port of web/src/components/QueueRail.tsx
 *
 * Full rail with getQueue + reorderQueue + deleteQueueItem + ↑/↓/✕ per row.
 * Rendered as a modal overlay (triggered via /queue command) with TUI dark styling.
 * Also used as inline rail when needed.
 */

import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js'
import { rpc } from '../rpc/client'

type Props = {
  open: boolean
  onClose: () => void
  sessionId: string | null
}

export default function QueueRail(props: Props) {
  const [items, setItems] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const load = async () => {
    const id = props.sessionId
    if (!id) {
      setItems([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const q = await rpc.getQueue(id)
      setItems(q ?? [])
    } catch (e) {
      setError((e as Error).message ?? String(e))
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    if (props.open) void load()
  })

  // Also reload when session changes while open
  createEffect(() => {
    const sid = props.sessionId
    if (props.open && sid) void load()
  })

  const move = async (idx: number, dir: number) => {
    const id = props.sessionId
    if (!id) return
    const arr = [...items()]
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= arr.length) return
    ;[arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]]
    setItems(arr)
    try {
      await rpc.reorderQueue(id, arr)
    } catch (e) {
      setError((e as Error).message ?? String(e))
      void load()
    }
  }

  const cancel = async (idx: number) => {
    const id = props.sessionId
    if (!id) return
    const prompt = items()[idx]
    const arr = items().filter((_, i) => i !== idx)
    setItems(arr)
    try {
      await rpc.deleteQueueItem(id, prompt)
    } catch (e) {
      setError((e as Error).message ?? String(e))
      void load()
    }
  }

  const preview = (text: string) => {
    const t = text.trim()
    if (t.length <= 80) return t
    return t.slice(0, 77) + '…'
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
    }
  }

  createEffect(() => {
    if (props.open) window.addEventListener('keydown', onKeyDown)
    else window.removeEventListener('keydown', onKeyDown)
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
                Queue
              </span>
              <Show when={!loading() && items().length > 0}>
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
                  {items().length}
                </span>
              </Show>
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
            </div>
            <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
              <button
                onClick={() => void load()}
                title="Refresh queue"
                style={{
                  padding: '5px 10px',
                  'border-radius': '6px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#e5e7eb',
                  cursor: 'pointer',
                  'font-size': '12px',
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

          {/* Error */}
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
                No session selected — create or pick a session to view its queue.
              </div>
            </Show>

            <Show when={props.sessionId && !loading() && items().length === 0 && !error()}>
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
                Queue is empty — messages typed while streaming will appear here.
              </div>
            </Show>

            <Show when={loading()}>
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
            </Show>

            <Show when={!loading() && items().length > 0}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                <For each={items()}>
                  {(text, i) => (
                    <div
                      style={{
                        padding: '9px 11px',
                        display: 'flex',
                        gap: '9px',
                        'align-items': 'flex-start',
                        'border-radius': '8px',
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.08)',
                      }}
                    >
                      <div
                        style={{
                          'font-family': 'ui-monospace, monospace',
                          'font-size': '11px',
                          color: '#6b7280',
                          'margin-top': '2px',
                          flex: 'none',
                          width: '22px',
                        }}
                      >
                        {i() + 1}
                      </div>
                      <div style={{ flex: '1', 'min-width': '0' }}>
                        <div
                          style={{
                            'font-size': '13px',
                            color: '#e5e7eb',
                            'line-height': '1.45',
                            'word-break': 'break-word',
                            'white-space': 'pre-wrap',
                          }}
                        >
                          {preview(text)}
                        </div>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          'flex-direction': 'column',
                          gap: '4px',
                          flex: 'none',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => void move(i(), -1)}
                          disabled={i() === 0}
                          title="Move up"
                          style={{
                            padding: '2px 6px',
                            'font-size': '11px',
                            border: '1px solid rgba(255,255,255,0.12)',
                            'border-radius': '999px',
                            background:
                              i() === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)',
                            color: i() === 0 ? '#6b7280' : '#e5e7eb',
                            cursor: i() === 0 ? 'not-allowed' : 'pointer',
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => void move(i(), 1)}
                          disabled={i() === items().length - 1}
                          title="Move down"
                          style={{
                            padding: '2px 6px',
                            'font-size': '11px',
                            border: '1px solid rgba(255,255,255,0.12)',
                            'border-radius': '999px',
                            background:
                              i() === items().length - 1
                                ? 'rgba(255,255,255,0.03)'
                                : 'rgba(255,255,255,0.06)',
                            color: i() === items().length - 1 ? '#6b7280' : '#e5e7eb',
                            cursor: i() === items().length - 1 ? 'not-allowed' : 'pointer',
                          }}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => void cancel(i())}
                          title="Cancel item"
                          style={{
                            padding: '2px 6px',
                            'font-size': '11px',
                            border: '1px solid rgba(239,68,68,0.25)',
                            'border-radius': '999px',
                            background: 'rgba(239,68,68,0.10)',
                            color: '#fca5a5',
                            cursor: 'pointer',
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
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
            <span>↑/↓ reorder · ✕ cancel · queued prompts run after current turn</span>
            <span>Esc to close</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
