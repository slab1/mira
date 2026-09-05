import { Show } from 'solid-js'
import { useFocusTrap } from '../hooks/useFocusTrap'

export interface ConfirmDialogProps {
  open: () => boolean
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
  useFocusTrap(props.open, () => dialogRef, props.onCancel)

  return (
    <Show when={props.open()}>
      <div
        class="modal-backdrop"
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onCancel()
        }}
      >
        <div
          ref={dialogRef}
          class="modal modal-sm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          aria-describedby="confirm-dialog-message"
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ padding: '16px 18px' }}>
            <div
              id="confirm-dialog-title"
              class="modal-title"
              tabindex="-1"
              style={{ 'margin-bottom': '6px' }}
            >
              {props.title}
            </div>
            <div
              id="confirm-dialog-message"
              style={{
                'font-size': 'var(--fs-sm)',
                color: 'var(--fg-muted)',
                'line-height': '1.5',
                'margin-bottom': '14px',
              }}
            >
              {props.message}
            </div>
            <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
              <button
                type="button"
                class="btn btn-ghost"
                onClick={props.onCancel}
                style={{ padding: '7px 14px', 'font-size': 'var(--fs-sm)' }}
              >
                {props.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                class={props.danger ? 'btn btn-danger' : 'btn btn-solid'}
                onClick={props.onConfirm}
                style={{ padding: '7px 14px', 'font-size': 'var(--fs-sm)' }}
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
