/**
 * MemoryGraph — TUI port of web/src/components/MemoryGraph.tsx
 *
 * TUI adaptation: tier-grouped list + detail card (no SVG canvas).
 * Falls back to ASCII-style list when terminal width is narrow.
 * Features: tier columns, hash jitter legend, detail card with touch/promote/resolve, seed form.
 */

import { createSignal, createResource, For, Show, createEffect } from 'solid-js'
import { rpc, type GraphNode, type KnowledgeGraph } from '../rpc/client'

type Props = {
  onOpenInChat?: (node: GraphNode) => void
  onRequestClose?: () => void
}

const FRESH_MS = 7 * 24 * 60 * 60 * 1000
const DECAY_MS = 30 * 24 * 60 * 60 * 1000

function isFresh(n: GraphNode): boolean {
  const t = n.lastAccessedAt || n.updatedAt || n.createdAt
  return Date.now() - t < FRESH_MS
}
function isDecayed(n: GraphNode): boolean {
  const t = n.lastAccessedAt || n.updatedAt || n.createdAt
  return Date.now() - t > DECAY_MS
}

function fmtTime(ts: number): string {
  try {
    const d = new Date(ts)
    return (
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    )
  } catch {
    return ''
  }
}

function tierColor(tier: string): string {
  if (tier === 'episodic') return '#f59e0b'
  if (tier === 'procedural') return '#8b5cf6'
  return '#10b981'
}

function tierIcon(tier: string): string {
  if (tier === 'episodic') return '●'
  if (tier === 'procedural') return '◆'
  return '■'
}

