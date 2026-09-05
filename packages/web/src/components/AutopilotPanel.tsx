import { createSignal, onMount, Show, For } from 'solid-js'
import { api } from '../api/client'
import type { SchedulerStatus, EvalDelta, Patch } from '../api/client'

export function AutopilotPanel() {
  const [status, setStatus] = createSignal<SchedulerStatus | null>(null)
  const [delta, setDelta] = createSignal<EvalDelta | null>(null)
  const [patches, setPatches] = createSignal<Patch[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [approving, setApproving] = createSignal<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, d, p] = await Promise.all([
        api.getLearningSchedulerStatus(),
        api.getLearningLastEvalDelta(),
        api.listPendingPatches(),
      ])
      setStatus(s)
      setDelta(d)
      setPatches(p)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load autopilot')
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    load()
  })

  const approve = async (id: string) => {
    setApproving(id)
    try {
      await api.approvePatch(id)
      setPatches((ps) => ps.filter((p) => p.id !== id))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to approve patch')
    } finally {
      setApproving(null)
    }
  }

  const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

  return (
    <section class="card" aria-labelledby="autopilot-title">
      <header class="card-head">
        <h2 id="autopilot-title">Autopilot</h2>
        <span class={`pill ${status()?.status === 'running' ? 'pill-ok' : 'pill-muted'}`}>
          {status()?.status ?? 'idle'}
        </span>
      </header>

      <Show when={loading()}>
        <div class="skeleton" aria-live="polite">
          Loading autopilot…
        </div>
      </Show>

      <Show when={error()}>
        <div class="alert alert-danger" role="alert">
          {error()}
        </div>
      </Show>

      <Show when={!loading() && !error()}>
        <div class="grid-2">
          <div class="card">
            <h3>Schedule</h3>
            <dl>
              <div>
                <dt>Next run</dt>
                <dd>{fmt(status()?.nextRunAt)}</dd>
              </div>
              <div>
                <dt>Last run</dt>
                <dd>{fmt(status()?.lastRunAt)}</dd>
              </div>
            </dl>
          </div>
          <div class="card">
            <h3>Last eval delta</h3>
            <Show when={delta()}>
              <div>
                <div class="fs-lg">
                  {delta()!.delta >= 0 ? '+' : ''}
                  {delta()!.delta.toFixed(2)}
                </div>
                <div class="fg-muted">Session {delta()!.sessionID}</div>
              </div>
            </Show>
            <Show when={!delta()}>
              <div class="fg-muted">No eval data yet</div>
            </Show>
          </div>
        </div>

        <div class="section">
          <h3>Pending self-improvement patches</h3>
          <Show when={patches().length === 0}>
            <div class="empty">No pending patches</div>
          </Show>
          <ul class="list" role="list">
            <For each={patches()}>
              {(p) => (
                <li class="card">
                  <div class="row">
                    <div>
                      <div class="chip">{p.painPointId}</div>
                      <p class="fg-muted">{p.reason}</p>
                      <pre class="mono">{p.change.slice(0, 300)}</pre>
                    </div>
                    <button
                      class="btn btn-primary"
                      aria-busy={approving() === p.id}
                      onClick={() => approve(p.id)}
                    >
                      {approving() === p.id ? 'Approving…' : 'Approve'}
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </section>
  )
}
