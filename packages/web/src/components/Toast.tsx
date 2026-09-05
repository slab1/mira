import { createSignal, For, Show, onCleanup } from 'solid-js'

export type ToastKind = 'info' | 'success' | 'warn' | 'error'
export interface Toast {
  id: string
  kind: ToastKind
  message: string
  ttl?: number
  action?: { label: string; onClick: () => void }
}

const [toasts, setToasts] = createSignal<Toast[]>([])

function logToast(kind: ToastKind, message: string): void {
  const entry = `[mira:toast] ${kind.toUpperCase()} ${message}`
  if (kind === 'error') console.error(entry)
  else if (kind === 'warn') console.warn(entry)
  else console.log(entry)
}

export function toast(message: string, kind: ToastKind = 'info', ttl = 4000): string {
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const t: Toast = { id, kind, message, ttl }
  setToasts((prev) => [...prev, t])
  logToast(kind, message)
  if (ttl > 0) setTimeout(() => dismiss(id), ttl)
  return id
}

toast.success = (m: string, ttl?: number) => toast(m, 'success', ttl)
toast.warn = (m: string, ttl?: number) => toast(m, 'warn', ttl)
toast.error = (m: string, ttl?: number) => toast(m, 'error', ttl ?? 6000)
toast.info = (m: string, ttl?: number) => toast(m, 'info', ttl)

toast.withAction = (
  message: string,
  actionLabel: string,
  onClick: () => void,
  kind: ToastKind = 'info',
  ttl = 8000,
): string => {
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const t: Toast = { id, kind, message, ttl, action: { label: actionLabel, onClick } }
  setToasts((prev) => [...prev, t])
  logToast(kind, message)
  if (ttl > 0) setTimeout(() => dismiss(id), ttl)
  return id
}

export function dismiss(id: string): void {
  setToasts((prev) => prev.filter((t) => t.id !== id))
}

export function ToastViewport() {
  onCleanup(() => {
    setToasts([])
  })
  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      aria-atomic="false"
      style={{
        position: 'fixed',
        bottom: '16px',
        right: '16px',
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
        'z-index': '9999',
        'max-width': '360px',
        'pointer-events': 'none',
      }}
    >
      <For each={toasts()}>
        {(t) => (
          <div
            role={t.kind === 'error' ? 'alert' : 'status'}
            data-kind={t.kind}
            class={`toast toast-${t.kind}`}
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              padding: '10px 14px',
              'border-radius': 'var(--r-md)',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-strong)',
              'box-shadow': '0 8px 24px rgba(0,0,0,0.4)',
              'font-size': 'var(--fs-sm)',
              color: 'var(--fg)',
              'pointer-events': 'auto',
              animation: 'slide-in 200ms ease-out',
            }}
          >
            <span aria-hidden="true" style={{ 'flex-shrink': '0', 'font-size': '14px' }}>
              {t.kind === 'success'
                ? '✓'
                : t.kind === 'warn'
                  ? '⚠'
                  : t.kind === 'error'
                    ? '✗'
                    : 'ℹ'}
            </span>
            <span style={{ flex: '1', 'word-break': 'break-word' }}>{t.message}</span>
            <Show when={t.action}>
              <button
                type="button"
                class="btn btn-ghost"
                onClick={() => {
                  t.action?.onClick()
                  dismiss(t.id)
                }}
                style={{
                  padding: '3px 10px',
                  'font-size': 'var(--fs-xs)',
                  'font-weight': '600',
                  color: 'var(--accent)',
                  flex: 'none',
                }}
              >
                {t.action!.label}
              </button>
            </Show>
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              style={{
                padding: '2px 6px',
                'font-size': 'var(--fs-xs)',
                color: 'var(--fg-faint)',
                flex: 'none',
              }}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
