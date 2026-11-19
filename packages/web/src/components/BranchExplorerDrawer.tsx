// @ts-nocheck
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import {
  api,
  type BranchCompareResponse,
  type BranchNodeDTO,
  type BranchTreeResponse,
  type ResearchMode,
} from '../api/client'
import { toast } from './Toast'

type LayoutNode = BranchNodeDTO & {
  x: number
  y: number
  depth: number
}

function buildTreeLayout(nodes: BranchNodeDTO[], rootId: string) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const childrenMap = new Map<string, BranchNodeDTO[]>()
  for (const n of nodes) {
    if (n.parentID && byId.has(n.parentID)) {
      const list = childrenMap.get(n.parentID) ?? []
      list.push(n)
      childrenMap.set(n.parentID, list)
    }
  }
  for (const list of childrenMap.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt)
  }

  // Assign post-order leaf row indices so parent nodes center cleanly across branches
  let nextRow = 0
  const placed: LayoutNode[] = []
  const edges: Array<{ from: LayoutNode; to: LayoutNode }> = []
  const placedMap = new Map<string, LayoutNode>()

  const visit = (id: string, depth: number): LayoutNode | null => {
    const node = byId.get(id)
    if (!node || placedMap.has(id)) return null
    const kids = childrenMap.get(id) ?? []
    const childLayout: LayoutNode[] = []
    for (const k of kids) {
      const l = visit(k.id, depth + 1)
      if (l) childLayout.push(l)
    }
    const row =
      childLayout.length > 0
        ? (childLayout[0]!.y + childLayout[childLayout.length - 1]!.y) / 2
        : nextRow++ * 64 + 34
    const ln: LayoutNode = {
      ...node,
      depth,
      x: depth * 170 + 24,
      y: row,
    }
    placedMap.set(id, ln)
    placed.push(ln)
    for (const c of childLayout) {
      edges.push({ from: ln, to: c })
    }
    return ln
  }

  visit(rootId, 0)
  // Place any disconnected nodes gracefully
  for (const n of nodes) {
    if (!placedMap.has(n.id)) visit(n.id, 0)
  }

  const width = Math.max(460, ...placed.map((p) => p.x + 170))
  const height = Math.max(170, ...placed.map((p) => p.y + 52))
  return { nodes: placed, edges, width, height }
}

function kindColor(kind: string, mergedAt?: number | null): string {
  if (mergedAt) return 'var(--ok)'
  if (kind === 'research') return 'var(--accent)'
  if (kind === 'fanout') return 'var(--warn)'
  return 'var(--fg-subtle)'
}

