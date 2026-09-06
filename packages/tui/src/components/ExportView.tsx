/**
 * ExportView — TUI session export for Mira
 *
 * Exports session as markdown/json, copies to clipboard, downloads file.
 * Uses rpc.exportSession(sessionId, format) — same endpoint as web.
 */

import { Show, createSignal, createEffect, onCleanup } from 'solid-js'
import { rpc } from '../rpc/client'

type Props = {
  open: boolean
  onClose: () => void
  sessionId: string | null
}

type Format = 'md' | 'json'

export default function ExportView(props: Props) {
  const [format, setFormat] = createSignal<Format>('md')
  const [content, setContent] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal(false)
  const [downloaded, setDownloaded] = createSignal(false)

  const fetchExport = async () => {
    const sid = props.sessionId
    if (!sid) {
      setContent(null)
      return
    }
    setLoading(true)
    setError(null)
    setCopied(false)
    setDownloaded(false)
    try {
      const text = await rpc.exportSession(sid, format())
      setContent(text)
    } catch (e) {
      setError((e as Error).message ?? String(e))
      setContent(null)
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    // track format() so switching format refetches
    const f = format()
    if (props.open && props.sessionId) {
      void fetchExport()
    } else if (!props.open) {
      setContent(null)
      setError(null)
      setCopied(false)
      setDownloaded(false)
    }
  })

  const handleCopy = async () => {
    const text = content()
    if (!text) return
    setError(null)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        // fallback for environments without clipboard API
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        if (!ok) throw new Error('copy failed — clipboard unavailable')
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      setError(`Copy failed: ${(e as Error).message ?? String(e)}`)
    }
  }

  const handleDownload = () => {
    const text = content()
    const sid = props.sessionId
    if (!text || !sid) return
    setError(null)
    try {
      const ext = format() === 'json' ? 'json' : 'md'
      const mime =
        format() === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8'
      const blob = new Blob([text], { type: mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `mira-${sid.slice(0, 8)}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setDownloaded(true)
      setTimeout(() => setDownloaded(false), 2000)
    } catch (e) {
      setError(`Download failed: ${(e as Error).message ?? String(e)}`)
    }
  }

  let dialogRef: HTMLDivElement | undefined
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
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

  createEffect(() => {
    if (props.open) {
      window.addEventListener('keydown', onKeyDown)
      queueMicrotask(() => {
        const el = dialogRef?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        el?.focus()
      })
    } else window.removeEventListener('keydown', onKeyDown)
  })
  onCleanup(() => window.removeEventListener('keydown', onKeyDown))

  const preview = () => {
    const c = content()
    if (!c) return ''
    return c.length > 4000 ? c.slice(0, 4000) + '\n\n… (truncated preview, download for full)' : c
  }

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
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Export"
          tabindex="-1"
          style={{
            width: 'min(720px, 94vw)',
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
                Export
              </span>
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

          {/* Controls */}
          <div
            style={{
              display: 'flex',
              gap: '8px',
              'align-items': 'center',
              padding: '10px 12px',
              'border-bottom': '1px solid rgba(255,255,255,0.06)',
              'flex-wrap': 'wrap',
              'flex-shrink': '0',
            }}
          >
            <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
              <span
                style={{
                  'font-size': '11px',
                  opacity: '0.6',
                  'font-weight': '600',
                  'letter-spacing': '0.04em',
                }}
              >
                FORMAT
              </span>
              <button
                onClick={() => setFormat('md')}
                style={{
                  padding: '5px 10px',
                  'border-radius': '6px',
                  border:
                    format() === 'md'
                      ? '1px solid rgba(99,102,241,0.5)'
                      : '1px solid rgba(255,255,255,0.12)',
                  background:
                    format() === 'md' ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.04)',
                  color: format() === 'md' ? '#a5b4fc' : '#9ca3af',
                  cursor: 'pointer',
                  'font-size': '12px',
                  'font-weight': format() === 'md' ? '700' : '500',
                }}
              >
                Markdown
              </button>
              <button
                onClick={() => setFormat('json')}
                style={{
                  padding: '5px 10px',
                  'border-radius': '6px',
                  border:
                    format() === 'json'
                      ? '1px solid rgba(99,102,241,0.5)'
                      : '1px solid rgba(255,255,255,0.12)',
                  background:
                    format() === 'json' ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.04)',
                  color: format() === 'json' ? '#a5b4fc' : '#9ca3af',
                  cursor: 'pointer',
                  'font-size': '12px',
                  'font-weight': format() === 'json' ? '700' : '500',
                }}
              >
                JSON
              </button>
            </div>
            <div style={{ flex: '1' }} />
            <button
              onClick={() => void fetchExport()}
              disabled={loading() || !props.sessionId}
              style={{
                padding: '5px 10px',
                'border-radius': '6px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.06)',
                color: '#e5e7eb',
                cursor: loading() || !props.sessionId ? 'not-allowed' : 'pointer',
                'font-size': '12px',
                opacity: loading() || !props.sessionId ? '0.5' : '1',
              }}
            >
              ↻ Refresh
            </button>
            <button
              onClick={() => void handleCopy()}
              disabled={!content() || loading()}
              title="Copy to clipboard"
              style={{
                padding: '6px 12px',
                'border-radius': '6px',
                border: '1px solid rgba(99,102,241,0.35)',
                background: copied() ? 'rgba(52,211,153,0.18)' : 'rgba(99,102,241,0.15)',
                color: copied() ? '#6ee7b7' : '#a5b4fc',
                cursor: !content() || loading() ? 'not-allowed' : 'pointer',
                'font-size': '12px',
                'font-weight': '600',
                opacity: !content() || loading() ? '0.5' : '1',
              }}
            >
              {copied() ? '✓ Copied' : '⎘ Copy'}
            </button>
            <button
              onClick={handleDownload}
              disabled={!content() || loading()}
              title="Download file"
              style={{
                padding: '6px 12px',
                'border-radius': '6px',
                border: '1px solid rgba(99,102,241,0.5)',
                background: downloaded() ? 'rgba(52,211,153,0.18)' : 'rgba(99,102,241,0.85)',
                color: downloaded() ? '#6ee7b7' : 'white',
                cursor: !content() || loading() ? 'not-allowed' : 'pointer',
                'font-size': '12px',
                'font-weight': '700',
                opacity: !content() || loading() ? '0.5' : '1',
              }}
            >
              {downloaded() ? '✓ Saved' : '⤓ Download'}
            </button>
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
          <div style={{ flex: '1', overflow: 'auto', padding: '12px' }}>
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
                No session selected — create or pick a session to export.
              </div>
            </Show>

            <Show when={props.sessionId && loading()}>
              <div
                style={{
                  padding: '20px',
                  'text-align': 'center',
                  color: '#9ca3af',
                  'font-size': '13px',
                }}
              >
                Loading export…
              </div>
            </Show>

            <Show when={props.sessionId && !loading() && content()}>
              <div
                style={{
                  display: 'flex',
                  'justify-content': 'space-between',
                  'align-items': 'center',
                  'margin-bottom': '8px',
                }}
              >
                <span
                  style={{
                    'font-size': '11px',
                    opacity: '0.5',
                    'font-family': 'ui-monospace, monospace',
                  }}
                >
                  {content()?.length ?? 0} chars · {format() === 'json' ? 'JSON' : 'Markdown'}{' '}
                  preview
                </span>
                <span style={{ 'font-size': '11px', opacity: '0.4' }}>Esc to close</span>
              </div>
              <pre
                style={{
                  margin: '0',
                  padding: '10px 12px',
                  'border-radius': '8px',
                  background: 'rgba(0,0,0,0.32)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  'font-size': '11px',
                  'line-height': '1.5',
                  overflow: 'auto',
                  'max-height': '50vh',
                  'white-space': 'pre-wrap',
                  'word-break': 'break-word',
                  color: '#e5e7eb',
                }}
              >
                {preview()}
              </pre>
            </Show>

            <Show when={props.sessionId && !loading() && !content() && !error()}>
              <div
                style={{
                  padding: '20px',
                  'text-align': 'center',
                  color: '#9ca3af',
                  'font-size': '13px',
                  border: '1px dashed rgba(255,255,255,0.12)',
                  'border-radius': '8px',
                }}
              >
                No content yet — the session may have no messages to export.
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
            <span>
              Copy puts transcript on clipboard · Download saves mira-&lt;id&gt;.{format()}
            </span>
            <span>Esc to close</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
