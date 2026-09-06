/**
 * Toast — TUI toast stack, auto-dismiss 3s, Box/Text styling
 * Ported from web/src/components/Toast.tsx — dark TUI styling, same API.
 */

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

export function toast(message: string, kind: ToastKind = 'info', ttl = 3000): string {
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const t: Toast = { id, kind, message, ttl }
  setToasts((prev) => [...prev, t])
  logToast(kind, message)
  if (ttl > 0) setTimeout(() => dismiss(id), ttl)
  return id
}

toast.success = (m: string, ttl?: number) => toast(m, 'success', ttl ?? 3000)
toast.warn = (m: string, ttl?: number) => toast(m, 'warn', ttl ?? 4000)
toast.error = (m: string, ttl?: number) => toast(m, 'error', ttl ?? 6000)
toast.info = (m: string, ttl?: number) => toast(m, 'info', ttl ?? 3000)

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

function kindIcon(kind: ToastKind): string {
  switch (kind) {
    case 'success':
      return '✓'
    case 'warn':
      return '⚠'
    case 'error':
      return '✗'
    default:
      return 'ℹ'
  }
}

function kindStyle(kind: ToastKind): Record<string, string> {
  switch (kind) {
    case 'success':
      return {
        background: 'rgba(52,211,153,0.12)',
        border: '1px solid rgba(52,211,153,0.30)',
        color: '#6ee7b7',
      }
    case 'warn':
      return {
        background: 'rgba(251,191,36,0.12)',
        border: '1px solid rgba(251,191,36,0.30)',
        color: '#fde68a',
      }
    case 'error':
      return {
        background: 'rgba(239,68,68,0.12)',
        border: '1px solid rgba(239,68,68,0.30)',
        color: '#fecaca',
      }
    default:
      return {
        background: 'rgba(99,102,241,0.12)',
        border: '1px solid rgba(99,102,241,0.25)',
        color: '#c4b5fd',
      }
  }
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
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              padding: '10px 14px',
              'border-radius': '8px',
              'box-shadow': '0 8px 24px rgba(0,0,0,0.45)',
              'font-size': '12px',
              'pointer-events': 'auto',
              animation: 'slide-in 200ms ease-out',
              ...kindStyle(t.kind),
            }}
          >
            <span aria-hidden="true" style={{ 'flex-shrink': '0', 'font-size': '14px' }}>
              {kindIcon(t.kind)}
            </span>
            <span style={{ flex: '1', 'word-break': 'break-word' }}>{t.message}</span>
            <Show when={t.action}>
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick()
                  dismiss(t.id)
                }}
                style={{
                  padding: '3px 10px',
                  'font-size': '11px',
                  'font-weight': '600',
                  color: '#a5b4fc',
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  'border-radius': '6px',
                  cursor: 'pointer',
                  flex: 'none',
                }}
              >
                {t.action!.label}
              </button>
            </Show>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              style={{
                padding: '2px 6px',
                'font-size': '11px',
                color: 'rgba(255,255,255,0.5)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
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

export default ToastViewport
