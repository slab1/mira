// @ts-nocheck
import { createSignal, createMemo, onMount, onCleanup, Show, For } from 'solid-js'
import { api, req, type ResearchMode, type ResearchRunDTO } from '../api/client'
import { DataStateBadge, type OperationalState } from '../components/DataState'
import { createIntelligenceFeatureStore } from '../features/intelligence'
import { Card, SectionHeader, StatusBadge } from '../components/DesignSystem'
import { ProgressiveDisclosure } from '../components/ProgressiveDisclosure'
import { ResearchTimeline } from '../components/ResearchTimeline'
import { toast } from '../components/Toast'

interface KnowledgeNode {
  id: string
  label: string
  tier: string
  source: string
  tags: string[]
  entities: string[]
  createdAt: number
  updatedAt: number
  lastAccessedAt: number
  accessCount: number
  kind: string
  severity?: string
  status?: string
}

interface KnowledgeGraph {
  nodes: KnowledgeNode[]
  edges: Array<{ from: string; to: string; kind: string }>
}

interface MemoryEntry {
  id: string
  tier: string
  source: string
  title: string
  content: string
  tags: string[]
  provenance: string
  confidence: number
  createdAt: number
  updatedAt: number
}

interface RepoStats {
  nodes: number
  edges: number
  byKind: Record<string, number>
}

function provenanceTone(provenance: string): 'success' | 'warning' | 'error' | 'info' | 'muted' {
  if (provenance === 'human-verified') return 'success'
  if (provenance === 'unverified') return 'muted'
  return 'info'
}

