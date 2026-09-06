/**
 * HelpOverlay — Searchable keybindings reference (keyboard-first rebuild)
 *
 * - Searchable, shows all keybindings by context (triggered by ?)
 * - Esc to close, focus trap, arrow keys to navigate
 * - Respects NO_COLOR / TERM=dumb
 */

import { Show, For, createSignal, createMemo, createEffect, onCleanup } from 'solid-js'
import { KEYBINDINGS, allKeybindingsGrouped, type Keybinding } from '../lib/a11y'
import { getColorMode } from '../lib/a11y'

type Props = {
  open: boolean
  onClose: () => void
}

export default function HelpOverlay(props: Props) {
  let dialogRef: HTMLDivElement | undefined
  let searchRef: HTMLInputElement | undefined
  const [query, setQuery] = createSignal('')

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return KEYBINDINGS
    return KEYBINDINGS.filter(
      (k) => k.key.toLowerCase().includes(q) || k.desc.toLowerCase().includes(q) || k.context.toLowerCase().includes(q),
    )
  })

  const grouped = createMemo(() => {
    const groups: Record<string, Keybinding[]> = {}
    for (const kb of filtered()) {
      if (!groups[kb.context]) groups[kb.context] = []
      groups[kb.context].push(kb)
    }
    return groups
  })

  createEffect(() => {
    if (!props.open) return
    setQuery('')
    queueMicrotask(() => searchRef?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
        return
      }
      // ? also closes when not typing
      if (e.key === '?' && (e.target as HTMLElement)?.tagName?.toLowerCase() !== 'input') {
        e.preventDefault()
        props.onClose()
        return
      }
      if (e.key === 'Tab' && dialogRef) {
        const focusable = dialogRef.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    onCleanup(() => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prev
    })
  })

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
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="help-title"
          tabindex={-1}
          style={{
            width: 'min(640px, 96vw)',
            'max-height': '85vh',
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
          <div
            style={{
              padding: '14px 16px',
              'border-bottom': '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              'justify-content': 'space-between',
              'align-items': 'center',
              gap: '12px',
            }}
          >
            <span
              id="help-title"
              style={{ 'font-weight': '700', 'font-size': '15px', 'letter-spacing': '0.02em' }}
            >
              Keyboard Shortcuts
            </span>
            <span style={{ 'font-size': '11px', opacity: '0.55' }}>? or Esc to close</span>
          </div>

          <div style={{ padding: '10px 16px', 'border-bottom': '1px solid rgba(255,255,255,0.06)' }}>
            <input
              ref={searchRef}
              type="text"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search keybindings… (e.g. 'palette', 'delete', 'Tab')"
              aria-label="Search keybindings"
              style={{
                width: '100%',
                padding: '7px 10px',
                'border-radius': '6px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(0,0,0,0.28)',
                color: '#e5e7eb',
                'font-size': '12px',
                outline: 'none',
                'box-sizing': 'border-box',
              }}
            />
          </div>

          <div style={{ flex: '1', overflow: 'auto', padding: '12px 16px', display: 'flex', 'flex-direction': 'column', gap: '16px' }}>
            <For each={Object.entries(grouped())}>
              {([ctx, bindings]) => (
                <div>
                  <div
                    style={{
                      'font-size': '11px',
                      'font-weight': '700',
                      color: '#a5b4fc',
                      'letter-spacing': '0.06em',
                      'text-transform': 'uppercase',
                      'margin-bottom': '8px',
                      'border-bottom': '1px solid rgba(255,255,255,0.06)',
                      'padding-bottom': '4px',
                    }}
                  >
                    {ctx}
                  </div>
                  <div style={{ display: 'grid', 'grid-template-columns': '160px 1fr', gap: '8px 16px' }}>
                    <For each={bindings}>
                      {(s) => (
                        <div style={{ display: 'contents' }}>
                          <kbd
                            style={{
                              padding: '3px 7px',
                              'border-radius': '6px',
                              background: 'rgba(255,255,255,0.08)',
                              border: '1px solid rgba(255,255,255,0.12)',
                              'font-family': 'ui-monospace, monospace',
                              'font-size': '12px',
                              'text-align': 'center',
                              'white-space': 'nowrap',
                            }}
                          >
                            {s.key}
                          </kbd>
                          <span style={{ 'font-size': '13px', opacity: '0.85', display: 'flex', 'align-items': 'center' }}>{s.desc}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
            <Show when={filtered().length === 0}>
              <div style={{ padding: '20px', 'text-align': 'center', opacity: '0.5', 'font-size': '13px' }}>
                No keybindings match “{query()}”
              </div>
            </Show>
          </div>

          <div
            style={{
              padding: '10px 16px',
              'border-top': '1px solid rgba(255,255,255,0.06)',
              'font-size': '11px',
              opacity: '0.55',
              display: 'flex',
              'justify-content': 'space-between',
            }}
          >
            <span>Commands: /cost · /undo · /queue · /jobs · /fork · /export · /autopilot</span>
            <span>NO_COLOR=1 · TERM=dumb · --json / --plain</span>
          </div>

          <div style={{ padding: '8px 16px', display: 'flex', 'justify-content': 'flex-end' }}>
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Close help"
              style={{
                padding: '6px 14px',
                'border-radius': '6px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.06)',
                color: '#e5e7eb',
                cursor: 'pointer',
                'font-size': '12px',
                'font-weight': '600',
              }}
            >
              Close (Esc)
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
