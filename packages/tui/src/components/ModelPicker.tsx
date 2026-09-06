/**
 * ModelPicker — TUI port for P1-4 Eval Badge
 *
 * Agent select + EvalBadge pill. Fetches agents via rpc.listAgents,
 * shows EvalBadge for selected model/agent. Wired to App header + createSession.
 */

import { createSignal, createEffect, onCleanup, Show, For } from 'solid-js'
import { rpc, type AgentEntry } from '../rpc/client'
import type { ModelEval } from '../rpc/client'

// ── EvalBadge (TUI dark) ────────────────────────────────────────────
function EvalBadge(props: { model?: string }) {
  const [data, setData] = createSignal<ModelEval | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  let abort = false

  createEffect(() => {
    const model = props.model
    if (!model) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    abort = false
    setLoading(true)
    setError(null)
    setData(null)

    rpc
      .getModelEval(model)
      .then((d) => {
        if (!abort) setData(d)
      })
      .catch((e) => {
        if (!abort) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!abort) setLoading(false)
      })

    onCleanup(() => {
      abort = true
    })
  })

  const percent = () => {
    const d = data()
    if (!d || d.successRate == null) return null
    return Math.round(d.successRate * 100)
  }

  const runs = () => data()?.sessions ?? 0

  const colorBand = () => {
    const p = percent()
    if (p == null) return '#6b7280'
    if (p >= 80) return '#6ee7b7'
    if (p >= 60) return '#fbbf24'
    return '#fca5a5'
  }

  const bgBand = () => {
    const p = percent()
    if (p == null) return 'rgba(255,255,255,0.06)'
    if (p >= 80) return 'rgba(52,211,153,0.15)'
    if (p >= 60) return 'rgba(251,191,36,0.15)'
    return 'rgba(248,113,113,0.15)'
  }

  const borderBand = () => {
    const p = percent()
    if (p == null) return 'rgba(255,255,255,0.12)'
    if (p >= 80) return 'rgba(52,211,153,0.25)'
    if (p >= 60) return 'rgba(251,191,36,0.25)'
    return 'rgba(248,113,113,0.25)'
  }

  return (
    <span
      style={{
        'font-size': '10px',
        'font-family': 'ui-monospace, monospace',
        padding: '2px 8px',
        background: bgBand(),
        color: colorBand(),
        border: `1px solid ${borderBand()}`,
        'border-radius': '999px',
        'white-space': 'nowrap',
        display: 'inline-flex',
        'align-items': 'center',
        gap: '4px',
      }}
      title={
        data()
          ? `Eval: ${percent()}% success over ${runs()} runs${data()?.lastEvalAt ? ` · last ${new Date(data()!.lastEvalAt!).toLocaleDateString()}` : ''}`
          : 'Eval'
      }
    >
      <Show
        when={loading()}
        fallback={
          <Show
            when={error()}
            fallback={
              <Show when={data()} fallback={<span style={{ opacity: '0.6' }}>eval —</span>}>
                <span>
                  ✓ {percent()}% · {runs()}
                </span>
              </Show>
            }
          >
            <span style={{ opacity: '0.7' }}>⚠ err</span>
          </Show>
        }
      >
        <span style={{ opacity: '0.7' }}>…</span>
      </Show>
    </span>
  )
}

// ── ModelPicker ─────────────────────────────────────────────────────
export default function ModelPicker(props: {
  value: string
  onChange: (agent: string) => void
  onCreateSession?: (agent: string) => void
}) {
  const [agents, setAgents] = createSignal<AgentEntry[]>([])
  const [loading, setLoading] = createSignal(false)

  createEffect(() => {
    setLoading(true)
    rpc
      .listAgents()
      .then((list) => setAgents(list ?? []))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false))
  })

  // Derive model for EvalBadge: use agent name as model key, or fallback to value
  const evalModel = () => props.value || 'general'

  return (
    <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        title="Agent lane — session template (tools + posture)"
        aria-label="Agent lane"
        style={{
          padding: '4px 8px',
          'font-size': '11px',
          border: '1px solid rgba(255,255,255,0.12)',
          'border-radius': '6px',
          background: 'rgba(0,0,0,0.28)',
          color: '#e5e7eb',
          cursor: 'pointer',
          'max-width': '140px',
        }}
      >
        <option value="">general</option>
        <For each={agents()}>
          {(a) => (
            <option value={a.name}>
              {a.name}
              {a.custom ? ' *' : ''}
            </option>
          )}
        </For>
      </select>
      <Show when={!loading()}>
        <EvalBadge model={evalModel()} />
      </Show>
      <Show when={props.onCreateSession}>
        <button
          type="button"
          onClick={() => props.onCreateSession?.(props.value)}
          title={props.value ? `New ${props.value} session` : 'New session'}
          style={{
            padding: '4px 9px',
            'font-size': '11px',
            border: '1px solid rgba(99,102,241,0.35)',
            'border-radius': '6px',
            background: 'rgba(99,102,241,0.15)',
            color: '#a5b4fc',
            cursor: 'pointer',
            'font-weight': '600',
          }}
        >
          ＋ {props.value || 'new'}
        </button>
      </Show>
    </div>
  )
}

export { EvalBadge }
