/**
 * ConfirmDialog — TUI modal, ported from web/src/components/ConfirmDialog.tsx
 * Focus trap + Escape handling, dark TUI styling.
 */

import { Show, createEffect, onCleanup } from 'solid-js'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  let dialogRef: HTMLDivElement | undefined

  createEffect(() => {
    if (!props.open) return
    queueMicrotask(() => {
      const root = dialogRef
      if (!root) return
      const focusables = root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      const first = focusables[0]
      if (first) first.focus()
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const root = dialogRef
      if (!root) return
      const focusables = root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    onCleanup(() => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
    })
  })

  return (
    <Show when={props.open}>
      <div
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onCancel()
        }}
        style={{
          position: 'fixed',
          inset: '0',
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          'z-index': '1000',
        }}
      >
        <div
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          aria-describedby="confirm-dialog-message"
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 'min(420px, 92vw)',
            'border-radius': '12px',
            background: '#0f1117',
            border: '1px solid rgba(255,255,255,0.12)',
            'box-shadow': '0 16px 48px rgba(0,0,0,0.55)',
            overflow: 'hidden',
            color: '#e5e7eb',
          }}
        >
          <div style={{ padding: '16px 18px' }}>
            <div
              id="confirm-dialog-title"
              tabindex="-1"
              style={{
                'font-weight': '700',
                'font-size': '14px',
                'margin-bottom': '6px',
                color: '#e5e7eb',
              }}
            >
              {props.title}
            </div>
            <div
              id="confirm-dialog-message"
              style={{
                'font-size': '12px',
                color: '#9ca3af',
                'line-height': '1.5',
                'margin-bottom': '14px',
              }}
            >
              {props.message}
            </div>
            <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
              <button
                type="button"
                onClick={props.onCancel}
                style={{
                  padding: '7px 14px',
                  'font-size': '12px',
                  'border-radius': '6px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#e5e7eb',
                  cursor: 'pointer',
                }}
              >
                {props.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                onClick={props.onConfirm}
                style={{
                  padding: '7px 14px',
                  'font-size': '12px',
                  'border-radius': '6px',
                  border: props.danger
                    ? '1px solid rgba(239,68,68,0.35)'
                    : '1px solid rgba(99,102,241,0.5)',
                  background: props.danger ? 'rgba(239,68,68,0.85)' : 'rgba(99,102,241,0.9)',
                  color: 'white',
                  cursor: 'pointer',
                  'font-weight': '600',
                }}
              >
                {props.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default ConfirmDialog
