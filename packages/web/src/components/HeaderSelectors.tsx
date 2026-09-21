import { createSignal, createEffect, createMemo, For, Show, onCleanup } from 'solid-js'
import type { SettingsStore } from '../stores/settings'
import type { AgentEntry } from '../api/client'
import { providerModelId, api } from '../api/client'
import { toast } from './Toast'
import { EvalBadge } from './EvalBadge'

// ── Shared helpers ──────────────────────────────────────────────────
// Live-only model catalog: no hardcoded fallback. Providers are the source
// of truth (GET /providers → models). Current config model is added as a
// transient entry if absent so the selector never loses the active value.
// This keeps the header selector grounded in what the server actually offers.

type LiveModel = {
  id: string
  provider: string
  label: string
  context: string
  pricing: string
  capabilities: string[]
}

const AUTO_ID = 'auto'
// NVIDIA auto-pick lane — per task spec: nvidia primary with healthiest cheapest
const NVIDIA_AUTO_MODELS: Record<string, string> = {
  default: 'nvidia/deepseek-ai/deepseek-v4-flash',
  cheap: 'nvidia/deepseek-ai/deepseek-v4-flash',
  compaction: 'nvidia/deepseek-ai/deepseek-v4-flash',
  'agent:ask': 'nvidia/deepseek-ai/deepseek-v4-flash',
  reasoning: 'nvidia/deepseek-ai/deepseek-v4-pro',
  vision: 'openai/gpt-4o', // keep openai for vision unless nvidia vision present
}
const FALLBACK_CHAIN = [
  'nvidia/deepseek-ai/deepseek-v4-flash',
  'nvidia/deepseek-ai/deepseek-v4-pro',
  'nvidia/meta/llama-3.3-70b',
  'nvidia/mistral-large-3',
  'nvidia/meta/llama-3.1-8b',
]

function providerDisplayName(raw: string): string {
  const m: Record<string, string> = {
    openrouter: 'OpenRouter',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    deepseek: 'DeepSeek',
    nvidia: 'NVIDIA',
  }
  return m[raw.toLowerCase()] ?? raw.charAt(0).toUpperCase() + raw.slice(1)
}

function shortModelId(id: string): string {
  const short = id.split('/').pop() ?? id
  return short.length > 22 ? short.slice(0, 22) + '…' : short
}

function inferCapabilities(id: string): string[] {
  const lower = id.toLowerCase()
  const caps: string[] = []
  if (
    lower.includes('claude') ||
    lower.includes('gpt-4o') ||
    lower.includes('sonnet') ||
    lower.includes('opus') ||
    lower.includes('coder') ||
    lower.includes('deepseek')
  )
    caps.push('coding')
  if (
    lower.includes('reason') ||
    lower.includes('o1') ||
    lower.includes('opus') ||
    lower.includes('deepseek')
  ) {
    if (!caps.includes('reasoning')) caps.push('reasoning')
  }
  if (
    lower.includes('vision') ||
    lower.includes('claude') ||
    lower.includes('gpt-4o') ||
    lower.includes('gemini')
  ) {
    if (!caps.includes('vision')) caps.push('vision')
  }
  if (lower.includes('mini') || lower.includes('haiku') || lower.includes('flash'))
    caps.push('speed')
  return [...new Set(caps)].slice(0, 3)
}

function inferContext(id: string): string {
  const lower = id.toLowerCase()
  if (lower.includes('gemini-2')) return '1M+'
  if (lower.includes('claude')) return '200k'
  if (lower.includes('gpt-4') || lower.includes('o1') || lower.includes('deepseek')) return '128k'
  return '—'
}

// ── Health types (mirrors GET /provider/health snapshot) ───────────
type HealthSnapshot = {
  ok: boolean
  lanes: Record<string, { lane: string; circuit: string; state: string; failureCount: number; latencyMs: number; cooldownUntil: number | null; stats: { avgLatencyMs: number; costUSD: number } }>
  providers: Record<string, { providerKey: string; state: string; status: string; latencyMs: number; failureCount: number; consecutiveFailures: number; cooldownUntil: number | null }>
  laneStats: Record<string, { avgLatencyMs: number; costUSD: number }>
  timestamp: number
}

function healthPillVariant(circuit: string, status: string): 'ok' | 'warn' | 'danger' | 'unknown' {
  const c = (circuit || status || '').toLowerCase()
  if (c === 'open' || c === 'down') return 'danger'
  if (c === 'half-open' || c === 'half_open' || c === 'degraded' || c === 'warn') return 'warn'
  if (c === 'closed' || c === 'healthy' || c === 'ok') return 'ok'
  return 'unknown'
}

