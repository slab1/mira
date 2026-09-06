/**
 * ToolCallView — Collapsible tool-call / tool-result with keyboard nav (2026 rebuild)
 *
 * - Collapsible sections: tool name + status icon + elapsed, expand to show inputs/outputs
 * - Keyboard: Enter/Space to toggle, arrow keys to navigate between tool calls
 * - Status colors: running (amber), done (ok), error (danger) — respect NO_COLOR
 * - Diff view for edit/write/patch tools (red/green)
 * - Copy button for outputs
 */

import { Show, createMemo, createSignal, createEffect, onMount, onCleanup } from 'solid-js'
import type { Part } from '../rpc/client'
import { rpc } from '../rpc/client'
import { getColorMode } from '../lib/a11y'
import { font, text } from '../lib/tokens'

type Props = {
  part: Part
  expanded?: boolean
  latencyMs?: number
  toolMetrics?: Array<{ tool: string; durationMs: number; isError: boolean }>
  focused?: boolean
  onFocusNext?: () => void
  onFocusPrev?: () => void
}

function pretty(obj: unknown): string {
  if (obj === undefined || obj === null) return ''
  if (typeof obj === 'string') return obj
  try {
    return JSON.stringify(obj, null, 2)
  } catch {
    return String(obj)
  }
}

function truncate(s: string, n = 1200): string {
  if (s.length <= n) return s
  return s.slice(0, n) + ` … (+${s.length - n} chars)`
}

const TOOL_ICON: Record<string, string> = {
  bash: '⌁',
  read: '▤',
  write: '✎',
  edit: '✎',
  patch: '⬢',
  glob: '◎',
  grep: '⌕',
  lsp: '◈',
  task: '⬡',
  todowrite: '☑',
  question: '？',
  websearch: '⌕',
  webfetch: '⬇',
  memory_search: '◐',
  memory_write: '◑',
  skill: '⬔',
}

