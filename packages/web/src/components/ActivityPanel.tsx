import { For, Show, createSignal, createMemo, createEffect, onCleanup } from 'solid-js'
import type { AppStore } from '../stores/app'
import type { Part, Todo } from '../api/client'

// ── Types ──────────────────────────────────────────────────────────────

type ActivityEntry = {
  id: string
  tool: string
  status: 'running' | 'done' | 'error'
  input?: unknown
  output?: unknown
  elapsedMs?: number
  timestamp: number
  type: 'tool_call' | 'tool_result' | 'reasoning'
  raw: Part
}

type FilterType = 'all' | 'tool_call' | 'reasoning' | 'approval'

// ── Helpers ────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function toolIcon(tool: string): string {
  const map: Record<string, string> = {
    read: '◫',
    write: '✎',
    edit: '✎',
    patch: '⬡',
    bash: '›',
    grep: '⌕',
    glob: '⬢',
    web: '◯',
    fetch: '◯',
    task: '⬣',
  }
  return map[tool] ?? '⬔'
}

function statusMeta(status: ActivityEntry['status']) {
  switch (status) {
    case 'running':
      return { label: 'running', dotClass: 'activity-step-dot-running', icon: '◷' }
    case 'done':
      return { label: 'done', dotClass: 'activity-step-dot-done', icon: '✓' }
    case 'error':
      return { label: 'error', dotClass: 'activity-step-dot-error', icon: '✕' }
  }
}

// ── Detail disclosure ─────────────────────────────────────────────────

function EntryDetail(props: { entry: ActivityEntry }) {
  const [level, setLevel] = createSignal<1 | 2 | 3>(1)

  const summary = () => {
    const inp = props.entry.input as Record<string, unknown> | undefined
    if (!inp) return ''
    if (props.entry.tool === 'edit' && inp.path)
      return `${String(inp.path)}: ${String(inp.oldString ?? '').slice(0, 60)} → ${String(inp.newString ?? '').slice(0, 60)}`
    if (props.entry.tool === 'write' && inp.path)
      return `${String(inp.path)} (${String(inp.content ?? '').length} chars)`
    if (props.entry.tool === 'bash' && inp.command) return String(inp.command).slice(0, 120)
    if (props.entry.tool === 'read' && inp.path) return String(inp.path)
    if (props.entry.tool === 'grep' && inp.pattern) return `/${String(inp.pattern).slice(0, 60)}/`
    return JSON.stringify(inp).slice(0, 120)
  }

  const jsonStr = (v: unknown) => {
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }

  return (
    <div class="activity-entry-detail">
      {/* Level 1: summary */}
      <Show when={summary()}>
        <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'line-height': '1.5' }}>
          {summary()}
        </div>
      </Show>

      {/* Level 2: formatted inputs */}
      <Show when={level() >= 2}>
        <Show when={props.entry.input !== undefined}>
          <div>
            <div
              style={{
                'font-size': 'var(--fs-2xs)',
                'font-weight': '600',
                color: 'var(--fg-muted)',
                'margin-bottom': '4px',
                'letter-spacing': '0.04em',
                'text-transform': 'uppercase',
              }}
            >
              Input
            </div>
            <pre class="activity-entry-json">{jsonStr(props.entry.input)}</pre>
          </div>
        </Show>
        <Show when={props.entry.output !== undefined}>
          <div>
            <div
              style={{
                'font-size': 'var(--fs-2xs)',
                'font-weight': '600',
                color: 'var(--fg-muted)',
                'margin-bottom': '4px',
                'letter-spacing': '0.04em',
                'text-transform': 'uppercase',
              }}
            >
              Output
            </div>
            <pre class="activity-entry-json">{jsonStr(props.entry.output)}</pre>
          </div>
        </Show>
      </Show>

      {/* Level 3: raw request/response */}
      <Show when={level() >= 3}>
        <div>
          <div
            style={{
              'font-size': 'var(--fs-2xs)',
              'font-weight': '600',
              color: 'var(--fg-muted)',
              'margin-bottom': '4px',
              'letter-spacing': '0.04em',
              'text-transform': 'uppercase',
            }}
          >
            Raw
          </div>
          <pre class="activity-entry-json">{jsonStr(props.entry.raw)}</pre>
        </div>
      </Show>

      <div class="activity-entry-actions">
        <Show when={level() === 1 && (props.entry.input !== undefined || props.entry.output !== undefined)}>
          <button type="button" class="btn btn-ghost" onClick={() => setLevel(2)} style={{ padding: '3px 8px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-full)' }}>
            Show details
          </button>
        </Show>
        <Show when={level() === 2}>
          <button type="button" class="btn btn-ghost" onClick={() => setLevel(3)} style={{ padding: '3px 8px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-full)' }}>
            Show raw
          </button>
          <button type="button" class="btn btn-ghost" onClick={() => setLevel(1)} style={{ padding: '3px 8px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-full)' }}>
            Collapse
          </button>
        </Show>
        <Show when={level() === 3}>
          <button type="button" class="btn btn-ghost" onClick={() => setLevel(2)} style={{ padding: '3px 8px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-full)' }}>
            Hide raw
          </button>
        </Show>
      </div>
    </div>
  )
}

