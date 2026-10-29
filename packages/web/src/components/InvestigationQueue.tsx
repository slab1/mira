// @ts-nocheck
/**
 * InvestigationQueue — open questions awaiting a real fix (§24)
 *
 * An investigation is NOT a failure. It is a proposal that carried no
 * appliable change: Mira observed and diagnosed something real, but has no
 * honest fix to verify yet. This panel surfaces those questions with what is
 * needed to act on them — the failure, the cause, the risk, any research
 * evidence validated against the diagnosis (§10) — and states the next step:
 * produce a real unified diff and re-observe.
 *
 * Like the approval queue, this is a SURFACE: it reads
 * GET /evolution/investigations and holds no authority of its own.
 */

import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'

type Investigation = {
  id: string
  title?: string
  cause?: string
  failure?: string
  affectedEngine?: string
  confidence?: number
  risk?: string
  riskReasons?: string[]
  why: string
  next: string
  researchHints: Array<{ claim: string; confidence: number; corroboratedBy: number }>
  createdAt?: number
}

function riskPill(risk: string | undefined): string {
  const r = (risk ?? '').toLowerCase()
  if (r === 'high') return 'pill-danger'
  if (r === 'medium') return 'pill-warn'
  return 'pill-ok'
}

export function InvestigationQueue() {
  const [items, setItems] = createSignal<Investigation[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal('')
  const [expanded, setExpanded] = createSignal<string | null>(null)

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      // Imported lazily to keep this component free of transport concerns
      // beyond the shared client (same auth path as every other panel).
      const { req } = await import('../api/client')
      const res = await req<{ ok: boolean; investigations: Investigation[] }>(
        '/evolution/investigations',
      )
      setItems(res.investigations ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    onCleanup(() => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    })
  })

  return (
    <section
      class="card"
      aria-labelledby="investigation-queue-title"
      style={{ padding: '14px', display: 'flex', 'flex-direction': 'column', gap: '10px' }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
        <div
          id="investigation-queue-title"
          style={{
            'font-size': 'var(--fs-xs)',
            'font-weight': '700',
            'letter-spacing': '0.04em',
            'text-transform': 'uppercase',
            color: 'var(--fg-muted)',
          }}
        >
          Open Investigations
        </div>
        <button
          class="btn btn-ghost"
          onClick={refresh}
          disabled={loading()}
          style={{ 'font-size': 'var(--fs-xs)' }}
          aria-label="Refresh investigations"
        >
          {loading() ? '…' : 'Refresh'}
        </button>
      </div>

      <Show
        when={items().length > 0}
        fallback={
          <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
            No open investigations — every observed failure currently carries a real, appliable
            change.
          </div>
        }
      >
        <For each={items()}>
          {(inv) => (
            <div
              style={{
                border: '1px solid var(--border)',
                'border-radius': 'var(--r-md)',
                padding: '10px',
                display: 'flex',
                'flex-direction': 'column',
                gap: '8px',
                background: 'var(--bg-app)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '8px',
                  'flex-wrap': 'wrap',
                }}
              >
                <span class={`pill ${riskPill(inv.risk)}`}>{inv.risk ?? 'risk?'} risk</span>
                <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', flex: '1' }}>
                  {inv.title ?? inv.id}
                </span>
                <Show when={inv.affectedEngine}>
                  <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)' }}>
                    {inv.affectedEngine}
                  </span>
                </Show>
              </div>

              <Show when={inv.cause}>
                <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-subtle)' }}>
                  cause: {inv.cause}
                </div>
              </Show>

              <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)' }}>
                {inv.why}
              </div>

              <Show when={expanded() === inv.id}>
                <div
                  style={{
                    'font-size': 'var(--fs-2xs)',
                    color: 'var(--fg-subtle)',
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '6px',
                  }}
                >
                  <Show when={inv.failure}>
                    <div>
                      <strong>failure:</strong> {inv.failure}
                    </div>
                  </Show>
                  <Show when={inv.riskReasons && inv.riskReasons.length > 0}>
                    <div>
                      <strong>risk:</strong>
                      <ul style={{ margin: '2px 0 0', 'padding-left': '16px' }}>
                        <For each={inv.riskReasons}>{(r) => <li>{r}</li>}</For>
                      </ul>
                    </div>
                  </Show>
                  <Show when={inv.researchHints.length > 0}>
                    <div>
                      <strong>research evidence (§10, advisory):</strong>
                      <ul style={{ margin: '2px 0 0', 'padding-left': '16px' }}>
                        <For each={inv.researchHints}>
                          {(h) => (
                            <li>
                              {h.claim}
                              {h.corroboratedBy > 1
                                ? ` — corroborated by ${h.corroboratedBy} sources`
                                : ''}
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  </Show>
                  <div style={{ 'margin-top': '4px' }}>
                    <strong>next step:</strong> {inv.next}
                  </div>
                </div>
              </Show>

              <button
                class="btn btn-ghost"
                style={{ 'font-size': 'var(--fs-2xs)', 'align-self': 'flex-start' }}
                onClick={() => setExpanded(expanded() === inv.id ? null : inv.id)}
                aria-expanded={expanded() === inv.id}
              >
                {expanded() === inv.id ? 'Hide details' : 'View details'}
              </button>
            </div>
          )}
        </For>
      </Show>

      <Show when={error()}>
        <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--danger)' }}>{error()}</div>
      </Show>

      <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)' }}>
        An investigation means no honest fix was available yet — Mira records the question rather
        than fabricating a patch.
      </div>
    </section>
  )
}