export default function IntelligencePage(props: {
  store?: any
  onOpenInChat?: (id: string) => void
} = {}) {
  const [graph, setGraph] = createSignal<KnowledgeGraph | null>(null)
  const [memories, setMemories] = createSignal<MemoryEntry[]>([])
  const [repoStats, setRepoStats] = createSignal<RepoStats | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [state, setState] = createSignal<OperationalState>('loading')
  const intelligenceStore = createIntelligenceFeatureStore()

  // Online Deep Research workbench state
  const [researchQuery, setResearchQuery] = createSignal('')
  const [researchMode, setResearchMode] = createSignal<ResearchMode>('deep-investigation')
  const [spawnBranch, setSpawnBranch] = createSignal(true)
  const [launchingResearch, setLaunchingResearch] = createSignal(false)
  const [activeRun, setActiveRun] = createSignal<ResearchRunDTO | null>(null)
  const [recentRuns, setRecentRuns] = createSignal<ResearchRunDTO[]>([])
  const [providerLabel, setProviderLabel] = createSignal<string>('grounded-web')
  let activeStreamAbort: AbortController | null = null

  onCleanup(() => {
    activeStreamAbort?.abort()
    activeStreamAbort = null
  })

  const repo = createMemo(() => {
    const d = repoStats() as any
    if (!d) return null
    return d.repo ?? (d.nodes !== undefined ? d : null)
  })

  const filteredMemories = createMemo(() => {
    const q = intelligenceStore.state().searchQuery.trim().toLowerCase()
    const tier = intelligenceStore.state().tierFilter
    return memories().filter((m) => {
      if (tier !== 'all' && m.tier !== tier) return false
      if (!q) return true
      return (
        (m.title ?? '').toLowerCase().includes(q) ||
        (m.content ?? '').toLowerCase().includes(q) ||
        (m.tags ?? []).some((t) => t.toLowerCase().includes(q))
      )
    })
  })

  const filteredNodes = createMemo(() => {
    const g = graph()
    if (!g?.nodes) return []
    const q = intelligenceStore.state().searchQuery.trim().toLowerCase()
    const tier = intelligenceStore.state().tierFilter
    return g.nodes.filter((n) => {
      if (tier !== 'all' && n.tier !== tier) return false
      if (!q) return true
      return (
        (n.label ?? '').toLowerCase().includes(q) ||
        (n.source ?? '').toLowerCase().includes(q) ||
        (n.tags ?? []).some((t) => t.toLowerCase().includes(q)) ||
        (n.entities ?? []).some((e) => e.toLowerCase().includes(q))
      )
    })
  })

  const subscribeRun = (runId: string) => {
    activeStreamAbort?.abort()
    const ctrl = new AbortController()
    activeStreamAbort = ctrl
    void api
      .streamResearchRun(
        runId,
        (ev) => {
          if (ev.run) {
            setActiveRun(ev.run)
            setRecentRuns((prev) => [ev.run, ...prev.filter((r) => r.id !== ev.run.id)].slice(0, 12))
          }
        },
        ctrl.signal,
      )
      .catch(() => {})
  }

  const handleLaunchResearch = async (e?: Event) => {
    e?.preventDefault()
    const q = researchQuery().trim()
    if (!q || launchingResearch()) return
    setLaunchingResearch(true)
    try {
      let branchSessionID: string | null = null
      const activeSessionId = props.store?.state?.currentId ?? null
      if (spawnBranch() && activeSessionId) {
        const forked = await api.forkSession(activeSessionId, {
          title: `Research: ${q.slice(0, 48)}`,
          branchKind: 'research',
          hypothesisLabel: q.slice(0, 48),
        })
        branchSessionID = forked.id ?? forked.session?.id ?? null
        props.store?.loadSessions?.()
      }
      const run = await api.startResearchRun({
        query: q,
        mode: researchMode(),
        autoRun: researchMode() === 'quick-grounded',
        sessionID: activeSessionId,
        branchSessionID,
      })
      setActiveRun(run)
      setRecentRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)].slice(0, 12))
      setResearchQuery('')
      subscribeRun(run.id)
    } catch (err) {
      toast.error(`Research failed to start: ${(err as Error).message}`)
    } finally {
      setLaunchingResearch(false)
    }
  }

  const loadIntelligence = async () => {
    setState('loading')
    setError(null)
    try {
      const [g, m, r, runs, status] = await Promise.all([
        req<KnowledgeGraph>('/knowledge/graph').catch(() => null),
        req<MemoryEntry[]>('/memory').catch(() => null),
        req<any>('/dashboard').catch(() => null),
        api.listResearchRuns().catch(() => [] as ResearchRunDTO[]),
        api.researchStatus().catch(() => null),
      ])
      setGraph(g)
      setMemories(Array.isArray(m) ? m : [])
      setRepoStats(r)
      setRecentRuns(runs)
      if (!activeRun() && runs.length > 0) setActiveRun(runs[0]!)
      if (status?.groundingProvider) setProviderLabel(status.groundingProvider)
      const hasNodes = (g?.nodes?.length ?? 0) > 0
      const hasMemories = Array.isArray(m) && m.length > 0
      const hasRepo = (r?.repo?.nodes ?? r?.nodes ?? 0) > 0
      setState(hasNodes || hasMemories || hasRepo || runs.length > 0 ? 'live' : 'empty')
    } catch (e) {
      setError(String(e))
      setState('error')
    }
  }

  onMount(() => {
    void loadIntelligence()
  })

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
              'flex-shrink': '0',
            }}
            aria-hidden="true"
          >
            I
          </div>
          <div style={{ 'min-width': '160px', flex: '1' }}>
            <div style={{ 'font-size': 'var(--fs-lg)', 'font-weight': '700' }}>Intelligence</div>
            <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
              What does Mira know, and why does Mira believe it?
            </div>
          </div>
          <div
            style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}
          >
            <input
              type="text"
              placeholder="Search knowledge…"
              value={intelligenceStore.state().searchQuery}
              onInput={(e) => intelligenceStore.setSearch(e.currentTarget.value)}
              style={{
                padding: '5px 10px',
                'border-radius': 'var(--r-sm)',
                border: '1px solid var(--border)',
                background: 'var(--bg-surface)',
                color: 'var(--fg)',
                'font-size': 'var(--fs-xs)',
                width: '160px',
                'min-height': '32px',
              }}
              aria-label="Search knowledge"
            />
            <select
              value={intelligenceStore.state().tierFilter}
              onChange={(e) =>
                intelligenceStore.setTierFilter(
                  e.currentTarget.value as 'all' | 'episodic' | 'semantic' | 'procedural',
                )
              }
              style={{
                padding: '5px 8px',
                'border-radius': 'var(--r-sm)',
                border: '1px solid var(--border)',
                background: 'var(--bg-surface)',
                color: 'var(--fg)',
                'font-size': 'var(--fs-xs)',
                'min-height': '32px',
              }}
              aria-label="Filter by tier"
            >
              <option value="all">All tiers</option>
              <option value="episodic">Episodic</option>
              <option value="semantic">Semantic</option>
              <option value="procedural">Procedural</option>
            </select>
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => void loadIntelligence()}
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
            <div class="skeleton" style={{ height: '18px', width: '40%' }} />
            <div class="skeleton" style={{ height: '42px', width: '100%' }} />
            <div class="skeleton" style={{ height: '42px', width: '100%' }} />
          </Card>
        </Show>

        <Show when={state() === 'empty'}>
          <Card padding="24px" style={{ 'text-align': 'center', color: 'var(--fg-subtle)', display: 'flex', 'flex-direction': 'column', 'align-items': 'center', gap: '8px' }}>
            <div style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', color: 'var(--fg)' }}>
              No knowledge nodes or memories indexed yet
            </div>
            <div style={{ 'font-size': 'var(--fs-xs)', 'max-width': '48ch', 'line-height': '1.5' }}>
              Memories and repository entities are automatically extracted during Mira sessions.
            </div>
          </Card>
        </Show>

        {/* Live Online Deep Research Workbench */}
        <Card padding="16px" style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
          <SectionHeader
            title="Live Online Deep Research"
            sub={`Grounded web search, URL extraction & collaborative planning (${providerLabel()})`}
          />
          <form
            onSubmit={handleLaunchResearch}
            style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap', 'align-items': 'center' }}
          >
            <input
              type="text"
              value={researchQuery()}
              onInput={(e) => setResearchQuery(e.currentTarget.value)}
              placeholder="Investigate libraries, CVEs, benchmarks, architecture trade-offs…"
              style={{
                flex: '1',
                'min-width': '240px',
                padding: '8px 12px',
                'border-radius': 'var(--r-sm)',
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-surface)',
                color: 'var(--fg)',
                'font-size': 'var(--fs-sm)',
              }}
              aria-label="Online research query"
            />
            <select
              value={researchMode()}
              onChange={(e) => setResearchMode(e.currentTarget.value as ResearchMode)}
              style={{
                padding: '8px 10px',
                'border-radius': 'var(--r-sm)',
                border: '1px solid var(--border)',
                background: 'var(--bg-surface)',
                color: 'var(--fg)',
                'font-size': 'var(--fs-xs)',
              }}
              aria-label="Research depth"
            >
              <option value="deep-investigation">Deep Investigation (Reviewable Plan)</option>
              <option value="quick-grounded">Quick Grounded Answer</option>
            </select>
            <Show when={props.store?.state?.currentId}>
              <label style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                <input
                  type="checkbox"
                  checked={spawnBranch()}
                  aria-label="Isolate research in Mira Branch"
                  onChange={(e) => setSpawnBranch(e.currentTarget.checked)}
                />
                <span>Isolate in Mira Branch</span>
              </label>
            </Show>
            <button
              type="submit"
              class="btn btn-solid"
              disabled={launchingResearch() || !researchQuery().trim()}
              style={{ padding: '8px 14px', 'font-size': 'var(--fs-xs)' }}
            >
              {launchingResearch() ? 'Planning…' : 'Start Research →'}
            </button>
          </form>

          <Show when={recentRuns().length > 0}>
            <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap', 'align-items': 'center' }}>
              <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>Runs:</span>
              <For each={recentRuns().slice(0, 6)}>
                {(r) => (
                  <button
                    type="button"
                    class="btn btn-ghost"
                    onClick={() => {
                      setActiveRun(r)
                      if (r.status === 'running' || r.status === 'planning') subscribeRun(r.id)
                    }}
                    style={{
                      padding: '3px 9px',
                      'font-size': 'var(--fs-xs)',
                      border: activeRun()?.id === r.id ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                      background: activeRun()?.id === r.id ? 'var(--accent-soft)' : 'var(--bg-surface)',
                      color: activeRun()?.id === r.id ? 'var(--accent)' : 'var(--fg-muted)',
                      'border-radius': 'var(--r-sm)',
                    }}
                  >
                    {r.query.slice(0, 34)}{r.query.length > 34 ? '…' : ''} · {r.status}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={activeRun()}>
            {(run) => (
              <ResearchTimeline
                run={run()}
                onUpdated={(updated) => {
                  setActiveRun(updated)
                  setRecentRuns((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
                  if (updated.status === 'running') subscribeRun(updated.id)
                }}
                onPromoted={() => void loadIntelligence()}
                onOpenBranch={props.onOpenInChat}
              />
            )}
          </Show>
        </Card>

        {/* Knowledge Graph — Progressive Disclosure */}
        <Show when={graph()}>
          {(g) => (
            <Card padding="0">
              <div style={{ padding: '12px 16px', 'border-bottom': '1px solid var(--border)' }}>
                <SectionHeader
                  title="Knowledge Graph"
                  sub={`${g().nodes.length} nodes · ${g().edges.length} edges`}
                />
              </div>
              <For each={filteredNodes().slice(0, 30)}>
                {(n) => (
                  <ProgressiveDisclosure
                    title={n.label}
                    metric={`${n.accessCount ?? 0} accesses`}
                    badgeLabel={n.tier}
                    badgeTone="info"
                  >
                    <div
                      style={{
                        display: 'flex',
                        'flex-direction': 'column',
                        gap: '6px',
                        'font-size': 'var(--fs-xs)',
                      }}
                    >
                      <div style={{ display: 'flex', gap: '12px', 'flex-wrap': 'wrap' }}>
                        <span style={{ color: 'var(--fg-subtle)' }}>Source: {n.source}</span>
                        <span style={{ color: 'var(--fg-subtle)' }}>Kind: {n.kind}</span>
                      </div>
                      <Show when={(n.tags ?? []).length > 0}>
                        <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
                          <For each={n.tags ?? []}>
                            {(tag) => <StatusBadge label={tag} tone="muted" />}
                          </For>
                        </div>
                      </Show>
                      <Show when={(n.entities ?? []).length > 0}>
                        <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
                          <For each={n.entities ?? []}>
                            {(entity) => <StatusBadge label={entity} tone="info" />}
                          </For>
                        </div>
                      </Show>
                      <div style={{ display: 'flex', gap: '12px', color: 'var(--fg-faint)' }}>
                        <span>Created: {new Date(n.createdAt).toLocaleDateString()}</span>
                        <span>Updated: {new Date(n.updatedAt).toLocaleDateString()}</span>
                        <span>Last access: {new Date(n.lastAccessedAt).toLocaleDateString()}</span>
                      </div>
                      <Show when={n.severity}>
                        <div style={{ color: 'var(--warn)' }}>Severity: {n.severity}</div>
                      </Show>
                      <Show when={n.status}>
                        <div style={{ color: 'var(--fg-subtle)' }}>Status: {n.status}</div>
                      </Show>
                    </div>
                  </ProgressiveDisclosure>
                )}
              </For>
            </Card>
          )}
        </Show>

        {/* Memory — Progressive Disclosure */}
        <Show when={filteredMemories().length > 0}>
          <Card padding="0">
            <div style={{ padding: '12px 16px', 'border-bottom': '1px solid var(--border)' }}>
              <SectionHeader title="Memory" sub={`${filteredMemories().length} entries`} />
            </div>
            <For each={filteredMemories().slice(0, 30)}>
              {(m) => (
                <ProgressiveDisclosure
                  title={m.title}
                  metric={`${((m.confidence ?? 0.5) * 100).toFixed(0)}%`}
                  badgeLabel={m.provenance}
                  badgeTone={provenanceTone(m.provenance)}
                >
                  <div
                    style={{
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '6px',
                      'font-size': 'var(--fs-xs)',
                    }}
                  >
                    <div style={{ color: 'var(--fg-subtle)', 'line-height': '1.5' }}>
                      {m.content}
                    </div>
                    <div style={{ display: 'flex', gap: '12px', 'flex-wrap': 'wrap' }}>
                      <span style={{ color: 'var(--fg-subtle)' }}>Tier: {m.tier}</span>
                      <span style={{ color: 'var(--fg-subtle)' }}>Source: {m.source}</span>
                    </div>
                    <Show when={(m.tags ?? []).length > 0}>
                      <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
                        <For each={m.tags ?? []}>{(tag) => <StatusBadge label={tag} tone="muted" />}</For>
                      </div>
                    </Show>
                    <div style={{ display: 'flex', gap: '12px', color: 'var(--fg-faint)' }}>
                      <span>Created: {new Date(m.createdAt).toLocaleDateString()}</span>
                      <span>Updated: {new Date(m.updatedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                </ProgressiveDisclosure>
              )}
            </For>
          </Card>
        </Show>

        {/* Repository Understanding */}
        <Show when={repo()}>
          {(r) => (
            <Card padding="16px">
              <SectionHeader title="Repository Understanding" sub="Codebase structure overview" />
              <div style={{ display: 'flex', gap: '16px', 'flex-wrap': 'wrap' }}>
                <span style={{ 'font-size': 'var(--fs-sm)' }}>{r().nodes ?? 0} nodes</span>
                <span style={{ 'font-size': 'var(--fs-sm)' }}>{r().edges ?? 0} edges</span>
                <For each={Object.entries(r().byKind ?? {})}>
                  {([kind, count]) => (
                    <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                      {kind}: {count}
                    </span>
                  )}
                </For>
              </div>
            </Card>
          )}
        </Show>
      </div>
    </div>
  )
}
