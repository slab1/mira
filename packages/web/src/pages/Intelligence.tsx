import { createSignal, onMount, Show, For } from 'solid-js'
import { req } from '../api/client'
import { DataStateBadge, type OperationalState } from '../components/DataState'
import { createIntelligenceFeatureStore } from '../features/intelligence'
import { Card, SectionHeader, StatusBadge } from '../components/DesignSystem'
import { ProgressiveDisclosure } from '../components/ProgressiveDisclosure'
import { ScopeTransparency } from '../components/ScopeTransparency'

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

interface RepoNode {
  id: string
  kind: string
  name: string
  path?: string
  updatedAt: number
}

interface RepoStats {
  nodes: number
  edges: number
  byKind: Record<string, number>
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(res.status + ' ' + (await res.text().catch(() => '')))
  return (await res.json()) as T
}

function provenanceTone(provenance: string): 'success' | 'warning' | 'error' | 'info' | 'muted' {
  if (provenance === 'human-verified') return 'success'
  if (provenance === 'unverified') return 'muted'
  return 'info'
}

export default function IntelligencePage() {
  const [graph, setGraph] = createSignal<KnowledgeGraph | null>(null)
  const [memories, setMemories] = createSignal<MemoryEntry[]>([])
  const [repoStats, setRepoStats] = createSignal<RepoStats | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [state, setState] = createSignal<OperationalState>('loading')
  const intelligenceStore = createIntelligenceFeatureStore()

  onMount(async () => {
    try {
      const [g, m, r] = await Promise.all([
        getJson<KnowledgeGraph>('/knowledge/graph').catch(() => null),
        getJson<MemoryEntry[]>('/memory').catch(() => null),
        getJson<RepoStats>('/dashboard').catch(() => null),
      ])
      setGraph(g)
      setMemories(m ?? [])
      setRepoStats(r)
      setState(g || m ? 'live' : 'empty')
    } catch (e) {
      setError(String(e))
      setState('error')
    }
  })

  return (
    <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', overflow: 'auto', background: 'var(--bg-canvas)', padding: '18px 14px 28px' }}>
      <div style={{ 'max-width': '1100px', margin: '0 auto', width: '100%', display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
        <Card padding="14px 16px" style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
          <div style={{ width: '28px', height: '28px', 'border-radius': '8px', background: 'var(--grad-brand)', display: 'grid', 'place-items': 'center', color: 'var(--on-accent)', 'font-weight': '800', 'font-size': '14px' }} aria-hidden="true">I</div>
          <div>
            <div style={{ 'font-size': 'var(--fs-lg)', 'font-weight': '700' }}>Intelligence</div>
            <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>What does Mira know, and why does Mira believe it?</div>
          </div>
          <div style={{ 'margin-left': 'auto', display: 'flex', 'align-items': 'center', 'gap': '8px' }}>
            <input
              type="text"
              placeholder="Search knowledge..."
              value={intelligenceStore.state().searchQuery}
              onInput={(e) => intelligenceStore.setSearch(e.currentTarget.value)}
              style={{ padding: '4px 8px', 'border-radius': '4px', border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--fg)', 'font-size': 'var(--fs-xs)', width: '160px' }}
              aria-label="Search knowledge"
            />
            <select
              value={intelligenceStore.state().tierFilter}
              onChange={(e) => intelligenceStore.setTierFilter(e.currentTarget.value as 'all' | 'episodic' | 'semantic' | 'procedural')}
              style={{ padding: '4px 8px', 'border-radius': '4px', border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--fg)', 'font-size': 'var(--fs-xs)' }}
              aria-label="Filter by tier"
            >
              <option value="all">All tiers</option>
              <option value="episodic">Episodic</option>
              <option value="semantic">Semantic</option>
              <option value="procedural">Procedural</option>
            </select>
            <DataStateBadge state={state()} />
          </div>
        </Card>

        <Show when={error()}>
          <div class="card" style={{ padding: '12px 16px', color: 'var(--danger)' }}>Error: {error()}</div>
        </Show>

        {/* Knowledge Graph — Progressive Disclosure */}
        <Show when={graph()}>
          {(g) => (
            <Card padding="0">
              <div style={{ padding: '12px 16px', 'border-bottom': '1px solid var(--border)' }}>
                <SectionHeader title="Knowledge Graph" sub={`${g().nodes.length} nodes · ${g().edges.length} edges`} />
              </div>
              <For each={g().nodes.slice(0, 20)}>
                {(n) => (
                  <ProgressiveDisclosure
                    title={n.label}
                    metric={`${n.accessCount} accesses`}
                    badgeLabel={n.tier}
                    badgeTone="info"
                  >
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', 'font-size': 'var(--fs-xs)' }}>
                      <div style={{ display: 'flex', 'gap': '12px', 'flex-wrap': 'wrap' }}>
                        <span style={{ color: 'var(--fg-subtle)' }}>Source: {n.source}</span>
                        <span style={{ color: 'var(--fg-subtle)' }}>Kind: {n.kind}</span>
                      </div>
                      <Show when={n.tags.length > 0}>
                        <div style={{ display: 'flex', 'gap': '6px', 'flex-wrap': 'wrap' }}>
                          <For each={n.tags}>
                            {(tag) => <StatusBadge label={tag} tone="muted" />}
                          </For>
                        </div>
                      </Show>
                      <Show when={n.entities.length > 0}>
                        <div style={{ display: 'flex', 'gap': '6px', 'flex-wrap': 'wrap' }}>
                          <For each={n.entities}>
                            {(entity) => <StatusBadge label={entity} tone="info" />}
                          </For>
                        </div>
                      </Show>
                      <div style={{ display: 'flex', 'gap': '12px', color: 'var(--fg-faint)' }}>
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
        <Show when={memories().length > 0}>
          <Card padding="0">
            <div style={{ padding: '12px 16px', 'border-bottom': '1px solid var(--border)' }}>
              <SectionHeader title="Memory" sub={`${memories().length} entries`} />
            </div>
            <For each={memories().slice(0, 10)}>
              {(m) => (
                <ProgressiveDisclosure
                  title={m.title}
                  metric={`${(m.confidence * 100).toFixed(0)}%`}
                  badgeLabel={m.provenance}
                  badgeTone={provenanceTone(m.provenance)}
                >
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', 'font-size': 'var(--fs-xs)' }}>
                    <div style={{ color: 'var(--fg-subtle)', 'line-height': '1.5' }}>{m.content}</div>
                    <div style={{ display: 'flex', 'gap': '12px', 'flex-wrap': 'wrap' }}>
                      <span style={{ color: 'var(--fg-subtle)' }}>Tier: {m.tier}</span>
                      <span style={{ color: 'var(--fg-subtle)' }}>Source: {m.source}</span>
                    </div>
                    <Show when={m.tags.length > 0}>
                      <div style={{ display: 'flex', 'gap': '6px', 'flex-wrap': 'wrap' }}>
                        <For each={m.tags}>
                          {(tag) => <StatusBadge label={tag} tone="muted" />}
                        </For>
                      </div>
                    </Show>
                    <div style={{ display: 'flex', 'gap': '12px', color: 'var(--fg-faint)' }}>
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
        <Show when={repoStats()}>
          {(r) => (
            <Card padding="16px">
              <SectionHeader title="Repository Understanding" sub="Codebase structure overview" />
              <div style={{ display: 'flex', 'gap': '16px', 'flex-wrap': 'wrap' }}>
                <span style={{ 'font-size': 'var(--fs-sm)' }}>{r().nodes} nodes</span>
                <span style={{ 'font-size': 'var(--fs-sm)' }}>{r().edges} edges</span>
                <For each={Object.entries(r().byKind)}>
                  {([kind, count]) => (
                    <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>{kind}: {count}</span>
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
