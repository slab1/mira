/**
 * HelpOverlay — shortcuts reference for Mira TUI
 */

import { Show, onMount, onCleanup } from 'solid-js'

type Props = {
  open: boolean
  onClose: () => void
}

const shortcuts = [
  { key: 'Enter', desc: 'Send prompt' },
  { key: 'Shift+Enter', desc: 'New line in input' },
  { key: 'Esc', desc: 'Stop streaming / close overlay' },
  { key: '/', desc: 'Open command palette' },
  { key: '?', desc: 'Toggle help' },
  { key: 'Tab', desc: 'Cycle focus sidebar → messages → input' },
  { key: '1-9', desc: 'Quick session pick' },
  { key: 'a / A', desc: 'Allow permission' },
  { key: 'd / D', desc: 'Deny permission' },
  { key: '1 / 2', desc: 'Number pick in PermissionView' },
  { key: '1-9', desc: 'Quick pick in QuestionView / CommandPalette' },
  { key: '↩ undo', desc: 'Undo last mutation (header)' },
]

export default function HelpOverlay(props: Props) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
    }
  }

  onMount(() => {
    if (props.open) window.addEventListener('keydown', onKeyDown)
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
          'align-items': 'center',
          'justify-content': 'center',
          'z-index': '1000',
        }}
        onClick={props.onClose}
      >
        <div
          style={{
            width: 'min(520px, 92vw)',
            'border-radius': '12px',
            background: '#0f1117',
            border: '1px solid rgba(255,255,255,0.12)',
            'box-shadow': '0 16px 48px rgba(0,0,0,0.55)',
            overflow: 'hidden',
            color: '#e5e7eb',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              padding: '14px 16px',
              'border-bottom': '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              'justify-content': 'space-between',
              'align-items': 'center',
            }}
          >
            <span style={{ 'font-weight': '700', 'font-size': '15px', 'letter-spacing': '0.02em' }}>
              Keyboard Shortcuts
            </span>
            <span style={{ 'font-size': '11px', opacity: '0.55' }}>Press ? to close</span>
          </div>

          <div
            style={{
              padding: '12px 16px',
              display: 'grid',
              'grid-template-columns': '140px 1fr',
              gap: '10px 16px',
            }}
          >
            {shortcuts.map((s) => (
              <div style={{ display: 'contents' }}>
                <kbd
                  style={{
                    padding: '3px 7px',
                    'border-radius': '6px',
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    'font-family': 'ui-monospace, monospace',
                    'font-size': '12px',
                  }}
                >
                  {s.key}
                </kbd>
                <span style={{ 'font-size': '13px', opacity: '0.85' }}>{s.desc}</span>
              </div>
            ))}
          </div>

          <div
            style={{
              padding: '10px 16px',
              'border-top': '1px solid rgba(255,255,255,0.06)',
              'font-size': '11px',
              opacity: '0.55',
            }}
          >
            Commands: /cost · /undo · /queue · /jobs · /fork · /export
          </div>
        </div>
      </div>
    </Show>
  )
}
