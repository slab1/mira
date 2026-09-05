import { createSignal, createEffect, Show, For } from 'solid-js'
import type { AppStore } from '../stores/app'
import { api } from '../api/client'

export function QueueRail(props: { store: AppStore }) {
  const sessionId = () => props.store.state.currentId
  const [items, setItems] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const load = async () => {
    const id = sessionId()
    if (!id) {
      setItems([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const q = await api.getQueue(id)
      setItems(q ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    load()
  })

  const move = async (idx: number, dir: number) => {
    const id = sessionId()
    if (!id) return
    const arr = [...items()]
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= arr.length) return
    ;[arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]]
    setItems(arr)
    try {
      await api.reorderQueue(id, arr)
    } catch (e) {
      setError((e as Error).message)
      load()
    }
  }

  const cancel = async (idx: number) => {
    const id = sessionId()
    if (!id) return
    const arr = items().filter((_, i) => i !== idx)
    setItems(arr)
    try {
      await api.deleteQueueItem(id, idx)
    } catch (e) {
      setError((e as Error).message)
      load()
    }
  }

  const preview = (text: string) => {
    const t = text.trim()
    if (t.length <= 80) return t
    return t.slice(0, 77) + '…'
  }

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          'margin-bottom': '2px',
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
          Queue
        </span>
        <Show when={sessionId()}>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => load()}
            title="Refresh queue"
            style={{
              padding: '2px 7px',
              'font-size': 'var(--fs-xs)',
              border: '1px solid var(--border)',
              'border-radius': 'var(--r-full)',
            }}
          >
            ↻
          </button>
        </Show>
      </div>

      <Show when={error()}>
        <div
          class="alert"
          style={{
            padding: '9px 11px',
            'border-radius': 'var(--r-md)',
            background: 'var(--danger-soft)',
            border: '1px solid var(--danger-border)',
            color: 'var(--danger)',
            'font-size': 'var(--fs-xs)',
          }}
        >
          {error()}
        </div>
      </Show>

      <Show when={!sessionId()}>
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
          Select a session to view its queue.
        </div>
      </Show>

      <Show when={sessionId() && !loading() && items().length === 0}>
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
          Queue is empty — messages typed while streaming will appear here.
        </div>
      </Show>

      <Show when={loading()}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <For each={[0, 1, 2]}>
            {() => (
              <div class="skeleton" style={{ height: '48px', 'border-radius': 'var(--r-md)' }} />
            )}
          </For>
        </div>
      </Show>

      <Show when={!loading() && items().length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <For each={items()}>
            {(text, i) => (
              <div
                class="card"
                style={{
                  padding: '9px 11px',
                  display: 'flex',
                  gap: '9px',
                  'align-items': 'flex-start',
                }}
              >
                <div
                  style={{
                    'font-family': 'var(--font-mono)',
                    'font-size': 'var(--fs-2xs)',
                    color: 'var(--fg-faint)',
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
                      'font-size': 'var(--fs-sm)',
                      color: 'var(--fg)',
                      'line-height': '1.45',
                      'word-break': 'break-word',
                    }}
                  >
                    {preview(text)}
                  </div>
                </div>
                <div
                  style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', flex: 'none' }}
                >
                  <button
                    type="button"
                    class="btn btn-ghost"
                    onClick={() => move(i(), -1)}
                    disabled={i() === 0}
                    title="Move up"
                    style={{
                      padding: '2px 6px',
                      'font-size': 'var(--fs-xs)',
                      border: '1px solid var(--border)',
                      'border-radius': 'var(--r-full)',
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost"
                    onClick={() => move(i(), 1)}
                    disabled={i() === items().length - 1}
                    title="Move down"
                    style={{
                      padding: '2px 6px',
                      'font-size': 'var(--fs-xs)',
                      border: '1px solid var(--border)',
                      'border-radius': 'var(--r-full)',
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost"
                    onClick={() => cancel(i())}
                    title="Cancel item"
                    style={{
                      padding: '2px 6px',
                      'font-size': 'var(--fs-xs)',
                      border: '1px solid var(--border)',
                      'border-radius': 'var(--r-full)',
                      color: 'var(--danger)',
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
  )
}
