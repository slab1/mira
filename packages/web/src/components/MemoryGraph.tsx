import { createSignal, createResource, For, Show, onMount, onCleanup, createEffect } from "solid-js"
import { api, type GraphNode, type GraphEdge, type KnowledgeGraph } from "../api/client"

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
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  } catch { return "" }
}

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Deterministic layout: tier columns + hash jitter + simple repulsion */
function layout(nodes: GraphNode[], edges: GraphEdge[]): Map<string, { x: number; y: number }> {
  const W = 1000
  const H = 600
  const pad = 40
  const pos = new Map<string, { x: number; y: number }>()

  // Initial: tier columns (episodic left, semantic center, procedural right), jitter by hash
  for (const n of nodes) {
    const h = hashStr(n.id)
    let baseX: number
    if (n.tier === "episodic") baseX = W * 0.22
    else if (n.tier === "procedural") baseX = W * 0.78
    else baseX = W * 0.5
    // spread within column ±140
    const jx = ((h % 280) - 140)
    const jy = ((hashStr(n.label + n.id) % 480) - 240)
    // also spread vertically by index to avoid stacking
    const idx = nodes.indexOf(n)
    const rowY = pad + 60 + (idx % 8) * 64 + (h % 24)
    const x = Math.max(pad + 40, Math.min(W - pad - 40, baseX + jx * 0.6))
    const y = Math.max(pad + 20, Math.min(H - pad - 20, rowY + jy * 0.15))
    pos.set(n.id, { x, y })
  }

  // 2 iterations of simple repulsion to reduce overlap
  for (let iter = 0; iter < 12; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id)!
        const b = pos.get(nodes[j].id)!
        const dx = a.x - b.x
        const dy = a.y - b.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const minDist = 78
        if (dist < minDist) {
          const push = (minDist - dist) * 0.18
          const nx = (dx / dist) * push
          const ny = (dy / dist) * push
          a.x = Math.max(pad, Math.min(W - pad, a.x + nx))
          a.y = Math.max(pad, Math.min(H - pad, a.y + ny))
          b.x = Math.max(pad, Math.min(W - pad, b.x - nx))
          b.y = Math.max(pad, Math.min(H - pad, b.y - ny))
        }
      }
    }
    // attract along edges slightly
    for (const e of edges) {
      const a = pos.get(e.from)
      const b = pos.get(e.to)
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      if (dist > 140) {
        const pull = (dist - 140) * 0.02
        const nx = (dx / dist) * pull
        const ny = (dy / dist) * pull
        a.x += nx
        a.y += ny
        b.x -= nx
        b.y -= ny
      }
    }
  }
  return pos
}

function tierColor(tier: string): string {
  if (tier === "episodic") return "var(--warn)"
  if (tier === "procedural") return "var(--accent)"
  return "var(--ok)"
}