function pillClass(v: ReturnType<typeof healthPillVariant>): string {
  if (v === 'ok') return 'mira-health-pill mira-health-pill--ok'
  if (v === 'warn') return 'mira-health-pill mira-health-pill--warn'
  if (v === 'danger') return 'mira-health-pill mira-health-pill--danger'
  return 'mira-health-pill mira-health-pill--unknown'
}

// ── Lane Tooltip ────────────────────────────────────────────────────
function LaneTooltip() {
  const [open, setOpen] = createSignal(false)
  const mapText = [
    'default → flash',
    'cheap → flash',
    'compaction → flash',
    'vision → openai/gpt-4o (or nvidia vision)',
    'agent:ask → flash',
    'reasoning → pro',
  ].join('  ·  ')
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        class="mira-lane-tip"
        aria-label="Auto routing explain"
        title={mapText}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      <Show when={open()}>
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: '0',
            width: 'min(320px, 88vw)',
            padding: '8px 10px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            'border-radius': 'var(--r-md)',
            'box-shadow': 'var(--shadow-pop)',
            'font-size': 'var(--fs-xs)',
            'line-height': '1.5',
            color: 'var(--fg-muted)',
            'z-index': '60',
            'white-space': 'normal',
          }}
        >
          <span style={{ 'font-weight': '700', color: 'var(--fg)', display: 'block', 'margin-bottom': '4px' }}>Auto logic</span>
          default → flash · cheap → flash · compaction → flash · vision → openai/gpt-4o · agent:ask → flash · reasoning → pro
          <span style={{ display: 'block', 'margin-top': '6px', color: 'var(--fg-faint)', 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-2xs)' }}>
            fallback: {FALLBACK_CHAIN.map((m) => m.split('/').pop()).join(' → ')}
          </span>
        </span>
      </Show>
    </span>
  )
}

// ── Header Model Selector ───────────────────────────────────────────

