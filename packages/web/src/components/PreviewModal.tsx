/**
 * PreviewModal — "Show, Then Believe" pattern.
 *
 * Shows a preview of an action before the user commits to it.
 * Based on Microsoft Copilot research: previewing artifacts before the
 * "Apply" click increases acceptance by +28%.
 *
 * Features:
 *   - Overlay modal with backdrop
 *   - Title, description, affected resources
 *   - Confirm / Cancel buttons
 *   - Optional "Don't show again" checkbox
 *   - Keyboard: Escape to cancel, Enter to confirm
 *   - Focus trap within modal
 *   - ARIA: role="dialog", aria-modal="true", aria-labelledby
 */

import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'

export interface PreviewResource {
  name: string
  type: string
}

export function PreviewModal(props: {
  open: boolean
  title: string
  description: string
  resources?: PreviewResource[]
  confirmLabel?: string
  cancelLabel?: string
  showDontShowAgain?: boolean
  onConfirm: () => void
  onCancel: () => void
  onDontShowAgain?: (checked: boolean) => void
}) {
  const [dontShowAgain, setDontShowAgain] = createSignal(false)
  let dialogRef: HTMLDivElement | undefined
  let confirmBtnRef: HTMLButtonElement | undefined

  onMount(() => {
    if (props.open) {
      // Focus the confirm button when modal opens
      queueMicrotask(() => confirmBtnRef?.focus())
    }
  })

  function onBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      props.onCancel()
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onCancel()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // Enter confirms (unless focus is on a button/link)
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag !== 'button' && tag !== 'a' && tag !== 'input' && tag !== 'textarea') {
        e.preventDefault()
        props.onConfirm()
      }
    } else if (e.key === 'Tab') {
      // Focus trap: cycle between confirm and cancel buttons
      const focusables = dialogRef?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (!focusables || focusables.length === 0) return
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
  }

  onCleanup(() => {
    // No-op for now; future: restore focus to trigger element
  })

  return (
    <Show when={props.open}>
      <div
        class="modal-backdrop"
        role="presentation"
        onClick={onBackdropClick}
        onKeyDown={onKeyDown}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.55)',
          'backdrop-filter': 'blur(4px)',
          display: 'grid',
          'place-items': 'center',
          'z-index': 200,
          padding: 'var(--sp-4)',
          animation: 'fade-up var(--dur-med) var(--ease) both',
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="preview-modal-title"
          style={{
            width: 'min(480px, 100%)',
            'max-height': 'min(80vh, 600px)',
            background: 'var(--bg-canvas)',
            border: '1px solid var(--border-strong)',
            'border-radius': 'var(--r-lg)',
            'box-shadow': 'var(--shadow-pop)',
            display: 'flex',
            'flex-direction': 'column',
            overflow: 'hidden',
            animation: 'fade-up var(--dur-med) var(--ease) both',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              gap: 'var(--sp-3)',
              padding: 'var(--sp-4) var(--sp-5)',
              'border-bottom': '1px solid var(--border)',
              'flex-shrink': '0',
            }}
          >
            <div
              id="preview-modal-title"
              style={{
                'font-size': 'var(--fs-lg)',
                'font-weight': '700',
                'letter-spacing': '-0.02em',
                color: 'var(--fg)',
              }}
            >
              {props.title}
            </div>
            <button
              type="button"
              onClick={props.onCancel}
              aria-label="Close preview"
              style={{
                width: '28px',
                height: '28px',
                display: 'grid',
                'place-items': 'center',
                border: '1px solid var(--border)',
                background: 'var(--bg-surface)',
                color: 'var(--fg-muted)',
                'border-radius': 'var(--r-sm)',
                cursor: 'pointer',
                'font-size': '14px',
                'line-height': '1',
                transition:
                  'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
              }}
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div
            style={{
              flex: '1',
              overflow: 'auto',
              padding: 'var(--sp-4) var(--sp-5)',
              display: 'flex',
              'flex-direction': 'column',
              gap: 'var(--sp-3)',
            }}
          >
            <div
              style={{
                'font-size': 'var(--fs-sm)',
                color: 'var(--fg-muted)',
                'line-height': '1.55',
              }}
            >
              {props.description}
            </div>

            <Show when={props.resources && props.resources.length > 0}>
              <div
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-md)',
                  padding: 'var(--sp-3)',
                }}
              >
                <div
                  style={{
                    'font-size': 'var(--fs-xs)',
                    'font-weight': '700',
                    'text-transform': 'uppercase',
                    'letter-spacing': '0.04em',
                    color: 'var(--fg-muted)',
                    'margin-bottom': 'var(--sp-2)',
                  }}
                >
                  Affected Resources
                </div>
                <For each={props.resources}>
                  {(r) => (
                    <div
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: 'var(--sp-2)',
                        padding: '4px 0',
                        'font-size': 'var(--fs-sm)',
                      }}
                    >
                      <span
                        style={{
                          color: 'var(--fg-faint)',
                          'font-family': 'var(--font-mono)',
                          'font-size': 'var(--fs-xs)',
                        }}
                      >
                        {r.type}
                      </span>
                      <span
                        style={{
                          color: 'var(--fg)',
                          'font-family': 'var(--font-mono)',
                          'font-size': 'var(--fs-sm)',
                        }}
                      >
                        {r.name}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              gap: 'var(--sp-3)',
              padding: 'var(--sp-3) var(--sp-5)',
              'border-top': '1px solid var(--border)',
              'flex-shrink': '0',
            }}
          >
            <Show when={props.showDontShowAgain}>
              <label
                style={{
                  display: 'inline-flex',
                  'align-items': 'center',
                  gap: '6px',
                  'font-size': 'var(--fs-xs)',
                  color: 'var(--fg-muted)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={dontShowAgain()}
                  onChange={(e) => {
                    setDontShowAgain(e.currentTarget.checked)
                    props.onDontShowAgain?.(e.currentTarget.checked)
                  }}
                  aria-label="Don't show again"
                  style={{ 'accent-color': 'var(--accent)' }}
                />
                Don't show again
              </label>
            </Show>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', 'margin-left': 'auto' }}>
              <button
                type="button"
                onClick={props.onCancel}
                style={{
                  padding: '7px 14px',
                  'border-radius': 'var(--r-md)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-surface)',
                  color: 'var(--fg)',
                  'font-size': 'var(--fs-sm)',
                  'font-weight': '600',
                  cursor: 'pointer',
                  transition: 'background var(--dur-fast) var(--ease)',
                }}
              >
                {props.cancelLabel ?? 'Cancel'}
              </button>
              <button
                ref={confirmBtnRef}
                type="button"
                onClick={props.onConfirm}
                style={{
                  padding: '7px 14px',
                  'border-radius': 'var(--r-md)',
                  border: '1px solid var(--accent)',
                  background: 'var(--accent)',
                  color: 'var(--on-accent)',
                  'font-size': 'var(--fs-sm)',
                  'font-weight': '600',
                  cursor: 'pointer',
                  transition: 'background var(--dur-fast) var(--ease)',
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