export function MemoryGraph(props: Props) {
  const [graph, { refetch }] = createResource(() => api.getKnowledgeGraph(100).catch(() => ({ nodes: [], edges: [] } as KnowledgeGraph)))
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [hoveredId, setHoveredId] = createSignal<string | null>(null)
  const [focusIndex, setFocusIndex] = createSignal(0)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [seedTitle, setSeedTitle] = createSignal("")
  const [seedContent, setSeedContent] = createSignal("")
  const [seedTier, setSeedTier] = createSignal("semantic")
  const [showSeed, setShowSeed] = createSignal(false)
  const [seedError, setSeedError] = createSignal<string | null>(null)

  const nodes = () => graph()?.nodes ?? []
  const edges = () => graph()?.edges ?? []
  const selected = () => nodes().find(n => n.id === selectedId()) ?? null

  // positions derived
  const positions = () => {
    const ns = nodes()
    const es = edges()
    if (!ns.length) return new Map<string, { x: number; y: number }>()
    return layout(ns, es)
  }

  // keyboard nav: arrow to cycle, Enter to select, Esc to clear
  const onKeyDown = (e: KeyboardEvent) => {
    const ns = nodes()
    if (!ns.length) return
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault()
      const next = (focusIndex() + 1) % ns.length
      setFocusIndex(next)
      setSelectedId(ns[next].id)
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault()
      const next = (focusIndex() - 1 + ns.length) % ns.length
      setFocusIndex(next)
      setSelectedId(ns[next].id)
    } else if (e.key === "Escape") {
      setSelectedId(null)
    } else if (e.key === "Enter") {
      const n = ns[focusIndex()]
      if (n) setSelectedId(n.id)
    }
  }

  // keep focusIndex in sync with selectedId
  createEffect(() => {
    const id = selectedId()
    if (!id) return
    const idx = nodes().findIndex(n => n.id === id)
    if (idx >= 0) setFocusIndex(idx)
  })

  // auto-select first on load for keyboard a11y
  createEffect(() => {
    const ns = nodes()
    if (ns.length && selectedId() === null) {
      // don't auto-select visually, but set focus index 0 for keyboard
      setFocusIndex(0)
    }
  })

  const handleResolve = async (n: GraphNode) => {
    if (n.kind !== "finding") return
    setBusy(`resolve:${n.id}`)
    try {
      await api.resolveFinding(n.id)
      await refetch()
    } catch {} finally {
      setBusy(null)
    }
  }

  const handleTouch = async (n: GraphNode) => {
    if (n.kind !== "knowledge") return
    setBusy(`touch:${n.id}`)
    try {
      await api.touchKnowledge(n.id)
      await refetch()
    } catch {} finally {
      setBusy(null)
    }
  }

  const handlePromote = async (n: GraphNode) => {
    if (n.kind !== "finding") return
    setBusy(`promote:${n.id}`)
    try {
      await api.promoteFinding(n.id)
      await refetch()
    } catch {} finally {
      setBusy(null)
    }
  }

  const handleSeed = async () => {
    const title = seedTitle().trim()
    const content = seedContent().trim()
    if (!title || !content) {
      setSeedError("Title and content are required.")
      return
    }
    if (title.length > 200) {
      setSeedError("Title must be 200 characters or fewer.")
      return
    }
    if (content.length > 4000) {
      setSeedError("Content must be 4000 characters or fewer.")
      return
    }
    setBusy("seed")
    setSeedError(null)
    try {
      await api.seedKnowledge({ title, content, tier: seedTier() })
      setSeedTitle("")
      setSeedContent("")
      setSeedTier("semantic")
      setShowSeed(false)
      await refetch()
    } catch (e) {
      setSeedError(e instanceof Error ? e.message : "Seed failed.")
    } finally {
      setBusy(null)
    }
  }

  /** Shared seed form — rendered in the empty state AND the toolbar bar (never both). */
  const seedForm = (prefix: string) => (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void handleSeed()
      }}
      aria-label="Seed knowledge form"
      style={{ display: "flex", "flex-direction": "column", gap: "8px", width: "100%", "max-width": "44ch", margin: prefix === "empty" ? "0 auto" : "0", "text-align": "left" }}
    >
      <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
        <label class="settings-label" for={`${prefix}-seed-title`}>Title</label>
        <input
          id={`${prefix}-seed-title`}
          class="input"
          type="text"
          value={seedTitle()}
          onInput={(e) => setSeedTitle(e.currentTarget.value)}
          placeholder="What should Mira remember?"
          maxlength={200}
          style={{ "font-size": "var(--fs-sm)" }}
        />
      </div>
      <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
        <label class="settings-label" for={`${prefix}-seed-content`}>Content</label>
        <textarea
          id={`${prefix}-seed-content`}
          class="input"
          value={seedContent()}
          onInput={(e) => setSeedContent(e.currentTarget.value)}
          placeholder="The fact, decision, or snippet…"
          rows={3}
          maxlength={4000}
          style={{ resize: "vertical", "font-size": "var(--fs-sm)", "line-height": "1.5" }}
        />
      </div>
      <div style={{ display: "flex", gap: "8px", "align-items": "flex-end" }}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "4px", flex: "1" }}>
          <label class="settings-label" for={`${prefix}-seed-tier`}>Tier</label>
          <select
            id={`${prefix}-seed-tier`}
            class="input"
            value={seedTier()}
            onChange={(e) => setSeedTier(e.currentTarget.value)}
            style={{ "font-size": "var(--fs-sm)" }}
          >
            <option value="semantic">semantic</option>
            <option value="episodic">episodic</option>
            <option value="procedural">procedural</option>
          </select>
        </div>
        <button
          type="submit"
          class="btn btn-solid"
          disabled={busy() === "seed"}
          aria-label="Save knowledge entry"
          style={{ padding: "7px 14px", "font-size": "var(--fs-sm)", "white-space": "nowrap" }}
        >
          {busy() === "seed" ? "Saving…" : "+ Seed memory"}
        </button>
      </div>
      <Show when={seedError()}>
        <div class="alert" role="alert" style={{ "font-size": "var(--fs-xs)" }}>{seedError()}</div>
      </Show>
    </form>
  )

  return (
    <div
      class="memory-canvas"
      role="application"
      aria-label="Memory graph — knowledge entries and findings"
      aria-roledescription="interactive graph"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {/* toolbar */}
      <div class="memory-canvas-toolbar">
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <span style={{ "font-size": "var(--fs-sm)", "font-weight": "700", color: "var(--fg)", "letter-spacing": "-0.01em" }}>Memory Graph</span>
          <Show when={!graph.loading}>
            <span class="pill" style={{ "font-size": "var(--fs-2xs)", padding: "1px 7px" }}>
              {nodes().length} nodes · {edges().length} edges
            </span>
          </Show>
          <Show when={graph.loading}>
            <span class="pill pill-warn" style={{ "font-size": "var(--fs-2xs)" }}>loading…</span>
          </Show>
          <Show when={nodes().length > 0}>
            <button
              type="button"
              class={showSeed() ? "btn btn-outline" : "btn btn-ghost"}
              onClick={() => setShowSeed((v) => !v)}
              aria-label={showSeed() ? "Hide seed knowledge form" : "Seed a knowledge entry"}
              aria-expanded={showSeed() ? "true" : "false"}
              style={{ padding: "3px 10px", "font-size": "var(--fs-xs)", border: "1px solid var(--border)", "border-radius": "var(--r-full)" }}
            >
              {showSeed() ? "✕ seed" : "+ seed"}
            </button>
          </Show>
        </div>
        <div class="memory-canvas-legend" aria-hidden="true">
          <span class="memory-legend-item"><span class="memory-legend-dot" style={{ background: "var(--warn)" }} /> episodic</span>
          <span class="memory-legend-item"><span class="memory-legend-rect" style={{ background: "var(--ok-soft)", "border-color": "var(--ok-border)" }} /> semantic</span>
          <span class="memory-legend-item"><span class="memory-legend-diamond" style={{ background: "var(--accent-soft)", "border-color": "var(--accent)" }} /> procedural</span>
        </div>
      </div>
      {/* collapsible seed bar (non-empty graphs) */}
      <Show when={showSeed() && nodes().length > 0}>
        <div style={{ padding: "10px 12px", "border-bottom": "1px solid var(--border)", background: "var(--bg-app)" }}>
          {seedForm("bar")}
        </div>
      </Show>

      {/* graph area */}
      <div style={{ flex: "1", position: "relative", "min-height": "0", overflow: "hidden", display: "flex" }}>
        <Show
          when={!graph.loading && nodes().length === 0}
          fallback={
            <Show
              when={!graph.loading}
              fallback={
                <div style={{ flex: "1", display: "grid", "place-items": "center", color: "var(--fg-faint)", "font-size": "var(--fs-sm)" }}>
                  Loading graph…
                </div>
              }
            >
              {/* SVG canvas */}
              <svg
                class="memory-graph-svg"
                viewBox="0 0 1000 600"
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={`Memory graph with ${nodes().length} nodes`}
              >
                {/* edges */}
                <g aria-hidden="true">
                  <For each={edges()}>
                    {(e) => {
                      const a = () => positions().get(e.from)
                      const b = () => positions().get(e.to)
                      const isDashed = () => e.kind === "entity" || e.kind === "finding"
                      const isHighlighted = () => hoveredId() === e.from || hoveredId() === e.to || selectedId() === e.from || selectedId() === e.to
                      return (
                        <Show when={a() && b()}>
                          <line
                            x1={a()!.x}
                            y1={a()!.y}
                            x2={b()!.x}
                            y2={b()!.y}
                            class={`memory-edge ${isDashed() ? "memory-edge-dashed" : ""} ${isHighlighted() ? "memory-edge-highlight" : ""}`}
                            aria-hidden="true"
                          />
                        </Show>
                      )
                    }}
                  </For>
                </g>

                {/* nodes */}
                <g>
                  <For each={nodes()}>
                    {(n) => {
                      const p = () => positions().get(n.id)
                      const decayed = () => isDecayed(n)
                      const fresh = () => isFresh(n)
                      const isSelected = () => selectedId() === n.id
                      const isHovered = () => hoveredId() === n.id
                      const label = () => n.label.length > 28 ? n.label.slice(0, 28) + "…" : n.label
                      return (
                        <Show when={p()}>
                          <g
                            class={`memory-node memory-node-${n.tier} ${decayed() ? "memory-node-decay" : ""} ${fresh() ? "memory-node-fresh" : ""} ${isSelected() ? "memory-node-selected" : ""}`}
                            transform={`translate(${p()!.x}, ${p()!.y})`}
                            role="button"
                            tabindex={0}
                            aria-label={`${n.tier} ${n.kind}: ${n.label} — ${n.source}${n.severity ? ` severity ${n.severity}` : ""}`}
                            aria-selected={isSelected() ? "true" : "false"}
                            onClick={() => setSelectedId(n.id)}
                            onMouseEnter={() => setHoveredId(n.id)}
                            onMouseLeave={() => setHoveredId(null)}
                            onFocus={() => setHoveredId(n.id)}
                            onBlur={() => setHoveredId(null)}
                            onKeyDown={(e: KeyboardEvent) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault()
                                setSelectedId(n.id)
                              }
                            }}
                          >
                            {/* episodic: amber dot + tail */}
                            <Show when={n.tier === "episodic"}>
                              <line x1={-14} y1={0} x2={-7} y2={0} stroke="var(--warn)" stroke-width="1.2" opacity={0.6} />
                              <circle r={isSelected() || isHovered() ? 8 : 6} fill="var(--warn)" stroke="var(--bg-canvas)" stroke-width={1.5} />
                              <Show when={isSelected() || isHovered()}>
                                <circle r={11} fill="none" stroke="var(--warn)" stroke-width={1} opacity={0.35} />
                              </Show>
                              <text x={12} y={-10} text-anchor="start" font-family="var(--font-mono)" font-size="9.5" fill="var(--fg-faint)">{fmtTime(n.updatedAt || n.createdAt)}</text>
                              <text x={12} y={4} text-anchor="start" font-family="var(--font-sans)" font-size="11" font-weight={isSelected() ? 600 : 500} fill={decayed() ? "var(--fg-faint)" : "var(--fg)"}>{label()}</text>
                            </Show>

                            {/* semantic: emerald rounded rect */}
                            <Show when={n.tier === "semantic"}>
                              <rect x={-62} y={-16} width={124} height={32} rx={8} ry={8} />
                              <text x={0} y={5} text-anchor="middle" font-family="var(--font-sans)" font-size="10.5" font-weight={isSelected() ? 600 : 500} fill={decayed() ? "var(--fg-faint)" : "var(--fg)"}>{label()}</text>
                              <Show when={n.entities.length > 0}>
                                <text x={0} y={-22} text-anchor="middle" font-family="var(--font-mono)" font-size="8.5" fill="var(--fg-faint)">{n.entities[0].slice(0, 22)}</text>
                              </Show>
                            </Show>

                            {/* procedural: violet diamond */}
                            <Show when={n.tier === "procedural"}>
                              <polygon points="0,-18 18,0 0,18 -18,0" />
                              <text x={0} y={4} text-anchor="middle" font-family="var(--font-sans)" font-size="10" font-weight={isSelected() ? 600 : 500} fill={decayed() ? "var(--fg-faint)" : "var(--fg)"}>{label().slice(0, 16)}</text>
                            </Show>

                            {/* fallback for unknown tier: treat as semantic */}
                            <Show when={n.tier !== "episodic" && n.tier !== "semantic" && n.tier !== "procedural"}>
                              <rect x={-62} y={-16} width={124} height={32} rx={8} ry={8} fill="var(--bg-surface)" stroke="var(--border-strong)" />
                              <text x={0} y={5} text-anchor="middle" font-family="var(--font-sans)" font-size="10.5" fill="var(--fg)">{label()}</text>
                            </Show>
                          </g>
                        </Show>
                      )
                    }}
                  </For>
                </g>
              </svg>

              {/* detail card */}
              <Show when={selected()}>
                {(node) => (
                  <div class="memory-detail-card" role="dialog" aria-label={`Details for ${node().label}`} aria-modal="false">
                    <div class="memory-detail-head">
                      <div style={{ display: "flex", "align-items": "center", gap: "8px", "justify-content": "space-between" }}>
                        <span
                          style={{
                            width: "8px",
                            height: "8px",
                            "border-radius": "50%",
                            background: tierColor(node().tier),
                            flex: "none",
                          }}
                          aria-hidden="true"
                        />
                        <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "font-family": "var(--font-mono)", "text-transform": "uppercase", "letter-spacing": "0.06em", flex: "1" }}>
                          {node().tier} · {node().kind}
                        </span>
                        <button
                          type="button"
                          class="btn btn-ghost"
                          onClick={() => setSelectedId(null)}
                          aria-label="Close details"
                          style={{ padding: "3px 8px", "font-size": "var(--fs-xs)", border: "1px solid var(--border)", "border-radius": "var(--r-full)" }}
                        >
                          ✕
                        </button>
                      </div>
                      <div class="memory-detail-title" style={{ "margin-top": "8px" }}>{node().label}</div>
                      <div class="memory-detail-meta">
                        <span class="pill" style={{ "font-size": "var(--fs-2xs)", padding: "2px 7px" }}>{node().source}</span>
                        <Show when={node().severity}>
                          <span
                            class={`pill ${node().severity === "critical" ? "pill-danger" : node().severity === "major" ? "pill-warn" : node().severity === "minor" ? "pill-accent" : ""}`}
                            style={{ "font-size": "var(--fs-2xs)", padding: "2px 7px" }}
                          >
                            {node().severity}
                          </span>
                        </Show>
                        <Show when={node().status}>
                          <span class="pill" style={{ "font-size": "var(--fs-2xs)", padding: "2px 7px", background: node().status === "resolved" ? "var(--ok-soft)" : "var(--warn-soft)", color: node().status === "resolved" ? "var(--ok)" : "var(--warn)", border: `1px solid ${node().status === "resolved" ? "var(--ok-border)" : "var(--warn-border)"}` }}>
                            {node().status}
                          </span>
                        </Show>
                        <span class="pill" style={{ "font-size": "var(--fs-2xs)", padding: "2px 7px", "font-family": "var(--font-mono)" }}>{fmtTime(node().updatedAt)}</span>
                      </div>
                    </div>
                    <div class="memory-detail-body">
                      <Show when={node().tags.length > 0}>
                        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
                          <For each={node().tags}>
                            {(tag) => <span class="pill" style={{ "font-size": "var(--fs-2xs)", padding: "2px 7px", "font-family": "var(--font-mono)" }}>{tag}</span>}
                          </For>
                        </div>
                      </Show>
                      <Show when={node().entities.length > 0}>
                        <div>
                          <div style={{ "font-size": "var(--fs-2xs)", "font-weight": "700", color: "var(--fg-subtle)", "letter-spacing": "0.05em", "text-transform": "uppercase", "margin-bottom": "6px" }}>Entities</div>
                          <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
                            <For each={node().entities.slice(0, 8)}>
                              {(en) => <span class="pill" style={{ "font-size": "var(--fs-2xs)", padding: "2px 7px", background: "var(--bg-app)", "font-family": "var(--font-mono)" }}>{en}</span>}
                            </For>
                          </div>
                        </div>
                      </Show>
                      <div>
                        <div style={{ "font-size": "var(--fs-2xs)", "font-weight": "700", color: "var(--fg-subtle)", "letter-spacing": "0.05em", "text-transform": "uppercase", "margin-bottom": "6px" }}>Evidence</div>
                        <div class="memory-detail-evidence">
                          {node().label}
                          <Show when={node().entities.length > 0}>
                            {"\n\nEntities: " + node().entities.join(", ")}
                          </Show>
                          <Show when={node().tags.length > 0}>
                            {"\nTags: " + node().tags.join(", ")}
                          </Show>
                          {"\n\nID: " + node().id}
                        </div>
                      </div>
                      <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "font-family": "var(--font-mono)", "line-height": "1.5" }}>
                        Created {fmtTime(node().createdAt)} · Accessed {node().accessCount}× · Last {fmtTime(node().lastAccessedAt)}
                      </div>
                    </div>
                    <div class="memory-detail-actions">
                      <Show when={node().kind === "knowledge"}>
                        <button
                          type="button"
                          class="btn btn-outline"
                          onClick={() => void handleTouch(node())}
                          disabled={busy() === `touch:${node().id}`}
                          aria-label={`Refresh memory entry: ${node().label}`}
                          title="Refresh — mark as recently accessed"
                          style={{ flex: "1", padding: "7px 12px", "font-size": "var(--fs-sm)" }}
                        >
                          {busy() === `touch:${node().id}` ? "⟳…" : "⟳ refresh"}
                        </button>
                      </Show>
                      <Show when={node().kind === "finding" && node().status !== "resolved"}>
                        <button
                          type="button"
                          class="btn btn-solid"
                          onClick={() => void handlePromote(node())}
                          disabled={busy() === `promote:${node().id}`}
                          aria-label={`Promote finding to memory: ${node().label}`}
                          title="Promote — copy this finding into long-term memory"
                          style={{ flex: "1", padding: "7px 12px", "font-size": "var(--fs-sm)" }}
                        >
                          {busy() === `promote:${node().id}` ? "⬆…" : "⬆ promote"}
                        </button>
                        <button
                          type="button"
                          class="btn btn-solid"
                          onClick={() => void handleResolve(node())}
                          disabled={busy() === `resolve:${node().id}`}
                          aria-label={`Resolve finding: ${node().label}`}
                          style={{ flex: "1", padding: "7px 12px", "font-size": "var(--fs-sm)" }}
                        >
                          {busy() === `resolve:${node().id}` ? "✓…" : "✓ resolve"}
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="btn btn-outline"
                        onClick={() => {
                          props.onOpenInChat?.(node())
                          setSelectedId(null)
                        }}
                        style={{ flex: "1", padding: "7px 12px", "font-size": "var(--fs-sm)" }}
                      >
                        open in chat ↗
                      </button>
                    </div>
                  </div>
                )}
              </Show>

              {/* a11y list fallback — screen readers + keyboard */}
              <div class="sr-only" role="list" aria-label="Memory nodes list">
                <For each={nodes()}>
                  {(n) => (
                    <div role="listitem">
                      {n.tier} {n.kind}: {n.label} — {n.source} — {fmtTime(n.updatedAt)}
                    </div>
                  )}
                </For>
              </div>
            </Show>
          }
        >
          {/* empty state */}
          <div class="memory-empty" role="status" aria-live="polite">
            <div>
              <div class="memory-empty-circles" aria-hidden="true">
                <span />
                <span />
                <span>◈</span>
              </div>
              <div style={{ "font-size": "var(--fs-md)", "font-weight": "600", color: "var(--fg)", "margin-bottom": "6px" }}>
                Mira hasn't learned this repo yet
              </div>
              <div style={{ "font-size": "var(--fs-sm)", color: "var(--fg-subtle)", "max-width": "36ch", "line-height": "1.55", margin: "0 auto 14px" }}>
                Run a session, trigger learning, or seed knowledge below — the graph will populate as Mira captures trajectories, facts, and skills.
              </div>
              {seedForm("empty")}
            </div>
          </div>
        </Show>
      </div>

      {/* error */}
      <Show when={graph.error}>
        <div class="alert" role="alert" style={{ margin: "8px 12px", "font-size": "var(--fs-xs)" }}>
          ⚠ Failed to load graph: {String(graph.error)}
        </div>
      </Show>
    </div>
  )
}
