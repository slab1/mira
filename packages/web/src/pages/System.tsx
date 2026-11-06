// @ts-nocheck
import { createSignal, onMount, Show, For } from 'solid-js'
import { req } from '../api/client'
import { DataStateBadge, type OperationalState } from '../components/DataState'
import { AuditTrail } from '../components/AuditTrail'
import { Card, SectionHeader, StatusRow } from '../components/DesignSystem'

interface HealthStatus {
  status: string
  healthy: boolean
  ok?: boolean
  version?: string
  uptime?: number
  tools?: number
  mcp?: number
  providers?: number
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

interface EngineEntry {
  id: string
  version: string
  capabilities: string[]
}

interface EngineHealthMap {
  ok: boolean
  count: number
  health: Record<string, { id: string; version: string; status: 'healthy' | 'degraded' | 'unhealthy'; latencyMs: number; message?: string }>
}

export default function SystemPage() {
  const [health, setHealth] = createSignal<HealthStatus | null>(null)
  const [config, setConfig] = createSignal<SystemConfig | null>(null)
  const [dashboard, setDashboard] = createSignal<DashboardData | null>(null)
  const [engines, setEngines] = createSignal<EngineEntry[]>([])
  const [engineHealth, setEngineHealth] = createSignal<Record<string, { id: string; version: string; status: string; latencyMs: number; message?: string }>>({})
  const [error, setError] = createSignal<string | null>(null)
  const [state, setState] = createSignal<OperationalState>('loading')

  onMount(async () => {
    try {
      const [h, c, d, engRes, healthRes] = await Promise.all([
        req<HealthStatus>('/health').catch(() => null),
        req<SystemConfig>('/config').catch(() => null),
        req<DashboardData>('/dashboard').catch(() => null),
        req<{ ok: boolean; engines: EngineEntry[] }>('/engines').catch(() => ({ ok: false, engines: [] })),
        req<EngineHealthMap>('/engines/health').catch(() => ({ ok: false, count: 0, health: {} })),
      ])
      setHealth(h)
      setConfig(c)
      setDashboard(d)
      if (engRes?.engines) setEngines(engRes.engines)
      if (healthRes?.health) setEngineHealth(healthRes.health)
      setState(h || c || engRes?.ok ? 'live' : 'empty')
    } catch (e) {
      setError(String(e))
      setState('error')
    }
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
        <Card padding="14px 16px" style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
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
            S
          </div>
          <div>
            <div style={{ 'font-size': 'var(--fs-lg)', 'font-weight': '700' }}>System Control Center</div>
            <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
              Operational governance, 15 modular engines, runtime health, and resource monitoring
            </div>
          </div>
          <div style={{ 'margin-left': 'auto' }}>
            <DataStateBadge state={state()} />
          </div>
        </Card>

        <Show when={error()}>
          <div class="card" style={{ padding: '12px 16px', color: 'var(--danger)' }}>
            Error: {error()}
          </div>
        </Show>

        {/* Server & Runtime Health */}
        <Show when={health()}>
          {(h) => (
            <Card padding="16px">
              <SectionHeader title="Server Health & Runtime" sub="Core server daemon status and resource allocation" />
              <StatusRow label="Status" value={h().status || (h().ok ? 'healthy' : 'degraded')} ok={h().healthy ?? h().ok} />
              <Show when={h().version}>
                <StatusRow label="Version" value={h().version!} />
              </Show>
              <Show when={h().uptime}>
                <StatusRow label="Uptime" value={`${Math.floor(h().uptime! / 60)} min`} />
              </Show>
              <Show when={h().tools !== undefined}>
                <StatusRow label="Registered Tools" value={String(h().tools)} />
              </Show>
            </Card>
          )}
        </Show>

        {/* 15 Modular Engines Health */}
        <Card padding="16px">
          <SectionHeader
            title="Modular Engine Registry"
            sub="15 core engines & flagship initiatives (Evolution, Shadow, Ledger, Research, Patch, Self-Healing)"
          />
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px', 'margin-top': '8px' }}>
            <For each={engines()}>
              {(eng) => {
                const rep = () => engineHealth()[eng.id]
                const status = () => rep()?.status ?? 'healthy'
                const ok = () => status() === 'healthy'
                const latency = () => (rep()?.latencyMs !== undefined ? `${rep()!.latencyMs}ms` : '—')
                const message = () => rep()?.message ? ` · ${rep()!.message}` : ''
                return (
                  <StatusRow
                    label={`${eng.id} (v${eng.version})`}
                    value={`${status().toUpperCase()} (${latency()}${message()})`}
                    ok={ok()}
                  />
                )
              }}
            </For>
            <Show when={engines().length === 0}>
              <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', padding: '6px 0' }}>
                Connecting to Engine Registry...
              </div>
            </Show>
          </div>
        </Card>

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
                <StatusRow
                  label="Guardrails"
                  value={c().guardrails!.enforce ? 'Enforced' : 'Disabled'}
                  ok={c().guardrails!.enforce}
                />
              </Show>
            </Card>
          )}
        </Show>

        {/* Operations Category */}
        <Show when={dashboard()}>
          {(d) => (
            <Card padding="16px">
              <SectionHeader title="Operations Summary" sub="Operational metrics aggregated across all agents and sessions" />
              <StatusRow label="Agents" value={String(d().agents.total)} />
              <StatusRow label="Proposals" value={String(d().governance.totalProposals)} />
              <StatusRow label="Memories" value={String(d().learning.totalMemories)} />
              <StatusRow label="Open Items" value={String(d().workspace.openItems)} />
              <StatusRow label="Repo Nodes" value={String(d().repo.nodes)} />
              <StatusRow
                label="Total Cost"
                value={`${(d().cost.totalTokens / 1000000).toFixed(1)}M tokens`}
              />
            </Card>
          )}
        </Show>

        {/* Audit Trail Category (P3.2) — admin-gated server-side */}
        <AuditTrail />
      </div>
    </div>
  )
}