export function BranchExplorerDrawer(props: {
  sessionId: string
  onSelectSession: (id: string) => void
  onRefreshSessions?: () => void
  onClose: () => void
}) {
  const [tree, setTree] = createSignal<BranchTreeResponse | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [tab, setTab] = createSignal<'tree' | 'fanout' | 'compare' | 'merge'>('tree')

  // Fanout form state
  const [fanoutMode, setFanoutMode] = createSignal<'research' | 'chat'>('research')
  const [researchTier, setResearchTier] = createSignal<ResearchMode>('quick-grounded')
  const [hypotheses, setHypotheses] = createSignal<Array<{ label: string; query: string }>>([
    { label: 'Option A', query: '' },
    { label: 'Option B', query: '' },
  ])
  const [launchingFanout, setLaunchingFanout] = createSignal(false)

  // Compare state
  const [leftId, setLeftId] = createSignal('')
  const [rightId, setRightId] = createSignal('')
  const [comparing, setComparing] = createSignal(false)
  const [compareData, setCompareData] = createSignal<BranchCompareResponse | null>(null)

  // Merge state
  const [mergeSummary, setMergeSummary] = createSignal('')
  const [promoteMerge, setPromoteMerge] = createSignal(true)
  const [merging, setMerging] = createSignal(false)

  const loadTree = async () => {
    if (!props.sessionId) return
    setLoading(true)
    try {
      const res = await api.getSessionTree(props.sessionId)
      setTree(res)
      const nodes = res.nodes ?? []
      if (!leftId() && nodes.length >= 1) {
        const child = nodes.find((n) => n.id === props.sessionId) ?? nodes[0]!
        setLeftId(child.id)
      }
      if (!rightId() && nodes.length >= 2) {
        const alt = nodes.find((n) => n.id !== leftId() && n.id !== res.rootId) ?? nodes.find((n) => n.id !== leftId())
        if (alt) setRightId(alt.id)
      }
    } catch (e) {
      toast.error(`Failed to load branch tree: ${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    void props.sessionId
    void loadTree()
  })

  const layout = createMemo(() => {
    const t = tree()
    if (!t || !t.nodes.length) return null
    return buildTreeLayout(t.nodes, t.rootId)
  })

  const activeNode = createMemo(() =>
    (tree()?.nodes ?? []).find((n) => n.id === props.sessionId) ?? null,
  )

  const runCompare = async (l = leftId(), r = rightId()) => {
    if (!l || !r || l === r) {
      toast.error('Select two different branches to compare')
      return
    }
    setComparing(true)
    try {
      const res = await api.compareBranches(l, r)
      setCompareData(res)
    } catch (e) {
      toast.error(`Compare failed: ${(e as Error).message}`)
    } finally {
      setComparing(false)
    }
  }

  const handleFanout = async () => {
    const clean = hypotheses().filter((h) => h.label.trim() && h.query.trim())
    if (clean.length === 0) {
      toast.error('Enter at least one hypothesis label and prompt')
      return
    }
    setLaunchingFanout(true)
    try {
      const res = await api.fanoutSession(props.sessionId, {
        mode: fanoutMode(),
        researchTier: researchTier(),
        autoRun: true,
        hypotheses: clean,
      })
      toast.success(`Launched ${res.branches.length} parallel branches`)
      props.onRefreshSessions?.()
      await loadTree()
      if (res.branches.length >= 2) {
        setLeftId(res.branches[0]!.sessionId)
        setRightId(res.branches[1]!.sessionId)
      }
      setTab('tree')
    } catch (e) {
      toast.error(`Fan-out failed: ${(e as Error).message}`)
    } finally {
      setLaunchingFanout(false)
    }
  }

  const handleMerge = async () => {
    const cur = activeNode()
    if (!cur?.parentID) {
      toast.error('Current session is already a root session with no parent')
      return
    }
    setMerging(true)
    try {
      const res = await api.mergeBranch(cur.id, {
        targetSessionId: cur.parentID,
        summary: mergeSummary().trim() || undefined,
        promoteToMemory: promoteMerge(),
      })
      toast.success('Merged branch findings into parent session & decision ledger')
      props.onRefreshSessions?.()
      props.onSelectSession(res.mergedInto)
      await loadTree()
      setTab('tree')
    } catch (e) {
      toast.error(`Merge failed: ${(e as Error).message}`)
    } finally {
      setMerging(false)
    }
  }

  return (
    <div
      role="region"
      aria-label="Mira Branches Explorer"
      style={{
        display: 'flex',
        'flex-direction': 'column',
        background: 'var(--bg-app)',
        'border-bottom': '1px solid var(--border)',
        'max-height': '64vh',
        overflow: 'auto',
      }}
    >
      {/* Top Bar */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '10px 14px',
          'border-bottom': '1px solid var(--border)',
          gap: '10px',
          'flex-wrap': 'wrap',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '12px', 'flex-wrap': 'wrap' }}>
          <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '700', color: 'var(--fg)' }}>
            ⎇ Mira Branches
          </span>
          <div style={{ display: 'flex', gap: '4px' }}>
            {(['tree', 'fanout', 'compare', 'merge'] as const).map((t) => (
              <button
                type="button"
                class="btn btn-ghost"
                onClick={() => {
                  setTab(t)
                  if (t === 'compare' && leftId() && rightId() && leftId() !== rightId()) {
                    void runCompare()
                  }
                }}
                style={{
                  padding: '4px 10px',
                  'font-size': 'var(--fs-xs)',
                  'border-radius': 'var(--r-sm)',
                  border: tab() === t ? '1px solid var(--accent-border)' : '1px solid transparent',
                  background: tab() === t ? 'var(--accent-soft)' : 'transparent',
                  color: tab() === t ? 'var(--accent)' : 'var(--fg-muted)',
                  'font-weight': tab() === t ? '600' : '500',
                }}
              >
                {t === 'tree'
                  ? 'Visual Tree'
                  : t === 'fanout'
                    ? 'Fan-Out'
                    : t === 'compare'
                      ? 'Compare'
                      : 'Merge'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => void loadTree()}
            disabled={loading()}
            style={{ padding: '4px 9px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-sm)' }}
          >
            {loading() ? 'Loading…' : '↻ Refresh'}
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => props.onClose()}
            aria-label="Close branch explorer"
            style={{ padding: '4px 9px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-sm)' }}
          >
            ✕ Close
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div style={{ padding: '14px', display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
        {/* VISUAL TREE */}
        <Show when={tab() === 'tree'}>
          <Show
            when={layout()}
            fallback={
              <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                {loading() ? 'Building session branch graph…' : 'No branches in this tree yet. Use Fan-Out or turn Branch buttons to explore parallel paths.'}
              </div>
            }
          >
            {(l) => (
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                <div
                  style={{
                    overflow: 'auto',
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    'border-radius': 'var(--r-md)',
                    padding: '10px',
                  }}
                >
                  <svg
                    width={l().width}
                    height={l().height}
                    viewBox={`0 0 ${l().width} ${l().height}`}
                    role="img"
                    aria-label="Branch hierarchy graph"
                    style={{ display: 'block' }}
                  >
                    <For each={l().edges}>
                      {(edge) => {
                        const x1 = edge.from.x + 140
                        const y1 = edge.from.y
                        const x2 = edge.to.x
                        const y2 = edge.to.y
                        const cx = (x1 + x2) / 2
                        return (
                          <path
                            d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
                            fill="none"
                            stroke={edge.to.mergedAt ? 'var(--ok)' : 'var(--border-strong)'}
                            stroke-width={edge.to.id === props.sessionId ? '2.2' : '1.5'}
                          />
                        )
                      }}
                    </For>
                    <For each={l().nodes}>
                      {(node) => {
                        const active = node.id === props.sessionId
                        const color = kindColor(node.branchKind, node.mergedAt)
                        const label = (node.hypothesisLabel || node.title || `Session ${node.id.slice(0, 6)}`).slice(0, 20)
                        return (
                          <g
                            transform={`translate(${node.x}, ${node.y - 22})`}
                            style={{ cursor: 'pointer' }}
                            onClick={() => props.onSelectSession(node.id)}
                          >
                            <rect
                              width="140"
                              height="44"
                              rx="7"
                              fill={active ? 'var(--accent-soft)' : 'var(--bg-app)'}
                              stroke={active ? 'var(--accent)' : 'var(--border-strong)'}
                              stroke-width={active ? '1.8' : '1'}
                            />
                            <circle cx="13" cy="15" r="4" fill={color} />
                            <text
                              x="23"
                              y="18"
                              fill="var(--fg)"
                              font-size="11"
                              font-weight={active ? '700' : '500'}
                            >
                              {label}
                            </text>
                            <text
                              x="13"
                              y="33"
                              fill="var(--fg-subtle)"
                              font-size="9.5"
                              font-family="monospace"
                            >
                              {node.branchKind} · {node.messageCount}m
                              {node.researchRun ? ` · ${node.researchRun.citationCount}c` : ''}
                              {node.mergedAt ? ' · ✓' : ''}
                            </text>
                          </g>
                        )
                      }}
                    </For>
                  </svg>
                </div>

                {/* Flat node quick actions */}
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                  <For each={l().nodes}>
                    {(n) => (
                      <div
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          'justify-content': 'space-between',
                          gap: '10px',
                          padding: '7px 10px',
                          background: n.id === props.sessionId ? 'var(--accent-soft)' : 'var(--bg-surface)',
                          border: n.id === props.sessionId ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                          'border-radius': 'var(--r-sm)',
                          'font-size': 'var(--fs-xs)',
                          'flex-wrap': 'wrap',
                        }}
                      >
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'min-width': '0', flex: '1' }}>
                          <span style={{ color: kindColor(n.branchKind, n.mergedAt) }}>●</span>
                          <button
                            type="button"
                            onClick={() => props.onSelectSession(n.id)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--fg)',
                              'font-weight': n.id === props.sessionId ? '700' : '600',
                              cursor: 'pointer',
                              padding: '0',
                              'text-align': 'left',
                            }}
                          >
                            {n.hypothesisLabel || n.title || n.id.slice(0, 8)}
                          </button>
                          <span class="tabular-nums" style={{ color: 'var(--fg-subtle)', 'font-family': 'var(--font-mono)' }}>
                            {n.branchKind} · {n.messageCount} msgs
                            {n.researchRun ? ` · ${n.researchRun.citationCount} cites (${n.researchRun.status})` : ''}
                            {n.mergedAt ? ' · merged' : ''}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            type="button"
                            class="btn btn-ghost"
                            onClick={() => {
                              setLeftId(n.id)
                              if (rightId() && rightId() !== n.id) {
                                setTab('compare')
                                void runCompare(n.id, rightId())
                              }
                            }}
                            style={{ padding: '2px 7px', 'font-size': 'var(--fs-2xs)', border: '1px solid var(--border)' }}
                          >
                            Set Left
                          </button>
                          <button
                            type="button"
                            class="btn btn-ghost"
                            onClick={() => {
                              setRightId(n.id)
                              if (leftId() && leftId() !== n.id) {
                                setTab('compare')
                                void runCompare(leftId(), n.id)
                              }
                            }}
                            style={{ padding: '2px 7px', 'font-size': 'var(--fs-2xs)', border: '1px solid var(--border)' }}
                          >
                            Set Right
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>
        </Show>

        {/* PARALLEL FAN-OUT */}
        <Show when={tab() === 'fanout'}>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '10px', 'flex-wrap': 'wrap', 'align-items': 'center' }}>
              <label style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                Execution Mode:{' '}
                <select
                  value={fanoutMode()}
                  onChange={(e) => setFanoutMode(e.currentTarget.value as 'research' | 'chat')}
                  style={{
                    padding: '4px 8px',
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    'border-radius': 'var(--r-sm)',
                    color: 'var(--fg)',
                    'font-size': 'var(--fs-xs)',
                  }}
                >
                  <option value="research">Online Grounded Research</option>
                  <option value="chat">Parallel Code/Chat Branches</option>
                </select>
              </label>
              <Show when={fanoutMode() === 'research'}>
                <label style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                  Depth:{' '}
                  <select
                    value={researchTier()}
                    onChange={(e) => setResearchTier(e.currentTarget.value as ResearchMode)}
                    style={{
                      padding: '4px 8px',
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border)',
                      'border-radius': 'var(--r-sm)',
                      color: 'var(--fg)',
                      'font-size': 'var(--fs-xs)',
                    }}
                  >
                    <option value="quick-grounded">Quick Grounded</option>
                    <option value="deep-investigation">Deep Investigation</option>
                  </select>
                </label>
              </Show>
              <Show when={hypotheses().length < 4}>
                <button
                  type="button"
                  class="btn btn-ghost"
                  onClick={() =>
                    setHypotheses((prev) => [
                      ...prev,
                      { label: `Option ${String.fromCharCode(65 + prev.length)}`, query: '' },
                    ])
                  }
                  style={{ padding: '4px 9px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)' }}
                >
                  + Add Hypothesis
                </button>
              </Show>
            </div>
            <For each={hypotheses()}>
              {(h, idx) => (
                <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                  <input
                    type="text"
                    value={h.label}
                    onInput={(e) =>
                      setHypotheses((prev) =>
                        prev.map((item, i) => (i === idx() ? { ...item, label: e.currentTarget.value } : item)),
                      )
                    }
                    placeholder="Branch label"
                    style={{
                      width: '140px',
                      padding: '6px 8px',
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border)',
                      'border-radius': 'var(--r-sm)',
                      color: 'var(--fg)',
                      'font-size': 'var(--fs-xs)',
                    }}
                  />
                  <input
                    type="text"
                    value={h.query}
                    onInput={(e) =>
                      setHypotheses((prev) =>
                        prev.map((item, i) => (i === idx() ? { ...item, query: e.currentTarget.value } : item)),
                      )
                    }
                    placeholder="Hypothesis or investigation prompt…"
                    style={{
                      flex: '1',
                      padding: '6px 10px',
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border)',
                      'border-radius': 'var(--r-sm)',
                      color: 'var(--fg)',
                      'font-size': 'var(--fs-xs)',
                    }}
                  />
                  <Show when={hypotheses().length > 1}>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      onClick={() => setHypotheses((prev) => prev.filter((_, i) => i !== idx()))}
                      style={{ padding: '4px 8px', 'font-size': 'var(--fs-xs)', color: 'var(--danger)' }}
                    >
                      ✕
                    </button>
                  </Show>
                </div>
              )}
            </For>
            <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
              <button
                type="button"
                class="btn btn-solid"
                disabled={launchingFanout()}
                onClick={() => void handleFanout()}
                style={{ padding: '7px 14px', 'font-size': 'var(--fs-xs)' }}
              >
                {launchingFanout() ? 'Launching Branches…' : 'Launch Parallel Fan-Out →'}
              </button>
            </div>
          </div>
        </Show>

        {/* SIDE-BY-SIDE COMPARE */}
        <Show when={tab() === 'compare'}>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap', 'align-items': 'center' }}>
              <select
                value={leftId()}
                onChange={(e) => setLeftId(e.currentTarget.value)}
                style={{
                  flex: '1',
                  padding: '6px 8px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-sm)',
                  color: 'var(--fg)',
                  'font-size': 'var(--fs-xs)',
                }}
              >
                <option value="">Select Left Branch…</option>
                <For each={tree()?.nodes ?? []}>
                  {(n) => <option value={n.id}>{n.hypothesisLabel || n.title || n.id.slice(0, 8)}</option>}
                </For>
              </select>
              <span style={{ color: 'var(--fg-faint)', 'font-size': 'var(--fs-xs)' }}>vs</span>
              <select
                value={rightId()}
                onChange={(e) => setRightId(e.currentTarget.value)}
                style={{
                  flex: '1',
                  padding: '6px 8px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-sm)',
                  color: 'var(--fg)',
                  'font-size': 'var(--fs-xs)',
                }}
              >
                <option value="">Select Right Branch…</option>
                <For each={tree()?.nodes ?? []}>
                  {(n) => <option value={n.id}>{n.hypothesisLabel || n.title || n.id.slice(0, 8)}</option>}
                </For>
              </select>
              <button
                type="button"
                class="btn btn-solid"
                disabled={comparing()}
                onClick={() => void runCompare()}
                style={{ padding: '6px 12px', 'font-size': 'var(--fs-xs)' }}
              >
                {comparing() ? 'Comparing…' : 'Compare'}
              </button>
            </div>

            <Show when={compareData()}>
              {(cmp) => (
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                  <div
                    class="tabular-nums"
                    style={{
                      display: 'grid',
                      'grid-template-columns': 'repeat(auto-fit, minmax(240px, 1fr))',
                      gap: '10px',
                    }}
                  >
                    {[cmp().left, cmp().right].map((side, idx) => (
                      <div
                        style={{
                          padding: '10px',
                          background: 'var(--bg-surface)',
                          border: '1px solid var(--border)',
                          'border-radius': 'var(--r-sm)',
                          display: 'flex',
                          'flex-direction': 'column',
                          gap: '6px',
                        }}
                      >
                        <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '700', color: 'var(--fg)' }}>
                          {idx === 0 ? 'Left: ' : 'Right: '}
                          {side.hypothesisLabel || side.title}
                        </div>
                        <div style={{ 'font-size': 'var(--fs-2xs)', 'font-family': 'var(--font-mono)', color: 'var(--fg-subtle)' }}>
                          {side.messageCount} msgs · {side.citationCount} citations · ${side.costUsd.toFixed(4)} · {side.verificationState}
                        </div>
                        <div
                          style={{
                            'font-size': 'var(--fs-xs)',
                            color: 'var(--fg-muted)',
                            'white-space': 'pre-wrap',
                            'max-height': '160px',
                            overflow: 'auto',
                            'line-height': '1.5',
                          }}
                        >
                          {side.conclusionPreview || 'No assistant or research conclusion recorded yet.'}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '16px', 'flex-wrap': 'wrap', 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                    <span class="tabular-nums">Shared citations: {cmp().citations.shared.length}</span>
                    <span class="tabular-nums">Left unique: {cmp().citations.leftOnly.length}</span>
                    <span class="tabular-nums">Right unique: {cmp().citations.rightOnly.length}</span>
                    <span class="tabular-nums">Shared files: {cmp().files.shared.length}</span>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </Show>

        {/* MERGE TO PARENT */}
        <Show when={tab() === 'merge'}>
          <Show
            when={activeNode()?.parentID}
            fallback={
              <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                Select a child branch in the Visual Tree to merge its verified conclusions back into its parent session.
              </div>
            }
          >
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
              <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                Merge findings, citations, and touched files from{' '}
                <strong style={{ color: 'var(--fg)' }}>
                  {activeNode()?.hypothesisLabel || activeNode()?.title}
                </strong>{' '}
                back into its parent session and record an auditable Decision Ledger entry.
              </div>
              <textarea
                rows={3}
                value={mergeSummary()}
                onInput={(e) => setMergeSummary(e.currentTarget.value)}
                placeholder="Optional custom merge takeaway (leave blank to auto-summarize from latest report/message)…"
                style={{
                  padding: '8px 10px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-sm)',
                  color: 'var(--fg)',
                  'font-size': 'var(--fs-xs)',
                }}
              />
              <label style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'font-size': 'var(--fs-xs)', color: 'var(--fg-muted)' }}>
                <input
                  type="checkbox"
                  checked={promoteMerge()}
                  onChange={(e) => setPromoteMerge(e.currentTarget.checked)}
                />
                <span>Also save branch decision & sources to Semantic Memory</span>
              </label>
              <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
                <button
                  type="button"
                  class="btn btn-solid"
                  disabled={merging()}
                  onClick={() => void handleMerge()}
                  style={{ padding: '7px 14px', 'font-size': 'var(--fs-xs)' }}
                >
                  {merging() ? 'Merging…' : 'Merge Branch into Parent →'}
                </button>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
