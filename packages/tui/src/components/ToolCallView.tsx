/**
 * ToolCallView — Renders a single tool-call / tool-result part
 *
 * P1-6 Tool Transparency: collapsed chip, diffPreview for edit/write/patch (red/green),
 * checkGuardrails audit on expand, per-tool latency.
 * Colors: success (teal), error (red), pending (amber).
 */

import { Show, createMemo, createSignal, createEffect } from 'solid-js'
import type { Part } from '../rpc/client'
import { rpc } from '../rpc/client'

type Props = {
  part: Part
  expanded?: boolean
  latencyMs?: number
  toolMetrics?: Array<{ tool: string; durationMs: number; isError: boolean }>
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

  // P1-6: collapsed by default, respect expanded? prop as initial
  const [open, setOpen] = createSignal(props.expanded ?? false)
  createEffect(() => {
    if (props.expanded !== undefined) setOpen(props.expanded)
  })

  // Normalize args: TUI uses args/result, web uses input/output
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

  // P1-6: per-tool latency
  const latency = createMemo(() => {
    if (typeof props.latencyMs === 'number') return props.latencyMs
    const metrics = props.toolMetrics
    if (metrics && metrics.length) {
      const m = metrics.find((x) => x.tool === part().tool)
      if (m) return m.durationMs
      // fallback: last metric for this tool
      const filtered = metrics.filter((x) => x.tool === part().tool)
      if (filtered.length) return filtered[filtered.length - 1].durationMs
    }
    return null
  })

  // P1-6: checkGuardrails on expand
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

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '6px',
        padding: '8px 10px',
        'border-radius': '8px',
        background: isError()
          ? 'rgba(239,68,68,0.08)'
          : isCall()
            ? 'rgba(251,191,36,0.07)'
            : 'rgba(16,185,129,0.08)',
        border: isError()
          ? '1px solid rgba(239,68,68,0.22)'
          : isCall()
            ? '1px solid rgba(251,191,36,0.18)'
            : '1px solid rgba(16,185,129,0.18)',
        'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        'font-size': '12px',
      }}
    >
      {/* Collapsed chip — always visible, toggles expanded */}
      <button
        type="button"
        onClick={() => setOpen(!open())}
        aria-expanded={open() ? 'true' : 'false'}
        title={isCall() ? 'Show tool input' : 'Show tool output'}
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
              color: isCall() ? '#fcd34d' : isError() ? '#fca5a5' : '#6ee7b7',
              flex: 'none',
            }}
          >
            {isCall() ? 'call' : isError() ? 'error' : 'result'}
          </span>
          <Show when={isDiffTool() && diffPreview()}>
            <span
              style={{
                'font-size': '10px',
                color: 'rgba(255,255,255,0.45)',
                'margin-left': '4px',
                'font-family': 'ui-monospace, monospace',
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
                'font-family': 'ui-monospace, monospace',
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
                  <span
                    style={{
                      'font-size': '10px',
                      opacity: '0.5',
                      'letter-spacing': '0.04em',
                      'font-weight': '600',
                    }}
                  >
                    ARGS
                  </span>
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
                  <span
                    style={{
                      'font-size': '10px',
                      opacity: '0.5',
                      'letter-spacing': '0.04em',
                      'font-weight': '600',
                    }}
                  >
                    {isError() ? 'ERROR' : 'RESULT'}
                  </span>
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
              'font-family': 'ui-monospace, monospace',
              'font-size': '11px',
              'line-height': '1.5',
              overflow: 'auto',
              'max-height': '260px',
            }}
          >
            <Show when={part().tool === 'edit'}>
              <div
                style={{
                  'font-size': '10px',
                  color: 'rgba(255,255,255,0.45)',
                  'margin-bottom': '2px',
                }}
              >
                {String((rawArgs() as Record<string, unknown> | null)?.path ?? '')}
              </div>
              <Show
                when={
                  String((rawArgs() as Record<string, unknown> | null)?.oldString ?? '').length > 0
                }
              >
                <div
                  style={{
                    background: 'rgba(239,68,68,0.12)',
                    color: '#fca5a5',
                    padding: '4px 6px',
                    'border-radius': '4px',
                    'white-space': 'pre-wrap',
                    'word-break': 'break-word',
                  }}
                >
                  −{' '}
                  {String((rawArgs() as Record<string, unknown> | null)?.oldString ?? '').slice(
                    0,
                    800,
                  )}
                </div>
              </Show>
              <div
                style={{
                  background: 'rgba(16,185,129,0.14)',
                  color: '#6ee7b7',
                  padding: '4px 6px',
                  'border-radius': '4px',
                  'white-space': 'pre-wrap',
                  'word-break': 'break-word',
                }}
              >
                +{' '}
                {String((rawArgs() as Record<string, unknown> | null)?.newString ?? '').slice(
                  0,
                  800,
                )}
              </div>
              <Show
                when={
                  String((rawArgs() as Record<string, unknown> | null)?.oldString ?? '').length >
                    800 ||
                  String((rawArgs() as Record<string, unknown> | null)?.newString ?? '').length >
                    800
                }
              >
                <div
                  style={{
                    'font-size': '10px',
                    color: 'rgba(255,255,255,0.35)',
                    'margin-top': '2px',
                  }}
                >
                  … truncated, expand JSON for full
                </div>
              </Show>
            </Show>
            <Show when={part().tool === 'write'}>
              <div
                style={{
                  'font-size': '10px',
                  color: 'rgba(255,255,255,0.45)',
                  'margin-bottom': '2px',
                }}
              >
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
                {String((rawArgs() as Record<string, unknown> | null)?.content ?? '').slice(
                  0,
                  1200,
                )}
              </pre>
              <Show
                when={
                  String((rawArgs() as Record<string, unknown> | null)?.content ?? '').length > 1200
                }
              >
                <div
                  style={{
                    'font-size': '10px',
                    color: 'rgba(255,255,255,0.35)',
                    'margin-top': '2px',
                  }}
                >
                  … truncated
                </div>
              </Show>
            </Show>
            <Show when={part().tool === 'patch'}>
              <pre
                style={{ margin: '0', 'white-space': 'pre', overflow: 'auto', color: '#e5e7eb' }}
              >
                {String((rawArgs() as Record<string, unknown> | null)?.patch ?? '').slice(0, 2000)}
              </pre>
            </Show>
          </div>
          {/* Also show result if present for diff tools */}
          <Show when={!isCall() && resultText()}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
              <span
                style={{
                  'font-size': '10px',
                  opacity: '0.5',
                  'letter-spacing': '0.04em',
                  'font-weight': '600',
                }}
              >
                {isError() ? 'ERROR' : 'RESULT'}
              </span>
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
