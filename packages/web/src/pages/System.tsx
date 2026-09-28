import { createSignal, onMount, Show, For } from 'solid-js'
import { req } from '../api/client'
import { DataStateBadge, type OperationalState } from '../components/DataState'
import { createSystemFeatureStore } from '../features/system'
import { Card, SectionHeader, StatusRow } from '../components/DesignSystem'
import { ScopeTransparency } from '../components/ScopeTransparency'

interface HealthStatus {
  status: string
  healthy: boolean
  engines?: Record<string, { status: string; healthy: boolean }>
}

interface SystemConfig {
  model: string
  provider: string
  loop?: { maxSteps?: number; contextLimit?: number }
  guardrails?: { enforce?: boolean }
}

interface DashboardData {
  agents: { total: number; avgReliability: number }
  governance: { totalProposals: number }
  learning: { totalMemories: number }
  workspace: { openItems: number }
  repo: { nodes: number; edges: number }
  cost: { totalTokens: number; totalRuns: number }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(res.status + ' ' + (await res.text().catch(() => '')))
  return (await res.json()) as T
}

export default function SystemPage() {
  const [health, setHealth] = createSignal<HealthStatus | null>(null)
  const [config, setConfig] = createSignal<SystemConfig | null>(null)
  const [dashboard, setDashboard] = createSignal<DashboardData | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [state, setState] = createSignal<OperationalState>('loading')
  const systemStore = createSystemFeatureStore()

  onMount(async () => {
    try {
      const [h, c, d] = await Promise.all([
        getJson<HealthStatus>('/health').catch(() => null),
        getJson<SystemConfig>('/config').catch(() => null),
        getJson<DashboardData>('/dashboard').catch(() => null),
      ])
      setHealth(h)
      setConfig(c)
      setDashboard(d)
      setState(h || c ? 'live' : 'empty')
    } catch (e) {
      setError(String(e))
      setState('error')
    }
  })

  return (
    <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', overflow: 'auto', background: 'var(--bg-canvas)', padding: '18px 14px 28px' }}>
      <div style={{ 'max-width': '1100px', margin: '0 auto', width: '100%', display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
        <Card padding="14px 16px" style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
          <div style={{ width: '28px', height: '28px', 'border-radius': '8px', background: 'var(--grad-brand)', display: 'grid', 'place-items': 'center', color: 'var(--on-accent)', 'font-weight': '800', 'font-size': '14px' }} aria-hidden="true">S</div>
          <div>
            <div style={{ 'font-size': 'var(--fs-lg)', 'font-weight': '700' }}>System</div>
            <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>Operational control center — health, config, resources</div>
          </div>
          <div style={{ 'margin-left': 'auto' }}>
            <DataStateBadge state={state()} />
          </div>
        </Card>

        <Show when={error()}>
          <div class="card" style={{ padding: '12px 16px', color: 'var(--danger)' }}>Error: {error()}</div>
        </Show>

        {/* Health Category */}
        <Show when={health()}>
          {(h) => (
            <Card padding="16px">
              <SectionHeader title="Health" sub="Server status and engine health" />
              <StatusRow label="Status" value={h().status} ok={h().healthy} />
              <Show when={h().engines}>
                <For each={Object.entries(h().engines!).slice(0, 4)}>
                  {([name, eng]) => <StatusRow label={name} value={eng.status} ok={eng.healthy} />}
                </For>
              </Show>
            </Card>
          )}
        </Show>

        {/* Config Category */}
        <Show when={config()}>
          {(c) => (
            <Card padding="16px">
              <SectionHeader title="Configuration" sub="Model, provider, and loop settings" />
              <StatusRow label="Model" value={c().model} />
              <StatusRow label="Provider" value={c().provider} />
              <Show when={c().loop?.maxSteps}>
                <StatusRow label="Max Steps" value={String(c().loop!.maxSteps)} />
              </Show>
              <Show when={c().loop?.contextLimit}>
                <StatusRow label="Context Limit" value={String(c().loop!.contextLimit)} />
              </Show>
              <Show when={c().guardrails?.enforce !== undefined}>
                <StatusRow label="Guardrails" value={c().guardrails!.enforce ? 'Enforced' : 'Disabled'} ok={c().guardrails!.enforce} />
              </Show>
            </Card>
          )}
        </Show>

        {/* Operations Category */}
        <Show when={dashboard()}>
          {(d) => (
            <Card padding="16px">
              <SectionHeader title="Operations" sub="Operational metrics summary" />
              <StatusRow label="Agents" value={String(d().agents.total)} />
              <StatusRow label="Proposals" value={String(d().governance.totalProposals)} />
              <StatusRow label="Memories" value={String(d().learning.totalMemories)} />
              <StatusRow label="Open Items" value={String(d().workspace.openItems)} />
              <StatusRow label="Repo Nodes" value={String(d().repo.nodes)} />
              <StatusRow label="Total Cost" value={`${(d().cost.totalTokens / 1000000).toFixed(1)}M tokens`} />
            </Card>
          )}
        </Show>
      </div>
    </div>
  )
}