export function HeaderModelSelector(props: { settings: SettingsStore; id?: string }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [highlight, setHighlight] = createSignal(0)
  const [health, setHealth] = createSignal<HealthSnapshot | null>(null)
  let wrapperRef!: HTMLDivElement
  let inputRef!: HTMLInputElement
  let listRef!: HTMLDivElement
  let triggerRef!: HTMLButtonElement

  const currentModel = () => props.settings.state.config?.model ?? ''
  const isAuto = () => currentModel().trim().toLowerCase() === AUTO_ID
  const providers = () => props.settings.state.providers ?? []

  // Poll GET /provider/health (alias of /gateway/health) — 30s, swallow 404
  createEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null
    let abort: AbortController | null = null
    const fetchOnce = async () => {
      try {
        abort?.abort()
        abort = new AbortController()
        const snap = await api.getProviderHealth()
        if (!alive) return
        setHealth(snap as unknown as HealthSnapshot)
      } catch (e) {
        // try gateway alias
        try {
          const snap2 = await api.getGatewayHealth()
          if (!alive) return
          setHealth(snap2 as unknown as HealthSnapshot)
        } catch {
          // swallow — older servers without /provider/health
          if (!alive) return
          const msg = String((e as Error)?.message ?? '')
          if (msg.includes('404')) {
            // keep prior health
          }
        }
      }
    }
    void fetchOnce()
    timer = setInterval(() => void fetchOnce(), 30_000)
    onCleanup(() => {
      alive = false
      if (timer) clearInterval(timer as unknown as number)
      try {
        abort?.abort()
      } catch {}
    })
  })

  const resolvedAuto = createMemo(() => {
    const h = health()
    // Prefer lane default model if server exposes it (routing.defaultProvider=nvidia path)
    // Fallback to static NVIDIA mapping
    if (h?.lanes?.default) {
      // lane health doesn't carry model id directly; infer from laneStats key or static mapping
      // Use static mapping as source of truth for display
      return NVIDIA_AUTO_MODELS.default
    }
    return NVIDIA_AUTO_MODELS.default
  })

  const healthForPill = createMemo(() => {
    const h = health()
    if (!h) return null
    // Prefer nvidia provider status, then default lane circuit
    const prov = h.providers?.['nvidia'] ?? h.providers?.['NVIDIA'] ?? Object.values(h.providers ?? {})[0]
    const lane = h.lanes?.['default']
    const circuit = lane?.circuit ?? prov?.status ?? lane?.state ?? ''
    const status = prov?.status ?? lane?.circuit ?? ''
    const latency = lane?.latencyMs ?? lane?.stats?.avgLatencyMs ?? prov?.latencyMs ?? 0
    const cost = lane?.stats?.costUSD ?? 0
    const failures = lane?.failureCount ?? prov?.failureCount ?? 0
    const cooldownUntil = lane?.cooldownUntil ?? prov?.cooldownUntil ?? null
    const variant = healthPillVariant(String(circuit), String(status))
    return { circuit: String(circuit), status: String(status), latency, cost, failures, cooldownUntil, variant }
  })

  const allModels = createMemo(() => {
    const seen = new Set<string>()
    const out: LiveModel[] = []
    for (const p of providers()) {
      const models = p.models ?? []
      for (const m of models) {
        const mid = providerModelId(m)
        if (!mid || seen.has(mid)) continue
        seen.add(mid)
        const provider = providerDisplayName(mid.split('/')[0] ?? p.id)
        out.push({
          id: mid,
          provider,
          label: mid.split('/').pop() ?? mid,
          context: inferContext(mid),
          pricing: '—',
          capabilities: inferCapabilities(mid),
        })
      }
    }
    // Include provider itself as a hint when it exposes zero models yet (configured but not refreshed)
    if (out.length === 0) {
      for (const p of providers()) {
        const id = (p.id || '').trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        out.push({
          id,
          provider: providerDisplayName(id),
          label: id,
          context: '—',
          pricing: '—',
          capabilities: [],
        })
      }
    }
    const cur = currentModel().trim()
    if (cur && cur !== AUTO_ID && !seen.has(cur)) {
      const provider = providerDisplayName(cur.split('/')[0] ?? 'Custom')
      out.push({
        id: cur,
        provider,
        label: cur.split('/').pop() ?? cur,
        context: inferContext(cur),
        pricing: 'custom',
        capabilities: inferCapabilities(cur),
      })
    }
    return out
  })

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return allModels()
    return allModels().filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q),
    )
  })

  const grouped = createMemo(() => {
    const map = new Map<string, LiveModel[]>()
    for (const m of filtered()) {
      const g = m.provider
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(m)
    }
    const order = ['NVIDIA', 'OpenRouter', 'Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'Custom']
    // When routing.defaultProvider=nvidia, ensure NVIDIA first even if alphabetical
    const entries = [...map.entries()]
    entries.sort((a, b) => {
      const ai = order.indexOf(a[0])
      const bi = order.indexOf(b[0])
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
      return a[0].localeCompare(b[0])
    })
    return entries
  })

  const flatList = createMemo(() => {
    // flat includes auto as first entry
    const autoEntry: LiveModel = {
      id: AUTO_ID,
      provider: 'NVIDIA',
      label: 'auto (healthiest cheapest)',
      context: 'auto',
      pricing: 'auto',
      capabilities: ['speed', 'cost_optimized'],
    }
    return [autoEntry, ...filtered()]
  })
  const listboxId = () => `${props.id ?? 'header-model'}-listbox`

  const close = () => {
    setOpen(false)
    setHighlight(0)
  }

  const selectModel = async (id: string) => {
    close()
    setQuery('')
    try {
      const res = await props.settings.saveConfig({ model: id } as never)
      if (res) toast.success(`Model → ${id}`)
      else toast.error(props.settings.state.error ?? 'Failed to set model')
    } catch (e) {
      toast.error((e as Error).message)
    }
    queueMicrotask(() => triggerRef?.focus())
  }

  // Click outside + Escape
  createEffect(() => {
    if (!open()) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef) return
      if (wrapperRef.contains(e.target as Node)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
        triggerRef?.focus()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    onCleanup(() => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    })
  })

  // Scroll highlighted into view
  createEffect(() => {
    if (!open()) return
    const idx = highlight()
    const el = listRef?.querySelector(`[data-idx="${idx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  })

  // Ctrl+M shortcut
  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
        const isInput =
          tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable
        if (isInput) return
        e.preventDefault()
        if (open()) close()
        else {
          setOpen(true)
          setQuery('')
          setHighlight(0)
          queueMicrotask(() => inputRef?.focus())
        }
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  const displayLabel = () => {
    const cur = currentModel()
    if (!cur) return 'model'
    if (cur.trim().toLowerCase() === AUTO_ID) {
      const resolved = resolvedAuto()
      const short = shortModelId(resolved)
      // spec wants "nvidia • deepseek-v4-flash (auto)"
      const prov = resolved.split('/')[0] ?? 'nvidia'
      return `${prov} • ${short} (auto)`
    }
    const short = cur.split('/').pop() ?? cur
    return short.length > 22 ? short.slice(0, 22) + '…' : short
  }

  const healthLabel = () => {
    const h = healthForPill()
    if (!h) return null
    const lat = h.latency ? `${Math.round(h.latency)}ms` : '—'
    const state = h.circuit || h.status || 'unknown'
    return { text: lat, state, variant: h.variant, cost: h.cost, failures: h.failures }
  }

  const degradedCount = createMemo(() => {
    const h = health()
    if (!h) return 0
    let c = 0
    for (const p of Object.values(h.providers ?? {})) {
      const s = String((p as { status: string }).status ?? (p as { state: string }).state ?? '').toLowerCase()
      if (s === 'degraded' || s === 'down' || s === 'open' || s === 'half_open' || s === 'half-open') c++
    }
    for (const l of Object.values(h.lanes ?? {})) {
      const s = String((l as { circuit: string }).circuit ?? (l as { state: string }).state ?? '').toLowerCase()
      if (s === 'open' || s === 'half-open') c++
    }
    return c
  })

  return (
    <div ref={(el) => (wrapperRef = el)} style={{ position: 'relative' }} class="mira-model-wrap">
      <button
        ref={(el) => (triggerRef = el)}
        type="button"
        aria-label="Select model"
        aria-expanded={open() ? 'true' : 'false'}
        aria-controls={listboxId()}
        aria-haspopup="listbox"
        title={currentModel() ? `Model: ${currentModel()} (Ctrl+M)` : 'Select model (Ctrl+M)'}
        onClick={() => {
          if (open()) close()
          else {
            setOpen(true)
            setQuery('')
            setHighlight(0)
            queueMicrotask(() => inputRef?.focus())
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open()) {
            e.preventDefault()
            setOpen(true)
            setQuery('')
            setHighlight(0)
            queueMicrotask(() => inputRef?.focus())
          }
        }}
        class="btn btn-ghost"
        style={{
          padding: '4px 8px',
          'font-size': 'var(--fs-xs)',
          border: '1px solid var(--border)',
          'border-radius': 'var(--r-md)',
          background: open() ? 'var(--bg-active)' : 'var(--bg-surface)',
          color: 'var(--fg)',
          'max-width': '220px',
          gap: '6px',
        }}
      >
        <span style={{ 'font-size': '10px', color: 'var(--accent)', flex: 'none' }}>◈</span>
        <span
          class="mira-model-label-text"
          style={{
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
            'font-family': 'var(--font-mono)',
            'font-size': 'var(--fs-xs)',
          }}
        >
          {displayLabel()}
        </span>
        <span
          style={{
            'font-size': '9px',
            color: 'var(--fg-faint)',
            flex: 'none',
            transform: open() ? 'rotate(180deg)' : 'none',
            transition: 'transform var(--dur-fast) var(--ease)',
          }}
        >
          ▾
        </span>
      </button>

      {/* Health pill — latency + circuit state (Linear dot grammar) */}
      <Show when={healthLabel()}>
        {(hl) => (
          <span
            class={pillClass(hl().variant)}
            title={
              healthForPill()
                ? `circuit: ${healthForPill()!.circuit || 'closed'} · status: ${healthForPill()!.status || 'healthy'} · failures: ${healthForPill()!.failures} · cost $${healthForPill()!.cost.toFixed(4)} · ${degradedCount() ? degradedCount() + ' degraded/down' : 'all healthy'}`
                : `auto → ${resolvedAuto()}`
            }
            style={{ cursor: 'default' }}
          >
            <span
              class="dot"
              style={{
                background:
                  hl().variant === 'ok'
                    ? 'var(--ok)'
                    : hl().variant === 'warn'
                      ? 'var(--warn)'
                      : hl().variant === 'danger'
                        ? 'var(--danger)'
                        : 'var(--fg-faint)',
              }}
            />
            <span class="mira-health-pill__latency-text">{hl().text}</span>
            <span style={{ 'font-size': '9px', 'text-transform': 'lowercase', opacity: '0.9' }}>{hl().state}</span>
          </span>
        )}
      </Show>

      <LaneTooltip />

      <Show when={currentModel() && currentModel().trim().toLowerCase() !== AUTO_ID}>
        <EvalBadge model={currentModel()} />
      </Show>
      <Show when={isAuto()}>
        <span
          class="pill"
          style={{
            'font-size': 'var(--fs-2xs)',
            'font-family': 'var(--font-mono)',
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent-border)',
            color: 'var(--accent)',
            padding: '2px 7px',
          }}
          title={`Auto picks healthiest cheapest — fallback chain: ${FALLBACK_CHAIN.join(' → ')}`}
        >
          auto
        </span>
      </Show>

      <Show when={open()}>
        <div
          ref={(el) => (listRef = el)}
          id={listboxId()}
          role="listbox"
          aria-label="Model options"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: '0',
            'min-width': '320px',
            'max-width': 'min(420px, 90vw)',
            'max-height': '420px',
            overflow: 'auto',
            background: 'var(--bg-canvas)',
            border: '1px solid var(--border-strong)',
            'border-radius': 'var(--r-md)',
            'box-shadow': 'var(--shadow-pop)',
            'z-index': '40',
            padding: '6px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '6px',
          }}
        >
          <div
            style={{
              position: 'sticky',
              top: '0',
              background: 'var(--bg-canvas)',
              'z-index': '1',
              padding: '2px 0 6px',
            }}
          >
            <input
              ref={(el) => (inputRef = el)}
              class="input"
              role="combobox"
              aria-expanded={open() ? 'true' : 'false'}
              aria-controls={listboxId()}
              aria-autocomplete="list"
              aria-activedescendant={
                open() ? `${props.id ?? 'header-model'}-opt-${highlight()}` : undefined
              }
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value)
                setHighlight(0)
              }}
              onKeyDown={(e) => {
                const len = flatList().length
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setHighlight((h) => (h + 1) % Math.max(len, 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHighlight((h) => (h - 1 + len) % Math.max(len, 1))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const h = highlight()
                  const m = flatList()[h]
                  if (m) void selectModel(m.id)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  close()
                  triggerRef?.focus()
                } else if (e.key === 'Tab') {
                  // Tab moves focus to next header control (agent) — close dropdown
                  close()
                }
              }}
              placeholder="Search models…"
              spellcheck={false}
              autocomplete="off"
              style={{ 'font-size': 'var(--fs-sm)' }}
            />
          </div>

          {/* Auto row — always first, per spec */}
          <div
            style={{
              'border-bottom': '1px solid var(--border)',
              'padding-bottom': '6px',
              'margin-bottom': '2px',
            }}
          >
            <button
              type="button"
              role="option"
              id={`${props.id ?? 'header-model'}-opt-0`}
              data-idx={0}
              aria-selected={isAuto() ? 'true' : 'false'}
              onClick={() => void selectModel(AUTO_ID)}
              onMouseEnter={() => setHighlight(0)}
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '4px',
                padding: '8px 10px',
                'border-radius': 'var(--r-sm)',
                border: highlight() === 0 ? '1px solid var(--accent-border)' : '1px solid transparent',
                background: highlight() === 0 ? 'var(--accent-soft)' : isAuto() ? 'var(--bg-surface)' : 'transparent',
                cursor: 'pointer',
                'text-align': 'left',
                width: '100%',
              }}
            >
              <span style={{ display: 'flex', gap: '6px', 'align-items': 'center', 'flex-wrap': 'wrap' }}>
                <span style={{ 'font-size': '11px' }}>⚡</span>
                <span style={{ 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-xs)', 'font-weight': '700', color: 'var(--fg)' }}>auto</span>
                <span
                  style={{
                    'font-size': 'var(--fs-2xs)',
                    padding: '1px 6px',
                    'border-radius': 'var(--r-full)',
                    background: 'var(--accent-soft)',
                    border: '1px solid var(--accent-border)',
                    color: 'var(--accent)',
                    'font-weight': '600',
                  }}
                >
                  healthiest cheapest
                </span>
                <Show when={isAuto()}>
                  <span style={{ color: 'var(--ok)', 'font-size': '11px' }}>✓</span>
                </Show>
              </span>
              <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-muted)', 'line-height': '1.4' }}>
                nvidia • {shortModelId(resolvedAuto())} <span style={{ color: 'var(--fg-faint)' }}>(GatewayRouter picks per lane)</span>
              </span>
              <span class="mira-auto-chain">
                default→flash · cheap→flash · compaction→flash · vision→openai/gpt-4o · agent:ask→flash · reasoning→pro
              </span>
              <span class="mira-auto-chain" style={{ opacity: '0.9' }}>
                fallback: {FALLBACK_CHAIN.slice(0, 3).map((m) => m.split('/').pop()).join(' → ')} · cost/latency + circuit
              </span>
            </button>
          </div>

          <Show
            when={filtered().length > 0}
            fallback={
              <div
                style={{
                  padding: '12px',
                  'text-align': 'center',
                  color: 'var(--fg-faint)',
                  'font-size': 'var(--fs-sm)',
                }}
              >
                No models match "{query()}"
              </div>
            }
          >
            <For each={grouped()}>
              {([provider, models]) => (
                <div>
                  <div
                    style={{
                      'font-size': 'var(--fs-2xs)',
                      'font-weight': '700',
                      'letter-spacing': '0.06em',
                      'text-transform': 'uppercase',
                      color: 'var(--fg-faint)',
                      padding: '4px 8px 2px',
                    }}
                  >
                    {provider}
                  </div>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                    <For each={models}>
                      {(m) => {
                        const idx = () => flatList().indexOf(m)
                        const isSelected = () => currentModel() === m.id
                        const isHighlighted = () => highlight() === idx()
                        return (
                          <button
                            type="button"
                            role="option"
                            id={`${props.id ?? 'header-model'}-opt-${idx()}`}
                            data-idx={idx()}
                            aria-selected={isSelected() ? 'true' : 'false'}
                            onClick={() => void selectModel(m.id)}
                            onMouseEnter={() => setHighlight(idx())}
                            style={{
                              display: 'flex',
                              'flex-direction': 'column',
                              gap: '3px',
                              padding: '7px 10px',
                              'border-radius': 'var(--r-sm)',
                              border: isHighlighted()
                                ? '1px solid var(--accent-border)'
                                : '1px solid transparent',
                              background: isHighlighted()
                                ? 'var(--accent-soft)'
                                : isSelected()
                                  ? 'var(--bg-surface)'
                                  : 'transparent',
                              cursor: 'pointer',
                              'text-align': 'left',
                              width: '100%',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                'align-items': 'center',
                                gap: '6px',
                                'flex-wrap': 'wrap',
                              }}
                            >
                              <span
                                style={{
                                  'font-family': 'var(--font-mono)',
                                  'font-size': 'var(--fs-xs)',
                                  'font-weight': '600',
                                  color: 'var(--fg)',
                                  'word-break': 'break-all',
                                }}
                              >
                                {m.id}
                              </span>
                              <Show when={isSelected()}>
                                <span style={{ color: 'var(--ok)', 'font-size': '11px' }}>✓</span>
                              </Show>
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                gap: '6px',
                                'align-items': 'center',
                                'flex-wrap': 'wrap',
                              }}
                            >
                              <span
                                style={{
                                  'font-size': 'var(--fs-2xs)',
                                  color: 'var(--fg-faint)',
                                  'font-family': 'var(--font-mono)',
                                }}
                              >
                                {m.context} ctx
                              </span>
                              <span
                                style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)' }}
                              >
                                ·
                              </span>
                              <span
                                style={{
                                  'font-size': 'var(--fs-2xs)',
                                  color: 'var(--fg-faint)',
                                  'font-family': 'var(--font-mono)',
                                }}
                              >
                                {m.pricing} /1k
                              </span>
                              <For each={m.capabilities}>
                                {(cap) => (
                                  <span
                                    style={{
                                      'font-size': '9px',
                                      padding: '1px 5px',
                                      'border-radius': 'var(--r-full)',
                                      background:
                                        cap === 'coding'
                                          ? 'var(--ok-soft)'
                                          : cap === 'reasoning'
                                            ? 'var(--accent-soft)'
                                            : cap === 'vision'
                                              ? 'var(--warn-soft)'
                                              : 'var(--bg-active)',
                                      border: `1px solid ${cap === 'coding' ? 'var(--ok-border)' : cap === 'reasoning' ? 'var(--accent-border)' : cap === 'vision' ? 'var(--warn-border)' : 'var(--border)'}`,
                                      color:
                                        cap === 'coding'
                                          ? 'var(--ok)'
                                          : cap === 'reasoning'
                                            ? 'var(--accent)'
                                            : cap === 'vision'
                                              ? 'var(--warn)'
                                              : 'var(--fg-subtle)',
                                      'font-weight': '600',
                                      'text-transform': 'uppercase',
                                      'letter-spacing': '0.04em',
                                    }}
                                  >
                                    {cap}
                                  </span>
                                )}
                              </For>
                            </div>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </Show>

          {/* Health strip — cost/latency + circuit state without clutter (Vercel/Deepline pattern) */}
          <div
            style={{
              'border-top': '1px solid var(--border)',
              'margin-top': '4px',
              'padding-top': '8px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '6px',
            }}
          >
            <Show
              when={health()}
              fallback={
                <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', padding: '0 6px' }}>
                  health: probing /provider/health…
                </span>
              }
            >
              {(h) => (
                <>
                  <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap', padding: '0 4px', 'align-items': 'center' }}>
                    <For each={Object.entries(h().providers ?? {}).slice(0, 4)}>
                      {([key, pv]) => {
                        const st = String((pv as { status: string }).status ?? (pv as { state: string }).state ?? '').toLowerCase()
                        const v = healthPillVariant('', st)
                        return (
                          <span class={pillClass(v)} style={{ 'font-size': '10px', padding: '1px 6px' }}>
                            <span
                              class="dot"
                              style={{
                                background:
                                  v === 'ok' ? 'var(--ok)' : v === 'warn' ? 'var(--warn)' : v === 'danger' ? 'var(--danger)' : 'var(--fg-faint)',
                              }}
                            />
                            {key} · {st || 'unknown'}
                          </span>
                        )
                      }}
                    </For>
                    <Show when={Object.keys(h().providers ?? {}).length === 0}>
                      <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)' }}>no provider health yet</span>
                    </Show>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap', padding: '0 4px', 'align-items': 'center' }}>
                    <For each={Object.entries(h().lanes ?? {}).slice(0, 4)}>
                      {([lane, lv]) => {
                        const c = String((lv as { circuit: string }).circuit ?? (lv as { state: string }).state ?? '').toLowerCase()
                        const v = healthPillVariant(c, '')
                        const lat = (lv as { latencyMs: number }).latencyMs ?? (lv as { stats: { avgLatencyMs: number } }).stats?.avgLatencyMs ?? 0
                        return (
                          <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'font-family': 'var(--font-mono)' }}>
                            <span class={pillClass(v)} style={{ 'font-size': '10px', padding: '1px 5px', 'margin-right': '4px' }}>{lane}</span>
                            {lat ? `${Math.round(lat)}ms` : '—'} · {c || 'closed'}
                          </span>
                        )
                      }}
                    </For>
                  </div>
                  <Show when={degradedCount() > 0}>
                    <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--warn)', padding: '0 6px' }}>
                      ⚠ {degradedCount()} lane/provider degraded — auto will skip to next in fallback
                    </span>
                  </Show>
                </>
              )}
            </Show>
            <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', padding: '0 6px', 'font-family': 'var(--font-mono)' }}>
              GET /provider/health ↺30s · model='auto' lets GatewayRouter pick healthiest cheapest
            </span>
          </div>
        </div>
      </Show>
    </div>
  )
}

// ── Header Agent Selector ───────────────────────────────────────────

export function HeaderAgentSelector(props: {
  agents: AgentEntry[]
  value: string
  onChange: (v: string) => void
  id?: string
}) {
  const [open, setOpen] = createSignal(false)
  const [highlight, setHighlight] = createSignal(0)
  let wrapperRef!: HTMLDivElement
  let triggerRef!: HTMLButtonElement
  let listRef!: HTMLDivElement

  const allOptions = createMemo(() => {
    const list: Array<{ name: string; description: string; custom: boolean }> = [
      { name: '', description: 'General — default lane', custom: false },
    ]
    for (const a of props.agents) {
      list.push({ name: a.name, description: a.description || '', custom: a.custom })
    }
    return list
  })

  const currentIndex = createMemo(() => {
    const idx = allOptions().findIndex((o) => o.name === props.value)
    return idx === -1 ? 0 : idx
  })

  const currentLabel = () => {
    const cur = allOptions().find((o) => o.name === props.value)
    if (!cur || !cur.name) return 'general'
    return cur.name + (cur.custom ? ' *' : '')
  }

  const currentDesc = () => {
    const cur = allOptions().find((o) => o.name === props.value)
    return cur?.description ?? ''
  }

  const close = () => {
    setOpen(false)
    setHighlight(currentIndex())
  }

  const selectAgent = (name: string) => {
    props.onChange(name)
    close()
    queueMicrotask(() => triggerRef?.focus())
  }

  // Sync highlight to current when opening
  createEffect(() => {
    if (open()) setHighlight(currentIndex())
  })

  // Click outside + Escape
  createEffect(() => {
    if (!open()) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef) return
      if (wrapperRef.contains(e.target as Node)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
        triggerRef?.focus()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    onCleanup(() => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    })
  })

  // Scroll highlighted into view
  createEffect(() => {
    if (!open()) return
    const idx = highlight()
    const el = listRef?.querySelector(`[data-idx="${idx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  })

  // Ctrl+G shortcut
  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
        const isInput =
          tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable
        if (isInput) return
        // Don't conflict with Memory Graph G toggle when not in input — only when Ctrl/Cmd held
        e.preventDefault()
        if (open()) close()
        else {
          setOpen(true)
          setHighlight(currentIndex())
        }
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  const cycleAgent = (dir: 1 | -1) => {
    const opts = allOptions()
    const cur = currentIndex()
    const next = (cur + dir + opts.length) % opts.length
    props.onChange(opts[next].name)
  }

  return (
    <div ref={(el) => (wrapperRef = el)} style={{ position: 'relative' }}>
      <button
        ref={(el) => (triggerRef = el)}
        type="button"
        aria-label="Agent lane"
        aria-expanded={open() ? 'true' : 'false'}
        aria-haspopup="listbox"
        title={
          currentDesc()
            ? `${currentLabel()} — ${currentDesc()} (Ctrl+G)`
            : `${currentLabel()} (Ctrl+G) — Tab to cycle`
        }
        onClick={() => {
          if (open()) close()
          else {
            setOpen(true)
            setHighlight(currentIndex())
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open()) {
            e.preventDefault()
            setOpen(true)
            setHighlight(currentIndex())
            return
          }
          if (e.key === 'ArrowUp' && !open()) {
            e.preventDefault()
            setOpen(true)
            setHighlight(currentIndex())
            return
          }
          if (e.key === 'Tab' && !open()) {
            // Tab cycling when closed: Tab → next agent, Shift+Tab → prev
            // But we must not break normal Tab navigation — only cycle if user holds Tab without leaving?
            // Spec: "Add Tab key to cycle through agents (Tab focuses next, Shift+Tab previous)"
            // Interpret as: when agent selector is focused, Tab cycles agents instead of moving focus.
            // We implement: Tab cycles, but allow Escape to exit cycling.
            // To keep a11y, we still allow Tab to move focus if user presses Tab twice quickly?
            // Simpler: Tab cycles agents, Shift+Tab reverse, and we prevent default focus move.
            e.preventDefault()
            cycleAgent(e.shiftKey ? -1 : 1)
            return
          }
          if (e.key === 'Enter' && !open()) {
            e.preventDefault()
            setOpen(true)
            setHighlight(currentIndex())
          }
        }}
        class="btn btn-ghost"
        style={{
          padding: '4px 8px',
          'font-size': 'var(--fs-xs)',
          border: '1px solid var(--border)',
          'border-radius': 'var(--r-md)',
          background: open() ? 'var(--bg-active)' : 'var(--bg-surface)',
          color: 'var(--fg)',
          gap: '6px',
        }}
      >
        <span style={{ 'font-size': '10px', flex: 'none' }}>🤖</span>
        <span
          style={{
            'font-family': 'var(--font-mono)',
            'font-size': 'var(--fs-xs)',
            'text-transform': 'lowercase',
          }}
        >
          {currentLabel()}
        </span>
        <span
          style={{
            'font-size': '9px',
            color: 'var(--fg-faint)',
            flex: 'none',
            transform: open() ? 'rotate(180deg)' : 'none',
            transition: 'transform var(--dur-fast) var(--ease)',
          }}
        >
          ▾
        </span>
      </button>

      <Show when={open()}>
        <div
          ref={(el) => (listRef = el)}
          role="listbox"
          aria-label="Agent lane options"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: '0',
            'min-width': '260px',
            'max-width': 'min(360px, 90vw)',
            'max-height': '320px',
            overflow: 'auto',
            background: 'var(--bg-canvas)',
            border: '1px solid var(--border-strong)',
            'border-radius': 'var(--r-md)',
            'box-shadow': 'var(--shadow-pop)',
            'z-index': '40',
            padding: '6px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '2px',
          }}
        >
          <For each={allOptions()}>
            {(opt, i) => {
              const isSelected = () => props.value === opt.name
              const isHighlighted = () => highlight() === i()
              return (
                <button
                  type="button"
                  role="option"
                  data-idx={i()}
                  aria-selected={isSelected() ? 'true' : 'false'}
                  title={opt.description || opt.name || 'general'}
                  onClick={() => selectAgent(opt.name)}
                  onMouseEnter={() => setHighlight(i())}
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '2px',
                    padding: '8px 10px',
                    'border-radius': 'var(--r-sm)',
                    border: isHighlighted()
                      ? '1px solid var(--accent-border)'
                      : '1px solid transparent',
                    background: isHighlighted()
                      ? 'var(--accent-soft)'
                      : isSelected()
                        ? 'var(--bg-surface)'
                        : 'transparent',
                    cursor: 'pointer',
                    'text-align': 'left',
                    width: '100%',
                  }}
                >
                  <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                    <span
                      style={{
                        'font-family': 'var(--font-mono)',
                        'font-size': 'var(--fs-sm)',
                        'font-weight': '600',
                        color: 'var(--fg)',
                        'text-transform': 'lowercase',
                      }}
                    >
                      {opt.name || 'general'}
                      {opt.custom ? ' *' : ''}
                    </span>
                    <Show when={isSelected()}>
                      <span style={{ color: 'var(--ok)', 'font-size': '11px' }}>✓</span>
                    </Show>
                  </span>
                  <Show when={opt.description}>
                    <span
                      style={{
                        'font-size': 'var(--fs-xs)',
                        color: 'var(--fg-subtle)',
                        'line-height': '1.4',
                      }}
                    >
                      {opt.description}
                    </span>
                  </Show>
                </button>
              )
            }}
          </For>
          <div
            style={{
              'border-top': '1px solid var(--border)',
              'margin-top': '4px',
              'padding-top': '6px',
              'font-size': 'var(--fs-2xs)',
              color: 'var(--fg-faint)',
              display: 'flex',
              gap: '6px',
              'align-items': 'center',
              'justify-content': 'center',
            }}
          >
            <span>
              <span class="kbd">↑↓</span> nav
            </span>
            <span>·</span>
            <span>
              <span class="kbd">↵</span> select
            </span>
            <span>·</span>
            <span>
              <span class="kbd">Tab</span> cycle
            </span>
          </div>
        </div>
      </Show>
    </div>
  )
}
