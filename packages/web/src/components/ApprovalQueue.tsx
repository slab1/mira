/**
 * ApprovalQueue — the operator's pending approval queue (§18)
 *
 * Authority model: this component is a SURFACE, not an authority. It renders
 * the server's durable pending queue (GET /evolution/approvals) and calls the
 * same authenticated endpoints a curl would (POST /evolution/approve|deny/:id
 * with the operator's bearer token). It owns no approval logic and trusts no
 * client state — identity comes from the caller's credentials server-side.
 *
 * Evidence-at-decision-time: each row shows the risk level/score/reasons and
 * autonomy level the operator is deciding on, captured by the server when the
 * approval was requested.
 */

import { createSignal, onMount, Show, For } from 'solid-js'
import { req } from '../api/client'
import { toast } from './Toast'

type PendingApproval = {
  id: string
  title?: string
  affectedEngine?: string
  risk?: string
  riskScore?: number
  riskReasons?: string[]
  level?: number
  requestedAt?: number
}

function riskPill(risk: string | undefined): string {
  const r = (risk ?? '').toLowerCase()
  if (r === 'high') return 'pill-danger'
  if (r === 'medium') return 'pill-warn'
  return 'pill-ok'
}

function fmtAge(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—'
  const ms = Date.now() - ts
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

export function ApprovalQueue(props: { onDecided?: () => void }) {
  const [pending, setPending] = createSignal<PendingApproval[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal('')
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const [busyId, setBusyId] = createSignal<string | null>(null)

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const res = await req<{ ok: boolean; pending: PendingApproval[] }>('/evolution/approvals')
      setPending(res.pending ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function decide(id: string, decision: 'approve' | 'deny'): Promise<void> {
    setBusyId(id)
    try {
      await req<{ ok: boolean; approved: boolean; reason?: string }>(
        `/evolution/${decision}/${encodeURIComponent(id)}`,
        { method: 'POST' },
      )
      toast(
        decision === 'approve' ? 'Approved by operator' : 'Denied by operator',
        decision === 'approve' ? 'success' : 'warn',
      )
      await refresh()
      props.onDecided?.()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast(`Decision failed: ${msg.slice(0, 120)}`, 'error')
      // 401 handled globally (token cleared); other errors keep the queue
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  onMount(refresh)

  return (
    <section
      class="card"
      aria-labelledby="approval-queue-title"
      style={{ padding: '14px', display: 'flex', 'flex-direction': 'column', gap: '10px' }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
        <div
          id="approval-queue-title"
          style={{
            'font-size': 'var(--fs-xs)',
            'font-weight': '700',
            'letter-spacing': '0.04em',
            'text-transform': 'uppercase',
            color: 'var(--fg-muted)',
          }}
        >
          Operator Approval Queue
        </div>
        <button
          class="btn btn-ghost"
          onClick={refresh}
          disabled={loading()}
          style={{ 'font-size': 'var(--fs-xs)' }}
          aria-label="Refresh approval queue"
        >
          {loading() ? '…' : 'Refresh'}
        </button>
      </div>

      <Show
        when={!loading() || pending().length > 0}
        fallback={
          <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
            Loading pending approvals…
          </div>
        }
      >
        <Show
          when={pending().length > 0}
          fallback={
            <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
              Nothing awaiting operator decision — the pipeline is fail-closed, so anything that
              needs you will appear here.
            </div>
          }
        >
          <For each={pending()}>
            {(p) => (
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
                  <span class={`pill ${riskPill(p.risk)}`}>{p.risk ?? 'risk?'} risk</span>
                  <Show when={p.level !== undefined}>
                    <span class="pill pill-accent">L{p.level}</span>
                  </Show>
                  <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', flex: '1' }}>
                    {p.title ?? p.id}
                  </span>
                  <span
                    style={{
                      'font-size': 'var(--fs-2xs)',
                      color: 'var(--fg-faint)',
                      'font-family': 'var(--font-mono)',
                    }}
                    title={p.requestedAt ? new Date(p.requestedAt).toLocaleString() : ''}
                  >
                    waiting {fmtAge(p.requestedAt)}
                  </span>
                </div>

                <Show when={p.affectedEngine}>
                  <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-subtle)' }}>
                    engine: {p.affectedEngine}
                    <Show when={p.riskScore !== undefined}>
                      {' '}
                      · risk score {p.riskScore?.toFixed(2)}
                    </Show>
                  </div>
                </Show>

                {/* Evidence at decision time — the operator decides on THIS */}
                <button
                  class="btn btn-ghost"
                  style={{ 'font-size': 'var(--fs-2xs)', 'align-self': 'flex-start' }}
                  onClick={() => setExpanded(expanded() === p.id ? null : p.id)}
                  aria-expanded={expanded() === p.id}
                >
                  {expanded() === p.id ? 'Hide evidence' : 'View evidence'}
                </button>
                <Show when={expanded() === p.id}>
                  <ul
                    style={{
                      margin: 0,
                      'padding-left': '18px',
                      'font-size': 'var(--fs-2xs)',
                      color: 'var(--fg-subtle)',
                    }}
                  >
                    <For each={p.riskReasons ?? []}>{(r) => <li>{r}</li>}</For>
                    <Show when={(p.riskReasons ?? []).length === 0}>
                      <li>no risk reasons recorded</li>
                    </Show>
                  </ul>
                </Show>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    class="btn btn-solid"
                    disabled={busyId() === p.id}
                    onClick={() => decide(p.id, 'approve')}
                    aria-label={`Approve ${p.title ?? p.id}`}
                  >
                    {busyId() === p.id ? '…' : 'Approve'}
                  </button>
                  <button
                    class="btn btn-danger"
                    disabled={busyId() === p.id}
                    onClick={() => decide(p.id, 'deny')}
                    aria-label={`Deny ${p.title ?? p.id}`}
                  >
                    Deny
                  </button>
                </div>
              </div>
            )}
          </For>
        </Show>
      </Show>

      <Show when={error()}>
        <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--danger)' }}>{error()}</div>
      </Show>

      <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)' }}>
        Identity comes from your session token server-side — this panel holds no authority of its
        own. Approvals are logged as "human operator" decisions.
      </div>
    </section>
  )
}
