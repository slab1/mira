import { createSignal, createMemo, onMount, Show, For } from 'solid-js'
import {
  api,
  type BanditArmDTO,
  type BoundedContextStatsDTO,
  type GenerationNodeDTO,
  type LineageResponseDTO,
} from '../api/client'
import { toast } from './Toast'

type StatusFilter = 'all' | 'active_base' | 'promoted_pending_approval' | 'promoted' | 'rejected'

function statusLabel(node: GenerationNodeDTO): string {
  if (node.isActiveBase) return 'Active Base'
  if (node.status === 'promoted_pending_approval') return 'Pending Human Approval'
  if (node.status === 'promoted') return 'Promoted'
  if (node.status === 'rejected') return 'Rejected'
  if (node.status === 'pruned') return 'Pruned'
  return 'Candidate'
}

function statusColor(node: GenerationNodeDTO): string {
  if (node.isActiveBase || node.status === 'promoted') return 'var(--ok)'
  if (node.status === 'promoted_pending_approval') return 'var(--warn)'
  if (node.status === 'rejected' || node.rewardHackingScore >= 0.4) return 'var(--danger)'
  return 'var(--fg-muted)'
}

function fmtPct(v: number | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(1)}%`
}

function fmtScore(v: number | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return v.toFixed(3)
}

export function RecursiveLineagePanel(props: { onMutated?: () => void }) {
  const [data, setData] = createSignal<LineageResponseDTO | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal('')
  const [busyAction, setBusyAction] = createSignal<string | null>(null)
  const [filter, setFilter] = createSignal<StatusFilter>('all')
  const [focusArm, setFocusArm] = createSignal('')
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

  const loadLineage = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.getEvolutionLineage()
      setData(res)
      if (!selectedId() && res.generations.length > 0) {
        const pending = res.generations.find((g) => g.status === 'promoted_pending_approval')
        setSelectedId(pending?.id ?? res.activeBase?.id ?? res.generations[0]!.id)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load lineage telemetry')
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void loadLineage()
  })

  const generations = createMemo<GenerationNodeDTO[]>(() => data()?.generations ?? [])
  const arms = createMemo<BanditArmDTO[]>(() => data()?.banditArms ?? [])
  const contextStats = createMemo<BoundedContextStatsDTO | null>(() => data()?.contextStats ?? null)

  const filteredGenerations = createMemo(() => {
    const f = filter()
    const list = generations()
    if (f === 'all') return list
    if (f === 'active_base') return list.filter((g) => g.isActiveBase)
    return list.filter((g) => g.status === f)
  })

  const selectedNode = createMemo<GenerationNodeDTO | null>(() => {
    const id = selectedId()
    const list = generations()
    return (id ? list.find((g) => g.id === id) : null) ?? data()?.activeBase ?? list[0] ?? null
  })

  const handleRunSearchStep = async () => {
    setBusyAction('search')
    try {
      const res = await api.runBanditSearchStep({
        k: 3,
        ...(focusArm() ? { strategyArm: focusArm() } : {}),
      })
      setData(res)
      if (res.stepResult?.bestCandidateId) {
        setSelectedId(res.stepResult.bestCandidateId)
        toast.success(`Search step complete — candidate ${res.stepResult.bestCandidateId} queued for approval`)
      } else {
        toast.success('Bandit search step evaluated 3 candidates against held-out suites')
      }
      props.onMutated?.()
    } catch (e) {
      toast.error(`Search step failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyAction(null)
    }
  }

  const handlePromote = async (node: GenerationNodeDTO) => {
    setBusyAction(`promote:${node.id}`)
    try {
      const res = await api.promoteGeneration(node.id, node.patchHash)
      toast.success(`Promoted ${res.generation.id} (Depth ${res.generation.depth}) as new Active Base`)
      await loadLineage()
      setSelectedId(res.generation.id)
      props.onMutated?.()
    } catch (e) {
      toast.error(`Promotion failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyAction(null)
    }
  }

  const handleReject = async (node: GenerationNodeDTO) => {
    setBusyAction(`reject:${node.id}`)
    try {
      await api.rejectGeneration(node.id, 'Rejected by operator during recursive lineage review')
      toast.success(`Rejected ${node.id}`)
      await loadLineage()
      props.onMutated?.()
    } catch (e) {
      toast.error(`Rejection failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <section
      aria-labelledby="recursive-lineage-title"
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '16px',
        padding: '18px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        'border-radius': 'var(--r-lg)',
      }}
    >
      {/* Header & Single Primary Action */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          'flex-wrap': 'wrap',
          gap: '12px',
          'padding-bottom': '12px',
          'border-bottom': '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
          <h2
            id="recursive-lineage-title"
            style={{
              margin: '0',
              'font-size': 'var(--fs-md)',
              'font-weight': '600',
              color: 'var(--fg)',
            }}
          >
            Recursive Self-Improvement Lineage & Bandit Search
          </h2>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'flex-wrap': 'wrap',
              gap: '8px',
              'font-size': 'var(--fs-xs)',
              color: 'var(--fg-subtle)',
            }}
          >
            <span>
              Active Base:{' '}
              <strong style={{ color: 'var(--fg)', 'font-family': 'var(--font-mono)' }}>
                {data()?.summary?.activeBaseId ?? 'gen_0'}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span style={{ 'font-family': 'var(--font-mono)', 'font-variant-numeric': 'tabular-nums' }}>
              Depth {data()?.summary?.activeBaseDepth ?? 0}
            </span>
            <span aria-hidden="true">·</span>
            <span style={{ 'font-family': 'var(--font-mono)', 'font-variant-numeric': 'tabular-nums' }}>
              Held-Out {fmtPct(data()?.summary?.activeBaseHeldOutScore)}
            </span>
            <span aria-hidden="true">·</span>
            <span style={{ 'font-family': 'var(--font-mono)', 'font-variant-numeric': 'tabular-nums' }}>
              Hacking Blocked {data()?.summary?.hackingBlockedCount ?? 0}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
          <select
            aria-label="Focus bandit strategy arm"
            value={focusArm()}
            onChange={(e) => setFocusArm(e.currentTarget.value)}
            style={{
              padding: '7px 10px',
              'font-size': 'var(--fs-xs)',
              background: 'var(--bg-app)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              'border-radius': 'var(--r-md)',
              'min-height': '36px',
            }}
          >
            <option value="">Auto-select UCB1 Arms</option>
            <For each={arms()}>
              {(arm) => <option value={arm.armId}>Focus: {arm.label}</option>}
            </For>
          </select>

          <button
            type="button"
            class="btn btn-primary"
            disabled={busyAction() !== null}
            onClick={() => void handleRunSearchStep()}
            style={{
              padding: '8px 16px',
              'font-size': 'var(--fs-xs)',
              'font-weight': '600',
              'white-space': 'nowrap',
              'min-height': '36px',
            }}
          >
            {busyAction() === 'search' ? 'Running Search Step…' : 'Run Search Step'}
          </button>
        </div>
      </div>

      {/* Error State */}
      <Show when={error()}>
        <div
          role="alert"
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            gap: '12px',
            padding: '10px 12px',
            background: 'var(--bg-app)',
            border: '1px solid var(--danger-border)',
            'border-radius': 'var(--r-md)',
            'font-size': 'var(--fs-xs)',
            color: 'var(--danger)',
          }}
        >
          <span>{error()}</span>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => void loadLineage()}
            style={{ padding: '4px 10px', 'font-size': 'var(--fs-xs)' }}
          >
            Retry
          </button>
        </div>
      </Show>

      {/* Loading Skeleton */}
      <Show when={loading() && !data()}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }} aria-hidden="true">
          <div class="skeleton" style={{ height: '42px' }} />
          <div class="skeleton" style={{ height: '140px' }} />
        </div>
      </Show>

      {/* Main Content */}
      <Show when={data()}>
        {/* Bounded Context Budget Strip */}
        <Show when={contextStats()}>
          {(ctx) => (
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'space-between',
                'flex-wrap': 'wrap',
                gap: '12px',
                padding: '10px 12px',
                background: 'var(--bg-app)',
                border: '1px solid var(--border)',
                'border-radius': 'var(--r-md)',
                'font-size': 'var(--fs-xs)',
              }}
            >
              <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
                <strong style={{ color: 'var(--fg)', 'font-weight': '600' }}>
                  Bounded Loop Context
                </strong>
                <span style={{ color: 'var(--fg-subtle)', 'font-family': 'var(--font-mono)', 'font-variant-numeric': 'tabular-nums' }}>
                  {ctx().usedTokens} / {ctx().budgetTokens} tokens ({ctx().utilizationPct}%)
                </span>
                <span aria-hidden="true" style={{ color: 'var(--fg-faint)' }}>·</span>
                <span style={{ color: 'var(--fg-subtle)', 'font-family': 'var(--font-mono)', 'font-variant-numeric': 'tabular-nums' }}>
                  Retained {ctx().retainedCount} · Compacted {ctx().compactedCount} · Dead-Ends Pruned {ctx().prunedDeadEnds}
                </span>
              </div>
              <div
                style={{
                  width: '140px',
                  height: '6px',
                  background: 'var(--border)',
                  'border-radius': '3px',
                  overflow: 'hidden',
                }}
                aria-label={`Context budget ${ctx().utilizationPct}% used`}
              >
                <div
                  style={{
                    width: `${Math.min(100, ctx().utilizationPct)}%`,
                    height: '100%',
                    background: ctx().utilizationPct > 85 ? 'var(--warn)' : 'var(--accent)',
                    transition: 'transform 150ms cubic-bezier(0.16, 1, 0.3, 1)',
                  }}
                />
              </div>
            </div>
          )}
        </Show>

        {/* Bandit Exploration Leaderboard Table */}
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-muted)' }}>
            UCB1 Strategy Arms
          </div>
          <div
            style={{
              overflow: 'auto',
              border: '1px solid var(--border)',
              'border-radius': 'var(--r-md)',
              background: 'var(--bg-app)',
            }}
          >
            <table
              style={{
                width: '100%',
                'border-collapse': 'collapse',
                'font-size': 'var(--fs-xs)',
                'text-align': 'left',
              }}
            >
              <thead>
                <tr style={{ 'border-bottom': '1px solid var(--border)', color: 'var(--fg-subtle)' }}>
                  <th style={{ padding: '8px 12px', 'font-weight': '600' }}>Strategy Arm</th>
                  <th style={{ padding: '8px 12px', 'font-weight': '600', 'text-align': 'right' }}>Pulls</th>
                  <th style={{ padding: '8px 12px', 'font-weight': '600', 'text-align': 'right' }}>Mean Reward</th>
                  <th style={{ padding: '8px 12px', 'font-weight': '600', 'text-align': 'right' }}>UCB1 Score</th>
                  <th style={{ padding: '8px 12px', 'font-weight': '600', 'text-align': 'right' }}>Held-Out Delta</th>
                  <th style={{ padding: '8px 12px', 'font-weight': '600', 'text-align': 'right' }}>Hacking Blocked</th>
                </tr>
              </thead>
              <tbody>
                <For each={arms()}>
                  {(arm) => (
                    <tr style={{ 'border-bottom': '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 12px', color: 'var(--fg)', 'font-weight': '500' }}>
                        {arm.label}
                        <span
                          style={{
                            'margin-left': '8px',
                            'font-family': 'var(--font-mono)',
                            color: 'var(--fg-faint)',
                            'font-size': 'var(--fs-2xs)',
                          }}
                        >
                          {arm.armId}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: '8px 12px',
                          'text-align': 'right',
                          'font-family': 'var(--font-mono)',
                          'font-variant-numeric': 'tabular-nums',
                        }}
                      >
                        {arm.pulls}
                      </td>
                      <td
                        style={{
                          padding: '8px 12px',
                          'text-align': 'right',
                          'font-family': 'var(--font-mono)',
                          'font-variant-numeric': 'tabular-nums',
                        }}
                      >
                        {arm.pulls > 0 ? fmtScore(arm.meanReward) : '—'}
                      </td>
                      <td
                        style={{
                          padding: '8px 12px',
                          'text-align': 'right',
                          'font-family': 'var(--font-mono)',
                          'font-variant-numeric': 'tabular-nums',
                          color: 'var(--fg)',
                          'font-weight': '600',
                        }}
                      >
                        {fmtScore(arm.lastUcbScore)}
                      </td>
                      <td
                        style={{
                          padding: '8px 12px',
                          'text-align': 'right',
                          'font-family': 'var(--font-mono)',
                          'font-variant-numeric': 'tabular-nums',
                          color:
                            arm.avgHeldOutDelta > 0
                              ? 'var(--ok)'
                              : arm.avgHeldOutDelta < 0
                                ? 'var(--danger)'
                                : 'var(--fg-subtle)',
                        }}
                      >
                        {arm.pulls > 0
                          ? `${arm.avgHeldOutDelta >= 0 ? '+' : ''}${(arm.avgHeldOutDelta * 100).toFixed(1)}%`
                          : '—'}
                      </td>
                      <td
                        style={{
                          padding: '8px 12px',
                          'text-align': 'right',
                          'font-family': 'var(--font-mono)',
                          'font-variant-numeric': 'tabular-nums',
                          color: arm.hackingBlockedCount > 0 ? 'var(--danger)' : 'var(--fg-subtle)',
                        }}
                      >
                        {arm.hackingBlockedCount}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </div>

        {/* Segmented Filter + Generation Tree Split */}
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              'flex-wrap': 'wrap',
              gap: '8px',
            }}
          >
            <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-muted)' }}>
              Generation Lineage Tree
            </div>
            <div
              role="group"
              aria-label="Filter generation lineage"
              style={{
                display: 'inline-flex',
                gap: '4px',
                padding: '3px',
                background: 'var(--bg-app)',
                border: '1px solid var(--border)',
                'border-radius': 'var(--r-md)',
                'flex-wrap': 'wrap',
              }}
            >
              {(
                [
                  ['all', 'All'],
                  ['active_base', 'Active Base'],
                  ['promoted_pending_approval', 'Pending Approval'],
                  ['promoted', 'Promoted'],
                  ['rejected', 'Rejected'],
                ] as const
              ).map(([key, label]) => (
                <button
                  type="button"
                  onClick={() => setFilter(key)}
                  style={{
                    padding: '4px 10px',
                    'font-size': 'var(--fs-2xs)',
                    'font-weight': filter() === key ? '600' : '500',
                    background: filter() === key ? 'var(--bg-surface)' : 'transparent',
                    color: filter() === key ? 'var(--fg)' : 'var(--fg-subtle)',
                    border: filter() === key ? '1px solid var(--border)' : '1px solid transparent',
                    'border-radius': 'var(--r-sm)',
                    cursor: 'pointer',
                    'white-space': 'nowrap',
                    transition: 'opacity 150ms cubic-bezier(0.16, 1, 0.3, 1)',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <Show
            when={filteredGenerations().length > 0}
            fallback={
              <div
                style={{
                  padding: '20px',
                  'text-align': 'center',
                  border: '1px dashed var(--border)',
                  'border-radius': 'var(--r-md)',
                  background: 'var(--bg-app)',
                  'font-size': 'var(--fs-xs)',
                  color: 'var(--fg-subtle)',
                }}
              >
                No generations match the selected filter. Run a search step to branch new candidates from the active baseline.
              </div>
            }
          >
            <div
              style={{
                display: 'grid',
                'grid-template-columns': 'repeat(auto-fit, minmax(300px, 1fr))',
                gap: '12px',
                'align-items': 'start',
              }}
            >
              {/* Left Column: Lineage Rows */}
              <div
                style={{
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-md)',
                  background: 'var(--bg-app)',
                  overflow: 'hidden',
                }}
                role="list"
                aria-label="Generations"
              >
                <For each={filteredGenerations()}>
                  {(node) => {
                    const isSelected = () => selectedNode()?.id === node.id
                    return (
                      <div
                        role="listitem"
                        onClick={() => setSelectedId(node.id)}
                        style={{
                          padding: '10px 12px',
                          'border-bottom': '1px solid var(--border)',
                          cursor: 'pointer',
                          background: isSelected() ? 'var(--bg-surface)' : 'transparent',
                          display: 'flex',
                          'flex-direction': 'column',
                          gap: '4px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            'justify-content': 'space-between',
                            gap: '8px',
                          }}
                        >
                          <span
                            style={{
                              'font-size': 'var(--fs-xs)',
                              'font-weight': '600',
                              color: 'var(--fg)',
                            }}
                          >
                            {node.title}
                          </span>
                          <span
                            style={{
                              'font-size': 'var(--fs-2xs)',
                              'font-weight': '600',
                              color: statusColor(node),
                              'white-space': 'nowrap',
                            }}
                          >
                            {statusLabel(node)}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            'flex-wrap': 'wrap',
                            gap: '6px',
                            'font-size': 'var(--fs-2xs)',
                            color: 'var(--fg-subtle)',
                            'font-family': 'var(--font-mono)',
                            'font-variant-numeric': 'tabular-nums',
                          }}
                        >
                          <span>Gen {node.depth}</span>
                          <span aria-hidden="true">·</span>
                          <span>{node.parentId ? `Parent ${node.parentId}` : 'Root'}</span>
                          <span aria-hidden="true">·</span>
                          <span>{node.strategyArm}</span>
                          <span aria-hidden="true">·</span>
                          <span>Held-Out {fmtPct(node.heldOutScore)}</span>
                          <span aria-hidden="true">·</span>
                          <span>Hacking {node.rewardHackingScore.toFixed(2)}</span>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>

              {/* Right Column: Selected Generation Inspector */}
              <Show when={selectedNode()}>
                {(node) => (
                  <div
                    style={{
                      padding: '14px',
                      border: '1px solid var(--border)',
                      'border-radius': 'var(--r-md)',
                      background: 'var(--bg-app)',
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '10px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'space-between',
                        gap: '8px',
                      }}
                    >
                      <div style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', color: 'var(--fg)' }}>
                        {node().title}
                      </div>
                      <span
                        style={{
                          'font-size': 'var(--fs-xs)',
                          'font-weight': '600',
                          color: statusColor(node()),
                        }}
                      >
                        {statusLabel(node())}
                      </span>
                    </div>

                    <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'line-height': '1.5' }}>
                      {node().summary}
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        'grid-template-columns': 'repeat(3, minmax(0, 1fr))',
                        gap: '8px',
                        'padding-top': '8px',
                        'border-top': '1px solid var(--border)',
                        'font-size': 'var(--fs-xs)',
                      }}
                    >
                      <div>
                        <div style={{ color: 'var(--fg-faint)', 'font-size': 'var(--fs-2xs)' }}>Train Score</div>
                        <div style={{ 'font-family': 'var(--font-mono)', 'font-variant-numeric': 'tabular-nums', 'font-weight': '600' }}>
                          {fmtPct(node().trainScore)}
                        </div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--fg-faint)', 'font-size': 'var(--fs-2xs)' }}>Held-Out Score</div>
                        <div style={{ 'font-family': 'var(--font-mono)', 'font-variant-numeric': 'tabular-nums', 'font-weight': '600' }}>
                          {fmtPct(node().heldOutScore)}
                        </div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--fg-faint)', 'font-size': 'var(--fs-2xs)' }}>Hacking Risk</div>
                        <div
                          style={{
                            'font-family': 'var(--font-mono)',
                            'font-variant-numeric': 'tabular-nums',
                            'font-weight': '600',
                            color: node().rewardHackingScore >= 0.4 ? 'var(--danger)' : 'var(--ok)',
                          }}
                        >
                          {node().rewardHackingScore.toFixed(2)}
                        </div>
                      </div>
                    </div>

                    {/* Held-Out Suite Breakdown */}
                    <Show when={node().suiteBreakdown.length > 0}>
                      <div
                        style={{
                          display: 'flex',
                          'flex-direction': 'column',
                          gap: '4px',
                          'padding-top': '8px',
                          'border-top': '1px solid var(--border)',
                          'font-size': 'var(--fs-2xs)',
                        }}
                      >
                        <div style={{ color: 'var(--fg-muted)', 'font-weight': '600' }}>
                          Held-Out Suite Breakdown
                        </div>
                        <For each={node().suiteBreakdown}>
                          {(s) => (
                            <div
                              style={{
                                display: 'flex',
                                'justify-content': 'space-between',
                                color: 'var(--fg-subtle)',
                              }}
                            >
                              <span>{s.domain}</span>
                              <span
                                style={{
                                  'font-family': 'var(--font-mono)',
                                  'font-variant-numeric': 'tabular-nums',
                                  color: s.passed ? 'var(--ok)' : 'var(--danger)',
                                }}
                              >
                                {fmtPct(s.score)} · {s.passed ? 'Pass' : 'Fail'}
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>

                    {/* Anti-Reward-Hacking Findings */}
                    <Show when={node().hackingFindings.length > 0}>
                      <div
                        style={{
                          padding: '8px 10px',
                          border: '1px solid var(--danger-border)',
                          'border-radius': 'var(--r-sm)',
                          'font-size': 'var(--fs-2xs)',
                          color: 'var(--danger)',
                        }}
                      >
                        <For each={node().hackingFindings}>
                          {(f) => <div>[{f.severity}] {f.category}: {f.detail}</div>}
                        </For>
                      </div>
                    </Show>

                    {/* Patch Preview */}
                    <Show when={node().patch}>
                      <pre
                        style={{
                          margin: '0',
                          padding: '8px 10px',
                          'max-height': '140px',
                          overflow: 'auto',
                          background: 'var(--bg-surface)',
                          border: '1px solid var(--border)',
                          'border-radius': 'var(--r-sm)',
                          'font-family': 'var(--font-mono)',
                          'font-size': 'var(--fs-2xs)',
                          color: 'var(--fg-subtle)',
                        }}
                      >
                        {node().patch}
                      </pre>
                    </Show>

                    {/* Human Promotion Controls */}
                    <Show when={node().status === 'promoted_pending_approval'}>
                      <div
                        style={{
                          display: 'flex',
                          gap: '8px',
                          'padding-top': '8px',
                          'border-top': '1px solid var(--border)',
                          'justify-content': 'flex-end',
                        }}
                      >
                        <button
                          type="button"
                          class="btn btn-danger-ghost"
                          disabled={busyAction() !== null}
                          onClick={() => void handleReject(node())}
                          style={{ padding: '7px 14px', 'font-size': 'var(--fs-xs)', 'min-height': '36px' }}
                        >
                          {busyAction() === `reject:${node().id}` ? 'Rejecting…' : 'Reject'}
                        </button>
                        <button
                          type="button"
                          class="btn btn-primary"
                          disabled={busyAction() !== null || node().rewardHackingScore >= 0.4}
                          onClick={() => void handlePromote(node())}
                          style={{
                            padding: '7px 14px',
                            'font-size': 'var(--fs-xs)',
                            'font-weight': '600',
                            'min-height': '36px',
                          }}
                        >
                          {busyAction() === `promote:${node().id}`
                            ? 'Promoting…'
                            : 'Approve & Promote Base'}
                        </button>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  )
}