// ── Single entry row ──────────────────────────────────────────────────

function ActivityEntryRow(props: { entry: ActivityEntry; isLast: boolean }) {
  const [open, setOpen] = createSignal(false)
  const meta = () => statusMeta(props.entry.status)

  return (
    <div class="activity-entry">
      <div class="activity-entry-line">
        <div class={`activity-step-dot ${meta().dotClass}`} aria-hidden="true">
          {meta().icon}
        </div>
        <Show when={!props.isLast}>
          <div class="activity-entry-connector" />
        </Show>
      </div>
      <div class={`activity-entry-card ${props.entry.status === 'running' ? 'activity-entry-card-running' : ''} ${props.entry.status === 'error' ? 'activity-entry-card-error' : ''}`}>
        <button type="button" class="activity-entry-head" onClick={() => setOpen(!open())} aria-expanded={open() ? 'true' : 'false'}>
          <span style={{ 'font-size': '11px', color: 'var(--fg-subtle)', flex: 'none' }}>{toolIcon(props.entry.tool)}</span>
          <span class="activity-entry-tool">{props.entry.tool || props.entry.type}</span>
          <Show when={props.entry.type === 'reasoning'}>
            <span class="pill" style={{ 'font-size': 'var(--fs-2xs)', padding: '1px 6px', background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent-border)' }}>
              reasoning
            </span>
          </Show>
          <Show when={props.entry.elapsedMs !== undefined}>
            <span class="activity-entry-time">{formatElapsed(props.entry.elapsedMs!)}</span>
          </Show>
          <Show when={props.entry.status === 'running'}>
            <span class="dot dot-pulse" style={{ background: 'var(--warn)', width: '6px', height: '6px', flex: 'none' }} />
          </Show>
          <span class={`activity-entry-chevron ${open() ? 'open' : ''}`}>▶</span>
        </button>
        <Show when={open()}>
          <EntryDetail entry={props.entry} />
        </Show>
      </div>
    </div>
  )
}

// ── Step group ────────────────────────────────────────────────────────

function StepGroup(props: { todo: Todo; entries: ActivityEntry[]; index: number; total: number }) {
  const [expanded, setExpanded] = createSignal(props.todo.status === 'in_progress')
  const done = () => props.todo.status === 'completed'
  const running = () => props.todo.status === 'in_progress'
  const dotClass = () => (done() ? 'activity-step-dot-done' : running() ? 'activity-step-dot-running' : '')

  return (
    <div class="activity-step-group">
      <button
        type="button"
        class="activity-step-header"
        onClick={() => setExpanded(!expanded())}
        aria-expanded={expanded() ? 'true' : 'false'}
        style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0', 'text-align': 'left', 'font-family': 'inherit' }}
      >
        <span class={`activity-step-dot ${dotClass()}`} aria-hidden="true">
          {done() ? '✓' : running() ? '◷' : '○'}
        </span>
        <span style={{ flex: '1', 'min-width': '0', 'font-size': 'var(--fs-sm)', 'font-weight': running() || done() ? '600' : '500', color: done() ? 'var(--fg-subtle)' : 'var(--fg)', 'text-decoration': done() ? 'line-through' : 'none', 'line-height': '1.4' }}>
          {props.todo.content}
        </span>
        <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'font-family': 'var(--font-mono)', flex: 'none' }}>
          {props.index + 1}/{props.total}
        </span>
        <span class={`activity-entry-chevron ${expanded() ? 'open' : ''}`} style={{ 'font-size': '9px', color: 'var(--fg-faint)' }}>
          ▶
        </span>
      </button>
      <Show when={expanded()}>
        <Show when={props.entries.length > 0} fallback={<div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-faint)', padding: '4px 0 4px 26px' }}>No tool calls yet</div>}>
          <div style={{ 'padding-left': '4px' }}>
            <For each={props.entries}>{(entry, i) => <ActivityEntryRow entry={entry} isLast={i() === props.entries.length - 1} />}</For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────

export function ActivityPanel(props: { store: AppStore; collapsed: boolean; onToggle: () => void }) {
  const [filter, setFilter] = createSignal<FilterType>('all')
  const [liveEntries, setLiveEntries] = createSignal<ActivityEntry[]>([])
  const [liveStart] = createSignal(Date.now())

  // Derive entries from messages' parts (tool_call / tool_result / reasoning)
  const derivedEntries = createMemo<ActivityEntry[]>(() => {
    const msgs = props.store.state.messages
    const entries: ActivityEntry[] = []
    let seq = 0
    for (const m of msgs) {
      if (!m.parts) continue
      for (const p of m.parts) {
        if (p.type === 'tool_call' || p.type === 'tool_result' || p.type === 'reasoning') {
          const isCall = p.type === 'tool_call'
          const isReasoning = p.type === 'reasoning'
          entries.push({
            id: `${m.id}-${seq++}`,
            tool: p.tool ?? (isReasoning ? 'reasoning' : ''),
            status: isCall ? 'done' : p.type === 'tool_result' ? 'done' : 'done',
            input: p.input,
            output: p.output ?? (p.text ? p.text : undefined),
            timestamp: new Date(m.createdAt).getTime(),
            type: p.type as ActivityEntry['type'],
            raw: p,
          })
        }
      }
    }
    // Merge live streaming entries (tool calls appearing via SSE before message sync)
    const live = liveEntries()
    // Deduplicate by tool+input JSON
    const seen = new Set(entries.map((e) => `${e.tool}:${JSON.stringify(e.input)}`))
    for (const le of live) {
      const key = `${le.tool}:${JSON.stringify(le.input)}`
      if (!seen.has(key)) entries.push(le)
    }
    return entries
  })

  // Track streaming tool calls via store's streamText changes — when streaming,
  // we show a live indicator. Actual tool parts arrive after stream completes via loadMessages.
  // For real-time feel, we also listen to BusEvent tool updates if available.
  // Here we synthesize a "streaming" entry when store is streaming but no new parts yet.
  const isStreaming = () => props.store.state.streaming

  // Elapsed timer for running entries
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!isStreaming() && derivedEntries().every((e) => e.status !== 'running')) return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(iv))
  })

  const filteredEntries = createMemo(() => {
    const f = filter()
    const all = derivedEntries()
    if (f === 'all') return all
    if (f === 'reasoning') return all.filter((e) => e.type === 'reasoning')
    if (f === 'tool_call') return all.filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
    if (f === 'approval') return all.filter((e) => e.raw.denied !== undefined)
    return all
  })

  // Group entries by todo step (round-robin assignment for now; server could provide step mapping)
  const todos = () => props.store.state.todos
  const grouped = createMemo(() => {
    const t = todos()
    const entries = filteredEntries()
    if (t.length === 0) return null
    // Distribute entries across todos by order
    const groups: Array<{ todo: Todo; entries: ActivityEntry[] }> = t.map((todo) => ({ todo, entries: [] }))
    entries.forEach((e, idx) => {
      const gi = Math.min(idx, groups.length - 1)
      // Prefer in_progress group for latest entries
      const runningIdx = groups.findIndex((g) => g.todo.status === 'in_progress')
      const target = runningIdx >= 0 ? runningIdx : gi
      groups[target].entries.push(e)
    })
    return groups
  })

  const progress = createMemo(() => {
    const t = todos()
    if (t.length === 0) return null
    const done = t.filter((x) => x.status === 'completed').length
    return { done, total: t.length, pct: Math.round((done / t.length) * 100) }
  })

  const FILTERS: Array<{ id: FilterType; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'tool_call', label: 'Tools' },
    { id: 'reasoning', label: 'Reasoning' },
    { id: 'approval', label: 'Approvals' },
  ]

  return (
    <aside
      class={`activity-panel ${props.collapsed ? 'activity-panel-collapsed' : ''} ${!props.collapsed ? 'activity-panel-open' : ''}`}
      aria-label="Activity"
      aria-expanded={props.collapsed ? 'false' : 'true'}
    >
      <Show
        when={!props.collapsed}
        fallback={
          <button
            type="button"
            class="btn btn-ghost"
            onClick={props.onToggle}
            title="Expand activity"
            aria-label="Expand activity panel"
            aria-expanded="false"
            style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'align-items': 'center', gap: '10px', padding: '12px 0', 'border-radius': '0' }}
          >
            <span style={{ 'font-size': '13px', color: 'var(--fg-muted)' }}>»</span>
            <span style={{ 'writing-mode': 'vertical-rl', transform: 'rotate(180deg)', 'font-size': 'var(--fs-2xs)', 'letter-spacing': '0.08em', color: 'var(--fg-subtle)' }}>Activity</span>
            <Show when={derivedEntries().length > 0}>
              <span class="pill" style={{ 'writing-mode': 'horizontal-tb', transform: 'none', 'font-size': 'var(--fs-2xs)', padding: '1px 5px', background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent-border)' }}>
                {derivedEntries().length}
              </span>
            </Show>
            <Show when={isStreaming()}>
              <span class="dot dot-pulse" style={{ background: 'var(--warn)', width: '8px', height: '8px' }} />
            </Show>
          </button>
        }
      >
        {/* Header */}
        <div class="activity-panel-header">
          <span class="activity-panel-title">Activity</span>
          <div style={{ display: 'flex', gap: '4px', 'align-items': 'center' }}>
            <Show when={isStreaming()}>
              <span class="pill pill-warn" style={{ 'font-size': 'var(--fs-2xs)', padding: '1px 6px' }}>
                <span class="dot dot-pulse" style={{ background: 'var(--warn)', width: '6px', height: '6px' }} />
                live
              </span>
            </Show>
            <button type="button" class="btn btn-ghost" onClick={props.onToggle} title="Collapse activity" aria-label="Collapse activity panel" style={{ width: '28px', height: '28px', padding: '0', 'border-radius': 'var(--r-sm)', flex: 'none', 'min-height': '28px' }}>
              «
            </button>
          </div>
        </div>

        {/* Progress */}
        <Show when={progress()}>
          {(p) => (
            <div class="activity-progress">
              <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-subtle)', 'font-family': 'var(--font-mono)', flex: 'none' }}>
                {p().done}/{p().total}
              </span>
              <div class="activity-progress-bar" role="progressbar" aria-valuenow={p().pct} aria-valuemin={0} aria-valuemax={100} aria-label="Task progress">
                <div class={`activity-progress-fill ${isStreaming() ? 'activity-progress-fill-running' : ''}`} style={{ width: `${p().pct}%` }} />
              </div>
              <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', flex: 'none' }}>{p().pct}%</span>
            </div>
          )}
        </Show>

        {/* Filters */}
        <div class="activity-filter-row" role="tablist" aria-label="Activity filters">
          <For each={FILTERS}>
            {(f) => (
              <button type="button" role="tab" aria-selected={filter() === f.id ? 'true' : 'false'} class={`activity-filter-btn ${filter() === f.id ? 'active' : ''}`} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            )}
          </For>
        </div>

        {/* Timeline */}
        <div class="activity-timeline scroll">
          <Show
            when={derivedEntries().length > 0}
            fallback={
              <div class="activity-empty">
                <div class="activity-empty-icon">◈</div>
                <div>No activity yet</div>
                <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-faint)', 'margin-top': '4px' }}>Tool calls and reasoning will appear here as the agent works.</div>
              </div>
            }
          >
            <Show
              when={grouped()}
              fallback={
                <div style={{ padding: '8px 12px', display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                  <For each={filteredEntries()}>{(entry, i) => <ActivityEntryRow entry={entry} isLast={i() === filteredEntries().length - 1} />}</For>
                </div>
              }
            >
              {(groups) => (
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                  <For each={groups()}>{(g, idx) => <StepGroup todo={g.todo} entries={g.entries} index={idx()} total={groups().length} />}</For>
                  {/* Ungrouped entries (more entries than todos) */}
                  <Show when={filteredEntries().length > 0 && grouped()!.every((g) => g.entries.length === 0)}>
                    <div style={{ padding: '8px 12px', display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                      <For each={filteredEntries()}>{(entry, i) => <ActivityEntryRow entry={entry} isLast={i() === filteredEntries().length - 1} />}</For>
                    </div>
                  </Show>
                </div>
              )}
            </Show>

            {/* Live streaming indicator */}
            <Show when={isStreaming()}>
              <div style={{ display: 'flex', gap: '10px', padding: '8px 12px', 'align-items': 'center' }}>
                <div class="activity-step-dot activity-step-dot-running" aria-hidden="true">
                  ◷
                </div>
                <div class="streaming-indicator" aria-label="Agent is working">
                  <span class="streaming-dot" />
                  <span class="streaming-dot" />
                  <span class="streaming-dot" />
                </div>
                <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>Agent working…</span>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </aside>
  )
}
