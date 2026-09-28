import { createSignal, onMount, Show, For } from 'solid-js'
import { req } from '../api/client'
import { DataStateBadge, type OperationalState } from '../components/DataState'
import { createChangesFeatureStore } from '../features/changes'
import { Card, SectionHeader, StatusBadge } from '../components/DesignSystem'
import { ProgressiveDisclosure } from '../components/ProgressiveDisclosure'
import { ScopeTransparency } from '../components/ScopeTransparency'

interface ChangeEntry {
  id: string
  type: string
  path: string
  diff: string
  agent: string
  tools: string[]
  before: string
  after: string
  tests: string
  verification: string
  snapshot: string
  rollback: string
  approval: string
  createdAt: number
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(res.status + ' ' + (await res.text().catch(() => '')))
  return (await res.json()) as T
}

function approvalTone(approval: string): 'success' | 'warning' | 'error' | 'info' | 'muted' {
  if (approval === 'approved' || approval === 'merged') return 'success'
  if (approval === 'pending' || approval === 'in-progress') return 'warning'
  if (approval === 'rejected' || approval === 'failed') return 'error'
  return 'muted'
}

export default function ChangesPage() {
  const [changes, setChanges] = createSignal<ChangeEntry[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [state, setState] = createSignal<OperationalState>('loading')
  const changesStore = createChangesFeatureStore()
  const [showAll, setShowAll] = createSignal(false)

  onMount(async () => {
    try {
      const c = await getJson<ChangeEntry[]>('/changes')
      setChanges(c ?? [])
      setState(c ? 'live' : 'empty')
    } catch (e) {
      setError(String(e))
      setState('error')
    }
  })

  const visibleChanges = () => showAll() ? changes() : changes().slice(0, 5)
  const hasHidden = () => changes().length > 5

  return (
    <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', overflow: 'auto', background: 'var(--bg-canvas)', padding: '18px 14px 28px' }}>
      <div style={{ 'max-width': '1100px', margin: '0 auto', width: '100%', display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
        <Card padding="14px 16px" style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
          <div style={{ width: '28px', height: '28px', 'border-radius': '8px', background: 'var(--grad-brand)', display: 'grid', 'place-items': 'center', color: 'var(--on-accent)', 'font-weight': '800', 'font-size': '14px' }} aria-hidden="true">C</div>
          <div>
            <div style={{ 'font-size': 'var(--fs-lg)', 'font-weight': '700' }}>Changes</div>
            <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>Every autonomous mutation traceable — timeline / diff / rewind</div>
          </div>
          <div style={{ 'margin-left': 'auto' }}>
            <DataStateBadge state={state()} />
          </div>
        </Card>

        <Show when={error()}>
          <div class="card" style={{ padding: '12px 16px', color: 'var(--danger)' }}>Error: {error()}</div>
        </Show>

        <Show when={changes().length === 0 && state() !== 'loading'}>
          <div class="card" style={{ padding: '16px', color: 'var(--fg-muted)' }}>No changes recorded yet.</div>
        </Show>

        {/* Changes list — Progressive Disclosure */}
        <Show when={visibleChanges().length > 0}>
          <Card padding="0">
            <div style={{ padding: '12px 16px', 'border-bottom': '1px solid var(--border)' }}>
              <SectionHeader
                title="Change History"
                sub={`${changes().length} total · showing ${visibleChanges().length}`}
                right={
                  <Show when={hasHidden()}>
                    <button
                      onClick={() => setShowAll(!showAll())}
                      style={{
                        padding: '4px 10px',
                        'border-radius': 'var(--r-sm)',
                        border: '1px solid var(--border-strong)',
                        background: 'var(--bg-surface)',
                        color: 'var(--fg-muted)',
                        'font-size': 'var(--fs-xs)',
                        'font-weight': '600',
                        cursor: 'pointer',
                      }}
                    >
                      {showAll() ? 'Show less' : `Show all ${changes().length}`}
                    </button>
                  </Show>
                }
              />
            </div>
            <For each={visibleChanges()}>
              {(c) => (
                <ProgressiveDisclosure
                  title={c.path}
                  metric={c.type}
                  badgeLabel={c.approval}
                  badgeTone={approvalTone(c.approval)}
                >
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px', 'font-size': 'var(--fs-xs)' }}>
                    {/* Diff */}
                    <div style={{ 'font-family': 'var(--font-mono)', background: 'var(--bg-surface)', padding: '8px', 'border-radius': 'var(--r-sm)', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>
                      {c.diff}
                    </div>

                    {/* Metadata row */}
                    <div style={{ display: 'flex', 'gap': '12px', 'flex-wrap': 'wrap', color: 'var(--fg-subtle)' }}>
                      <span>Agent: {c.agent}</span>
                      <span>Tools: {c.tools.join(', ')}</span>
                    </div>

                    {/* Before/After */}
                    <div style={{ display: 'flex', 'gap': '12px', 'flex-wrap': 'wrap' }}>
                      <span style={{ color: 'var(--danger)' }}>Before: {c.before}</span>
                      <span style={{ color: 'var(--ok)' }}>After: {c.after}</span>
                    </div>

                    {/* Verification */}
                    <div style={{ display: 'flex', 'gap': '12px', 'flex-wrap': 'wrap', color: 'var(--fg-subtle)' }}>
                      <span>Tests: {c.tests}</span>
                      <span>Verification: {c.verification}</span>
                    </div>

                    {/* Snapshot & Rollback */}
                    <div style={{ display: 'flex', 'gap': '12px', 'flex-wrap': 'wrap', color: 'var(--fg-faint)' }}>
                      <span>Snapshot: {c.snapshot}</span>
                      <span>Rollback: {c.rollback}</span>
                    </div>

                    {/* Timestamp */}
                    <div style={{ color: 'var(--fg-faint)' }}>
                      {new Date(c.createdAt).toLocaleString()}
                    </div>
                  </div>
                </ProgressiveDisclosure>
              )}
            </For>
          </Card>
        </Show>
      </div>
    </div>
  )
}
