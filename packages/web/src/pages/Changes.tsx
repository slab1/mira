import { createSignal, onMount, Show, For } from 'solid-js'
import {
  api,
  req,
  type ReviewCoverageManifest,
  type ReviewDisposition,
  type Session,
} from '../api/client'
import { DataStateBadge, type OperationalState } from '../components/DataState'
import { Card, SectionHeader } from '../components/DesignSystem'
import { ProgressiveDisclosure } from '../components/ProgressiveDisclosure'
import { toast } from '../components/Toast'

const SECTION_TITLES: Record<string, string> = {
  changed_files: '1. Changed Files',
  callers_dependents: '2. Callers & Reverse-Import Dependents',
  tool_event_registrations: '3. Tool & Event Registrations',
  adapters_hooks: '4. Adapters & Hooks',
  configuration_schema_migrations: '5. Configuration, Schema & Migrations',
  expected_tests: '6. Expected Tests',
  analysis_limitations: '7. Analysis Limitations',
}

function manifestStateColor(st: string): string {
  if (st === 'complete') return 'var(--ok)'
  if (st === 'in_progress') return 'var(--accent)'
  return 'var(--warn)'
}

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
  const [showAll, setShowAll] = createSignal(false)

  // Review Completeness Manifest state
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [selectedSessionId, setSelectedSessionId] = createSignal<string>('')
  const [manifest, setManifest] = createSignal<ReviewCoverageManifest | null>(null)
  const [generatingManifest, setGeneratingManifest] = createSignal(false)

  const loadManifestForSession = async (sid: string) => {
    if (!sid) return
    try {
      const res = await api.getSessionReviewManifest(sid)
      setManifest(res.latest ?? null)
    } catch {
      setManifest(null)
    }
  }

  const handleGenerateManifest = async () => {
    const sid = selectedSessionId()
    if (!sid) {
      toast.error('Select a session first to generate a Review Completeness Manifest')
      return
    }
    setGeneratingManifest(true)
    try {
      const m = await api.generateReviewManifest(sid)
      setManifest(m)
      toast.success('Generated 7-section Review Completeness Manifest')
    } catch (e) {
      toast.error(`Manifest generation failed: ${(e as Error).message}`)
    } finally {
      setGeneratingManifest(false)
    }
  }

  const handleUpdateSectionDisposition = async (sectionId: any, disposition: ReviewDisposition) => {
    const cur = manifest()
    if (!cur) return
    try {
      const updated = await api.updateReviewManifest(cur.id, {
        section: { id: sectionId, disposition },
      })
      setManifest(updated)
    } catch (e) {
      toast.error(`Update failed: ${(e as Error).message}`)
    }
  }

  const loadChanges = async () => {
    setState('loading')
    setError(null)
    try {
      const [res, sessList] = await Promise.all([
        req<any>('/changes'),
        api.listSessions().catch(() => [] as Session[]),
      ])
      setSessions(sessList)
      if (!selectedSessionId() && sessList.length > 0) {
        const firstId = sessList[0]!.id
        setSelectedSessionId(firstId)
        void loadManifestForSession(firstId)
      } else if (selectedSessionId()) {
        void loadManifestForSession(selectedSessionId())
      }
      const list: ChangeEntry[] = Array.isArray(res)
        ? res
        : (res && Array.isArray(res.changes)
            ? res.changes
            : (res && Array.isArray(res.items)
                ? res.items
                : []))
      setChanges(list)
      setState(list.length > 0 ? 'live' : 'empty')
    } catch (e) {
      setError(String(e))
      setState('error')
    }
  }

  onMount(() => {
    void loadChanges()
  })

  const safeChanges = (): ChangeEntry[] => (Array.isArray(changes()) ? changes() : [])
  const visibleChanges = (): ChangeEntry[] => (showAll() ? safeChanges() : safeChanges().slice(0, 5))
  const hasHidden = (): boolean => safeChanges().length > 5

  return (
    <div
      style={{
        flex: '1',
        display: 'flex',
        'flex-direction': 'column',
        overflow: 'auto',
        background: 'var(--bg-canvas)',
        padding: '18px 14px 28px',
      }}
    >
      <div
        style={{
          'max-width': '1100px',
          margin: '0 auto',
          width: '100%',
          display: 'flex',
          'flex-direction': 'column',
          gap: '14px',
        }}
      >
        <Card padding="14px 16px" style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'flex-wrap': 'wrap' }}>
          <div
            style={{
              width: '28px',
              height: '28px',
              'border-radius': '8px',
              background: 'var(--grad-brand)',
              display: 'grid',
              'place-items': 'center',
              color: 'var(--on-accent)',
              'font-weight': '800',
              'font-size': '14px',
            }}
            aria-hidden="true"
          >
            C
          </div>
          <div style={{ flex: '1', 'min-width': '160px' }}>
            <div style={{ 'font-size': 'var(--fs-lg)', 'font-weight': '700' }}>Changes</div>
            <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
              Every autonomous mutation traceable — timeline / diff / rewind
            </div>
          </div>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => void loadChanges()}
              disabled={state() === 'loading'}
              style={{
                padding: '5px 10px',
                'font-size': 'var(--fs-xs)',
                border: '1px solid var(--border)',
                'border-radius': 'var(--r-sm)',
                'min-height': '32px',
              }}
            >
              ↻ Refresh
            </button>
            <DataStateBadge state={state()} />
          </div>
        </Card>

        <Show when={error()}>
          <div class="card" style={{ padding: '12px 16px', color: 'var(--danger)' }}>
            Error: {error()}
          </div>
        </Show>

        <Show when={state() === 'loading'}>
          <Card padding="16px" style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <div class="skeleton" style={{ height: '18px', width: '35%' }} />
            <div class="skeleton" style={{ height: '48px', width: '100%' }} />
            <div class="skeleton" style={{ height: '48px', width: '100%' }} />
          </Card>
        </Show>

        <Show when={safeChanges().length === 0 && state() !== 'loading'}>
          <div class="card" style={{ padding: '20px', color: 'var(--fg-muted)', 'text-align': 'center', 'font-size': 'var(--fs-xs)' }}>
            No file changes recorded in this workspace yet.
          </div>
        </Show>

        {/* Review Completeness Manifest & Candidate Hash Verification */}
        <Card padding="16px" style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
          <SectionHeader
            title="Review Completeness Manifest"
            sub="7-section coverage ledger across git diff, CodeGraph dependents, registrations & workspace fingerprint"
            right={
              <div style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'flex-wrap': 'wrap' }}>
                <select
                  value={selectedSessionId()}
                  onChange={(e) => {
                    const id = e.currentTarget.value
                    setSelectedSessionId(id)
                    void loadManifestForSession(id)
                  }}
                  style={{
                    padding: '5px 8px',
                    'border-radius': 'var(--r-sm)',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-surface)',
                    color: 'var(--fg)',
                    'font-size': 'var(--fs-xs)',
                    'max-width': '220px',
                  }}
                  aria-label="Session for review manifest"
                >
                  <For each={sessions()}>
                    {(s) => <option value={s.id}>{s.title || s.id.slice(0, 8)}</option>}
                  </For>
                </select>
                <button
                  type="button"
                  class="btn btn-solid"
                  disabled={generatingManifest() || !selectedSessionId()}
                  onClick={() => void handleGenerateManifest()}
                  style={{ padding: '5px 12px', 'font-size': 'var(--fs-xs)' }}
                >
                  {generatingManifest() ? 'Generating…' : 'Generate Manifest'}
                </button>
              </div>
            }
          />

          <Show
            when={manifest()}
            fallback={
              <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                No review completeness manifest recorded for this session yet. Click Generate Manifest to fingerprint the candidate workspace and map all 7 review surfaces.
              </div>
            }
          >
            {(m) => (
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                <div
                  class="tabular-nums"
                  style={{
                    display: 'flex',
                    gap: '10px',
                    'flex-wrap': 'wrap',
                    'font-size': 'var(--fs-xs)',
                    'font-family': 'var(--font-mono)',
                    color: 'var(--fg-subtle)',
                  }}
                >
                  <span style={{ color: manifestStateColor(m().state), 'font-weight': '600' }}>
                    ● {m().state}
                  </span>
                  <span>·</span>
                  <span>{m().diff.changedFiles.length} changed files</span>
                  <span>·</span>
                  <span>{m().items.length} tracked items</span>
                  <span>·</span>
                  <span>{m().graph.indexedFiles} CodeGraph files</span>
                  <Show when={m().candidateHash}>
                    <span>·</span>
                    <span title={m().candidateHash}>fp:{m().candidateHash?.slice(0, 12)}</span>
                  </Show>
                </div>

                <Show when={m().blockers.length > 0}>
                  <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--warn)' }}>
                    Remaining: {m().blockers.join(' · ')}
                  </div>
                </Show>

                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                  <For each={m().sections}>
                    {(sec) => (
                      <div
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          'justify-content': 'space-between',
                          gap: '10px',
                          padding: '8px 10px',
                          background: 'var(--bg-surface)',
                          border: '1px solid var(--border)',
                          'border-radius': 'var(--r-sm)',
                          'font-size': 'var(--fs-xs)',
                          'flex-wrap': 'wrap',
                        }}
                      >
                        <div style={{ flex: '1', 'min-width': '220px' }}>
                          <div style={{ 'font-weight': '600', color: 'var(--fg)' }}>
                            {SECTION_TITLES[sec.id] ?? sec.id}
                          </div>
                          <div style={{ color: 'var(--fg-subtle)', 'margin-top': '2px' }}>
                            {sec.candidatePaths.length > 0
                              ? sec.candidatePaths.slice(0, 4).join(', ') +
                                (sec.candidatePaths.length > 4
                                  ? ` (+${sec.candidatePaths.length - 4} more)`
                                  : '')
                              : sec.reason || 'No candidate files'}
                          </div>
                        </div>
                        <select
                          value={sec.disposition}
                          onChange={(e) =>
                            void handleUpdateSectionDisposition(
                              sec.id,
                              e.currentTarget.value as ReviewDisposition,
                            )
                          }
                          aria-label={`Disposition for ${sec.id}`}
                          style={{
                            padding: '4px 8px',
                            background: 'var(--bg-app)',
                            border: '1px solid var(--border)',
                            'border-radius': 'var(--r-sm)',
                            color: 'var(--fg)',
                            'font-size': 'var(--fs-xs)',
                          }}
                        >
                          <option value="pending">pending</option>
                          <option value="inspected">inspected</option>
                          <option value="tested">tested</option>
                          <option value="not_applicable">not_applicable</option>
                          <option value="unresolved">unresolved</option>
                        </select>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>
        </Card>

        {/* Changes list — Progressive Disclosure */}
        <Show when={visibleChanges().length > 0}>
          <Card padding="0">
            <div style={{ padding: '12px 16px', 'border-bottom': '1px solid var(--border)' }}>
              <SectionHeader
                title="Change History"
                sub={`${safeChanges().length} total · showing ${visibleChanges().length}`}
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
                      {showAll() ? 'Show less' : `Show all ${safeChanges().length}`}
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
                  badgeLabel={c.approval || 'unreviewed'}
                  badgeTone={approvalTone(c.approval || 'unreviewed')}
                >
                  <div
                    style={{
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '8px',
                      'font-size': 'var(--fs-xs)',
                    }}
                  >
                    {/* Diff */}
                    <div
                      style={{
                        'font-family': 'var(--font-mono)',
                        background: 'var(--bg-surface)',
                        padding: '8px',
                        'border-radius': 'var(--r-sm)',
                        'white-space': 'pre-wrap',
                        'word-break': 'break-word',
                      }}
                    >
                      {c.diff}
                    </div>

                    {/* Metadata row */}
                    <div
                      style={{
                        display: 'flex',
                        gap: '12px',
                        'flex-wrap': 'wrap',
                        color: 'var(--fg-subtle)',
                      }}
                    >
                      <span>Agent: {c.agent ?? 'mira'}</span>
                      <span>Tools: {Array.isArray(c.tools) && c.tools.length > 0 ? c.tools.join(', ') : 'none'}</span>
                    </div>

                    {/* Before/After */}
                    <div style={{ display: 'flex', gap: '12px', 'flex-wrap': 'wrap' }}>
                      <span style={{ color: 'var(--danger)' }}>Before: {c.before ? (c.before.length > 80 ? c.before.slice(0, 80) + '…' : c.before) : '(empty)'}</span>
                      <span style={{ color: 'var(--ok)' }}>After: {c.after ? (c.after.length > 80 ? c.after.slice(0, 80) + '…' : c.after) : '(modified)'}</span>
                    </div>

                    {/* Verification */}
                    <div
                      style={{
                        display: 'flex',
                        gap: '12px',
                        'flex-wrap': 'wrap',
                        color: 'var(--fg-subtle)',
                      }}
                    >
                      <span>Tests: {c.tests ?? 'none'}</span>
                      <span>Verification: {c.verification ?? 'unverified'}</span>
                    </div>

                    {/* Snapshot & Rollback */}
                    <div
                      style={{
                        display: 'flex',
                        gap: '12px',
                        'flex-wrap': 'wrap',
                        color: 'var(--fg-faint)',
                      }}
                    >
                      <span>Snapshot: {c.snapshot ?? c.id}</span>
                      <span>Rollback: {c.rollback ?? 'available'}</span>
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
