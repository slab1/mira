import { createSignal, onMount, Show, For } from 'solid-js'
import { req } from '../api/client'
import { Card, SectionHeader } from '../components/DesignSystem'
import { KeyMetricsSection, DetailsSection, AlertSection, type KeyMetric, type AlertItem } from '../components/InfoHierarchy'
import { ScopeTransparency } from '../components/ScopeTransparency'

interface DashboardData {
  agents: { total: number; avgReliability: number; topPerformer: string | null; stats: Array<{ agent: string; runs: number; reliabilityScore: number; successRate: number }> }
  governance: { totalProposals: number; byState: Record<string, number>; recentTransitions: Array<{ proposalId: string; from: string; to: string; at: number }> }
  learning: { totalMemories: number; byProvenance: Record<string, number>; qualityScores: Array<{ memoryId: string; qualityScore: number; recommendation: string }>; retirementCandidates: number }
  workspace: { summary: Record<string, number>; openItems: number }
  repo: { nodes: number; edges: number; byKind: Record<string, number> }
  cost: { totalTokens: number; totalRuns: number; avgCostPerRun: number }
}

export default function DashboardPage() {
  const [data, setData] = createSignal<DashboardData | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  onMount(async () => {
    try {
      const d = await req<DashboardData>('/dashboard')
      setData(d)
    } catch (e) {
      setError(String(e))
    }
  })

  const d = data()

  const metrics = (): KeyMetric[] => {
    if (!d) return []
    return [
      { label: 'Agents', value: d.agents.total, sub: `avg reliability ${(d.agents.avgReliability * 100).toFixed(0)}%` },
      { label: 'Top Performer', value: d.agents.topPerformer ?? '—' },
      { label: 'Proposals', value: d.governance.totalProposals, sub: `${Object.keys(d.governance.byState).length} states` },
      { label: 'Memories', value: d.learning.totalMemories, sub: `${d.learning.retirementCandidates} to retire` },
      { label: 'Open Items', value: d.workspace.openItems },
      { label: 'Repo Nodes', value: d.repo.nodes, sub: `${d.repo.edges} edges` },
      { label: 'Total Cost', value: `${(d.cost.totalTokens / 1000000).toFixed(1)}M`, sub: `tokens across ${d.cost.totalRuns} runs` },
    ]
  }

  const alerts = (): AlertItem[] => {
    if (!d) return []
    const items: AlertItem[] = []
    if (d.learning.retirementCandidates > 0) {
      items.push({ message: `${d.learning.retirementCandidates} memories flagged for retirement`, tone: 'warning' })
    }
    if (d.workspace.openItems > 10) {
      items.push({ message: `${d.workspace.openItems} open workspace items require attention`, tone: 'info' })
    }
    return items
  }

  return (
    <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', overflow: 'auto', background: 'var(--bg-canvas)', padding: '18px 14px 28px' }}>
      <div style={{ 'max-width': '1100px', margin: '0 auto', width: '100%', display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
        <Card padding="14px 16px" style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
          <div style={{ width: '28px', height: '28px', 'border-radius': '8px', background: 'var(--grad-brand)', display: 'grid', 'place-items': 'center', color: 'var(--on-accent)', 'font-weight': '800', 'font-size': '14px' }} aria-hidden="true">D</div>
          <div>
            <div style={{ 'font-size': 'var(--fs-lg)', 'font-weight': '700' }}>Engineering Dashboard</div>
            <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>Unified visibility into agents, governance, learning, workspace, repo, and cost</div>
          </div>
        </Card>

        <Show when={error()}>
          <div class="card" style={{ padding: '12px 16px', color: 'var(--danger)' }}>Error: {error()}</div>
        </Show>

        <Show when={d}>
          <AlertSection alerts={alerts()} />`n          <ScopeTransparency workspace="dashboard" />

          <KeyMetricsSection metrics={metrics()} maxVisible={7} />

          <DetailsSection title="Agent Reliability" sub="Per-agent run counts and reliability scores">
            <For each={d!.agents.stats}>
              {(a) => (
                <div style={{ display: 'flex', 'justify-content': 'space-between', 'padding': '6px 0', 'border-bottom': '1px solid var(--border)' }}>
                  <span style={{ 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-sm)' }}>{a.agent}</span>
                  <span style={{ 'font-size': 'var(--fs-sm)', color: 'var(--fg-subtle)' }}>{a.runs} runs · {(a.reliabilityScore * 100).toFixed(0)}% reliable · {(a.successRate * 100).toFixed(0)}% success</span>
                </div>
              )}
            </For>
          </DetailsSection>

          <DetailsSection title="Governance Proposals by State" sub="Current proposal distribution">
            <For each={Object.entries(d!.governance.byState)}>
              {([state, count]) => (
                <div style={{ display: 'flex', 'justify-content': 'space-between', 'padding': '4px 0' }}>
                  <span style={{ 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-sm)' }}>{state}</span>
                  <span style={{ 'font-size': 'var(--fs-sm)', color: 'var(--fg-subtle)' }}>{count}</span>
                </div>
              )}
            </For>
          </DetailsSection>

          <DetailsSection title="Memory Quality" sub="Quality scores and recommendations">
            <For each={d!.learning.qualityScores.slice(0, 10)}>
              {(m) => (
                <div style={{ display: 'flex', 'justify-content': 'space-between', 'padding': '4px 0' }}>
                  <span style={{ 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-sm)' }}>{m.memoryId}</span>
                  <span style={{ 'font-size': 'var(--fs-sm)', color: m.recommendation === 'retire' ? 'var(--danger)' : m.recommendation === 'keep' ? 'var(--ok)' : 'var(--fg-subtle)' }}>
                    {m.qualityScore.toFixed(2)} · {m.recommendation}
                  </span>
                </div>
              )}
            </For>
          </DetailsSection>
        </Show>
      </div>
    </div>
  )
}
