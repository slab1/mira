// @ts-nocheck
import { createSignal, onMount, Show, For } from 'solid-js'
import { req } from '../api/client'
import { Card, SectionHeader } from '../components/DesignSystem'
import {
  KeyMetricsSection,
  DetailsSection,
  AlertSection,
  type KeyMetric,
  type AlertItem,
} from '../components/InfoHierarchy'
import { ScopeTransparency } from '../components/ScopeTransparency'

interface DashboardData {
  agents: {
    total: number
    avgReliability: number
    topPerformer: string | null
    stats: Array<{ agent: string; runs: number; reliabilityScore: number; successRate: number }>
  }
  governance: {
    totalProposals: number
    byState: Record<string, number>
    recentTransitions: Array<{ proposalId: string; from: string; to: string; at: number }>
  }
  learning: {
    totalMemories: number
    byProvenance: Record<string, number>
    qualityScores: Array<{ memoryId: string; qualityScore: number; recommendation: string }>
    retirementCandidates: number
  }
  workspace: { summary: Record<string, number>; openItems: number }
  repo: { nodes: number; edges: number; byKind: Record<string, number> }
  cost: { totalTokens: number; totalRuns: number; avgCostPerRun: number }
}

interface EngineItem {
  id: string
  version: string
  capabilities: string[]
}

interface EngineHealthMap {
  ok: boolean
  count: number
  health: Record<string, { id: string; status: 'healthy' | 'degraded' | 'unhealthy'; latencyMs: number; message?: string; capabilities: string[] }>
}

interface AgentTemplateItem {
  name: string
  description: string
  tools: string[]
  permissions: 'readonly' | 'standard' | 'elevated'
}

