/**
 * TerminalView — TUI xterm-like PTY via WS /terminal
 * Ported from web/src/components/SettingsPanel.tsx Terminal tab + web/src/api/client.ts createTerminalSocket
 * Uses rpc.createTerminalSocket, dark TUI styling, input + output scroll.
 */

import { createSignal, createEffect, onCleanup, Show } from 'solid-js'
import { createTerminalSocket, type JsonValue } from '../rpc/client'

type Props = {
  open: boolean
  onClose: () => void
}

export default function TerminalView(props: Props) {
  const [output, setOutput] = createSignal<string>('')
  const [input, setInput] = createSignal('')
  const [connected, setConnected] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let outputRef: HTMLDivElement | undefined
  let inputRef: HTMLInputElement | undefined
  let socket: ReturnType<typeof createTerminalSocket> | null = null

  const append = (data: string) => {
    setOutput((prev) => {
      const next = prev + data
      // cap at 100k chars to avoid DOM blowup
      return next.length > 100_000 ? next.slice(next.length - 100_000) : next
    })
    queueMicrotask(() => {
      if (outputRef) outputRef.scrollTop = outputRef.scrollHeight
    })
  }

  const connect = () => {
    if (socket) {
      try {
        socket.disconnect()
      } catch {}
      socket = null
    }
    setError(null)
    setConnected(false)
    socket = createTerminalSocket({
      onConnected: () => {
        setConnected(true)
        append('[terminal connected]\n')
      },
      onOutput: (_stream, data) => append(data),
      onExit: (code) => {
        append(`\n[exit ${code}]\n`)
        setConnected(false)
      },
      onClose: () => {
        setConnected(false)
        append('\n[disconnected]\n')
      },
      onError: () => {
        setError('WebSocket error — is the server running?')
        setConnected(false)
      },
    })
    try {
      socket.connect()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const disconnect = () => {
    try {
      socket?.disconnect()
    } catch {}
    socket = null
    setConnected(false)
  }

  const send = () => {
    const text = input()
    if (!text || !socket) return
    // send with newline if not already
    const data = text.endsWith('\n') ? text : text + '\n'
    try {
      socket.sendInput(data)
      append(`$ ${text}\n`)
    } catch (e) {
      setError((e as Error).message)
    }
    setInput('')
    inputRef?.focus()
  }

  createEffect(() => {
    if (props.open) {
      connect()
      queueMicrotask(() => inputRef?.focus())
    } else {
      disconnect()
      setOutput('')
      setError(null)
    }
  })

  onCleanup(() => disconnect())

  // Focus trap + Escape
  let dialogRef: HTMLDivElement | undefined
  createEffect(() => {
    if (!props.open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
        return
      }
      if (e.key !== 'Tab' || !dialogRef) return
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
    document.addEventListener('keydown', handler, true)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    onCleanup(() => {
      document.removeEventListener('keydown', handler, true)
      document.body.style.overflow = prevOverflow
    })
  })

  return (
    <Show when={props.open}>
      <div
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
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
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Terminal"
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 'min(860px, 96vw)',
            height: 'min(600px, 85vh)',
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
              padding: '12px 14px',
              'border-bottom': '1px solid rgba(255,255,255,0.08)',
              'flex-shrink': '0',
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              <span style={{ 'font-weight': '700', 'font-size': '14px' }}>▣ Terminal</span>
              <span
                style={{
                  padding: '2px 7px',
                  'border-radius': '999px',
                  'font-size': '11px',
                  'font-weight': '600',
                  background: connected() ? 'rgba(52,211,153,0.15)' : 'rgba(239,68,68,0.12)',
                  border: connected()
                    ? '1px solid rgba(52,211,153,0.25)'
                    : '1px solid rgba(239,68,68,0.25)',
                  color: connected() ? '#6ee7b7' : '#fca5a5',
                }}
              >
                {connected() ? '● connected' : '○ offline'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                onClick={() => {
                  setOutput('')
                  connect()
                }}
                title="Reconnect"
                style={{
                  padding: '5px 10px',
                  'border-radius': '6px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#e5e7eb',
                  cursor: 'pointer',
                  'font-size': '11px',
                }}
              >
                ↻ Reconnect
              </button>
              <button
                type="button"
                onClick={() => setOutput('')}
                title="Clear output"
                style={{
                  padding: '5px 10px',
                  'border-radius': '6px',
                  border: '1px solid rgba(255,255,255,0.10)',
                  background: 'transparent',
                  color: '#9ca3af',
                  cursor: 'pointer',
                  'font-size': '11px',
                }}
              >
                Clear
              </button>
              <button
                type="button"
                onClick={props.onClose}
                aria-label="Close terminal"
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
                ✕
              </button>
            </div>
          </div>

          <Show when={error()}>
            <div
              role="alert"
              style={{
                margin: '8px 12px 0 12px',
                padding: '8px 10px',
                'border-radius': '8px',
                background: 'rgba(239,68,68,0.10)',
                border: '1px solid rgba(239,68,68,0.22)',
                color: '#fecaca',
                'font-size': '12px',
              }}
            >
              ⚠ {error()}
            </div>
          </Show>

          <div
            ref={outputRef}
            role="log"
            aria-live="polite"
            aria-label="Terminal output"
            style={{
              flex: '1',
              overflow: 'auto',
              padding: '12px',
              background: 'rgba(0,0,0,0.35)',
              'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
              'font-size': '12px',
              'line-height': '1.5',
              'white-space': 'pre-wrap',
              'word-break': 'break-all',
              color: '#d1d5db',
            }}
          >
            {output() || 'Connecting to /terminal… type a command below and press Enter.'}
          </div>

          <div
            style={{
              display: 'flex',
              gap: '8px',
              padding: '10px 12px',
              'border-top': '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.02)',
              'align-items': 'center',
            }}
          >
            <span
              style={{
                color: '#6ee7b7',
                'font-family': 'ui-monospace, monospace',
                'font-size': '12px',
                'font-weight': '600',
              }}
            >
              $
            </span>
            <input
              ref={inputRef}
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={connected() ? 'Type a command… (Enter to send)' : 'Connecting…'}
              disabled={!connected()}
              aria-label="Terminal input"
              style={{
                flex: '1',
                padding: '7px 10px',
                'border-radius': '6px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(0,0,0,0.28)',
                color: '#e5e7eb',
                outline: 'none',
                'font-family': 'ui-monospace, monospace',
                'font-size': '12px',
              }}
            />
            <button
              type="button"
              onClick={send}
              disabled={!connected() || !input().trim()}
              style={{
                padding: '7px 14px',
                'border-radius': '6px',
                border: '1px solid rgba(99,102,241,0.5)',
                background:
                  !connected() || !input().trim()
                    ? 'rgba(255,255,255,0.06)'
                    : 'rgba(99,102,241,0.9)',
                color: !connected() || !input().trim() ? 'rgba(255,255,255,0.35)' : 'white',
                cursor: !connected() || !input().trim() ? 'not-allowed' : 'pointer',
                'font-size': '12px',
                'font-weight': '600',
              }}
            >
              Send ↵
            </button>
          </div>
          <div
            style={{
              padding: '6px 12px',
              'border-top': '1px solid rgba(255,255,255,0.06)',
              'font-size': '10px',
              opacity: '0.45',
              display: 'flex',
              'justify-content': 'space-between',
            }}
          >
            <span>WS /terminal · sandbox-aware · Enter to send · Esc to close</span>
            <span>{output().length} chars</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