export default function ToolCallView(props: Props) {
  const part = () => props.part
  const isCall = createMemo(
    () => part().type === 'tool-call' || (part().type as string) === 'tool_call',
  )
  const isError = createMemo(() => Boolean(part().isError))
  const icon = createMemo(() => TOOL_ICON[part().tool ?? ''] ?? '▸')
  const title = createMemo(() => part().tool ?? 'tool')
  const colorMode = getColorMode()
  const isNoColor = colorMode !== 'full'

  const [open, setOpen] = createSignal(props.expanded ?? false)
  createEffect(() => {
    if (props.expanded !== undefined) setOpen(props.expanded)
  })

  const [copied, setCopied] = createSignal(false)
  let containerRef: HTMLDivElement | undefined

  const rawArgs = createMemo(() => {
    const p = part() as unknown as Record<string, unknown>
    return (p.args ?? p.input ?? null) as Record<string, unknown> | null
  })

  const argsText = createMemo(() => {
    const a = rawArgs()
    if (!a) return ''
    return truncate(pretty(a))
  })

  const resultText = createMemo(() => {
    const p = part() as unknown as Record<string, unknown>
    const r = p.result ?? p.output
    if (r === undefined) return ''
    return truncate(pretty(r))
  })

  const isDiffTool = createMemo(() => {
    const t = part().tool ?? ''
    return isCall() && ['edit', 'write', 'patch'].includes(t)
  })

  const diffPreview = createMemo(() => {
    const inp = rawArgs() as Record<string, string> | null
    if (!inp) return ''
    const tool = part().tool ?? ''
    if (tool === 'edit' && inp.path) {
      const oldS = String((inp as Record<string, unknown>).oldString ?? '').slice(0, 240)
      const newS = String((inp as Record<string, unknown>).newString ?? '').slice(0, 240)
      const oldShort = oldS.length > 40 ? oldS.slice(0, 40) + '…' : oldS
      const newShort = newS.length > 40 ? newS.slice(0, 40) + '…' : newS
      return `${String(inp.path)}: ${oldShort} → ${newShort}`
    }
    if (tool === 'write' && inp.path)
      return `${String(inp.path)} (${String((inp as Record<string, unknown>).content ?? '').length} chars)`
    if (tool === 'patch' && (inp as Record<string, unknown>).patch)
      return `patch ${String((inp as Record<string, unknown>).patch).split('\n').length} lines`
    return ''
  })

  const latency = createMemo(() => {
    if (typeof props.latencyMs === 'number') return props.latencyMs
    const metrics = props.toolMetrics
    if (metrics && metrics.length) {
      const m = metrics.find((x) => x.tool === part().tool)
      if (m) return m.durationMs
      const filtered = metrics.filter((x) => x.tool === part().tool)
      if (filtered.length) return filtered[filtered.length - 1].durationMs
    }
    return null
  })

  // Guardrails on expand
  const [audit, setAudit] = createSignal<{
    decision: 'allow' | 'deny' | 'warn'
    reason?: string
  } | null>(null)
  const [auditLoading, setAuditLoading] = createSignal(false)

  createEffect(async () => {
    if (open() && isCall() && part().tool) {
      setAuditLoading(true)
      try {
        const res = await rpc.checkGuardrails({
          tool: part().tool!,
          args: (rawArgs() ?? {}) as Record<string, import('../rpc/client').JsonValue>,
        })
        setAudit({ decision: res.decision, reason: res.reason })
      } catch {
        setAudit(null)
      } finally {
        setAuditLoading(false)
      }
    }
  })

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback: select text
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } catch {}
      ta.remove()
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(!open())
    } else if (e.key === 'ArrowDown' || e.key === 'j') {
      if (props.onFocusNext) {
        e.preventDefault()
        props.onFocusNext()
      }
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      if (props.onFocusPrev) {
        e.preventDefault()
        props.onFocusPrev()
      }
    }
  }

  // Status colors — respect NO_COLOR
  const statusBg = () => {
    if (isNoColor) return 'transparent'
    if (isError()) return 'rgba(239,68,68,0.08)'
    if (isCall()) return 'rgba(251,191,36,0.07)'
    return 'rgba(16,185,129,0.08)'
  }
  const statusBorder = () => {
    if (isNoColor) return '1px solid rgba(255,255,255,0.12)'
    if (isError()) return '1px solid rgba(239,68,68,0.22)'
    if (isCall()) return '1px solid rgba(251,191,36,0.18)'
    return '1px solid rgba(16,185,129,0.18)'
  }
  const statusLabel = () => (isCall() ? 'call' : isError() ? 'error' : 'result')
  const statusColor = () => {
    if (isNoColor) return '#e5e7eb'
    if (isCall()) return '#fcd34d'
    if (isError()) return '#fca5a5'
    return '#6ee7b7'
  }

  return (
    <div
      ref={containerRef}
      tabindex={0}
      role="button"
      aria-expanded={open() ? 'true' : 'false'}
      aria-label={`${title()} ${statusLabel()} — press Enter to ${open() ? 'collapse' : 'expand'}`}
      onKeyDown={onKeyDown}
      onFocus={() => {
        // Announce focus for screen readers
      }}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '6px',
        padding: '8px 10px',
        'border-radius': '8px',
        background: statusBg(),
        border: props.focused ? '1px solid rgba(99,102,241,0.45)' : statusBorder(),
        'box-shadow': props.focused ? '0 0 0 1px rgba(99,102,241,0.15)' : 'none',
        'font-family': font.mono,
        'font-size': text.base,
        outline: 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {/* Header — always visible, toggles expanded */}
      <button
        type="button"
        onClick={() => setOpen(!open())}
        aria-expanded={open() ? 'true' : 'false'}
        aria-label={`${title()} ${statusLabel()} — ${open() ? 'collapse' : 'expand'}`}
        title={isCall() ? 'Show tool input (Enter to toggle)' : 'Show tool output (Enter to toggle)'}
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          'justify-content': 'space-between',
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: '0',
          cursor: 'pointer',
          color: 'inherit',
          'font-family': 'inherit',
          'font-size': 'inherit',
        }}
      >
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '8px',
            flex: '1',
            'min-width': '0',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              'align-items': 'center',
              'justify-content': 'center',
              width: '22px',
              height: '22px',
              'border-radius': '6px',
              background: isError() ? 'rgba(239,68,68,0.18)' : 'rgba(255,255,255,0.06)',
              'font-size': '13px',
              flex: 'none',
            }}
            aria-hidden="true"
          >
            {icon()}
          </span>
          <span style={{ 'font-weight': '700', 'letter-spacing': '0.02em' }}>{title()}</span>
          <span
            style={{
              'font-size': '11px',
              padding: '2px 6px',
              'border-radius': '999px',
              background: isCall()
                ? 'rgba(251,191,36,0.18)'
                : isError()
                  ? 'rgba(239,68,68,0.18)'
                  : 'rgba(16,185,129,0.18)',
              color: statusColor(),
              flex: 'none',
            }}
          >
            {statusLabel()}
          </span>
          <Show when={isDiffTool() && diffPreview()}>
            <span
              style={{
                'font-size': '10px',
                color: 'rgba(255,255,255,0.45)',
                'margin-left': '4px',
                'font-family': font.mono,
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
                'white-space': 'nowrap',
                'max-width': '28ch',
                flex: '1',
                'text-align': 'left',
              }}
            >
              {diffPreview()}
            </span>
          </Show>
        </div>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', flex: 'none' }}>
          <Show when={latency() !== null}>
            <span
              style={{
                'font-size': '10px',
                padding: '1px 6px',
                'border-radius': '999px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: '#9ca3af',
                'font-family': font.mono,
              }}
              title={`Tool latency ${latency()}ms`}
            >
              {latency()}ms
            </span>
          </Show>
          <Show when={part().toolCallID}>
            <span style={{ 'font-size': '10px', opacity: '0.45' }} title={part().toolCallID}>
              {part().toolCallID!.slice(0, 8)}
            </span>
          </Show>
          <span
            style={{
              'font-size': '10px',
              opacity: '0.6',
              transform: open() ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s',
            }}
            aria-hidden="true"
          >
            ▶
          </span>
        </div>
      </button>

      {/* Expanded content */}
      <Show when={open()}>
        <Show when={auditLoading()}>
          <div style={{ 'font-size': '11px', color: 'rgba(255,255,255,0.45)', padding: '4px 0' }}>
            Checking guardrails…
          </div>
        </Show>
        <Show when={audit()}>
          <div
            style={{
              padding: '6px 8px',
              'border-radius': '6px',
              'font-size': '11px',
              background:
                audit()?.decision === 'allow'
                  ? 'rgba(16,185,129,0.10)'
                  : audit()?.decision === 'deny'
                    ? 'rgba(239,68,68,0.10)'
                    : 'rgba(251,191,36,0.10)',
              color:
                audit()?.decision === 'allow'
                  ? '#6ee7b7'
                  : audit()?.decision === 'deny'
                    ? '#fca5a5'
                    : '#fcd34d',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
            role="status"
          >
            Guardrail: <b>{audit()?.decision}</b>
            {audit()?.reason ? ` — ${audit()?.reason}` : ''}
          </div>
        </Show>

        <Show
          when={isDiffTool()}
          fallback={
            <>
              <Show when={argsText()}>
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                  <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                    <span style={{ 'font-size': '10px', opacity: '0.5', 'letter-spacing': '0.04em', 'font-weight': '600' }}>
                      ARGS
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy(argsText())}
                      title="Copy args"
                      aria-label="Copy args to clipboard"
                      style={{
                        padding: '2px 6px',
                        'font-size': '10px',
                        border: '1px solid rgba(255,255,255,0.12)',
                        'border-radius': '4px',
                        background: 'rgba(255,255,255,0.06)',
                        color: copied() ? '#6ee7b7' : '#9ca3af',
                        cursor: 'pointer',
                      }}
                    >
                      {copied() ? '✓ copied' : '⎘ copy'}
                    </button>
                  </div>
                  <pre
                    style={{
                      margin: '0',
                      padding: '6px 8px',
                      'border-radius': '6px',
                      background: 'rgba(0,0,0,0.28)',
                      overflow: 'auto',
                      'max-height': '180px',
                      'white-space': 'pre-wrap',
                      'word-break': 'break-word',
                    }}
                  >
                    {argsText()}
                  </pre>
                </div>
              </Show>
              <Show when={!isCall() && resultText()}>
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                  <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                    <span style={{ 'font-size': '10px', opacity: '0.5', 'letter-spacing': '0.04em', 'font-weight': '600' }}>
                      {isError() ? 'ERROR' : 'RESULT'}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy(resultText())}
                      title="Copy result"
                      aria-label="Copy result to clipboard"
                      style={{
                        padding: '2px 6px',
                        'font-size': '10px',
                        border: '1px solid rgba(255,255,255,0.12)',
                        'border-radius': '4px',
                        background: 'rgba(255,255,255,0.06)',
                        color: copied() ? '#6ee7b7' : '#9ca3af',
                        cursor: 'pointer',
                      }}
                    >
                      {copied() ? '✓ copied' : '⎘ copy'}
                    </button>
                  </div>
                  <pre
                    style={{
                      margin: '0',
                      padding: '6px 8px',
                      'border-radius': '6px',
                      background: isError() ? 'rgba(239,68,68,0.12)' : 'rgba(0,0,0,0.28)',
                      overflow: 'auto',
                      'max-height': '260px',
                      'white-space': 'pre-wrap',
                      'word-break': 'break-word',
                    }}
                  >
                    {resultText()}
                  </pre>
                </div>
              </Show>
            </>
          }
        >
          {/* Diff preview for edit/write/patch — red/green */}
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '6px',
              padding: '8px 10px',
              'border-radius': '6px',
              background: 'rgba(0,0,0,0.28)',
              border: '1px solid rgba(255,255,255,0.06)',
              'font-family': font.mono,
              'font-size': '11px',
              'line-height': '1.5',
              overflow: 'auto',
              'max-height': '260px',
            }}
          >
            <Show when={part().tool === 'edit'}>
              <div style={{ 'font-size': '10px', color: 'rgba(255,255,255,0.45)', 'margin-bottom': '2px' }}>
                {String((rawArgs() as Record<string, unknown> | null)?.path ?? '')}
              </div>
              <Show when={String((rawArgs() as Record<string, unknown> | null)?.oldString ?? '').length > 0}>
                <div
                  style={{
                    background: isNoColor ? 'transparent' : 'rgba(239,68,68,0.12)',
                    color: isNoColor ? '#e5e7eb' : '#fca5a5',
                    padding: '4px 6px',
                    'border-radius': '4px',
                    'white-space': 'pre-wrap',
                    'word-break': 'break-word',
                    border: isNoColor ? '1px solid rgba(255,255,255,0.12)' : 'none',
                  }}
                >
                  −{' '}
                  {String((rawArgs() as Record<string, unknown> | null)?.oldString ?? '').slice(0, 800)}
                </div>
              </Show>
              <div
                style={{
                  background: isNoColor ? 'transparent' : 'rgba(16,185,129,0.14)',
                  color: isNoColor ? '#e5e7eb' : '#6ee7b7',
                  padding: '4px 6px',
                  'border-radius': '4px',
                  'white-space': 'pre-wrap',
                  'word-break': 'break-word',
                  border: isNoColor ? '1px solid rgba(255,255,255,0.12)' : 'none',
                }}
              >
                +{' '}
                {String((rawArgs() as Record<string, unknown> | null)?.newString ?? '').slice(0, 800)}
              </div>
              <Show
                when={
                  String((rawArgs() as Record<string, unknown> | null)?.oldString ?? '').length > 800 ||
                  String((rawArgs() as Record<string, unknown> | null)?.newString ?? '').length > 800
                }
              >
                <div style={{ 'font-size': '10px', color: 'rgba(255,255,255,0.35)', 'margin-top': '2px' }}>
                  … truncated, expand JSON for full
                </div>
              </Show>
            </Show>
            <Show when={part().tool === 'write'}>
              <div style={{ 'font-size': '10px', color: 'rgba(255,255,255,0.45)', 'margin-bottom': '2px' }}>
                {String((rawArgs() as Record<string, unknown> | null)?.path ?? '')} · new file
              </div>
              <pre
                style={{
                  margin: '0',
                  'white-space': 'pre-wrap',
                  'word-break': 'break-word',
                  color: '#e5e7eb',
                  background: 'rgba(0,0,0,0.18)',
                  padding: '6px 8px',
                  'border-radius': '4px',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                {String((rawArgs() as Record<string, unknown> | null)?.content ?? '').slice(0, 1200)}
              </pre>
              <Show when={String((rawArgs() as Record<string, unknown> | null)?.content ?? '').length > 1200}>
                <div style={{ 'font-size': '10px', color: 'rgba(255,255,255,0.35)', 'margin-top': '2px' }}>
                  … truncated
                </div>
              </Show>
            </Show>
            <Show when={part().tool === 'patch'}>
              <pre style={{ margin: '0', 'white-space': 'pre', overflow: 'auto', color: '#e5e7eb' }}>
                {String((rawArgs() as Record<string, unknown> | null)?.patch ?? '').slice(0, 2000)}
              </pre>
            </Show>
          </div>
          <Show when={!isCall() && resultText()}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
              <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                <span style={{ 'font-size': '10px', opacity: '0.5', 'letter-spacing': '0.04em', 'font-weight': '600' }}>
                  {isError() ? 'ERROR' : 'RESULT'}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(resultText())}
                  title="Copy result"
                  aria-label="Copy result to clipboard"
                  style={{
                    padding: '2px 6px',
                    'font-size': '10px',
                    border: '1px solid rgba(255,255,255,0.12)',
                    'border-radius': '4px',
                    background: 'rgba(255,255,255,0.06)',
                    color: copied() ? '#6ee7b7' : '#9ca3af',
                    cursor: 'pointer',
                  }}
                >
                  {copied() ? '✓ copied' : '⎘ copy'}
                </button>
              </div>
              <pre
                style={{
                  margin: '0',
                  padding: '6px 8px',
                  'border-radius': '6px',
                  background: isError() ? 'rgba(239,68,68,0.12)' : 'rgba(0,0,0,0.28)',
                  overflow: 'auto',
                  'max-height': '180px',
                  'white-space': 'pre-wrap',
                  'word-break': 'break-word',
                }}
              >
                {resultText()}
              </pre>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