export default function DashboardPage() {
  const [data, setData] = createSignal<DashboardData | null>(null)
  const [engines, setEngines] = createSignal<EngineItem[]>([])
  const [engineHealth, setEngineHealth] = createSignal<Record<string, { id: string; status: string; latencyMs: number; message?: string }>>({})
  const [agentTemplates, setAgentTemplates] = createSignal<AgentTemplateItem[]>([])
  const [error, setError] = createSignal<string | null>(null)

  const [loading, setLoading] = createSignal(true)

  const loadDashboard = async () => {
    setLoading(true)
    setError(null)
    try {
      const [dashRes, engRes, healthRes, agentsRes] = await Promise.all([
        req<DashboardData>('/dashboard').catch(() => null),
        req<{ ok: boolean; engines: EngineItem[] }>('/engines').catch(() => ({ ok: false, engines: [] })),
        req<EngineHealthMap>('/engines/health').catch(() => ({ ok: false, count: 0, health: {} })),
        req<AgentTemplateItem[]>('/agents').catch(() => []),
      ])
      if (dashRes) setData(dashRes)
      if (engRes?.engines) setEngines(engRes.engines)
      if (healthRes?.health) setEngineHealth(healthRes.health)
      if (Array.isArray(agentsRes)) setAgentTemplates(agentsRes)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void loadDashboard()
  })

  const d = () => data()

  const metrics = (): KeyMetric[] => {
    const list: KeyMetric[] = []
    const healthEntries = Object.values(engineHealth())
    const engTotal = engines().length || healthEntries.length
    const healthyEngs = healthEntries.filter((h) => h.status === 'healthy').length
    list.push({
      label: 'Engines Active',
      value: engTotal > 0 ? `${healthyEngs}/${engTotal}` : 'Unknown',
      sub: 'modular engines in registry',
    })

    const specAgentsCount = agentTemplates().filter((a) =>
      ['architect', 'developer', 'reviewer', 'security', 'qa', 'devops', 'researcher', 'memory-manager'].includes(a.name) ||
      a.name.startsWith('mira-')
    ).length
    list.push({
      label: 'Specialized Agents',
      value: specAgentsCount > 0 ? `${specAgentsCount}` : `${agentTemplates().length || '—'}`,
      sub: 'orchestrated lane personas',
    })

    const dash = d()
    if (dash) {
      list.push(
        {
          label: 'Total Agents',
          value: dash.agents.total || agentTemplates().length || 0,
          sub: `avg reliability ${(dash.agents.avgReliability * 100).toFixed(0)}%`,
        },
        { label: 'Top Performer', value: dash.agents.topPerformer ?? '—' },
        {
          label: 'Proposals',
          value: dash.governance.totalProposals,
          sub: `${Object.keys(dash.governance.byState).length} states`,
        },
        {
          label: 'Memories',
          value: dash.learning.totalMemories,
          sub: `${dash.learning.retirementCandidates} to retire`,
        },
        {
          label: 'Total Cost',
          value: `${(dash.cost.totalTokens / 1000000).toFixed(1)}M`,
          sub: `tokens across ${dash.cost.totalRuns} runs`,
        },
      )
    }
    return list
  }

  const alerts = (): AlertItem[] => {
    const dash = d()
    if (!dash) return []
    const items: AlertItem[] = []
    if (dash.learning.retirementCandidates > 0) {
      items.push({
        message: `${dash.learning.retirementCandidates} memories flagged for retirement`,
        tone: 'warning',
      })
    }
    if (dash.workspace.openItems > 10) {
      items.push({
        message: `${dash.workspace.openItems} open workspace items require attention`,
        tone: 'info',
      })
    }
    return items
  }

  // 7 Flagship Engineering Initiatives
  const flagshipInitiatives = [
    {
      id: 'evolution',
      name: 'Evolution Engine',
      desc: 'Closed-loop self-improvement, autonomous proposal lifecycle & canary verification gates',
      capabilities: ['lifecycle', 'canary-gate', 'governance', 'self-improvement'],
    },
    {
      id: 'shadow',
      name: 'Shadow Mira',
      desc: 'Isolated shadow execution & candidate vs production benchmarking before live traffic',
      capabilities: ['isolated-benchmark', 'candidate-eval', 'traffic-replay', 'shadow-runs'],
    },
    {
      id: 'registry',
      name: 'Engine Registry',
      desc: 'Central registry governing 15 modular engines with health, benchmarks, upgrade, and rollback',
      capabilities: ['registry-core', 'modular-discovery', 'versioning', 'rollback-control'],
    },
    {
      id: 'ledger',
      name: 'Improvement Ledger',
      desc: 'Tamper-evident append-only ledger tracking all mutations, verifications, and rollbacks',
      capabilities: ['audit-trail', 'append-only', 'hash-chaining', 'merkle-verification'],
    },
    {
      id: 'research',
      name: 'Research Lab',
      desc: 'Strict trust boundary sanitizing external literature, hypothesis formulation & corroboration',
      capabilities: ['literature-survey', 'hypothesis-testing', 'variant-exploration', 'trust-boundary'],
    },
    {
      id: 'patch',
      name: 'Autonomous Patch Engine',
      desc: 'Hash-anchored AST patcher with 9-layer fallback, automatic file snapshots & zero regression',
      capabilities: ['autonomous-patching', 'ast-diff', 'verification-gates', 'rollback-safety'],
    },
    {
      id: 'self-healing',
      name: 'Self-Healing Engine',
      desc: 'Automated failure diagnosis, anomaly detection, root cause classification & self-recovery',
      capabilities: ['anomaly-detection', 'autonomous-debugging', 'self-recovery', 'diagnosis-taxonomy'],
    },
  ]

  // 8 Specialized Mira Agents
  const specializedAgents = [
    {
      id: 'mira-architect',
      name: 'Mira Architect',
      title: 'Systems & Architecture',
      posture: 'readonly',
      desc: 'Evaluates designs, trade-offs, schemas, modular boundaries, and migration strategies.',
    },
    {
      id: 'mira-developer',
      name: 'Mira Developer',
      title: 'Autonomous Implementation',
      posture: 'standard',
      desc: 'Writes clean typed code, implements features, minimal diffs, and verifies before done.',
    },
    {
      id: 'mira-reviewer',
      name: 'Mira Reviewer',
      title: 'Code Analysis & Quality',
      posture: 'standard',
      desc: 'Critiques code for correctness, performance, and style with file:line severity ratings.',
    },
    {
      id: 'mira-security',
      name: 'Mira Security',
      title: 'Vulnerability & Hardening',
      posture: 'readonly',
      desc: 'Maps attack surface, inspects authz/authn, validates secret isolation and injection risks.',
    },
    {
      id: 'mira-qa',
      name: 'Mira QA',
      title: 'Testing & Verification',
      posture: 'standard',
      desc: 'Designs comprehensive test plans, edge cases, regression suites, and acceptance gates.',
    },
    {
      id: 'mira-devops',
      name: 'Mira DevOps',
      title: 'Infrastructure & Operations',
      posture: 'standard',
      desc: 'Manages CI/CD pipelines, containerization, deployments, and runtime diagnostics.',
    },
    {
      id: 'mira-researcher',
      name: 'Mira Researcher',
      title: 'Evidence & Fact Finding',
      posture: 'readonly',
      desc: 'Gathers primary sources, compares libraries, summarizes papers, and validates evidence.',
    },
    {
      id: 'mira-memory-manager',
      name: 'Mira Memory Manager',
      title: 'Knowledge & Long-term Memory',
      posture: 'standard',
      desc: 'Curates the Memory Bank, reconciles project conventions, and prunes stale recollections.',
    },
  ]

  const coreCapabilities = [
    'Autonomous software engineering',
    'Multi-agent orchestration',
    'Long-term memory (Memory Bank + SQLite)',
    'Reasoning and planning',
    'Tool execution & sandboxed shell',
    'Code analysis and review',
    'Autonomous debugging & fault isolation',
    'Security analysis & AST vulnerability auditing',
    'Self-healing mechanisms',
    'Controlled self-improvement',
    'Model and engine switching',
    'Local-first & cloud inference',
  ]

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
        {/* Flagship Header Banner */}
        <Card padding="16px 20px" style={{ display: 'flex', 'align-items': 'center', gap: '14px', 'flex-wrap': 'wrap' }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              'border-radius': '10px',
              background: 'var(--grad-brand)',
              display: 'grid',
              'place-items': 'center',
              color: 'var(--on-accent)',
              'font-weight': '800',
              'font-size': '16px',
              'flex-shrink': 0,
            }}
            aria-hidden="true"
          >
            M
          </div>
          <div style={{ flex: '1', 'min-width': '200px' }}>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
              <div style={{ 'font-size': 'var(--fs-lg)', 'font-weight': '700' }}>
                Mira Analytics & Telemetry
              </div>
              <span
                style={{
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  border: '1px solid var(--accent-border)',
                  'font-size': '11px',
                  'font-weight': '700',
                  padding: '2px 8px',
                  'border-radius': '4px',
                  'text-transform': 'uppercase',
                  'letter-spacing': '0.04em',
                }}
              >
                Live Telemetry
              </span>
            </div>
            <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'margin-top': '2px' }}>
              Agent reliability, engine readiness, governance state distribution, memory quality, and token spend.
            </div>
          </div>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => void loadDashboard()}
            disabled={loading()}
            aria-busy={loading() ? 'true' : 'false'}
            style={{
              padding: '6px 12px',
              'font-size': 'var(--fs-xs)',
              border: '1px solid var(--border)',
              'border-radius': 'var(--r-md)',
              'min-height': '32px',
            }}
          >
            {loading() ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </Card>

        <Show when={error()}>
          <div class="card" style={{ padding: '12px 16px', color: 'var(--danger)' }}>
            Error: {error()}
          </div>
        </Show>

        <AlertSection alerts={alerts()} />
        <ScopeTransparency workspace="dashboard" />

        {/* Top Key Metrics */}
        <KeyMetricsSection metrics={metrics()} maxVisible={7} />

        {/* Important Engineering Initiatives */}
        <Card padding="16px">
          <SectionHeader
            title="Flagship Engineering Initiatives"
            sub="7 core engineering pillars powering autonomous self-improvement and resilience"
          />
          <div
            style={{
              display: 'grid',
              'grid-template-columns': 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: '10px',
              'margin-top': '10px',
            }}
          >
            <For each={flagshipInitiatives}>
              {(init) => {
                const health = () => engineHealth()[init.id]
                const status = () => health()?.status ?? 'unknown'
                const isHealthy = () => status() === 'healthy'
                const isUnknown = () => status() === 'unknown'
                return (
                  <div
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border)',
                      'border-radius': '6px',
                      padding: '12px 14px',
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '6px',
                    }}
                  >
                    <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '8px' }}>
                      <span style={{ 'font-weight': '700', 'font-size': 'var(--fs-sm)' }}>
                        {init.name}
                      </span>
                      <span
                        class="tabular-nums"
                        style={{
                          'font-size': '11px',
                          'font-weight': '600',
                          padding: '2px 6px',
                          'border-radius': '4px',
                          background: isHealthy()
                            ? 'var(--ok-soft)'
                            : isUnknown()
                              ? 'var(--bg-canvas)'
                              : 'var(--danger-soft)',
                          color: isHealthy()
                            ? 'var(--ok)'
                            : isUnknown()
                              ? 'var(--fg-subtle)'
                              : 'var(--danger)',
                          border: isUnknown() ? '1px solid var(--border)' : 'none',
                        }}
                      >
                        {status().toUpperCase()}
                      </span>
                    </div>
                    <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'line-height': '1.4' }}>
                      {init.desc}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        'flex-wrap': 'wrap',
                        gap: '4px',
                        'margin-top': '4px',
                      }}
                    >
                      <For each={init.capabilities}>
                        {(cap) => (
                          <span
                            style={{
                              'font-family': 'var(--font-mono)',
                              'font-size': '10px',
                              padding: '1px 5px',
                              background: 'var(--bg-canvas)',
                              border: '1px solid var(--border)',
                              'border-radius': '3px',
                              color: 'var(--fg-muted)',
                            }}
                          >
                            {cap}
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Card>

        {/* Specialized Agents Showcase */}
        <Card padding="16px">
          <SectionHeader
            title="Specialized Mira Agents"
            sub="8 purpose-built personas for multi-agent orchestration and precision task delegation"
          />
          <div
            style={{
              display: 'grid',
              'grid-template-columns': 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: '10px',
              'margin-top': '10px',
            }}
          >
            <For each={specializedAgents}>
              {(agent) => (
                <div
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    'border-radius': '6px',
                    padding: '12px 14px',
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '4px',
                  }}
                >
                  <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                    <span style={{ 'font-weight': '700', 'font-size': 'var(--fs-sm)' }}>
                      {agent.name}
                    </span>
                    <span
                      style={{
                        'font-family': 'var(--font-mono)',
                        'font-size': '10px',
                        padding: '1px 5px',
                        'border-radius': '3px',
                        background:
                          agent.posture === 'readonly'
                            ? 'rgba(59, 130, 246, 0.12)'
                            : 'rgba(168, 85, 247, 0.12)',
                        color:
                          agent.posture === 'readonly'
                            ? 'var(--accent)'
                            : 'var(--purple, #a855f7)',
                      }}
                    >
                      {agent.posture}
                    </span>
                  </div>
                  <div style={{ 'font-size': '11px', color: 'var(--accent)', 'font-weight': '600' }}>
                    {agent.title}
                  </div>
                  <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'line-height': '1.35' }}>
                    {agent.desc}
                  </div>
                </div>
              )}
            </For>
          </div>
        </Card>

        {/* Core Capabilities Matrix */}
        <Card padding="16px">
          <SectionHeader
            title="Core Platform Capabilities"
            sub="Autonomous reasoning, tool execution, long-term memory, and self-healing"
          />
          <div
            style={{
              display: 'grid',
              'grid-template-columns': 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '8px',
              'margin-top': '10px',
            }}
          >
            <For each={coreCapabilities}>
              {(cap) => (
                <div
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '8px',
                    padding: '8px 10px',
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    'border-radius': '5px',
                    'font-size': 'var(--fs-xs)',
                  }}
                >
                  <span style={{ color: 'var(--ok)', 'font-weight': '700' }}>✓</span>
                  <span>{cap}</span>
                </div>
              )}
            </For>
          </div>
        </Card>

        <Show when={d()}>
          {(dash) => (
            <>
              {/* Agent Reliability Stats */}
              <DetailsSection
                title="Agent Reliability & Execution Runs"
                sub="Per-agent run counts and reliability scores from telemetry"
              >
                <Show
                  when={dash().agents.stats.length > 0}
                  fallback={
                    <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', padding: '6px 0' }}>
                      No agent execution runs recorded yet.
                    </div>
                  }
                >
                  <For each={dash().agents.stats}>
                    {(a) => (
                      <div
                        style={{
                          display: 'flex',
                          'justify-content': 'space-between',
                          gap: '8px',
                          'flex-wrap': 'wrap',
                          padding: '6px 0',
                          'border-bottom': '1px solid var(--border)',
                        }}
                      >
                        <span style={{ 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-sm)' }}>
                          {a.agent}
                        </span>
                        <span class="tabular-nums" style={{ 'font-size': 'var(--fs-sm)', color: 'var(--fg-subtle)' }}>
                          {a.runs} runs · {(a.reliabilityScore * 100).toFixed(0)}% reliable ·{' '}
                          {(a.successRate * 100).toFixed(0)}% success
                        </span>
                      </div>
                    )}
                  </For>
                </Show>
              </DetailsSection>

              {/* Governance Proposals by State */}
              <DetailsSection title="Governance Proposals by State" sub="Current proposal distribution">
                <Show
                  when={Object.keys(dash().governance.byState).length > 0}
                  fallback={
                    <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', padding: '6px 0' }}>
                      No governance proposals recorded yet.
                    </div>
                  }
                >
                  <For each={Object.entries(dash().governance.byState)}>
                    {([state, count]) => (
                      <div
                        style={{ display: 'flex', 'justify-content': 'space-between', padding: '4px 0' }}
                      >
                        <span style={{ 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-sm)' }}>
                          {state}
                        </span>
                        <span class="tabular-nums" style={{ 'font-size': 'var(--fs-sm)', color: 'var(--fg-subtle)' }}>
                          {count}
                        </span>
                      </div>
                    )}
                  </For>
                </Show>
              </DetailsSection>

              {/* Memory Quality */}
              <DetailsSection title="Memory Quality" sub="Quality scores and recommendations">
                <Show
                  when={dash().learning.qualityScores.length > 0}
                  fallback={
                    <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', padding: '6px 0' }}>
                      No memory quality scores evaluated yet.
                    </div>
                  }
                >
                  <For each={dash().learning.qualityScores.slice(0, 10)}>
                    {(m) => (
                      <div
                        style={{ display: 'flex', 'justify-content': 'space-between', padding: '4px 0' }}
                      >
                        <span style={{ 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-sm)' }}>
                          {m.memoryId}
                        </span>
                        <span
                          class="tabular-nums"
                          style={{
                            'font-size': 'var(--fs-sm)',
                            color:
                              m.recommendation === 'retire'
                                ? 'var(--danger)'
                                : m.recommendation === 'keep'
                                  ? 'var(--ok)'
                                  : 'var(--fg-subtle)',
                          }}
                        >
                          {m.qualityScore.toFixed(2)} · {m.recommendation}
                        </span>
                      </div>
                    )}
                  </For>
                </Show>
              </DetailsSection>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}
