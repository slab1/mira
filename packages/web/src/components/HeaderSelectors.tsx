import { createSignal, createEffect, createMemo, For, Show, onCleanup } from 'solid-js'
import type { SettingsStore } from '../stores/settings'
import type { AgentEntry } from '../api/client'
import { providerModelId } from '../api/client'
import { toast } from './Toast'

// ── Shared helpers ──────────────────────────────────────────────────

type KnownModel = {
  id: string
  provider: string
  label: string
  context: string
  pricing: string
  capabilities: string[]
}

const KNOWN_MODELS: KnownModel[] = [
  {
    id: 'openrouter/anthropic/claude-sonnet-4',
    provider: 'OpenRouter',
    label: 'Claude Sonnet 4',
    context: '200k',
    pricing: '$3/$15',
    capabilities: ['coding', 'reasoning', 'vision'],
  },
  {
    id: 'openrouter/anthropic/claude-opus-4',
    provider: 'OpenRouter',
    label: 'Claude Opus 4',
    context: '200k',
    pricing: '$15/$75',
    capabilities: ['coding', 'reasoning', 'vision'],
  },
  {
    id: 'openrouter/deepseek/deepseek-chat',
    provider: 'OpenRouter',
    label: 'DeepSeek Chat',
    context: '128k',
    pricing: '$0.27/$1.10',
    capabilities: ['coding', 'reasoning'],
  },
  {
    id: 'openrouter/openai/gpt-4o',
    provider: 'OpenRouter',
    label: 'GPT-4o',
    context: '128k',
    pricing: '$2.50/$10',
    capabilities: ['coding', 'vision'],
  },
  {
    id: 'openai/gpt-4o',
    provider: 'OpenAI',
    label: 'GPT-4o',
    context: '128k',
    pricing: '$2.50/$10',
    capabilities: ['coding', 'vision', 'reasoning'],
  },
  {
    id: 'openai/gpt-4o-mini',
    provider: 'OpenAI',
    label: 'GPT-4o Mini',
    context: '128k',
    pricing: '$0.15/$0.60',
    capabilities: ['speed', 'vision'],
  },
  {
    id: 'anthropic/claude-sonnet-4',
    provider: 'Anthropic',
    label: 'Claude Sonnet 4',
    context: '200k',
    pricing: '$3/$15',
    capabilities: ['coding', 'reasoning', 'vision'],
  },
  {
    id: 'google/gemini-2.0-flash',
    provider: 'Google',
    label: 'Gemini 2.0 Flash',
    context: '1M',
    pricing: '$0.10/$0.40',
    capabilities: ['speed', 'vision'],
  },
  {
    id: 'deepseek/deepseek-chat',
    provider: 'DeepSeek',
    label: 'DeepSeek Chat',
    context: '128k',
    pricing: '$0.27/$1.10',
    capabilities: ['coding', 'reasoning'],
  },
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

// ── Header Model Selector ───────────────────────────────────────────

export function HeaderModelSelector(props: { settings: SettingsStore; id?: string }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [highlight, setHighlight] = createSignal(0)
  let wrapperRef!: HTMLDivElement
  let inputRef!: HTMLInputElement
  let listRef!: HTMLDivElement
  let triggerRef!: HTMLButtonElement

  const currentModel = () => props.settings.state.config?.model ?? ''
  const providers = () => props.settings.state.providers ?? []

  const allModels = createMemo(() => {
    const seen = new Set<string>()
    const out: KnownModel[] = []
    for (const m of KNOWN_MODELS) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        out.push(m)
      }
    }
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
    const cur = currentModel().trim()
    if (cur && !seen.has(cur)) {
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
    const map = new Map<string, KnownModel[]>()
    for (const m of filtered()) {
      const g = m.provider
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(m)
    }
    const order = ['OpenRouter', 'Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'NVIDIA']
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

  const flatList = createMemo(() => filtered())
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
    const short = cur.split('/').pop() ?? cur
    return short.length > 22 ? short.slice(0, 22) + '…' : short
  }

  return (
    <div ref={(el) => (wrapperRef = el)} style={{ position: 'relative' }}>
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
          'max-width': '160px',
          gap: '6px',
        }}
      >
        <span style={{ 'font-size': '10px', color: 'var(--accent)', flex: 'none' }}>◈</span>
        <span
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
            'max-height': '380px',
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
