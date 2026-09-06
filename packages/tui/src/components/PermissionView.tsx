/**
 * PermissionView — HITL permission prompt (keyboard-first rebuild)
 *
 * Focus trap, Tab navigation, Enter to approve, Esc to deny.
 * Respects NO_COLOR / TERM=dumb via lib/a11y.
 */

import { Show, createMemo, onMount, onCleanup, createEffect } from 'solid-js'
import type { PendingPermission } from '../stores/session'
import { getColorMode } from '../lib/a11y'

type Props = {
  request: PendingPermission | null
  onAllow: () => void
  onDeny: () => void
}

function prettyArgs(args: unknown): string {
  if (!args) return '{}'
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

function isDestructive(tool: string, args: unknown): boolean {
  if (tool !== 'bash') return false
  const cmd = (args as { command?: string })?.command ?? ''
  return /rm\s+-rf|sudo|DROP|DELETE\s+FROM|TRUNCATE|git\s+reset\s+--hard|curl.*\|\s*bash/i.test(cmd)
}

export default function PermissionView(props: Props) {
  const req = () => props.request
  const destructive = createMemo(() => (req() ? isDestructive(req()!.tool, req()!.args) : false))
  const colorMode = getColorMode()
  let dialogRef: HTMLDivElement | undefined
  let allowRef: HTMLButtonElement | undefined

  // Focus trap + keyboard
  createEffect(() => {
    if (!req()) return
    queueMicrotask(() => allowRef?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (!req()) return
      if (e.key === 'Tab' && dialogRef) {
        const focusable = dialogRef.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        if (focusable.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        // Enter on focused button already triggers click; only handle when not on button
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
        if (tag !== 'button') {
          e.preventDefault()
          props.onAllow()
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onDeny()
        return
      }
      if (e.key === '1' || e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        props.onAllow()
        return
      }
      if (e.key === '2' || e.key === 'd' || e.key === 'D') {
        e.preventDefault()
        props.onDeny()
        return
      }
    }
    document.addEventListener('keydown', onKey, true)
    onCleanup(() => document.removeEventListener('keydown', onKey, true))
  })

  return (
    <Show when={req()}>
      {(r) => (
        <div
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="perm-title"
          aria-describedby="perm-args"
          tabindex={-1}
          style={{
            position: 'relative',
            display: 'flex',
            'flex-direction': 'column',
            gap: '10px',
            padding: '14px',
            'border-radius': '12px',
            background: destructive() ? 'rgba(239,68,68,0.10)' : 'rgba(251,191,36,0.08)',
            border: destructive()
              ? '1px solid rgba(239,68,68,0.30)'
              : '1px solid rgba(251,191,36,0.25)',
            'box-shadow': '0 8px 24px rgba(0,0,0,0.35)',
          }}
        >
          <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
            <span
              style={{
                width: '28px',
                height: '28px',
                display: 'inline-flex',
                'align-items': 'center',
                'justify-content': 'center',
                'border-radius': '8px',
                background: destructive() ? 'rgba(239,68,68,0.18)' : 'rgba(251,191,36,0.18)',
                'font-size': '16px',
              }}
              aria-hidden="true"
            >
              {destructive() ? '⚠' : '◐'}
            </span>
            <div style={{ display: 'flex', 'flex-direction': 'column' }}>
              <span
                id="perm-title"
                style={{ 'font-weight': '700', 'font-size': '13px', 'letter-spacing': '0.02em' }}
              >
                {destructive() ? 'Destructive action requires approval' : 'Permission required'}
              </span>
              <span style={{ 'font-size': '11px', opacity: '0.6' }}>
                Tool <b style={{ opacity: '1' }}>{r().tool}</b> wants to run — allow or deny?
              </span>
            </div>
          </div>

          <Show when={destructive()}>
            <div
              role="alert"
              style={{
                padding: '8px 10px',
                'border-radius': '8px',
                background: 'rgba(239,68,68,0.12)',
                border: '1px solid rgba(239,68,68,0.20)',
                'font-size': '11px',
                'font-weight': '600',
                'letter-spacing': '0.02em',
              }}
            >
              This command looks destructive (BashArity level 2). Review carefully before allowing.
            </div>
          </Show>

          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <span
              style={{
                'font-size': '10px',
                opacity: '0.5',
                'letter-spacing': '0.05em',
                'font-weight': '700',
              }}
            >
              ARGS
            </span>
            <pre
              id="perm-args"
              style={{
                margin: '0',
                padding: '8px 10px',
                'border-radius': '8px',
                background: 'rgba(0,0,0,0.32)',
                'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
                'font-size': '11px',
                overflow: 'auto',
                'max-height': '160px',
                'white-space': 'pre-wrap',
                'word-break': 'break-word',
              }}
            >
              {prettyArgs(r().args)}
            </pre>
          </div>

          <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
            <button
              type="button"
              onClick={props.onDeny}
              aria-label="Deny permission (Esc or 2)"
              style={{
                padding: '7px 14px',
                'border-radius': '8px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.06)',
                color: '#e5e7eb',
                cursor: 'pointer',
                'font-weight': '600',
                'font-size': '12px',
              }}
            >
              <u>D</u>eny <span style={{ opacity: '0.5' }}>(Esc / 2)</span>
            </button>
            <button
              ref={allowRef}
              type="button"
              onClick={props.onAllow}
              autofocus
              aria-label="Allow permission (Enter or 1)"
              style={{
                padding: '7px 16px',
                'border-radius': '8px',
                border: destructive()
                  ? '1px solid rgba(239,68,68,0.5)'
                  : '1px solid rgba(99,102,241,0.5)',
                background: destructive() ? 'rgba(239,68,68,0.18)' : 'rgba(99,102,241,0.85)',
                color: 'white',
                cursor: 'pointer',
                'font-weight': '700',
                'font-size': '12px',
              }}
            >
              <u>A</u>llow{destructive() ? ' anyway' : ''} <span style={{ opacity: '0.7' }}>(Enter / 1)</span>
            </button>
          </div>

          <span style={{ 'font-size': '10px', opacity: '0.45' }}>
            Tab to switch · Enter to allow · Esc to deny · 1/2 quick pick
          </span>
        </div>
      )}
    </Show>
  )
}