export default function MemoryGraph(props: Props) {
  const [graph, { refetch }] = createResource(() =>
    rpc.getKnowledgeGraph(100).catch(() => ({ nodes: [], edges: [] }) as KnowledgeGraph),
  )
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [focusIndex, setFocusIndex] = createSignal(0)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [seedTitle, setSeedTitle] = createSignal('')
  const [seedContent, setSeedContent] = createSignal('')
  const [seedTier, setSeedTier] = createSignal('semantic')
  const [showSeed, setShowSeed] = createSignal(false)
  const [seedError, setSeedError] = createSignal<string | null>(null)
  const [filterTier, setFilterTier] = createSignal<string | null>(null)

  const nodes = () => graph()?.nodes ?? []
  const edges = () => graph()?.edges ?? []
  const selected = () => nodes().find((n) => n.id === selectedId()) ?? null

  const filteredNodes = () => {
    const all = nodes()
    const f = filterTier()
    if (!f) return all
    return all.filter((n) => n.tier === f)
  }

  const grouped = () => {
    const all = filteredNodes()
    const episodic = all.filter((n) => n.tier === 'episodic')
    const semantic = all.filter((n) => n.tier === 'semantic')
    const procedural = all.filter((n) => n.tier === 'procedural')
    const other = all.filter(
      (n) => n.tier !== 'episodic' && n.tier !== 'semantic' && n.tier !== 'procedural',
    )
    return { episodic, semantic, procedural, other }
  }

  // keyboard nav: arrow to cycle, Enter to select, Esc to clear
  const onKeyDown = (e: KeyboardEvent) => {
    const ns = filteredNodes()
    if (!ns.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      const next = (focusIndex() + 1) % ns.length
      setFocusIndex(next)
      setSelectedId(ns[next].id)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = (focusIndex() - 1 + ns.length) % ns.length
      setFocusIndex(next)
      setSelectedId(ns[next].id)
    } else if (e.key === 'Escape') {
      setSelectedId(null)
    } else if (e.key === 'Enter') {
      const n = ns[focusIndex()]
      if (n) setSelectedId(n.id)
    }
  }

  createEffect(() => {
    const id = selectedId()
    if (!id) return
    const idx = filteredNodes().findIndex((n) => n.id === id)
    if (idx >= 0) setFocusIndex(idx)
  })

  createEffect(() => {
    const ns = filteredNodes()
    if (ns.length && selectedId() === null) {
      setFocusIndex(0)
    }
  })

  const handleResolve = async (n: GraphNode) => {
    if (n.kind !== 'finding') return
    setBusy(`resolve:${n.id}`)
    try {
      await rpc.resolveFinding(n.id)
      await refetch()
    } catch (e) {
      setSeedError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const handleTouch = async (n: GraphNode) => {
    if (n.kind !== 'knowledge') return
    setBusy(`touch:${n.id}`)
    try {
      await rpc.touchKnowledge(n.id)
      await refetch()
    } catch (e) {
      setSeedError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const handlePromote = async (n: GraphNode) => {
    if (n.kind !== 'finding') return
    setBusy(`promote:${n.id}`)
    try {
      await rpc.promoteFinding(n.id)
      await refetch()
    } catch (e) {
      setSeedError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const handleDelete = async (n: GraphNode) => {
    if (n.kind !== 'knowledge') return
    setBusy(`delete:${n.id}`)
    try {
      await rpc.deleteKnowledge(n.id)
      setSelectedId(null)
      await refetch()
    } catch (e) {
      setSeedError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const handleSeed = async () => {
    const title = seedTitle().trim()
    const content = seedContent().trim()
    if (!title || !content) {
      setSeedError('Title and content are required.')
      return
    }
    if (title.length > 200) {
      setSeedError('Title must be 200 characters or fewer.')
      return
    }
    if (content.length > 4000) {
      setSeedError('Content must be 4000 characters or fewer.')
      return
    }
    setBusy('seed')
    setSeedError(null)
    try {
      await rpc.seedKnowledge({ title, content, tier: seedTier() })
      setSeedTitle('')
      setSeedContent('')
      setSeedTier('semantic')
      setShowSeed(false)
      await refetch()
    } catch (e) {
      setSeedError(e instanceof Error ? e.message : 'Seed failed.')
    } finally {
      setBusy(null)
    }
  }

  const seedForm = (prefix: string) => (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void handleSeed()
      }}
      aria-label="Seed knowledge form"
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
        width: '100%',
        'max-width': '44ch',
        margin: prefix === 'empty' ? '0 auto' : '0',
        'text-align': 'left',
      }}
    >
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
        <label
          for={`${prefix}-seed-title`}
          style={{ 'font-size': '11px', 'font-weight': '600', opacity: '0.7' }}
        >
          Title
        </label>
        <input
          id={`${prefix}-seed-title`}
          type="text"
          value={seedTitle()}
          onInput={(e) => setSeedTitle(e.currentTarget.value)}
          placeholder="What should Mira remember?"
          maxlength={200}
          style={{
            padding: '6px 8px',
            'border-radius': '6px',
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(0,0,0,0.28)',
            color: '#e5e7eb',
            'font-size': '12px',
          }}
        />
      </div>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
        <label
          for={`${prefix}-seed-content`}
          style={{ 'font-size': '11px', 'font-weight': '600', opacity: '0.7' }}
        >
          Content
        </label>
        <textarea
          id={`${prefix}-seed-content`}
          value={seedContent()}
          onInput={(e) => setSeedContent(e.currentTarget.value)}
          placeholder="The fact, decision, or snippet…"
          rows={3}
          maxlength={4000}
          style={{
            padding: '6px 8px',
            'border-radius': '6px',
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(0,0,0,0.28)',
            color: '#e5e7eb',
            resize: 'vertical',
            'font-size': '12px',
            'line-height': '1.5',
          }}
        />
      </div>
      <div style={{ display: 'flex', gap: '8px', 'align-items': 'flex-end' }}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', flex: '1' }}>
          <label
            for={`${prefix}-seed-tier`}
            style={{ 'font-size': '11px', 'font-weight': '600', opacity: '0.7' }}
          >
            Tier
          </label>
          <select
            id={`${prefix}-seed-tier`}
            value={seedTier()}
            onChange={(e) => setSeedTier(e.currentTarget.value)}
            style={{
              padding: '6px 8px',
              'border-radius': '6px',
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(0,0,0,0.28)',
              color: '#e5e7eb',
              'font-size': '12px',
            }}
          >
            <option value="semantic">semantic</option>
            <option value="episodic">episodic</option>
            <option value="procedural">procedural</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={busy() === 'seed'}
          style={{
            padding: '7px 14px',
            'font-size': '12px',
            'white-space': 'nowrap',
            'border-radius': '6px',
            border: '1px solid rgba(99,102,241,0.5)',
            background: 'rgba(99,102,241,0.9)',
            color: 'white',
            cursor: 'pointer',
            'font-weight': '600',
          }}
        >
          {busy() === 'seed' ? 'Saving…' : '+ Seed memory'}
        </button>
      </div>
      <Show when={seedError()}>
        <div
          role="alert"
          style={{
            padding: '6px 8px',
            'border-radius': '6px',
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.22)',
            color: '#fecaca',
            'font-size': '11px',
          }}
        >
          {seedError()}
        </div>
      </Show>
    </form>
  )

  const renderNodeRow = (n: GraphNode) => {
    const decayed = isDecayed(n)
    const fresh = isFresh(n)
    const isSelected = selectedId() === n.id
    return (
      <div
        role="button"
        tabindex={0}
        aria-selected={isSelected ? 'true' : 'false'}
        aria-label={`${n.tier} ${n.kind}: ${n.label}`}
        onClick={() => setSelectedId(n.id)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setSelectedId(n.id)
          }
        }}
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          padding: '6px 8px',
          'border-radius': '6px',
          cursor: 'pointer',
          background: isSelected ? 'rgba(99,102,241,0.18)' : 'transparent',
          border: isSelected ? '1px solid rgba(99,102,241,0.35)' : '1px solid transparent',
          opacity: decayed ? '0.55' : '1',
        }}
      >
        <span
          style={{
            color: tierColor(n.tier),
            'font-size': '12px',
            'font-weight': '700',
            flex: 'none',
          }}
          aria-hidden="true"
        >
          {tierIcon(n.tier)}
        </span>
        <span
          style={{
            flex: '1',
            'font-size': '12px',
            'font-weight': isSelected ? '600' : '500',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
            color: decayed ? '#9ca3af' : '#e5e7eb',
          }}
          title={n.label}
        >
          {n.label.length > 40 ? n.label.slice(0, 40) + '…' : n.label}
        </span>
        <Show when={fresh}>
          <span
            style={{
              'font-size': '9px',
              padding: '1px 5px',
              'border-radius': '999px',
              background: 'rgba(16,185,129,0.15)',
              color: '#6ee7b7',
              'font-weight': '600',
              flex: 'none',
            }}
          >
            fresh
          </span>
        </Show>
        <Show when={decayed}>
          <span
            style={{
              'font-size': '9px',
              padding: '1px 5px',
              'border-radius': '999px',
              background: 'rgba(107,114,128,0.15)',
              color: '#9ca3af',
              flex: 'none',
            }}
          >
            decayed
          </span>
        </Show>
        <span
          style={{
            'font-size': '10px',
            color: '#6b7280',
            'font-family': 'ui-monospace, monospace',
            flex: 'none',
          }}
        >
          {n.kind === 'finding' ? (n.severity ?? n.kind) : n.kind}
        </span>
      </div>
    )
  }

  return (
    <div
      role="application"
      aria-label="Memory graph — knowledge entries and findings"
      aria-roledescription="interactive graph"
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        overflow: 'hidden',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        'border-radius': '10px',
      }}
    >
      {/* toolbar */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '8px 10px',
          'border-bottom': '1px solid rgba(255,255,255,0.06)',
          gap: '8px',
          'flex-wrap': 'wrap',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <span style={{ 'font-size': '13px', 'font-weight': '700', color: '#e5e7eb' }}>
            Memory Graph
          </span>
          <Show when={!graph.loading}>
            <span
              style={{
                'font-size': '10px',
                padding: '2px 7px',
                'border-radius': '999px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: '#9ca3af',
              }}
            >
              {nodes().length} nodes · {edges().length} edges
            </span>
          </Show>
          <Show when={graph.loading}>
            <span
              style={{
                'font-size': '10px',
                padding: '2px 7px',
                'border-radius': '999px',
                background: 'rgba(251,191,36,0.12)',
                color: '#fde68a',
              }}
            >
              loading…
            </span>
          </Show>
          <Show when={nodes().length > 0}>
            <button
              type="button"
              onClick={() => setShowSeed((v) => !v)}
              aria-label={showSeed() ? 'Hide seed knowledge form' : 'Seed a knowledge entry'}
              aria-expanded={showSeed() ? 'true' : 'false'}
              style={{
                padding: '3px 10px',
                'font-size': '11px',
                border: '1px solid rgba(255,255,255,0.12)',
                'border-radius': '999px',
                background: showSeed() ? 'rgba(99,102,241,0.15)' : 'transparent',
                color: showSeed() ? '#a5b4fc' : '#9ca3af',
                cursor: 'pointer',
              }}
            >
              {showSeed() ? '✕ seed' : '+ seed'}
            </button>
          </Show>
        </div>
        <div
          style={{
            display: 'flex',
            gap: '6px',
            'align-items': 'center',
            'font-size': '11px',
            color: '#9ca3af',
          }}
        >
          <span style={{ display: 'flex', 'align-items': 'center', gap: '4px' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                'border-radius': '50%',
                background: '#f59e0b',
                display: 'inline-block',
              }}
            />{' '}
            episodic
          </span>
          <span style={{ display: 'flex', 'align-items': 'center', gap: '4px' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                'border-radius': '2px',
                background: 'rgba(16,185,129,0.25)',
                border: '1px solid #10b981',
                display: 'inline-block',
              }}
            />{' '}
            semantic
          </span>
          <span style={{ display: 'flex', 'align-items': 'center', gap: '4px' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                transform: 'rotate(45deg)',
                background: 'rgba(139,92,246,0.25)',
                border: '1px solid #8b5cf6',
                display: 'inline-block',
              }}
            />{' '}
            procedural
          </span>
        </div>
      </div>

      {/* tier filter */}
      <Show when={nodes().length > 0}>
        <div
          style={{
            display: 'flex',
            gap: '6px',
            padding: '6px 10px',
            'border-bottom': '1px solid rgba(255,255,255,0.04)',
          }}
        >
          <For each={[null, 'episodic', 'semantic', 'procedural'] as const}>
            {(tier) => (
              <button
                type="button"
                onClick={() => setFilterTier(tier)}
                style={{
                  padding: '3px 8px',
                  'font-size': '11px',
                  'border-radius': '999px',
                  border:
                    filterTier() === tier
                      ? '1px solid rgba(99,102,241,0.35)'
                      : '1px solid rgba(255,255,255,0.08)',
                  background: filterTier() === tier ? 'rgba(99,102,241,0.15)' : 'transparent',
                  color: filterTier() === tier ? '#a5b4fc' : '#9ca3af',
                  cursor: 'pointer',
                }}
              >
                {tier ?? 'all'}
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* collapsible seed bar */}
      <Show when={showSeed() && nodes().length > 0}>
        <div
          style={{
            padding: '10px 12px',
            'border-bottom': '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(0,0,0,0.15)',
          }}
        >
          {seedForm('bar')}
        </div>
      </Show>

      {/* graph area */}
      <div style={{ flex: '1', display: 'flex', overflow: 'hidden', 'min-height': '0' }}>
        <Show
          when={!graph.loading && nodes().length === 0}
          fallback={
            <Show
              when={!graph.loading}
              fallback={
                <div
                  style={{
                    flex: '1',
                    display: 'grid',
                    'place-items': 'center',
                    color: '#6b7280',
                    'font-size': '12px',
                  }}
                >
                  Loading graph…
                </div>
              }
            >
              {/* tier-grouped list */}
              <div
                style={{
                  flex: '1',
                  display: 'flex',
                  'flex-direction': 'column',
                  overflow: 'hidden',
                  'min-height': '0',
                }}
              >
                <div
                  style={{
                    flex: '1',
                    overflow: 'auto',
                    padding: '8px',
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '10px',
                  }}
                >
                  <Show when={grouped().episodic.length > 0}>
                    <div>
                      <div
                        style={{
                          'font-size': '10px',
                          'font-weight': '700',
                          color: '#f59e0b',
                          'letter-spacing': '0.06em',
                          'text-transform': 'uppercase',
                          'margin-bottom': '4px',
                        }}
                      >
                        ● Episodic — {grouped().episodic.length}
                      </div>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                        <For each={grouped().episodic}>{(n) => renderNodeRow(n)}</For>
                      </div>
                    </div>
                  </Show>
                  <Show when={grouped().semantic.length > 0}>
                    <div>
                      <div
                        style={{
                          'font-size': '10px',
                          'font-weight': '700',
                          color: '#10b981',
                          'letter-spacing': '0.06em',
                          'text-transform': 'uppercase',
                          'margin-bottom': '4px',
                        }}
                      >
                        ■ Semantic — {grouped().semantic.length}
                      </div>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                        <For each={grouped().semantic}>{(n) => renderNodeRow(n)}</For>
                      </div>
                    </div>
                  </Show>
                  <Show when={grouped().procedural.length > 0}>
                    <div>
                      <div
                        style={{
                          'font-size': '10px',
                          'font-weight': '700',
                          color: '#8b5cf6',
                          'letter-spacing': '0.06em',
                          'text-transform': 'uppercase',
                          'margin-bottom': '4px',
                        }}
                      >
                        ◆ Procedural — {grouped().procedural.length}
                      </div>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                        <For each={grouped().procedural}>{(n) => renderNodeRow(n)}</For>
                      </div>
                    </div>
                  </Show>
                  <Show when={grouped().other.length > 0}>
                    <div>
                      <div
                        style={{
                          'font-size': '10px',
                          'font-weight': '700',
                          color: '#9ca3af',
                          'letter-spacing': '0.06em',
                          'text-transform': 'uppercase',
                          'margin-bottom': '4px',
                        }}
                      >
                        Other — {grouped().other.length}
                      </div>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                        <For each={grouped().other}>{(n) => renderNodeRow(n)}</For>
                      </div>
                    </div>
                  </Show>
                  <Show when={filteredNodes().length === 0 && nodes().length > 0}>
                    <div
                      style={{
                        padding: '12px',
                        'text-align': 'center',
                        color: '#6b7280',
                        'font-size': '12px',
                      }}
                    >
                      No nodes in this tier.
                    </div>
                  </Show>
                </div>
              </div>

              {/* detail card */}
              <Show when={selected()}>
                {(node) => (
                  <div
                    role="dialog"
                    aria-label={`Details for ${node().label}`}
                    aria-modal="false"
                    style={{
                      width: '320px',
                      'min-width': '260px',
                      'max-width': '380px',
                      display: 'flex',
                      'flex-direction': 'column',
                      border: '1px solid rgba(255,255,255,0.08)',
                      'border-radius': '10px',
                      margin: '8px',
                      background: 'rgba(0,0,0,0.25)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        padding: '10px 12px',
                        'border-bottom': '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '8px',
                          'justify-content': 'space-between',
                        }}
                      >
                        <span
                          style={{
                            width: '8px',
                            height: '8px',
                            'border-radius': '50%',
                            background: tierColor(node().tier),
                            flex: 'none',
                          }}
                          aria-hidden="true"
                        />
                        <span
                          style={{
                            'font-size': '10px',
                            color: '#6b7280',
                            'font-family': 'ui-monospace, monospace',
                            'text-transform': 'uppercase',
                            'letter-spacing': '0.06em',
                            flex: '1',
                          }}
                        >
                          {node().tier} · {node().kind}
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedId(null)}
                          aria-label="Close details"
                          style={{
                            padding: '3px 8px',
                            'font-size': '11px',
                            border: '1px solid rgba(255,255,255,0.12)',
                            'border-radius': '999px',
                            background: 'transparent',
                            color: '#9ca3af',
                            cursor: 'pointer',
                          }}
                        >
                          ✕
                        </button>
                      </div>
                      <div
                        style={{
                          'margin-top': '8px',
                          'font-weight': '600',
                          'font-size': '13px',
                          color: '#e5e7eb',
                          'word-break': 'break-word',
                        }}
                      >
                        {node().label}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          'flex-wrap': 'wrap',
                          gap: '6px',
                          'margin-top': '6px',
                        }}
                      >
                        <span
                          style={{
                            'font-size': '10px',
                            padding: '2px 7px',
                            'border-radius': '999px',
                            background: 'rgba(255,255,255,0.06)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            color: '#9ca3af',
                          }}
                        >
                          {node().source}
                        </span>
                        <Show when={node().severity}>
                          <span
                            style={{
                              'font-size': '10px',
                              padding: '2px 7px',
                              'border-radius': '999px',
                              background:
                                node().severity === 'critical'
                                  ? 'rgba(239,68,68,0.15)'
                                  : node().severity === 'major'
                                    ? 'rgba(251,191,36,0.15)'
                                    : 'rgba(139,92,246,0.15)',
                              color:
                                node().severity === 'critical'
                                  ? '#fca5a5'
                                  : node().severity === 'major'
                                    ? '#fde68a'
                                    : '#c4b5fd',
                              border: `1px solid ${node().severity === 'critical' ? 'rgba(239,68,68,0.25)' : node().severity === 'major' ? 'rgba(251,191,36,0.25)' : 'rgba(139,92,246,0.25)'}`,
                            }}
                          >
                            {node().severity}
                          </span>
                        </Show>
                        <Show when={node().status}>
                          <span
                            style={{
                              'font-size': '10px',
                              padding: '2px 7px',
                              'border-radius': '999px',
                              background:
                                node().status === 'resolved'
                                  ? 'rgba(16,185,129,0.15)'
                                  : 'rgba(251,191,36,0.12)',
                              color: node().status === 'resolved' ? '#6ee7b7' : '#fde68a',
                              border: `1px solid ${node().status === 'resolved' ? 'rgba(16,185,129,0.25)' : 'rgba(251,191,36,0.25)'}`,
                            }}
                          >
                            {node().status}
                          </span>
                        </Show>
                        <span
                          style={{
                            'font-size': '10px',
                            padding: '2px 7px',
                            'border-radius': '999px',
                            background: 'rgba(255,255,255,0.06)',
                            color: '#6b7280',
                            'font-family': 'ui-monospace, monospace',
                          }}
                        >
                          {fmtTime(node().updatedAt)}
                        </span>
                      </div>
                    </div>
                    <div
                      style={{
                        padding: '10px 12px',
                        display: 'flex',
                        'flex-direction': 'column',
                        gap: '10px',
                        overflow: 'auto',
                        flex: '1',
                      }}
                    >
                      <Show when={node().tags.length > 0}>
                        <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '6px' }}>
                          <For each={node().tags}>
                            {(tag) => (
                              <span
                                style={{
                                  'font-size': '10px',
                                  padding: '2px 7px',
                                  'border-radius': '999px',
                                  background: 'rgba(255,255,255,0.06)',
                                  color: '#9ca3af',
                                  'font-family': 'ui-monospace, monospace',
                                }}
                              >
                                {tag}
                              </span>
                            )}
                          </For>
                        </div>
                      </Show>
                      <Show when={node().entities.length > 0}>
                        <div>
                          <div
                            style={{
                              'font-size': '10px',
                              'font-weight': '700',
                              color: '#6b7280',
                              'letter-spacing': '0.05em',
                              'text-transform': 'uppercase',
                              'margin-bottom': '6px',
                            }}
                          >
                            Entities
                          </div>
                          <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '6px' }}>
                            <For each={node().entities.slice(0, 8)}>
                              {(en) => (
                                <span
                                  style={{
                                    'font-size': '10px',
                                    padding: '2px 7px',
                                    'border-radius': '999px',
                                    background: 'rgba(0,0,0,0.28)',
                                    color: '#9ca3af',
                                    'font-family': 'ui-monospace, monospace',
                                  }}
                                >
                                  {en}
                                </span>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                      <div>
                        <div
                          style={{
                            'font-size': '10px',
                            'font-weight': '700',
                            color: '#6b7280',
                            'letter-spacing': '0.05em',
                            'text-transform': 'uppercase',
                            'margin-bottom': '6px',
                          }}
                        >
                          Evidence
                        </div>
                        <div
                          style={{
                            padding: '6px 8px',
                            'border-radius': '6px',
                            background: 'rgba(0,0,0,0.28)',
                            border: '1px solid rgba(255,255,255,0.06)',
                            'font-size': '11px',
                            color: '#9ca3af',
                            'white-space': 'pre-wrap',
                            'word-break': 'break-word',
                            'line-height': '1.5',
                          }}
                        >
                          {node().label}
                          <Show when={node().entities.length > 0}>
                            {'\n\nEntities: ' + node().entities.join(', ')}
                          </Show>
                          <Show when={node().tags.length > 0}>
                            {'\nTags: ' + node().tags.join(', ')}
                          </Show>
                          {'\n\nID: ' + node().id}
                        </div>
                      </div>
                      <div
                        style={{
                          'font-size': '10px',
                          color: '#6b7280',
                          'font-family': 'ui-monospace, monospace',
                          'line-height': '1.5',
                        }}
                      >
                        Created {fmtTime(node().createdAt)} · Accessed {node().accessCount}× · Last{' '}
                        {fmtTime(node().lastAccessedAt)}
                      </div>
                    </div>
                    <div
                      style={{
                        padding: '8px 12px',
                        'border-top': '1px solid rgba(255,255,255,0.06)',
                        display: 'flex',
                        gap: '6px',
                        'flex-wrap': 'wrap',
                      }}
                    >
                      <Show when={node().kind === 'knowledge'}>
                        <button
                          type="button"
                          onClick={() => void handleTouch(node())}
                          disabled={busy() === `touch:${node().id}`}
                          aria-label={`Refresh memory entry: ${node().label}`}
                          title="Refresh — mark as recently accessed"
                          style={{
                            flex: '1',
                            padding: '7px 12px',
                            'font-size': '12px',
                            'border-radius': '6px',
                            border: '1px solid rgba(255,255,255,0.12)',
                            background: 'transparent',
                            color: '#e5e7eb',
                            cursor: 'pointer',
                          }}
                        >
                          {busy() === `touch:${node().id}` ? '⟳…' : '⟳ refresh'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(node())}
                          disabled={busy() === `delete:${node().id}`}
                          aria-label={`Delete memory entry: ${node().label}`}
                          title="Delete — remove this knowledge entry"
                          style={{
                            flex: '1',
                            padding: '7px 12px',
                            'font-size': '12px',
                            'border-radius': '6px',
                            border: '1px solid rgba(239,68,68,0.25)',
                            background: 'transparent',
                            color: '#fca5a5',
                            cursor: 'pointer',
                          }}
                        >
                          {busy() === `delete:${node().id}` ? '…' : '🗑 delete'}
                        </button>
                      </Show>
                      <Show when={node().kind === 'finding' && node().status !== 'resolved'}>
                        <button
                          type="button"
                          onClick={() => void handlePromote(node())}
                          disabled={busy() === `promote:${node().id}`}
                          aria-label={`Promote finding to memory: ${node().label}`}
                          title="Promote — copy this finding into long-term memory"
                          style={{
                            flex: '1',
                            padding: '7px 12px',
                            'font-size': '12px',
                            'border-radius': '6px',
                            border: '1px solid rgba(99,102,241,0.5)',
                            background: 'rgba(99,102,241,0.9)',
                            color: 'white',
                            cursor: 'pointer',
                          }}
                        >
                          {busy() === `promote:${node().id}` ? '⬆…' : '⬆ promote'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleResolve(node())}
                          disabled={busy() === `resolve:${node().id}`}
                          aria-label={`Resolve finding: ${node().label}`}
                          style={{
                            flex: '1',
                            padding: '7px 12px',
                            'font-size': '12px',
                            'border-radius': '6px',
                            border: '1px solid rgba(99,102,241,0.5)',
                            background: 'rgba(99,102,241,0.9)',
                            color: 'white',
                            cursor: 'pointer',
                          }}
                        >
                          {busy() === `resolve:${node().id}` ? '✓…' : '✓ resolve'}
                        </button>
                      </Show>
                      <button
                        type="button"
                        onClick={() => {
                          props.onOpenInChat?.(node())
                          setSelectedId(null)
                        }}
                        style={{
                          flex: '1',
                          padding: '7px 12px',
                          'font-size': '12px',
                          'border-radius': '6px',
                          border: '1px solid rgba(255,255,255,0.12)',
                          background: 'transparent',
                          color: '#e5e7eb',
                          cursor: 'pointer',
                        }}
                      >
                        open in chat ↗
                      </button>
                    </div>
                  </div>
                )}
              </Show>
            </Show>
          }
        >
          {/* empty state */}
          <div
            role="status"
            aria-live="polite"
            style={{
              flex: '1',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              padding: '24px',
              'text-align': 'center',
            }}
          >
            <div>
              <div
                aria-hidden="true"
                style={{
                  'font-size': '24px',
                  'letter-spacing': '8px',
                  opacity: '0.3',
                  'margin-bottom': '12px',
                }}
              >
                ◈
              </div>
              <div
                style={{
                  'font-size': '14px',
                  'font-weight': '600',
                  color: '#e5e7eb',
                  'margin-bottom': '6px',
                }}
              >
                Mira hasn't learned this repo yet
              </div>
              <div
                style={{
                  'font-size': '12px',
                  color: '#9ca3af',
                  'max-width': '36ch',
                  'line-height': '1.55',
                  margin: '0 auto 14px',
                }}
              >
                Run a session, trigger learning, or seed knowledge below — the graph will populate
                as Mira captures trajectories, facts, and skills.
              </div>
              {seedForm('empty')}
            </div>
          </div>
        </Show>
      </div>

      {/* error */}
      <Show when={graph.error}>
        <div
          role="alert"
          style={{
            margin: '8px 12px',
            padding: '6px 8px',
            'border-radius': '6px',
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.22)',
            color: '#fecaca',
            'font-size': '11px',
          }}
        >
          ⚠ Failed to load graph: {String(graph.error)}
        </div>
      </Show>
    </div>
  )
}
