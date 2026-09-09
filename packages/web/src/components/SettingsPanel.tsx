import { createSignal, createEffect, createMemo, For, Show, onCleanup } from 'solid-js'
import type { SettingsStore } from '../stores/settings'
import { api } from '../api/client'
import type { MiraConfig, ThemeChoice, ProviderEntry, ProviderConfig } from '../api/client'
import { getApiUrl, providerModelId } from '../api/client'
import { ConfirmDialog } from './ConfirmDialog'
import { toast } from './Toast'
import { useFocusTrap } from '../hooks/useFocusTrap'

// ── ModelSelector ────────────────────────────────────────────────────

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
    id: 'openrouter/anthropic/claude-haiku-4',
    provider: 'OpenRouter',
    label: 'Claude Haiku 4',
    context: '200k',
    pricing: '$0.25/$1.25',
    capabilities: ['speed', 'vision'],
  },
  {
    id: 'openrouter/deepseek/deepseek-v3.2-exp',
    provider: 'OpenRouter',
    label: 'DeepSeek V3.2 Exp',
    context: '128k',
    pricing: '$0.27/$1.10',
    capabilities: ['coding', 'reasoning'],
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
    id: 'openrouter/deepseek/deepseek-reasoner',
    provider: 'OpenRouter',
    label: 'DeepSeek Reasoner',
    context: '128k',
    pricing: '$0.55/$2.19',
    capabilities: ['reasoning', 'coding'],
  },
  {
    id: 'openrouter/openai/gpt-4o',
    provider: 'OpenRouter',
    label: 'GPT-4o',
    context: '128k',
    pricing: '$2.50/$10',
    capabilities: ['coding', 'vision', 'reasoning'],
  },
  {
    id: 'openrouter/openai/gpt-4o-mini',
    provider: 'OpenRouter',
    label: 'GPT-4o Mini',
    context: '128k',
    pricing: '$0.15/$0.60',
    capabilities: ['speed', 'vision'],
  },
  {
    id: 'openrouter/google/gemini-2.0-flash',
    provider: 'OpenRouter',
    label: 'Gemini 2.0 Flash',
    context: '1M',
    pricing: '$0.10/$0.40',
    capabilities: ['speed', 'vision'],
  },
  {
    id: 'openrouter/google/gemini-2.0-pro',
    provider: 'OpenRouter',
    label: 'Gemini 2.0 Pro',
    context: '2M',
    pricing: '$1.25/$10',
    capabilities: ['reasoning', 'vision'],
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
    id: 'openai/gpt-4-turbo',
    provider: 'OpenAI',
    label: 'GPT-4 Turbo',
    context: '128k',
    pricing: '$10/$30',
    capabilities: ['coding', 'vision'],
  },
  {
    id: 'openai/o1',
    provider: 'OpenAI',
    label: 'o1',
    context: '200k',
    pricing: '$15/$60',
    capabilities: ['reasoning', 'coding'],
  },
  {
    id: 'openai/o1-mini',
    provider: 'OpenAI',
    label: 'o1 Mini',
    context: '128k',
    pricing: '$3/$12',
    capabilities: ['reasoning', 'speed'],
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
    id: 'anthropic/claude-opus-4',
    provider: 'Anthropic',
    label: 'Claude Opus 4',
    context: '200k',
    pricing: '$15/$75',
    capabilities: ['coding', 'reasoning', 'vision'],
  },
  {
    id: 'anthropic/claude-haiku-3.5',
    provider: 'Anthropic',
    label: 'Claude Haiku 3.5',
    context: '200k',
    pricing: '$0.80/$4',
    capabilities: ['speed', 'vision'],
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
    id: 'google/gemini-2.0-pro',
    provider: 'Google',
    label: 'Gemini 2.0 Pro',
    context: '2M',
    pricing: '$1.25/$10',
    capabilities: ['reasoning', 'vision'],
  },
  {
    id: 'google/gemini-1.5-pro',
    provider: 'Google',
    label: 'Gemini 1.5 Pro',
    context: '2M',
    pricing: '$1.25/$5',
    capabilities: ['reasoning', 'vision'],
  },
  {
    id: 'deepseek/deepseek-chat',
    provider: 'DeepSeek',
    label: 'DeepSeek Chat',
    context: '128k',
    pricing: '$0.27/$1.10',
    capabilities: ['coding', 'reasoning'],
  },
  {
    id: 'deepseek/deepseek-reasoner',
    provider: 'DeepSeek',
    label: 'DeepSeek Reasoner',
    context: '128k',
    pricing: '$0.55/$2.19',
    capabilities: ['reasoning', 'coding'],
  },
  {
    id: 'deepseek/deepseek-coder',
    provider: 'DeepSeek',
    label: 'DeepSeek Coder',
    context: '128k',
    pricing: '$0.27/$1.10',
    capabilities: ['coding'],
  },
]

function providerDisplayName(raw: string): string {
  const m: Record<string, string> = {
    openrouter: 'OpenRouter',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    deepseek: 'DeepSeek',
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
    lower.includes('gemini') ||
    lower.includes('vision')
  ) {
    if (!caps.includes('vision')) caps.push('vision')
  }
  if (
    lower.includes('mini') ||
    lower.includes('haiku') ||
    lower.includes('flash') ||
    lower.includes('speed')
  )
    caps.push('speed')
  // dedupe
  return [...new Set(caps)].slice(0, 3)
}

function inferContext(id: string): string {
  const lower = id.toLowerCase()
  if (lower.includes('gemini-2')) return '1M+'
  if (lower.includes('claude')) return '200k'
  if (lower.includes('gpt-4') || lower.includes('o1') || lower.includes('deepseek')) return '128k'
  return '—'
}

function ModelSelector(props: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  label: string
  id: string
  providers: ProviderEntry[]
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [highlight, setHighlight] = createSignal(0)
  const [customMode, setCustomMode] = createSignal(false)
  const [customValue, setCustomValue] = createSignal(props.value)

  let wrapperRef!: HTMLDivElement
  let inputRef!: HTMLInputElement
  let listRef!: HTMLDivElement
  let customInputRef!: HTMLInputElement

  // Sync customValue when external value changes
  createEffect(() => {
    setCustomValue(props.value)
    // if value is not in known/provider list, keep customMode hint but don't auto-open
    if (props.value && !customMode()) {
      setQuery('')
    }
  })

  // Build merged model list: known + provider models (dedupe by id)
  const allModels = createMemo(() => {
    const seen = new Set<string>()
    const out: KnownModel[] = []
    for (const m of KNOWN_MODELS) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        out.push(m)
      }
    }
    for (const p of props.providers) {
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
      // also include provider id as prefix hint if no models but provider exists
      // (don't add synthetic entries)
    }
    // If current value is not in list, add it as a transient entry so it appears selected
    const cur = props.value.trim()
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
    // Sort groups: OpenRouter first, then alphabetical
    const order = ['OpenRouter', 'Anthropic', 'OpenAI', 'Google', 'DeepSeek']
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

  // Flat list for keyboard navigation (includes custom sentinel at end)
  const flatList = createMemo(() => filtered())

  const listboxId = () => `${props.id}-listbox`

  const close = () => {
    setOpen(false)
    setHighlight(0)
  }

  const selectModel = (id: string) => {
    props.onChange(id)
    setQuery('')
    setCustomMode(false)
    close()
    // keep focus on input
    queueMicrotask(() => inputRef?.focus())
  }

  const handleCustomConfirm = () => {
    const v = customValue().trim()
    if (v) props.onChange(v)
    setCustomMode(false)
    close()
  }

  // Click outside to close
  createEffect(() => {
    if (!open() && !customMode()) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef) return
      if (wrapperRef.contains(e.target as Node)) return
      close()
      if (customMode()) setCustomMode(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (customMode()) {
          setCustomMode(false)
        } else {
          close()
          inputRef?.focus()
        }
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

  return (
    <div class="settings-field">
      <label for={props.id} class="settings-label">
        {props.label}
      </label>
      <div ref={(el) => (wrapperRef = el)} style={{ position: 'relative' }}>
        <div style={{ position: 'relative', display: 'flex', 'align-items': 'center' }}>
          <input
            ref={(el) => (inputRef = el)}
            id={props.id}
            class="input"
            role="combobox"
            aria-expanded={open() ? 'true' : 'false'}
            aria-controls={listboxId()}
            aria-autocomplete="list"
            aria-activedescendant={open() ? `${props.id}-opt-${highlight()}` : undefined}
            value={open() ? query() : props.value}
            onFocus={() => {
              setOpen(true)
              setQuery('')
              setHighlight(0)
            }}
            onInput={(e) => {
              const v = e.currentTarget.value
              setQuery(v)
              setOpen(true)
              setHighlight(0)
              // if user types, exit custom mode
              if (customMode()) setCustomMode(false)
            }}
            onKeyDown={(e) => {
              const len = flatList().length
              const total = len + 1 // +1 for Custom option
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                if (!open()) {
                  setOpen(true)
                  return
                }
                setHighlight((h) => (h + 1) % total)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                if (!open()) {
                  setOpen(true)
                  return
                }
                setHighlight((h) => (h - 1 + total) % total)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (!open()) {
                  setOpen(true)
                  return
                }
                const h = highlight()
                if (h < len) {
                  const m = flatList()[h]
                  if (m) selectModel(m.id)
                } else {
                  // Custom
                  setCustomMode(true)
                  setCustomValue(query().trim() || props.value)
                  setOpen(false)
                  queueMicrotask(() => customInputRef?.focus())
                }
              } else if (e.key === 'Escape') {
                if (open()) {
                  e.preventDefault()
                  e.stopPropagation()
                  close()
                } else if (customMode()) {
                  e.preventDefault()
                  setCustomMode(false)
                }
              }
            }}
            onClick={() => {
              if (!open()) {
                setOpen(true)
                setQuery('')
              }
            }}
            placeholder={props.placeholder}
            spellcheck={false}
            autocomplete="off"
          />
          <button
            type="button"
            aria-label="Toggle model list"
            aria-expanded={open() ? 'true' : 'false'}
            aria-controls={listboxId()}
            onClick={() => {
              if (open()) close()
              else {
                setOpen(true)
                setQuery('')
                setHighlight(0)
                inputRef?.focus()
              }
            }}
            style={{
              position: 'absolute',
              right: '6px',
              top: '50%',
              transform: 'translateY(-50%)',
              width: '28px',
              height: '28px',
              display: 'grid',
              'place-items': 'center',
              border: 'none',
              background: 'transparent',
              color: 'var(--fg-subtle)',
              cursor: 'pointer',
              'border-radius': 'var(--r-sm)',
              'font-size': '12px',
            }}
          >
            ▾
          </button>
        </div>

        <Show when={open()}>
          <div
            ref={(el) => (listRef = el)}
            id={listboxId()}
            role="listbox"
            aria-label={`${props.label} options`}
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: '0',
              right: '0',
              'max-height': '320px',
              overflow: 'auto',
              background: 'var(--bg-canvas)',
              border: '1px solid var(--border-strong)',
              'border-radius': 'var(--r-md)',
              'box-shadow': 'var(--shadow-pop)',
              'z-index': '30',
              padding: '6px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '8px',
            }}
          >
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
                          const isSelected = () => props.value === m.id
                          const isHighlighted = () => highlight() === idx()
                          return (
                            <button
                              type="button"
                              role="option"
                              id={`${props.id}-opt-${idx()}`}
                              data-idx={idx()}
                              aria-selected={isSelected() ? 'true' : 'false'}
                              onClick={() => selectModel(m.id)}
                              onMouseEnter={() => setHighlight(idx())}
                              style={{
                                display: 'flex',
                                'flex-direction': 'column',
                                gap: '3px',
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
                                <span
                                  style={{
                                    'font-size': 'var(--fs-2xs)',
                                    padding: '1px 6px',
                                    'border-radius': 'var(--r-full)',
                                    background: 'var(--bg-surface)',
                                    border: '1px solid var(--border)',
                                    color: 'var(--fg-subtle)',
                                    'font-weight': '600',
                                  }}
                                >
                                  {m.provider}
                                </span>
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

            {/* Custom option */}
            <div
              style={{
                'border-top': '1px solid var(--border)',
                'margin-top': '4px',
                'padding-top': '6px',
              }}
            >
              <button
                type="button"
                role="option"
                id={`${props.id}-opt-${flatList().length}`}
                data-idx={flatList().length}
                aria-selected="false"
                onClick={() => {
                  setCustomMode(true)
                  setCustomValue(query().trim() || props.value)
                  setOpen(false)
                  queueMicrotask(() => customInputRef?.focus())
                }}
                onMouseEnter={() => setHighlight(flatList().length)}
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '8px',
                  padding: '8px 10px',
                  'border-radius': 'var(--r-sm)',
                  border:
                    highlight() === flatList().length
                      ? '1px solid var(--accent-border)'
                      : '1px solid transparent',
                  background:
                    highlight() === flatList().length ? 'var(--accent-soft)' : 'transparent',
                  cursor: 'pointer',
                  width: '100%',
                  'text-align': 'left',
                }}
              >
                <span
                  style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', color: 'var(--fg)' }}
                >
                  ✎ Custom
                </span>
                <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-faint)' }}>
                  — enter any model ID
                </span>
              </button>
            </div>
          </div>
        </Show>

        <Show when={customMode()}>
          <div
            style={{
              display: 'flex',
              gap: '8px',
              'align-items': 'center',
              'margin-top': '8px',
              padding: '8px',
              background: 'var(--bg-app)',
              border: '1px solid var(--border)',
              'border-radius': 'var(--r-md)',
            }}
          >
            <input
              ref={(el) => (customInputRef = el)}
              class="input"
              value={customValue()}
              onInput={(e) => setCustomValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleCustomConfirm()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setCustomMode(false)
                }
              }}
              placeholder="provider/model-id — e.g. openrouter/anthropic/claude-sonnet-4"
              spellcheck={false}
              autocomplete="off"
              aria-label={`${props.label} custom value`}
              style={{ flex: '1' }}
            />
            <button
              type="button"
              class="btn btn-solid"
              onClick={handleCustomConfirm}
              style={{ padding: '7px 12px', 'font-size': 'var(--fs-sm)', 'min-height': '36px' }}
            >
              Use
            </button>
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => setCustomMode(false)}
              style={{ padding: '7px 10px', 'font-size': 'var(--fs-sm)' }}
            >
              Cancel
            </button>
          </div>
        </Show>

        <span
          class="settings-hint"
          style={{ display: 'block', 'margin-top': customMode() ? '6px' : '4px' }}
        >
          {props.id === 'settings-model'
            ? 'Primary model for turns. Format: provider/model-id.'
            : 'Used for context compaction and summaries.'}
        </span>
      </div>
    </div>
  )
}

type TabId =
  'general' | 'providers' | 'permissions' | 'connectors' | 'agents' | 'commands' | 'terminal'

const TABS: Array<{ id: TabId; label: string; icon: string; desc: string }> = [
  { id: 'general', label: 'General', icon: '⚙', desc: 'Model & appearance' },
  { id: 'providers', label: 'Providers', icon: '🔑', desc: 'API keys' },
  { id: 'permissions', label: 'Permissions', icon: '🛡', desc: 'Tool access' },
  { id: 'connectors', label: 'Connectors', icon: '🔌', desc: 'MCP servers' },
  { id: 'agents', label: 'Agents', icon: '🤖', desc: 'Lane personas' },
  { id: 'commands', label: 'Commands', icon: '⌘', desc: 'Slash & skills' },
  { id: 'terminal', label: 'Terminal', icon: '▣', desc: 'PTY & sandbox' },
]

export function SettingsPanel(props: { store: SettingsStore; open: boolean; onClose: () => void }) {
  const [tab, setTab] = createSignal<TabId>('general')
  const s = () => props.store.state

  // Form state for General
  const [model, setModel] = createSignal('')
  const [smallModel, setSmallModel] = createSignal('')
  const [loopMaxSteps, setLoopMaxSteps] = createSignal('')
  const [loopContextLimit, setLoopContextLimit] = createSignal('')
  const [loopThreshold, setLoopThreshold] = createSignal('')
  const [loopSmallModel, setLoopSmallModel] = createSignal('')
  const [theme, setThemeLocal] = createSignal<ThemeChoice>('system')

  // Providers add form
  const [provName, setProvName] = createSignal('')
  const [provKey, setProvKey] = createSignal('')
  const [provUrl, setProvUrl] = createSignal('')
  const [provTesting, setProvTesting] = createSignal<string | null>(null)
  const [provResult, setProvResult] = createSignal<Record<string, string>>({})

  // MCP add form (mira parity: env + headers)
  const [mcpName, setMcpName] = createSignal('')
  const [mcpType, setMcpType] = createSignal<'local' | 'remote'>('local')
  const [mcpCommand, setMcpCommand] = createSignal('')
  const [mcpUrl, setMcpUrl] = createSignal('')
  const [mcpEnv, setMcpEnv] = createSignal('')
  const [mcpHeaders, setMcpHeaders] = createSignal('')
  const [mcpTesting, setMcpTesting] = createSignal<string | null>(null)
  const [mcpResult, setMcpResult] = createSignal<Record<string, string>>({})

  // Permission add form
  const [permTool, setPermTool] = createSignal('')
  const [permPattern, setPermPattern] = createSignal('')
  const [permAction, setPermAction] = createSignal<'allow' | 'deny' | 'ask'>('allow')

  // Permission dry-run (5-layer preview like providers/mcp Test)
  const [permTestTool, setPermTestTool] = createSignal('bash')
  const [permTestArgs, setPermTestArgs] = createSignal('{"command":"ls -la"}')
  const [permTestAgent, setPermTestAgent] = createSignal('')
  const [permTesting, setPermTesting] = createSignal(false)
  const [permTestResult, setPermTestResult] = createSignal('')

  // Guardrails (advanced)
  const [guardEnforce, setGuardEnforce] = createSignal(false)
  const [guardAllowedRoots, setGuardAllowedRoots] = createSignal('')
  const [guardBlockedPaths, setGuardBlockedPaths] = createSignal('')
  const [guardMaxBytes, setGuardMaxBytes] = createSignal('')
  const [guardTestTool, setGuardTestTool] = createSignal('read')
  const [guardTestPath, setGuardTestPath] = createSignal('')
  const [guardTesting, setGuardTesting] = createSignal(false)
  const [guardResult, setGuardResult] = createSignal('')

  // Lane contract preview (per-agent)
  const [agentPreview, setAgentPreview] = createSignal<string | null>(null)
  const [agentPreviewResult, setAgentPreviewResult] = createSignal<Record<string, string>>({})

  // Terminal
  const [termEnabled, setTermEnabled] = createSignal(true)
  const [termSandbox, setTermSandbox] = createSignal(true)
  const [termAllowed, setTermAllowed] = createSignal('')
  const [termTimeout, setTermTimeout] = createSignal('')
  const [termTesting, setTermTesting] = createSignal(false)
  const [termResult, setTermResult] = createSignal('')

  // Features
  const [featInject, setFeatInject] = createSignal(true)
  const [featLane, setFeatLane] = createSignal(true)
  const [featPerAgent, setFeatPerAgent] = createSignal(true)
  const [budgetCapEnabled, setBudgetCapEnabled] = createSignal(false)
  const [budgetCapAmount, setBudgetCapAmount] = createSignal(100)

  let dialogRef!: HTMLDivElement
  let titleRef!: HTMLDivElement
  let previouslyFocused: HTMLElement | null = null

  // Sync form from loaded config — only on modal OPEN transition, not on every config update
  // (the server re-renders config after save and would wipe user edits).
  let wasOpen = false
  createEffect(() => {
    const open = props.open
    if (open && !wasOpen && s().config) {
      try {
        const enabled = localStorage.getItem('mira.budgetCap.enabled')
        const amount = localStorage.getItem('mira.budgetCap.amount')
        if (enabled != null) setBudgetCapEnabled(enabled === 'true')
        if (amount != null) setBudgetCapAmount(Number(amount) || 100)
      } catch {}
      setModel(s().config?.model ?? '')
      setSmallModel(s().config?.smallModel ?? '')
      const loop = s().config?.loop ?? {}
      setLoopMaxSteps(loop.maxSteps != null ? String(loop.maxSteps) : '')
      setLoopContextLimit(loop.contextLimit != null ? String(loop.contextLimit) : '')
      setLoopThreshold(loop.compactionThreshold != null ? String(loop.compactionThreshold) : '')
      setLoopSmallModel(loop.smallModel ?? '')
      const guard = s().config?.guardrails ?? {}
      setGuardEnforce(!!guard.enforce)
      setGuardAllowedRoots((guard.allowedRoots ?? []).join(', '))
      setGuardBlockedPaths((guard.blockedPaths ?? []).join(', '))
      setGuardMaxBytes(guard.maxOutputBytes != null ? String(guard.maxOutputBytes) : '')
      const tools = (
        s().config as {
          tools?: {
            terminal?: {
              enabled?: boolean
              sandbox?: boolean
              allowedCommands?: string[]
              timeoutMs?: number
            }
          }
        }
      )?.tools
      const term = tools?.terminal
      if (term) {
        setTermEnabled(term.enabled ?? true)
        setTermSandbox(term.sandbox ?? true)
        setTermAllowed((term.allowedCommands ?? []).join(', '))
        setTermTimeout(term.timeoutMs != null ? String(term.timeoutMs) : '')
      }
      const feats = s().config?.features ?? {}
      setFeatInject(feats.injectTodosIntoLoadContext ?? true)
      setFeatLane(feats.enforceLaneContracts ?? true)
      setFeatPerAgent(feats.perAgentPermissionProfiles ?? true)
    }
    if (open && !wasOpen) setThemeLocal(s().theme)
    wasOpen = open
  })

  // Focus trap & Escape — uses shared hook + restores focus on close
  useFocusTrap(
    () => props.open,
    () => dialogRef,
    () => props.onClose(),
  )
  createEffect(() => {
    if (props.open) {
      previouslyFocused = document.activeElement as HTMLElement | null
      queueMicrotask(() => titleRef?.focus())
      const prevOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      onCleanup(() => {
        document.body.style.overflow = prevOverflow
        // restore focus to trigger
        queueMicrotask(() => previouslyFocused?.focus())
      })
    }
  })

  // Load on open
  createEffect(() => {
    if (props.open) void props.store.loadAll()
  })

  const [saveError, setSaveError] = createSignal<string | null>(null)
  const [generalSaving, setGeneralSaving] = createSignal(false)

  const handleSaveGeneral = async (e: Event) => {
    e.preventDefault()
    setSaveError(null)
    // Validation
    const errors: string[] = []
    if (loopMaxSteps().trim()) {
      const v = parseInt(loopMaxSteps().trim(), 10)
      if (!Number.isFinite(v) || v <= 0 || v > 200) errors.push('Max steps must be 1–200')
    }
    if (loopContextLimit().trim()) {
      const v = parseInt(loopContextLimit().trim(), 10)
      if (!Number.isFinite(v) || v < 1000 || v > 1_000_000)
        errors.push('Context limit must be 1000–1000000')
    }
    if (loopThreshold().trim()) {
      const v = parseFloat(loopThreshold().trim())
      if (!Number.isFinite(v) || v <= 0 || v > 1) errors.push('Compaction threshold must be 0–1')
    }
    if (guardMaxBytes().trim()) {
      const v = parseInt(guardMaxBytes().trim(), 10)
      if (!Number.isFinite(v) || v < 1024) errors.push('Max output bytes must be ≥1024')
    }
    if (budgetCapAmount() < 0) errors.push('Budget cap must be ≥0')
    if (errors.length) {
      setSaveError(errors.join(' · '))
      toast.error(errors[0])
      return
    }
    setGeneralSaving(true)
    const patch: Partial<MiraConfig> = {}
    if (model().trim()) patch.model = model().trim()
    if (smallModel().trim()) patch.smallModel = smallModel().trim()
    // Loop limits — only include fields the user touched (empty = leave as-is)
    const loopPatch: Record<string, string | number> = {}
    const maxSteps = parseInt(loopMaxSteps().trim(), 10)
    if (loopMaxSteps().trim() && Number.isFinite(maxSteps) && maxSteps > 0)
      loopPatch.maxSteps = maxSteps
    const ctxLimit = parseInt(loopContextLimit().trim(), 10)
    if (loopContextLimit().trim() && Number.isFinite(ctxLimit) && ctxLimit > 0)
      loopPatch.contextLimit = ctxLimit
    const thresh = parseFloat(loopThreshold().trim())
    if (loopThreshold().trim() && Number.isFinite(thresh) && thresh > 0 && thresh <= 1)
      loopPatch.compactionThreshold = thresh
    if (loopSmallModel().trim()) loopPatch.smallModel = loopSmallModel().trim()
    if (Object.keys(loopPatch).length > 0) patch.loop = loopPatch as MiraConfig['loop']
    // Guardrails — include when user touched fields (mira parity)
    const guardPatch: Record<string, string | number | boolean | string[]> = {}
    const guardOrig = s().config?.guardrails ?? {}
    if (guardEnforce() !== !!guardOrig.enforce) guardPatch.enforce = guardEnforce()
    const roots = guardAllowedRoots()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const rootsOrig = (guardOrig.allowedRoots ?? []).join(', ')
    if (guardAllowedRoots().trim() !== rootsOrig) guardPatch.allowedRoots = roots
    const blocked = guardBlockedPaths()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const blockedOrig = (guardOrig.blockedPaths ?? []).join(', ')
    if (guardBlockedPaths().trim() !== blockedOrig) guardPatch.blockedPaths = blocked
    const maxBytes = parseInt(guardMaxBytes().trim(), 10)
    const maxOrig = guardOrig.maxOutputBytes != null ? String(guardOrig.maxOutputBytes) : ''
    if (guardMaxBytes().trim() !== maxOrig) {
      if (guardMaxBytes().trim() === '')
        guardPatch.maxOutputBytes = 0 // 0 = clear (server treats 0 as no limit)
      else if (Number.isFinite(maxBytes) && maxBytes > 0) guardPatch.maxOutputBytes = maxBytes
    }
    if (Object.keys(guardPatch).length > 0)
      patch.guardrails = guardPatch as MiraConfig['guardrails']
    // Features — lane contracts
    const feats = s().config?.features ?? {}
    const featPatch: Record<string, boolean> = {}
    if (featInject() !== (feats.injectTodosIntoLoadContext ?? true))
      featPatch.injectTodosIntoLoadContext = featInject()
    if (featLane() !== (feats.enforceLaneContracts ?? true))
      featPatch.enforceLaneContracts = featLane()
    if (featPerAgent() !== (feats.perAgentPermissionProfiles ?? true))
      featPatch.perAgentPermissionProfiles = featPerAgent()
    if (Object.keys(featPatch).length > 0) patch.features = { ...feats, ...featPatch }
    // Allow clearing loop fields when user empties them — send explicit null via delete? keep as-is for now
    try {
      if (Object.keys(patch).length > 0) {
        const res = await props.store.saveConfig(patch)
        if (res) toast.success('Settings saved')
        else {
          setSaveError(props.store.state.error ?? 'Save failed')
          toast.error(props.store.state.error ?? 'Save failed')
        }
      } else {
        toast.info('No changes to save')
      }
    } finally {
      setGeneralSaving(false)
    }
    // Persist spend cockpit locally
    try {
      localStorage.setItem('mira.budgetCap.enabled', String(budgetCapEnabled()))
      localStorage.setItem('mira.budgetCap.amount', String(budgetCapAmount()))
    } catch {}
    // Theme is local-only (persisted via store, not server) — apply instantly
    props.store.setTheme(theme())
  }

  const handleAddProvider = async (e: Event) => {
    e.preventDefault()
    const name = provName().trim()
    const key = provKey().trim()
    if (!name || !key) {
      toast.error('Provider id and API key are required')
      return
    }
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      toast.error('Provider id must be alphanumeric, dash or underscore')
      return
    }
    const urlTrimmed = provUrl().trim()
    if (urlTrimmed) {
      try {
        const u = new URL(urlTrimmed)
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol')
      } catch {
        toast.error('Base URL must be a valid http(s) URL')
        return
      }
    }
    // Save as provider.<name> via PATCH /config
    const baseURL = urlTrimmed || undefined
    const providerPatch = {
      provider: {
        ...(s().config?.provider ?? {}),
        [name]: {
          npm: '@ai-sdk/openai-compatible',
          name,
          options: { baseURL: baseURL ?? 'https://api.openai.com/v1', apiKey: key },
          models: {},
        },
      },
    }
    const res = await props.store.saveConfig(providerPatch as Partial<MiraConfig>)
    if (res) {
      setProvName('')
      setProvKey('')
      setProvUrl('')
      void props.store.loadProviders()
      toast.success(`Provider "${name}" added`)
    } else {
      toast.error(props.store.state.error ?? 'Failed to add provider')
    }
  }

  const handleTestProvider = async (id: string) => {
    if (provTesting()) return
    setProvTesting(id)
    try {
      const r = await props.store.testProvider(id)
      setProvResult((prev) => ({
        ...prev,
        [id]: r.ok ? `✓ ok${r.latencyMs ? ` · ${r.latencyMs}ms` : ''}` : `✗ ${r.error ?? 'failed'}`,
      }))
      if (r.ok) toast.success(`Provider "${id}" reachable`)
      else toast.error(`Provider "${id}" test failed: ${r.error ?? 'unknown'}`)
    } finally {
      setProvTesting(null)
    }
  }

  const [provRefreshing, setProvRefreshing] = createSignal<string | null>(null)

  const handleRefreshModels = async (id: string) => {
    if (provRefreshing()) return
    setProvRefreshing(id)
    try {
      const r = await api.listProviderModels(id)
      if (!r.ok || !r.models) {
        toast.error(`Refresh failed for "${id}": ${r.error ?? 'unknown error'}`)
        return
      }
      const providers = (s().config?.provider ?? {}) as Record<string, ProviderConfig>
      const existing = providers[id] as
        | { models?: Record<string, { name: string; limit: { context: number; output: number } }> }
        | undefined
      const merged: Record<string, { name: string; limit: { context: number; output: number } }> = {
        ...(existing?.models ?? {}),
      }
      for (const m of r.models) {
        const mid = m?.id
        if (!mid) continue
        merged[mid] = {
          name: m.name || mid,
          limit: merged[mid]?.limit ?? { context: 128000, output: 4096 },
        }
      }
      const res = await props.store.saveConfig({
        provider: { ...providers, [id]: { ...(existing ?? {}), models: merged } },
      } as Partial<MiraConfig>)
      if (res) {
        void props.store.loadProviders()
        toast.success(
          `Refreshed ${r.models.length} model${r.models.length === 1 ? '' : 's'} for "${id}"`,
        )
      } else {
        toast.error(props.store.state.error ?? `Failed to save models for "${id}"`)
      }
    } catch (e) {
      toast.error(`Refresh failed for "${id}": ${(e as Error).message}`)
    } finally {
      setProvRefreshing(null)
    }
  }

  const [confirmRemoveProvider, setConfirmRemoveProvider] = createSignal<string | null>(null)
  const [confirmRemovePermission, setConfirmRemovePermission] = createSignal<{
    tool: string
    pattern?: string
  } | null>(null)
  const [confirmRemoveMcp, setConfirmRemoveMcp] = createSignal<string | null>(null)

  const handleRemoveProvider = async (id: string) => {
    setConfirmRemoveProvider(id)
  }

  const handleAddMcp = async (e: Event) => {
    e.preventDefault()
    const name = mcpName().trim()
    if (!name) {
      toast.error('MCP server name is required')
      return
    }
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      toast.error('MCP name must be alphanumeric, dash or underscore')
      return
    }
    // Validate env/headers JSON if provided
    const validateJsonField = (raw: string, field: string): boolean => {
      const s = raw.trim()
      if (!s) return true
      try {
        const j = JSON.parse(s)
        if (j && typeof j === 'object' && !Array.isArray(j)) return true
      } catch {}
      // also allow KEY=val format — if it contains '=', consider valid
      if (s.includes('=')) return true
      toast.error(`${field} must be valid JSON or KEY=val pairs`)
      return false
    }
    if (!validateJsonField(mcpEnv(), 'Env')) return
    if (!validateJsonField(mcpHeaders(), 'Headers')) return
    const parseRecord = (raw: string): Record<string, string> | undefined => {
      const s = raw.trim()
      if (!s) return undefined
      try {
        const j = JSON.parse(s)
        if (j && typeof j === 'object' && !Array.isArray(j)) {
          const out: Record<string, string> = {}
          for (const [k, v] of Object.entries(j as Record<string, string>)) out[k] = String(v)
          return out
        }
      } catch {}
      const out: Record<string, string> = {}
      for (const pair of s.split(/[,\n]+/)) {
        const i = pair.indexOf('=')
        if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
      }
      return Object.keys(out).length ? out : undefined
    }
    const env = parseRecord(mcpEnv())
    const headers = parseRecord(mcpHeaders())
    const body: {
      name: string
      type: 'local' | 'remote'
      command?: string[]
      url?: string
      enabled?: boolean
      env?: Record<string, string>
      headers?: Record<string, string>
    } = {
      name,
      type: mcpType(),
      enabled: true,
      env,
      headers,
    }
    if (mcpType() === 'local') {
      const cmd = mcpCommand().trim()
      if (!cmd) {
        toast.error('Command is required for local MCP servers')
        return
      }
      body.command = cmd.split(/\s+/).filter(Boolean)
    } else {
      const url = mcpUrl().trim()
      if (!url) {
        toast.error('URL is required for remote MCP servers')
        return
      }
      try {
        const u = new URL(url)
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad')
      } catch {
        toast.error('MCP URL must be a valid http(s) URL')
        return
      }
      body.url = url
    }
    const created = await props.store.addMcp(body)
    if (created) {
      setMcpName('')
      setMcpCommand('')
      setMcpUrl('')
      setMcpEnv('')
      setMcpHeaders('')
      toast.success(`MCP server "${name}" added`)
    } else {
      toast.error(props.store.state.error ?? 'Failed to add MCP server')
    }
  }

  const handleAddPermission = async (e: Event) => {
    e.preventDefault()
    const tool = permTool().trim()
    const pattern = permPattern().trim()
    const action = permAction()
    if (!tool) {
      toast.error('Tool name is required')
      return
    }
    if (!/^[a-z0-9_-]+$/i.test(tool) && tool !== '*') {
      toast.error('Tool must be alphanumeric or *')
      return
    }
    const current = { ...(s().config?.permission ?? {}) } as Record<
      string,
      string | Record<string, string>
    >
    let next: Record<string, string | Record<string, string>>
    if (pattern) {
      const existing = current[tool]
      const rec =
        typeof existing === 'object' && existing !== null
          ? { ...(existing as Record<string, string>), [pattern]: action }
          : { [pattern]: action }
      next = { ...current, [tool]: rec }
    } else {
      next = { ...current, [tool]: action }
    }
    const res = await props.store.saveConfig({ permission: next } as Partial<MiraConfig>)
    if (res) {
      setPermTool('')
      setPermPattern('')
      toast.success(`Permission ${tool}${pattern ? `:${pattern}` : ''} → ${action}`)
    } else {
      toast.error(props.store.state.error ?? 'Failed to save permission')
    }
  }

  const handleRemovePermission = async (tool: string, pattern?: string) => {
    setConfirmRemovePermission({ tool, pattern })
  }

  const performRemovePermission = async (tool: string, pattern?: string) => {
    setConfirmRemovePermission(null)
    const current = { ...(s().config?.permission ?? {}) } as Record<
      string,
      string | Record<string, string>
    >
    if (pattern) {
      const rec = current[tool]
      if (typeof rec === 'object' && rec !== null) {
        const copy = { ...(rec as Record<string, string>) }
        delete copy[pattern]
        if (Object.keys(copy).length === 0) delete current[tool]
        else current[tool] = copy
      }
    } else {
      delete current[tool]
    }
    const res = await props.store.saveConfig({ permission: current } as Partial<MiraConfig>)
    if (res) toast.success('Permission removed')
  }

  const [terminalSaving, setTerminalSaving] = createSignal(false)
  const handleSaveTerminal = async (e: Event) => {
    e.preventDefault()
    if (termTimeout().trim()) {
      const v = parseInt(termTimeout().trim(), 10)
      if (!Number.isFinite(v) || v < 1000 || v > 300_000) {
        toast.error('Timeout must be 1000–300000 ms')
        return
      }
    }
    setTerminalSaving(true)
    try {
      const allowed = termAllowed()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const timeout = parseInt(termTimeout().trim(), 10)
      const patch = {
        tools: {
          ...(s().config as { tools?: Record<string, unknown> })?.tools,
          terminal: {
            enabled: termEnabled(),
            sandbox: termSandbox(),
            allowedCommands: allowed.length ? allowed : undefined,
            timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
          },
        },
      }
      const res = await props.store.saveConfig(patch as Partial<MiraConfig>)
      if (res) toast.success('Terminal settings saved')
      else toast.error(props.store.state.error ?? 'Save failed')
    } finally {
      setTerminalSaving(false)
    }
  }

  const handleTestTerminal = async () => {
    setTermTesting(true)
    setTermResult('')
    try {
      // Derive the WS host from the same API base the client uses (direct-connect
      // to a separate API port breaks if we always use location.host). Empty base
      // means dev-proxy same-origin → fall back to location.host.
      let wsUrl = ''
      try {
        const base = getApiUrl()
        if (base) {
          const u = new URL(base)
          wsUrl = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}/terminal`
        }
      } catch {}
      if (!wsUrl) {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        wsUrl = `${proto}//${location.host}/terminal`
      }
      const ws = new WebSocket(wsUrl)
      let done = false
      const t = setTimeout(() => {
        if (!done) {
          try {
            ws.close()
          } catch {}
          setTermResult('✗ timeout (no terminal.connected)')
          setTermTesting(false)
        }
      }, 6000)
      ws.onopen = () => {}
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data))
          if (m.type === 'terminal.connected') {
            ws.send(JSON.stringify({ type: 'terminal.input', data: 'echo mira-terminal-ok\n' }))
          } else if (
            m.type === 'terminal.output' &&
            String(m.payload?.data).includes('mira-terminal-ok')
          ) {
            done = true
            clearTimeout(t)
            setTermResult('✓ terminal ok — echo returned')
            try {
              ws.close()
            } catch {}
            setTermTesting(false)
          } else if (m.type === 'terminal.output' && String(m.payload?.data).includes('sandbox:')) {
            done = true
            clearTimeout(t)
            setTermResult(`✗ sandbox blocked: ${String(m.payload.data).slice(0, 120)}`)
            try {
              ws.close()
            } catch {}
            setTermTesting(false)
          }
        } catch {}
      }
      ws.onerror = () => {
        clearTimeout(t)
        setTermResult('✗ WS error')
        setTermTesting(false)
      }
      ws.onclose = () => {
        clearTimeout(t)
        if (!done && !termResult()) {
          setTermResult('✗ closed without output')
          setTermTesting(false)
        }
      }
    } catch (err) {
      setTermResult(`✗ ${(err as Error).message}`)
      setTermTesting(false)
    }
  }

  const handleToggleMcp = async (name: string, enabled: boolean) => {
    await props.store.toggleMcp(name, enabled)
  }

  const handleTestMcp = async (name: string) => {
    setMcpTesting(name)
    const r = await props.store.testMcp(name)
    setMcpResult((prev) => ({
      ...prev,
      [name]: r.ok ? `✓ ${r.toolCount ?? 0} tools` : `✗ ${r.error ?? 'failed'}`,
    }))
    setMcpTesting(null)
  }

  const handleTestPermission = async () => {
    setPermTesting(true)
    setPermTestResult('')
    try {
      const tool = permTestTool().trim() || 'bash'
      let args: Record<string, unknown> = {}
      const raw = permTestArgs().trim()
      if (raw) {
        try {
          args = JSON.parse(raw) as Record<string, unknown>
        } catch {
          args = { command: raw }
        }
      }
      const agent = permTestAgent().trim() || undefined
      const body: Record<string, unknown> = { tool, args, sessionID: 'preview' }
      if (agent) body.agent = agent
      const res = await api.checkPermission(
        body as Record<string, import('../api/client').JsonValue>,
      )
      const lane = (res as { lane?: { agent: string; permissions: string } }).lane
        ? ` · lane:${(res as { lane: { agent: string; permissions: string } }).lane.agent}/${(res as { lane: { agent: string; permissions: string } }).lane.permissions}`
        : ''
      const pat = (res as { matchedPattern?: string }).matchedPattern
        ? ` · pattern:${(res as { matchedPattern: string }).matchedPattern}`
        : ''
      const arity =
        (res as { arity?: number }).arity != null
          ? ` · arity:${(res as { arity: number }).arity}`
          : ''
      const act =
        ((res as { action?: string }).action ?? (res as { allowed?: boolean }).allowed)
          ? 'allow'
          : 'deny'
      const icon = act === 'allow' ? '✓' : act === 'deny' ? '✗' : '?'
      setPermTestResult(`${icon} ${act}${lane}${pat}${arity} — ${res.reason ?? ''}`)
    } catch (err) {
      setPermTestResult(`✗ ${(err as Error).message}`)
    } finally {
      setPermTesting(false)
    }
  }

  const handleTestGuardrails = async () => {
    setGuardTesting(true)
    setGuardResult('')
    try {
      const tool = guardTestTool().trim() || 'read'
      const path = guardTestPath().trim()
      let args: Record<string, unknown> = {}
      if (tool === 'bash') args = { command: path }
      else if (['read', 'write', 'edit', 'glob', 'grep', 'patch'].includes(tool)) args = { path }
      else if (tool === 'webfetch') args = { url: path }
      else args = { path }
      const res = await api.checkGuardrails({
        tool,
        args: args as Record<string, import('../api/client').JsonValue>,
        sessionID: 'preview',
      })
      const icon = res.decision === 'allow' ? '✓' : res.decision === 'deny' ? '✗' : '⚠'
      setGuardResult(`${icon} ${res.decision}${res.reason ? ` — ${res.reason}` : ''}`)
    } catch (err) {
      setGuardResult(`✗ ${(err as Error).message}`)
    } finally {
      setGuardTesting(false)
    }
  }

  const handlePreviewAgent = async (name: string) => {
    setAgentPreview(name)
    try {
      const res = await api.previewAgent(name)
      setAgentPreviewResult((prev) => ({
        ...prev,
        [name]: `✓ ${res.permissions} · ${res.allowed.length} allowed / ${res.blocked.length} blocked — allowed: ${res.allowed.slice(0, 8).join(', ')}${res.allowed.length > 8 ? '…' : ''}`,
      }))
    } catch (err) {
      setAgentPreviewResult((prev) => ({ ...prev, [name]: `✗ ${(err as Error).message}` }))
    } finally {
      setAgentPreview(null)
    }
  }

  return (
    <Show when={props.open}>
      <div
        class="modal-backdrop"
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
      >
        <div
          ref={(el) => (dialogRef = el)}
          class="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="modal-header">
            <div>
              <div
                ref={(el) => (titleRef = el)}
                id="settings-title"
                class="modal-title"
                tabindex="-1"
              >
                Settings
              </div>
              <div
                style={{
                  'font-size': 'var(--fs-xs)',
                  color: 'var(--fg-subtle)',
                  'margin-top': '2px',
                }}
              >
                Configure Mira — models, providers, permissions, and connectors.
              </div>
            </div>
            <button
              type="button"
              class="modal-close"
              onClick={props.onClose}
              aria-label="Close settings"
            >
              ×
            </button>
          </div>

          <div class="settings-layout">
            <nav
              class="settings-nav"
              role="tablist"
              aria-orientation="vertical"
              aria-label="Settings sections"
              onKeyDown={(e) => {
                const idx = TABS.findIndex((t) => t.id === tab())
                if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                  e.preventDefault()
                  const next = TABS[(idx + 1) % TABS.length]!
                  setTab(next.id)
                  document.getElementById(`settings-tab-${next.id}`)?.focus()
                } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                  e.preventDefault()
                  const prev = TABS[(idx - 1 + TABS.length) % TABS.length]!
                  setTab(prev.id)
                  document.getElementById(`settings-tab-${prev.id}`)?.focus()
                } else if (e.key === 'Home') {
                  e.preventDefault()
                  setTab(TABS[0]!.id)
                  document.getElementById(`settings-tab-${TABS[0]!.id}`)?.focus()
                } else if (e.key === 'End') {
                  e.preventDefault()
                  setTab(TABS[TABS.length - 1]!.id)
                  document.getElementById(`settings-tab-${TABS[TABS.length - 1]!.id}`)?.focus()
                }
              }}
            >
              <For each={TABS}>
                {(t) => (
                  <button
                    type="button"
                    role="tab"
                    id={`settings-tab-${t.id}`}
                    aria-selected={tab() === t.id ? 'true' : 'false'}
                    aria-controls={`settings-panel-${t.id}`}
                    tabindex={tab() === t.id ? 0 : -1}
                    class="settings-tab"
                    onClick={() => setTab(t.id)}
                  >
                    <span
                      aria-hidden="true"
                      style={{ 'font-size': '13px', width: '16px', 'text-align': 'center' }}
                    >
                      {t.icon}
                    </span>
                    <span
                      style={{
                        display: 'flex',
                        'flex-direction': 'column',
                        'align-items': 'flex-start',
                        gap: '1px',
                      }}
                    >
                      <span>{t.label}</span>
                      <span
                        style={{
                          'font-size': 'var(--fs-2xs)',
                          color: 'var(--fg-faint)',
                          'font-weight': '400',
                        }}
                      >
                        {t.desc}
                      </span>
                    </span>
                  </button>
                )}
              </For>
              <div
                style={{
                  'margin-top': '12px',
                  padding: '8px 0 2px',
                  'border-top': '1px solid var(--border)',
                }}
              >
                <div
                  style={{
                    'font-size': 'var(--fs-2xs)',
                    color: 'var(--fg-faint)',
                    'line-height': '1.5',
                  }}
                >
                  Changes save to{' '}
                  <code
                    style={{
                      'font-family': 'var(--font-mono)',
                      background: 'var(--bg-surface)',
                      padding: '1px 4px',
                      'border-radius': '4px',
                    }}
                  >
                    mira.json
                  </code>{' '}
                  via PATCH /config.
                </div>
              </div>
            </nav>

            <div class="settings-content scroll">
              {/* ── General ─────────────────────────────────────────── */}
              <Show when={tab() === 'general'}>
                <div
                  id="settings-panel-general"
                  role="tabpanel"
                  aria-labelledby="settings-tab-general"
                >
                  <div class="settings-section-title">General</div>

                  <Show when={s().loading}>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                      <div class="skeleton" style={{ height: '64px' }} />
                      <div class="skeleton" style={{ height: '64px' }} />
                    </div>
                  </Show>

                  <Show when={s().error}>
                    <div class="alert" role="alert" style={{ 'margin-bottom': '12px' }}>
                      ⚠ {s().error}
                    </div>
                  </Show>

                  <form
                    onSubmit={handleSaveGeneral}
                    style={{ display: 'flex', 'flex-direction': 'column', gap: '16px' }}
                  >
                    <div
                      class="settings-card"
                      style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}
                    >
                      <ModelSelector
                        value={model()}
                        onChange={setModel}
                        placeholder="openrouter/anthropic/claude-sonnet-4"
                        label="Model"
                        id="settings-model"
                        providers={s().providers}
                      />

                      <ModelSelector
                        value={smallModel()}
                        onChange={setSmallModel}
                        placeholder="openrouter/deepseek/deepseek-v3.2-exp"
                        label="Small model (compaction)"
                        id="settings-small-model"
                        providers={s().providers}
                      />

                      <div
                        style={{
                          'font-size': 'var(--fs-xs)',
                          'font-weight': '700',
                          color: 'var(--fg-muted)',
                          'letter-spacing': '0.04em',
                          'text-transform': 'uppercase',
                          'margin-top': '4px',
                        }}
                      >
                        Loop limits
                      </div>
                      <div
                        style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}
                      >
                        <div class="settings-field">
                          <label for="settings-loop-maxsteps" class="settings-label">
                            Max steps
                          </label>
                          <input
                            id="settings-loop-maxsteps"
                            class="input"
                            type="number"
                            min="1"
                            value={loopMaxSteps()}
                            onInput={(e) => setLoopMaxSteps(e.currentTarget.value)}
                            placeholder="32"
                            autocomplete="off"
                          />
                          <span class="settings-hint">LLM turns per prompt.</span>
                        </div>
                        <div class="settings-field">
                          <label for="settings-loop-ctx" class="settings-label">
                            Context limit
                          </label>
                          <input
                            id="settings-loop-ctx"
                            class="input"
                            type="number"
                            min="1000"
                            value={loopContextLimit()}
                            onInput={(e) => setLoopContextLimit(e.currentTarget.value)}
                            placeholder="128000"
                            autocomplete="off"
                          />
                          <span class="settings-hint">Tokens before compaction.</span>
                        </div>
                      </div>
                      <div
                        style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}
                      >
                        <div class="settings-field">
                          <label for="settings-loop-thresh" class="settings-label">
                            Compaction threshold
                          </label>
                          <input
                            id="settings-loop-thresh"
                            class="input"
                            type="number"
                            min="0.1"
                            max="1"
                            step="0.05"
                            value={loopThreshold()}
                            onInput={(e) => setLoopThreshold(e.currentTarget.value)}
                            placeholder="0.8"
                            autocomplete="off"
                          />
                          <span class="settings-hint">0–1 fraction of limit.</span>
                        </div>
                        <div class="settings-field">
                          <label for="settings-loop-small" class="settings-label">
                            Loop small model
                          </label>
                          <input
                            id="settings-loop-small"
                            class="input"
                            value={loopSmallModel()}
                            onInput={(e) => setLoopSmallModel(e.currentTarget.value)}
                            placeholder="openrouter/deepseek/..."
                            autocomplete="off"
                            spellcheck={false}
                          />
                          <span class="settings-hint">Overrides smallModel for loops.</span>
                        </div>
                      </div>

                      <div
                        style={{
                          'font-size': 'var(--fs-xs)',
                          'font-weight': '700',
                          color: 'var(--fg-muted)',
                          'letter-spacing': '0.04em',
                          'text-transform': 'uppercase',
                          'margin-top': '4px',
                        }}
                      >
                        Spend cockpit
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '8px',
                          'margin-bottom': '12px',
                        }}
                      >
                        <label
                          style={{
                            display: 'inline-flex',
                            'align-items': 'center',
                            gap: '6px',
                            'font-size': 'var(--fs-sm)',
                            color: 'var(--fg)',
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={budgetCapEnabled()}
                            onChange={(e) => setBudgetCapEnabled(e.currentTarget.checked)}
                          />
                          Enable budget cap
                        </label>
                        <span class="settings-hint" style={{ margin: '0' }}>
                          Warn when monthly spend exceeds
                        </span>
                        <label for="settings-budget-cap" class="sr-only">
                          Budget cap amount USD
                        </label>
                        <input
                          id="settings-budget-cap"
                          type="number"
                          min="0"
                          step="10"
                          aria-label="Budget cap amount in USD"
                          value={budgetCapAmount()}
                          onInput={(e) => setBudgetCapAmount(Number(e.currentTarget.value) || 0)}
                          class="input"
                          style={{ 'font-size': 'var(--fs-sm)', width: '90px', padding: '6px 8px' }}
                        />
                        USD / month
                      </div>

                      <div
                        style={{
                          'font-size': 'var(--fs-xs)',
                          'font-weight': '700',
                          color: 'var(--fg-muted)',
                          'letter-spacing': '0.04em',
                          'text-transform': 'uppercase',
                          'margin-top': '4px',
                        }}
                      >
                        Guardrails
                      </div>
                      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                        <label
                          style={{
                            display: 'inline-flex',
                            'align-items': 'center',
                            gap: '6px',
                            'font-size': 'var(--fs-sm)',
                            color: 'var(--fg)',
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={guardEnforce()}
                            onChange={(e) => setGuardEnforce(e.currentTarget.checked)}
                          />
                          Enforce
                        </label>
                        <span class="settings-hint" style={{ margin: '0' }}>
                          Block outside allowed roots.
                        </span>
                      </div>
                      <div
                        style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}
                      >
                        <div class="settings-field">
                          <label for="settings-guard-roots" class="settings-label">
                            Allowed roots
                          </label>
                          <input
                            id="settings-guard-roots"
                            class="input"
                            value={guardAllowedRoots()}
                            onInput={(e) => setGuardAllowedRoots(e.currentTarget.value)}
                            placeholder="/srv/projects, /home/me/code"
                            autocomplete="off"
                            spellcheck={false}
                          />
                          <span class="settings-hint">Comma separated.</span>
                        </div>
                        <div class="settings-field">
                          <label for="settings-guard-blocked" class="settings-label">
                            Blocked paths
                          </label>
                          <input
                            id="settings-guard-blocked"
                            class="input"
                            value={guardBlockedPaths()}
                            onInput={(e) => setGuardBlockedPaths(e.currentTarget.value)}
                            placeholder="**/.env, **/secrets/**"
                            autocomplete="off"
                            spellcheck={false}
                          />
                          <span class="settings-hint">Glob patterns.</span>
                        </div>
                      </div>
                      <div class="settings-field">
                        <label for="settings-guard-max" class="settings-label">
                          Max output bytes
                        </label>
                        <input
                          id="settings-guard-max"
                          class="input"
                          type="number"
                          min="1024"
                          value={guardMaxBytes()}
                          onInput={(e) => setGuardMaxBytes(e.currentTarget.value)}
                          placeholder="1048576"
                          autocomplete="off"
                        />
                        <span class="settings-hint">Truncate tool output.</span>
                      </div>

                      <div
                        class="settings-card"
                        style={{
                          display: 'flex',
                          'flex-direction': 'column',
                          gap: '8px',
                          padding: '10px 12px',
                          background: 'var(--bg-app)',
                          border: '1px dashed var(--border)',
                        }}
                      >
                        <div
                          style={{
                            'font-size': 'var(--fs-xs)',
                            'font-weight': '700',
                            color: 'var(--fg-muted)',
                            'letter-spacing': '0.04em',
                            'text-transform': 'uppercase',
                          }}
                        >
                          Guardrails audit preview
                        </div>
                        <div
                          style={{
                            display: 'grid',
                            'grid-template-columns': '110px 1fr auto',
                            gap: '8px',
                            'align-items': 'end',
                          }}
                        >
                          <div class="settings-field">
                            <label class="settings-label" for="guard-test-tool">
                              Tool
                            </label>
                            <select
                              id="guard-test-tool"
                              class="input"
                              value={guardTestTool()}
                              onChange={(e) => setGuardTestTool(e.currentTarget.value)}
                            >
                              <option value="read">read</option>
                              <option value="write">write</option>
                              <option value="edit">edit</option>
                              <option value="bash">bash</option>
                              <option value="glob">glob</option>
                              <option value="webfetch">webfetch</option>
                            </select>
                          </div>
                          <div class="settings-field">
                            <label class="settings-label" for="guard-test-path">
                              Path / command / URL
                            </label>
                            <input
                              id="guard-test-path"
                              class="input"
                              value={guardTestPath()}
                              onInput={(e) => setGuardTestPath(e.currentTarget.value)}
                              placeholder="/path/to/file or rm -rf /"
                              spellcheck={false}
                              autocomplete="off"
                            />
                          </div>
                          <button
                            type="button"
                            class="btn btn-outline"
                            disabled={guardTesting()}
                            aria-busy={guardTesting() ? 'true' : 'false'}
                            aria-label="Test guardrails dry-run"
                            onClick={() => void handleTestGuardrails()}
                            style={{
                              padding: '7px 12px',
                              'font-size': 'var(--fs-sm)',
                              height: '36px',
                              'min-height': '36px',
                            }}
                          >
                            {guardTesting() ? 'Testing…' : 'Test'}
                          </button>
                        </div>
                        <Show when={guardResult()}>
                          <span
                            style={{
                              'font-size': 'var(--fs-xs)',
                              color: guardResult().startsWith('✓')
                                ? 'var(--ok)'
                                : guardResult().startsWith('✗')
                                  ? 'var(--danger)'
                                  : 'var(--warn)',
                              'font-family': 'var(--font-mono)',
                              'word-break': 'break-word',
                            }}
                          >
                            {guardResult()}
                          </span>
                        </Show>
                        <span class="settings-hint">
                          Dry-run GuardrailsManager.check — respects enforce +
                          allowedRoots/blockedPaths. Like Test in Providers/MCP.
                        </span>
                      </div>

                      <div
                        style={{
                          'font-size': 'var(--fs-xs)',
                          'font-weight': '700',
                          color: 'var(--fg-muted)',
                          'letter-spacing': '0.04em',
                          'text-transform': 'uppercase',
                          'margin-top': '4px',
                        }}
                      >
                        Features
                      </div>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                        <label
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '8px',
                            'font-size': 'var(--fs-sm)',
                            color: 'var(--fg)',
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={featInject()}
                            onChange={(e) => setFeatInject(e.currentTarget.checked)}
                          />
                          Inject todos into loadContext
                        </label>
                        <label
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '8px',
                            'font-size': 'var(--fs-sm)',
                            color: 'var(--fg)',
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={featLane()}
                            onChange={(e) => setFeatLane(e.currentTarget.checked)}
                          />
                          Enforce lane contracts (tool allowlist)
                        </label>
                        <label
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '8px',
                            'font-size': 'var(--fs-sm)',
                            color: 'var(--fg)',
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={featPerAgent()}
                            onChange={(e) => setFeatPerAgent(e.currentTarget.checked)}
                          />
                          Per-agent permission profiles
                        </label>
                        <span class="settings-hint">
                          Saved to mira.json → features. Controls context injection and agent tool
                          filtering.
                        </span>
                      </div>

                      <div class="settings-field">
                        <span id="settings-theme-label" class="settings-label">
                          Theme
                        </span>
                        <div
                          role="radiogroup"
                          aria-labelledby="settings-theme-label"
                          style={{ display: 'flex', gap: '6px' }}
                          onKeyDown={(e) => {
                            const order: ThemeChoice[] = ['light', 'dark', 'system']
                            const idx = order.indexOf(theme())
                            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                              e.preventDefault()
                              const next = order[(idx + 1) % order.length]!
                              setThemeLocal(next)
                              props.store.setTheme(next)
                            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                              e.preventDefault()
                              const prev = order[(idx - 1 + order.length) % order.length]!
                              setThemeLocal(prev)
                              props.store.setTheme(prev)
                            }
                          }}
                        >
                          <For each={['light', 'dark', 'system'] as ThemeChoice[]}>
                            {(choice) => (
                              <button
                                type="button"
                                role="radio"
                                aria-checked={theme() === choice ? 'true' : 'false'}
                                tabindex={theme() === choice ? 0 : -1}
                                onClick={() => {
                                  setThemeLocal(choice)
                                  props.store.setTheme(choice)
                                }}
                                style={{
                                  flex: '1',
                                  padding: '8px 10px',
                                  'border-radius': 'var(--r-md)',
                                  border:
                                    theme() === choice
                                      ? '1px solid var(--accent-border)'
                                      : '1px solid var(--border)',
                                  background:
                                    theme() === choice ? 'var(--accent-soft)' : 'var(--bg-app)',
                                  color: theme() === choice ? 'var(--fg)' : 'var(--fg-muted)',
                                  'font-size': 'var(--fs-sm)',
                                  'font-weight': theme() === choice ? '600' : '500',
                                  cursor: 'pointer',
                                }}
                              >
                                {choice === 'light'
                                  ? '☀ Light'
                                  : choice === 'dark'
                                    ? '☾ Dark'
                                    : '◐ System'}
                              </button>
                            )}
                          </For>
                        </div>
                        <span class="settings-hint">
                          System follows your OS preference via{' '}
                          <code style={{ 'font-family': 'var(--font-mono)' }}>
                            prefers-color-scheme
                          </code>
                          . Stored in localStorage.
                        </span>
                      </div>
                    </div>

                    <Show when={saveError()}>
                      <div class="alert" role="alert" style={{ 'margin-top': '8px' }}>
                        ⚠ {saveError()}
                      </div>
                    </Show>
                    <Show when={s().error}>
                      <div class="alert" role="alert" style={{ 'margin-top': '8px' }}>
                        ⚠ {s().error}
                      </div>
                    </Show>
                    <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
                      <button
                        type="button"
                        class="btn btn-ghost"
                        onClick={props.onClose}
                        style={{ padding: '7px 14px', 'font-size': 'var(--fs-sm)' }}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        class="btn btn-solid"
                        disabled={generalSaving() || props.store.saving()}
                        aria-busy={generalSaving() || props.store.saving() ? 'true' : 'false'}
                        style={{ padding: '7px 14px', 'font-size': 'var(--fs-sm)', gap: '6px' }}
                      >
                        <Show when={generalSaving() || props.store.saving()} fallback={null}>
                          <span class="spinner" aria-hidden="true" />
                        </Show>
                        {generalSaving() || props.store.saving() ? 'Saving…' : 'Save'}
                      </button>
                    </div>

                    <Show when={!s().config && !s().loading}>
                      <div
                        style={{
                          padding: '10px 12px',
                          'border-radius': 'var(--r-md)',
                          border: '1px dashed var(--border-strong)',
                          color: 'var(--fg-faint)',
                          'font-size': 'var(--fs-xs)',
                          'text-align': 'center',
                        }}
                      >
                        No config endpoint — server may be older. Settings still apply to theme
                        locally.
                      </div>
                    </Show>
                  </form>
                </div>
              </Show>

              {/* ── Providers ───────────────────────────────────────── */}
              <Show when={tab() === 'providers'}>
                <div
                  id="settings-panel-providers"
                  role="tabpanel"
                  aria-labelledby="settings-tab-providers"
                >
                  <div class="settings-section-title">Providers</div>
                  <div class="settings-hint" style={{ 'margin-bottom': '12px' }}>
                    API keys are masked. Add a provider to PATCH /config — keys never leave your
                    server.
                  </div>

                  <Show when={s().providers.length === 0 && !s().loading}>
                    <div
                      style={{
                        padding: '14px',
                        border: '1px dashed var(--border-strong)',
                        'border-radius': 'var(--r-md)',
                        'text-align': 'center',
                        color: 'var(--fg-faint)',
                        'font-size': 'var(--fs-sm)',
                        'margin-bottom': '12px',
                      }}
                    >
                      No providers configured. Add one below or set keys in{' '}
                      <code style={{ 'font-family': 'var(--font-mono)' }}>mira.json</code>.
                    </div>
                  </Show>

                  <div
                    style={{
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '8px',
                      'margin-bottom': '16px',
                    }}
                  >
                    <For each={s().providers}>
                      {(p) => (
                        <div class="provider-row">
                          <div
                            style={{
                              display: 'flex',
                              'flex-direction': 'column',
                              gap: '2px',
                              'min-width': '0',
                            }}
                          >
                            <span
                              style={{
                                'font-size': 'var(--fs-sm)',
                                'font-weight': '600',
                                color: 'var(--fg)',
                              }}
                            >
                              {p.name || p.id}
                            </span>
                            <span
                              style={{
                                'font-size': 'var(--fs-2xs)',
                                color: 'var(--fg-faint)',
                                'font-family': 'var(--font-mono)',
                              }}
                            >
                              {p.baseURL || '—'}
                            </span>
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              gap: '8px',
                              'align-items': 'center',
                              'flex-shrink': '0',
                            }}
                          >
                            <span class="masked-key" title={p.maskedKey}>
                              {p.maskedKey ?? '—'}
                            </span>
                            <button
                              type="button"
                              class="btn btn-outline"
                              disabled={provTesting() === p.id}
                              aria-busy={provTesting() === p.id ? 'true' : 'false'}
                              aria-label={`Test provider ${p.id}`}
                              onClick={() => void handleTestProvider(p.id)}
                              style={{
                                padding: '5px 10px',
                                'font-size': 'var(--fs-xs)',
                                'min-height': '28px',
                              }}
                            >
                              {provTesting() === p.id ? 'Testing…' : 'Test'}
                            </button>
                            <button
                              type="button"
                              class="btn btn-outline"
                              disabled={provRefreshing() === p.id}
                              aria-busy={provRefreshing() === p.id ? 'true' : 'false'}
                              aria-label={`Refresh models for provider ${p.id}`}
                              title={`Fetch live model list for ${p.id}`}
                              onClick={() => void handleRefreshModels(p.id)}
                              style={{
                                padding: '5px 10px',
                                'font-size': 'var(--fs-xs)',
                                'min-height': '28px',
                              }}
                            >
                              {provRefreshing() === p.id ? 'Refreshing…' : 'Refresh'}
                            </button>
                            <button
                              type="button"
                              class="btn btn-ghost"
                              onClick={() => void handleRemoveProvider(p.id)}
                              title={`Remove ${p.id}`}
                              aria-label={`Remove provider ${p.id}`}
                              style={{
                                padding: '5px 8px',
                                'font-size': 'var(--fs-xs)',
                                color: 'var(--danger)',
                                'min-height': '28px',
                              }}
                            >
                              Remove
                            </button>
                            <Show when={provResult()[p.id]}>
                              <span
                                style={{
                                  'font-size': 'var(--fs-xs)',
                                  color: provResult()[p.id].startsWith('✓')
                                    ? 'var(--ok)'
                                    : 'var(--danger)',
                                }}
                              >
                                {provResult()[p.id]}
                              </span>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>

                  <form
                    onSubmit={handleAddProvider}
                    class="settings-card"
                    style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}
                  >
                    <div
                      style={{
                        'font-size': 'var(--fs-sm)',
                        'font-weight': '600',
                        color: 'var(--fg)',
                      }}
                    >
                      Add provider
                    </div>
                    <div
                      style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}
                    >
                      <div class="settings-field">
                        <label for="prov-name" class="settings-label">
                          Provider id
                        </label>
                        <input
                          id="prov-name"
                          class="input"
                          value={provName()}
                          onInput={(e) => setProvName(e.currentTarget.value)}
                          placeholder="openrouter"
                          autocomplete="off"
                          spellcheck={false}
                        />
                      </div>
                      <div class="settings-field">
                        <label for="prov-url" class="settings-label">
                          Base URL (optional)
                        </label>
                        <input
                          id="prov-url"
                          class="input"
                          value={provUrl()}
                          onInput={(e) => setProvUrl(e.currentTarget.value)}
                          placeholder="https://openrouter.ai/api/v1"
                          autocomplete="off"
                          spellcheck={false}
                        />
                      </div>
                    </div>
                    <div class="settings-field">
                      <label for="prov-key" class="settings-label">
                        API key
                      </label>
                      <input
                        id="prov-key"
                        class="input"
                        type="password"
                        value={provKey()}
                        onInput={(e) => setProvKey(e.currentTarget.value)}
                        placeholder="sk-…"
                        autocomplete="off"
                        spellcheck={false}
                      />
                    </div>
                    <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
                      <button
                        type="submit"
                        class="btn btn-solid"
                        disabled={!provName().trim() || !provKey().trim() || props.store.saving()}
                        aria-busy={props.store.saving() ? 'true' : 'false'}
                        style={{
                          padding: '6px 12px',
                          'font-size': 'var(--fs-sm)',
                          'min-height': '32px',
                        }}
                      >
                        {props.store.saving() ? 'Saving…' : 'Add provider'}
                      </button>
                    </div>
                  </form>
                </div>
              </Show>

              {/* ── Permissions ─────────────────────────────────────── */}
              <Show when={tab() === 'permissions'}>
                <div
                  id="settings-panel-permissions"
                  role="tabpanel"
                  aria-labelledby="settings-tab-permissions"
                >
                  <div class="settings-section-title">Permissions</div>
                  <div class="settings-hint" style={{ 'margin-bottom': '12px' }}>
                    7-layer config: explicit deny → allow → pattern → BashArity → default ask. Read
                    from <code style={{ 'font-family': 'var(--font-mono)' }}>GET /permission</code>{' '}
                    (falls back to{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>config.permission</code>).
                  </div>

                  <Show
                    when={s().permission !== null && Object.keys(s().permission ?? {}).length > 0}
                    fallback={
                      <div
                        style={{
                          padding: '14px',
                          border: '1px dashed var(--border-strong)',
                          'border-radius': 'var(--r-md)',
                          'text-align': 'center',
                          color: 'var(--fg-faint)',
                          'font-size': 'var(--fs-sm)',
                        }}
                      >
                        No permission rules found. Configure in{' '}
                        <code style={{ 'font-family': 'var(--font-mono)' }}>
                          mira.json → permission
                        </code>{' '}
                        — e.g.{' '}
                        <code style={{ 'font-family': 'var(--font-mono)' }}>
                          &#123;"bash":"allow","read":"allow"&#125;
                        </code>
                        .
                      </div>
                    }
                  >
                    <div class="settings-card" style={{ padding: '0', overflow: 'hidden' }}>
                      <table class="perm-table">
                        <thead>
                          <tr>
                            <th>Tool / pattern</th>
                            <th>Policy</th>
                            <th style={{ width: '40px' }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          <For
                            each={Object.entries(
                              (s().permission ?? {}) as Record<
                                string,
                                string | Record<string, string>
                              >,
                            )}
                          >
                            {([tool, rule]) => {
                              const isRecord = typeof rule === 'object' && rule !== null
                              return (
                                <>
                                  <Show
                                    when={!isRecord}
                                    fallback={
                                      <For each={Object.entries(rule as Record<string, string>)}>
                                        {([pattern, action]) => (
                                          <tr>
                                            <td>
                                              <span
                                                style={{
                                                  'font-family': 'var(--font-mono)',
                                                  'font-size': 'var(--fs-xs)',
                                                  color: 'var(--fg)',
                                                }}
                                              >
                                                {tool}
                                              </span>
                                              <span
                                                style={{
                                                  color: 'var(--fg-faint)',
                                                  'margin-left': '6px',
                                                }}
                                              >
                                                {pattern}
                                              </span>
                                            </td>
                                            <td>
                                              <span
                                                class={`perm-badge ${action === 'allow' ? 'perm-allow' : action === 'deny' ? 'perm-deny' : 'perm-ask'}`}
                                              >
                                                {action}
                                              </span>
                                            </td>
                                            <td style={{ 'text-align': 'right' }}>
                                              <button
                                                type="button"
                                                class="btn btn-ghost"
                                                onClick={() =>
                                                  void handleRemovePermission(tool, pattern)
                                                }
                                                title={`Remove ${tool}:${pattern}`}
                                                style={{
                                                  padding: '2px 6px',
                                                  'font-size': 'var(--fs-2xs)',
                                                  color: 'var(--danger)',
                                                }}
                                              >
                                                ✕
                                              </button>
                                            </td>
                                          </tr>
                                        )}
                                      </For>
                                    }
                                  >
                                    <tr>
                                      <td
                                        style={{
                                          'font-family': 'var(--font-mono)',
                                          'font-size': 'var(--fs-xs)',
                                          color: 'var(--fg)',
                                        }}
                                      >
                                        {tool}
                                      </td>
                                      <td>
                                        <span
                                          class={`perm-badge ${rule === 'allow' ? 'perm-allow' : rule === 'deny' ? 'perm-deny' : 'perm-ask'}`}
                                        >
                                          {String(rule)}
                                        </span>
                                      </td>
                                      <td style={{ 'text-align': 'right' }}>
                                        <button
                                          type="button"
                                          class="btn btn-ghost"
                                          onClick={() => void handleRemovePermission(tool)}
                                          title={`Remove ${tool}`}
                                          style={{
                                            padding: '2px 6px',
                                            'font-size': 'var(--fs-2xs)',
                                            color: 'var(--danger)',
                                          }}
                                        >
                                          ✕
                                        </button>
                                      </td>
                                    </tr>
                                  </Show>
                                </>
                              )
                            }}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>

                  <form
                    onSubmit={handleAddPermission}
                    class="settings-card"
                    style={{
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '8px',
                      'margin-top': '12px',
                      padding: '10px 12px',
                    }}
                  >
                    <div
                      style={{
                        'font-size': 'var(--fs-sm)',
                        'font-weight': '600',
                        color: 'var(--fg)',
                      }}
                    >
                      Add / update rule
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        'grid-template-columns': '1fr 1fr 110px auto',
                        gap: '8px',
                        'align-items': 'end',
                      }}
                    >
                      <div class="settings-field">
                        <label class="settings-label" for="perm-tool">
                          Tool
                        </label>
                        <input
                          id="perm-tool"
                          class="input"
                          value={permTool()}
                          onInput={(e) => setPermTool(e.currentTarget.value)}
                          placeholder="bash or read"
                          spellcheck={false}
                          autocomplete="off"
                        />
                      </div>
                      <div class="settings-field">
                        <label class="settings-label" for="perm-pattern">
                          Pattern (optional)
                        </label>
                        <input
                          id="perm-pattern"
                          class="input"
                          value={permPattern()}
                          onInput={(e) => setPermPattern(e.currentTarget.value)}
                          placeholder="rm -rf * or *.ts"
                          spellcheck={false}
                          autocomplete="off"
                        />
                      </div>
                      <div class="settings-field">
                        <label class="settings-label" for="perm-action">
                          Action
                        </label>
                        <select
                          id="perm-action"
                          class="input"
                          value={permAction()}
                          onChange={(e) =>
                            setPermAction(e.currentTarget.value as 'allow' | 'deny' | 'ask')
                          }
                        >
                          <option value="allow">allow</option>
                          <option value="deny">deny</option>
                          <option value="ask">ask</option>
                        </select>
                      </div>
                      <button
                        type="submit"
                        class="btn btn-solid"
                        disabled={!permTool().trim() || props.store.saving()}
                        aria-busy={props.store.saving() ? 'true' : 'false'}
                        style={{
                          padding: '7px 12px',
                          'font-size': 'var(--fs-sm)',
                          height: '36px',
                          'min-height': '36px',
                        }}
                      >
                        {props.store.saving() ? 'Saving…' : 'Add'}
                      </button>
                    </div>
                    <span class="settings-hint">
                      Pattern empty = tool-wide rule. With pattern = tool:pattern → action
                      (7-layer).
                    </span>
                  </form>

                  <div
                    class="settings-card"
                    style={{
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '8px',
                      'margin-top': '12px',
                      padding: '10px 12px',
                      background: 'var(--bg-app)',
                      border: '1px dashed var(--border)',
                    }}
                  >
                    <div
                      style={{
                        'font-size': 'var(--fs-xs)',
                        'font-weight': '700',
                        color: 'var(--fg-muted)',
                        'letter-spacing': '0.04em',
                        'text-transform': 'uppercase',
                      }}
                    >
                      Dry-run permission.check — 5 layers
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        'grid-template-columns': '110px 1fr 110px auto',
                        gap: '8px',
                        'align-items': 'end',
                      }}
                    >
                      <div class="settings-field">
                        <label class="settings-label" for="perm-test-tool">
                          Tool
                        </label>
                        <select
                          id="perm-test-tool"
                          class="input"
                          value={permTestTool()}
                          onChange={(e) => setPermTestTool(e.currentTarget.value)}
                        >
                          <option value="bash">bash</option>
                          <option value="read">read</option>
                          <option value="write">write</option>
                          <option value="edit">edit</option>
                          <option value="glob">glob</option>
                          <option value="grep">grep</option>
                          <option value="webfetch">webfetch</option>
                          <option value="task">task</option>
                        </select>
                      </div>
                      <div class="settings-field">
                        <label class="settings-label" for="perm-test-args">
                          Args (JSON)
                        </label>
                        <input
                          id="perm-test-args"
                          class="input"
                          value={permTestArgs()}
                          onInput={(e) => setPermTestArgs(e.currentTarget.value)}
                          placeholder='{"command":"ls"} or {"path":"/tmp/x"}'
                          spellcheck={false}
                          autocomplete="off"
                        />
                      </div>
                      <div class="settings-field">
                        <label class="settings-label" for="perm-test-agent">
                          Agent (lane)
                        </label>
                        <select
                          id="perm-test-agent"
                          class="input"
                          value={permTestAgent()}
                          onChange={(e) => setPermTestAgent(e.currentTarget.value)}
                        >
                          <option value="">(none)</option>
                          <option value="researcher">researcher</option>
                          <option value="coder">coder</option>
                          <option value="explorer">explorer</option>
                          <option value="reviewer">reviewer</option>
                          <option value="general">general</option>
                        </select>
                      </div>
                      <button
                        type="button"
                        class="btn btn-outline"
                        disabled={permTesting()}
                        aria-busy={permTesting() ? 'true' : 'false'}
                        aria-label="Test permission dry-run"
                        onClick={() => void handleTestPermission()}
                        style={{
                          padding: '7px 12px',
                          'font-size': 'var(--fs-sm)',
                          height: '36px',
                          'min-height': '36px',
                        }}
                      >
                        {permTesting() ? 'Testing…' : 'Test'}
                      </button>
                    </div>
                    <Show when={permTestResult()}>
                      <span
                        style={{
                          'font-size': 'var(--fs-xs)',
                          color: permTestResult().startsWith('✓')
                            ? 'var(--ok)'
                            : permTestResult().startsWith('✗')
                              ? 'var(--danger)'
                              : 'var(--warn)',
                          'font-family': 'var(--font-mono)',
                          'word-break': 'break-word',
                        }}
                      >
                        {permTestResult()}
                      </span>
                    </Show>
                    <span class="settings-hint">
                      Dry-run POST /permission/check — 5 layers + BashArity + lane contract (if
                      agent set). Like Test in Providers/MCP.
                    </span>
                  </div>

                  <div
                    style={{
                      'margin-top': '10px',
                      'font-size': 'var(--fs-2xs)',
                      color: 'var(--fg-faint)',
                      'line-height': '1.6',
                    }}
                  >
                    Per-agent overrides live in{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>agents.*.permissions</code>{' '}
                    (readonly / standard / elevated). MCP tools surface as{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>
                      mcp__&lt;server&gt;__*
                    </code>
                    .
                  </div>
                </div>
              </Show>

              {/* ── Connectors (MCP) ────────────────────────────────── */}
              <Show when={tab() === 'connectors'}>
                <div
                  id="settings-panel-connectors"
                  role="tabpanel"
                  aria-labelledby="settings-tab-connectors"
                >
                  <div class="settings-section-title">Connectors — MCP</div>
                  <div class="settings-hint" style={{ 'margin-bottom': '12px' }}>
                    Model Context Protocol servers. Toggle, test, or add via{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>PATCH /config</code> /{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>POST /mcp</code>.
                  </div>

                  <Show when={s().mcp.length === 0 && !s().loading}>
                    <div
                      style={{
                        padding: '14px',
                        border: '1px dashed var(--border-strong)',
                        'border-radius': 'var(--r-md)',
                        'text-align': 'center',
                        color: 'var(--fg-faint)',
                        'font-size': 'var(--fs-sm)',
                        'margin-bottom': '12px',
                      }}
                    >
                      No MCP servers connected. Add one below — local (stdio) or remote
                      (StreamableHTTP/SSE).
                    </div>
                  </Show>

                  <div
                    style={{
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '8px',
                      'margin-bottom': '16px',
                    }}
                  >
                    <For each={s().mcp}>
                      {(srv) => (
                        <div class="mcp-row">
                          <div
                            style={{
                              display: 'flex',
                              gap: '10px',
                              'align-items': 'center',
                              'min-width': '0',
                              flex: '1',
                            }}
                          >
                            <span
                              class="dot"
                              style={{
                                width: '8px',
                                height: '8px',
                                background:
                                  srv.status === 'connected'
                                    ? 'var(--ok)'
                                    : srv.status === 'disabled'
                                      ? 'var(--fg-faint)'
                                      : 'var(--danger)',
                                'box-shadow':
                                  srv.status === 'connected' ? '0 0 8px var(--ok-soft)' : 'none',
                              }}
                            />
                            <div
                              style={{
                                display: 'flex',
                                'flex-direction': 'column',
                                gap: '2px',
                                'min-width': '0',
                              }}
                            >
                              <span
                                style={{
                                  'font-size': 'var(--fs-sm)',
                                  'font-weight': '600',
                                  color: 'var(--fg)',
                                  'font-family': 'var(--font-mono)',
                                }}
                              >
                                {srv.name}
                              </span>
                              <span
                                style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)' }}
                              >
                                {srv.type} · {srv.toolCount} tools · {srv.status}
                                {srv.error ? ` · ${srv.error}` : ''}
                              </span>
                            </div>
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              gap: '6px',
                              'align-items': 'center',
                              'flex-shrink': '0',
                              'flex-wrap': 'wrap',
                              'justify-content': 'flex-end',
                            }}
                          >
                            <label
                              style={{
                                display: 'inline-flex',
                                'align-items': 'center',
                                gap: '6px',
                                'font-size': 'var(--fs-xs)',
                                color: 'var(--fg-muted)',
                                cursor: 'pointer',
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={srv.status !== 'disabled'}
                                onChange={(e) =>
                                  void handleToggleMcp(srv.name, e.currentTarget.checked)
                                }
                                aria-label={`Enable ${srv.name}`}
                              />
                              enabled
                            </label>
                            <button
                              type="button"
                              class="btn btn-outline"
                              disabled={mcpTesting() === srv.name}
                              aria-busy={mcpTesting() === srv.name ? 'true' : 'false'}
                              aria-label={`Test MCP server ${srv.name}`}
                              onClick={() => void handleTestMcp(srv.name)}
                              style={{
                                padding: '5px 10px',
                                'font-size': 'var(--fs-xs)',
                                'min-height': '28px',
                              }}
                            >
                              {mcpTesting() === srv.name ? 'Testing…' : 'Test'}
                            </button>
                            <button
                              type="button"
                              class="btn btn-ghost"
                              onClick={() => setConfirmRemoveMcp(srv.name)}
                              title={`Remove ${srv.name}`}
                              aria-label={`Remove MCP server ${srv.name}`}
                              style={{
                                padding: '5px 8px',
                                'font-size': 'var(--fs-xs)',
                                color: 'var(--danger)',
                                'min-height': '28px',
                              }}
                            >
                              Remove
                            </button>
                            <Show when={mcpResult()[srv.name]}>
                              <span
                                style={{
                                  'font-size': 'var(--fs-xs)',
                                  color: mcpResult()[srv.name].startsWith('✓')
                                    ? 'var(--ok)'
                                    : 'var(--danger)',
                                }}
                              >
                                {mcpResult()[srv.name]}
                              </span>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>

                  <form
                    onSubmit={handleAddMcp}
                    class="settings-card"
                    style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}
                  >
                    <div
                      style={{
                        'font-size': 'var(--fs-sm)',
                        'font-weight': '600',
                        color: 'var(--fg)',
                      }}
                    >
                      Add MCP server
                    </div>
                    <div
                      style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}
                    >
                      <div class="settings-field">
                        <label for="mcp-name" class="settings-label">
                          Name
                        </label>
                        <input
                          id="mcp-name"
                          class="input"
                          value={mcpName()}
                          onInput={(e) => setMcpName(e.currentTarget.value)}
                          placeholder="my-tools"
                          autocomplete="off"
                          spellcheck={false}
                        />
                      </div>
                      <div class="settings-field">
                        <label for="mcp-type" class="settings-label">
                          Type
                        </label>
                        <select
                          id="mcp-type"
                          class="input"
                          value={mcpType()}
                          onChange={(e) => setMcpType(e.currentTarget.value as 'local' | 'remote')}
                        >
                          <option value="local">local (stdio)</option>
                          <option value="remote">remote (http/sse)</option>
                        </select>
                      </div>
                    </div>
                    <Show
                      when={mcpType() === 'local'}
                      fallback={
                        <div class="settings-field">
                          <label for="mcp-url" class="settings-label">
                            URL
                          </label>
                          <input
                            id="mcp-url"
                            class="input"
                            value={mcpUrl()}
                            onInput={(e) => setMcpUrl(e.currentTarget.value)}
                            placeholder="https://mcp.example.com/mcp"
                            autocomplete="off"
                            spellcheck={false}
                          />
                        </div>
                      }
                    >
                      <div class="settings-field">
                        <label for="mcp-command" class="settings-label">
                          Command
                        </label>
                        <input
                          id="mcp-command"
                          class="input"
                          value={mcpCommand()}
                          onInput={(e) => setMcpCommand(e.currentTarget.value)}
                          placeholder="npx -y my-mcp-server"
                          autocomplete="off"
                          spellcheck={false}
                        />
                        <span class="settings-hint">
                          Spawned via stdio. Env vars with {'{env:VAR}'} are expanded server-side.
                        </span>
                      </div>
                    </Show>
                    <div
                      style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}
                    >
                      <div class="settings-field">
                        <label for="mcp-env" class="settings-label">
                          Env (mira parity)
                        </label>
                        <input
                          id="mcp-env"
                          class="input"
                          value={mcpEnv()}
                          onInput={(e) => setMcpEnv(e.currentTarget.value)}
                          placeholder='{"FOO":"bar"} or FOO=bar,BAZ=qux'
                          autocomplete="off"
                          spellcheck={false}
                        />
                        <span class="settings-hint">JSON or KEY=val, comma separated.</span>
                      </div>
                      <div class="settings-field">
                        <label for="mcp-headers" class="settings-label">
                          Headers (remote)
                        </label>
                        <input
                          id="mcp-headers"
                          class="input"
                          value={mcpHeaders()}
                          onInput={(e) => setMcpHeaders(e.currentTarget.value)}
                          placeholder='{"Authorization":"Bearer ..."}'
                          autocomplete="off"
                          spellcheck={false}
                        />
                        <span class="settings-hint">For remote StreamableHTTP/SSE.</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
                      <button
                        type="submit"
                        class="btn btn-solid"
                        disabled={!mcpName().trim() || props.store.saving()}
                        aria-busy={props.store.saving() ? 'true' : 'false'}
                        style={{
                          padding: '6px 12px',
                          'font-size': 'var(--fs-sm)',
                          'min-height': '32px',
                        }}
                      >
                        {props.store.saving() ? 'Saving…' : 'Add server'}
                      </button>
                    </div>
                  </form>
                </div>
              </Show>

              {/* ── Agents ──────────────────────────────────────────── */}
              <Show when={tab() === 'agents'}>
                <div
                  id="settings-panel-agents"
                  role="tabpanel"
                  aria-labelledby="settings-tab-agents"
                >
                  <div class="settings-section-title">Agents</div>
                  <div class="settings-hint" style={{ 'margin-bottom': '12px' }}>
                    Lane personas from{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>GET /agents</code> —
                    built-in + custom{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>mira.json → agents</code>.
                  </div>

                  <Show when={s().agents.length === 0 && !s().loading}>
                    <div
                      style={{
                        padding: '14px',
                        border: '1px dashed var(--border-strong)',
                        'border-radius': 'var(--r-md)',
                        'text-align': 'center',
                        color: 'var(--fg-faint)',
                        'font-size': 'var(--fs-sm)',
                      }}
                    >
                      No agents reported. Is the server running?
                    </div>
                  </Show>

                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                    <For each={s().agents}>
                      {(a) => (
                        <div class="settings-card" style={{ padding: '12px 14px' }}>
                          <div
                            style={{
                              display: 'flex',
                              'align-items': 'center',
                              gap: '8px',
                              'flex-wrap': 'wrap',
                            }}
                          >
                            <span
                              style={{
                                'font-size': 'var(--fs-sm)',
                                'font-weight': '700',
                                color: 'var(--fg)',
                                'font-family': 'var(--font-mono)',
                              }}
                            >
                              {a.name}
                            </span>
                            <span
                              class={`pill ${a.custom ? 'pill-accent' : ''}`}
                              style={{ 'font-size': 'var(--fs-2xs)' }}
                            >
                              {a.custom ? 'custom' : 'built-in'}
                            </span>
                            <span
                              class={`pill ${a.permissions === 'readonly' ? 'pill-ok' : a.permissions === 'elevated' ? 'pill-danger' : 'pill-warn'}`}
                              style={{ 'font-size': 'var(--fs-2xs)' }}
                            >
                              {a.permissions}
                            </span>
                            <button
                              type="button"
                              class="btn btn-outline"
                              disabled={agentPreview() === a.name}
                              aria-busy={agentPreview() === a.name ? 'true' : 'false'}
                              aria-label={`Test agent ${a.name}`}
                              onClick={() => void handlePreviewAgent(a.name)}
                              style={{
                                padding: '3px 8px',
                                'font-size': 'var(--fs-2xs)',
                                'margin-left': 'auto',
                                'min-height': '28px',
                              }}
                            >
                              {agentPreview() === a.name ? 'Testing…' : 'Test'}
                            </button>
                          </div>
                          <div
                            style={{
                              'font-size': 'var(--fs-sm)',
                              color: 'var(--fg-subtle)',
                              'margin-top': '6px',
                              'line-height': '1.5',
                            }}
                          >
                            {a.description || 'No description'}
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              'flex-wrap': 'wrap',
                              gap: '4px',
                              'margin-top': '8px',
                            }}
                          >
                            <For each={a.tools}>
                              {(tool) => (
                                <span
                                  style={{
                                    'font-family': 'var(--font-mono)',
                                    'font-size': 'var(--fs-2xs)',
                                    padding: '2px 7px',
                                    'border-radius': 'var(--r-full)',
                                    border: '1px solid var(--border)',
                                    background: 'var(--bg-app)',
                                    color: 'var(--fg-muted)',
                                  }}
                                >
                                  {tool}
                                </span>
                              )}
                            </For>
                          </div>
                          <Show when={agentPreviewResult()[a.name]}>
                            <div
                              style={{
                                'margin-top': '8px',
                                padding: '6px 8px',
                                'border-radius': 'var(--r-md)',
                                background: 'var(--bg-app)',
                                border: '1px solid var(--border)',
                                'font-size': 'var(--fs-xs)',
                                'font-family': 'var(--font-mono)',
                                color: agentPreviewResult()[a.name].startsWith('✓')
                                  ? 'var(--ok)'
                                  : 'var(--danger)',
                                'word-break': 'break-word',
                              }}
                            >
                              {agentPreviewResult()[a.name]}
                            </div>
                          </Show>
                          <div
                            style={{
                              'margin-top': '6px',
                              'font-size': 'var(--fs-2xs)',
                              color: 'var(--fg-faint)',
                            }}
                          >
                            Lane contract: filterToolsForAgent("{a.name}") — Test shows
                            allowed/blocked via GET /agents/{a.name}/preview (like Test in
                            Providers/MCP).
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              {/* ── Commands ────────────────────────────────────────── */}
              <Show when={tab() === 'commands'}>
                <div
                  id="settings-panel-commands"
                  role="tabpanel"
                  aria-labelledby="settings-tab-commands"
                >
                  <div class="settings-section-title">Commands & Skills</div>
                  <div class="settings-hint" style={{ 'margin-bottom': '12px' }}>
                    Slash commands from{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>.mira/commands/*.md</code>{' '}
                    via <code style={{ 'font-family': 'var(--font-mono)' }}>GET /commands</code> +
                    skills from{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>GET /skills</code>. Type{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>/</code> in the composer or
                    press <span class="kbd">Ctrl+P</span> to fuzzy-search.
                  </div>

                  <Show when={s().commands.length === 0 && s().skills.length === 0 && !s().loading}>
                    <div
                      style={{
                        padding: '14px',
                        border: '1px dashed var(--border-strong)',
                        'border-radius': 'var(--r-md)',
                        'text-align': 'center',
                        color: 'var(--fg-faint)',
                        'font-size': 'var(--fs-sm)',
                      }}
                    >
                      No commands or skills found. Add markdown files to{' '}
                      <code style={{ 'font-family': 'var(--font-mono)' }}>.mira/commands/</code> or{' '}
                      <code style={{ 'font-family': 'var(--font-mono)' }}>
                        packages/server/data/skills/
                      </code>
                      .
                    </div>
                  </Show>

                  <Show when={s().commands.length > 0}>
                    <div
                      style={{
                        'font-size': 'var(--fs-xs)',
                        'font-weight': '700',
                        color: 'var(--fg-muted)',
                        'letter-spacing': '0.04em',
                        'text-transform': 'uppercase',
                        'margin-bottom': '8px',
                      }}
                    >
                      Slash commands · {s().commands.length}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        'flex-direction': 'column',
                        gap: '6px',
                        'margin-bottom': '16px',
                      }}
                    >
                      <For each={s().commands}>
                        {(c) => (
                          <div
                            class="settings-card"
                            style={{
                              padding: '10px 12px',
                              display: 'flex',
                              'justify-content': 'space-between',
                              gap: '12px',
                              'align-items': 'center',
                            }}
                          >
                            <div>
                              <div
                                style={{
                                  'font-family': 'var(--font-mono)',
                                  'font-size': 'var(--fs-sm)',
                                  'font-weight': '600',
                                  color: 'var(--fg)',
                                }}
                              >
                                {c.name}
                              </div>
                              <div
                                style={{
                                  'font-size': 'var(--fs-xs)',
                                  color: 'var(--fg-subtle)',
                                  'margin-top': '2px',
                                }}
                              >
                                {c.description || 'No description'}
                              </div>
                            </div>
                            <span
                              class="pill"
                              style={{ 'font-size': 'var(--fs-2xs)', 'flex-shrink': '0' }}
                            >
                              {c.source}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={s().skills.length > 0}>
                    <div
                      style={{
                        'font-size': 'var(--fs-xs)',
                        'font-weight': '700',
                        color: 'var(--fg-muted)',
                        'letter-spacing': '0.04em',
                        'text-transform': 'uppercase',
                        'margin-bottom': '8px',
                      }}
                    >
                      Skills · {s().skills.length}
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                      <For each={s().skills}>
                        {(sk) => (
                          <div class="settings-card" style={{ padding: '10px 12px' }}>
                            <div
                              style={{
                                'font-family': 'var(--font-mono)',
                                'font-size': 'var(--fs-sm)',
                                'font-weight': '600',
                                color: 'var(--fg)',
                              }}
                            >
                              {sk.name}
                            </div>
                            <div
                              style={{
                                'font-size': 'var(--fs-xs)',
                                color: 'var(--fg-subtle)',
                                'margin-top': '2px',
                                'line-height': '1.45',
                              }}
                            >
                              {sk.description || 'No description'}
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* ── Terminal ────────────────────────────────────────── */}
              <Show when={tab() === 'terminal'}>
                <div
                  id="settings-panel-terminal"
                  role="tabpanel"
                  aria-labelledby="settings-tab-terminal"
                >
                  <div class="settings-section-title">Terminal — PTY</div>
                  <div class="settings-hint" style={{ 'margin-bottom': '12px' }}>
                    Interactive shell via{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>WS /terminal</code>. Toggle
                    + sandbox allowlist apply live from mira.json;{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>
                      MIRA_TERMINAL_ENABLED=0
                    </code>{' '}
                    hard-disables (env wins).
                  </div>
                  <form
                    onSubmit={handleSaveTerminal}
                    style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}
                  >
                    <div
                      class="settings-card"
                      style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}
                    >
                      <label
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '8px',
                          'font-size': 'var(--fs-sm)',
                          color: 'var(--fg)',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={termEnabled()}
                          onChange={(e) => setTermEnabled(e.currentTarget.checked)}
                        />
                        Enabled
                      </label>
                      <label
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '8px',
                          'font-size': 'var(--fs-sm)',
                          color: 'var(--fg)',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={termSandbox()}
                          onChange={(e) => setTermSandbox(e.currentTarget.checked)}
                        />
                        Sandbox (allowlist)
                      </label>
                      <div class="settings-field">
                        <label for="settings-term-allowed" class="settings-label">
                          Allowed commands
                        </label>
                        <input
                          id="settings-term-allowed"
                          class="input"
                          value={termAllowed()}
                          onInput={(e) => setTermAllowed(e.currentTarget.value)}
                          placeholder="bash, ls, cat, git, bun, node, tsc, echo, pwd"
                          autocomplete="off"
                          spellcheck={false}
                        />
                        <span class="settings-hint">
                          Comma separated. When sandbox on, first token must be in this list.
                        </span>
                      </div>
                      <div class="settings-field">
                        <label for="settings-term-timeout" class="settings-label">
                          Timeout ms
                        </label>
                        <input
                          id="settings-term-timeout"
                          class="input"
                          type="number"
                          min="1000"
                          value={termTimeout()}
                          onInput={(e) => setTermTimeout(e.currentTarget.value)}
                          placeholder="30000"
                          autocomplete="off"
                        />
                        <span class="settings-hint">Kill after this long.</span>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                        <button
                          type="button"
                          class="btn btn-outline"
                          disabled={termTesting()}
                          aria-busy={termTesting() ? 'true' : 'false'}
                          aria-label="Test terminal connection"
                          onClick={() => void handleTestTerminal()}
                          style={{
                            padding: '6px 12px',
                            'font-size': 'var(--fs-sm)',
                            'min-height': '32px',
                          }}
                        >
                          {termTesting() ? 'Testing…' : 'Test terminal'}
                        </button>
                        <Show when={termResult()}>
                          <span
                            style={{
                              'font-size': 'var(--fs-xs)',
                              color: termResult().startsWith('✓') ? 'var(--ok)' : 'var(--danger)',
                            }}
                          >
                            {termResult()}
                          </span>
                        </Show>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
                      <button
                        type="submit"
                        class="btn btn-solid"
                        disabled={terminalSaving() || props.store.saving()}
                        aria-busy={terminalSaving() || props.store.saving() ? 'true' : 'false'}
                        style={{
                          padding: '7px 14px',
                          'font-size': 'var(--fs-sm)',
                          'min-height': '32px',
                          gap: '6px',
                        }}
                      >
                        <Show when={terminalSaving() || props.store.saving()} fallback={null}>
                          <span class="spinner" aria-hidden="true" />
                        </Show>
                        {terminalSaving() || props.store.saving() ? 'Saving…' : 'Save terminal'}
                      </button>
                    </div>
                  </form>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={() => confirmRemoveProvider() !== null}
        title="Remove provider?"
        message={
          confirmRemoveProvider()
            ? `This will permanently remove the provider "${confirmRemoveProvider()!}" and its API key from mira.json. This cannot be undone.`
            : ''
        }
        confirmLabel="Remove"
        danger
        onConfirm={async () => {
          const id = confirmRemoveProvider()
          setConfirmRemoveProvider(null)
          if (id) {
            const ok = await props.store.removeProvider(id)
            if (ok) {
              await props.store.loadProviders()
              toast.success(`Provider "${id}" removed`)
            }
          }
        }}
        onCancel={() => setConfirmRemoveProvider(null)}
      />
      <ConfirmDialog
        open={() => confirmRemovePermission() !== null}
        title="Remove permission?"
        message={
          confirmRemovePermission()
            ? `Remove permission "${confirmRemovePermission()!.tool}${confirmRemovePermission()!.pattern ? ':' + confirmRemovePermission()!.pattern : ''}"? This will revert to default policy.`
            : ''
        }
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          const p = confirmRemovePermission()
          if (p) void performRemovePermission(p.tool, p.pattern)
        }}
        onCancel={() => setConfirmRemovePermission(null)}
      />
      <ConfirmDialog
        open={() => confirmRemoveMcp() !== null}
        title="Remove MCP server?"
        message={
          confirmRemoveMcp()
            ? `This will permanently remove the MCP server "${confirmRemoveMcp()!}" from mira.json. This cannot be undone.`
            : ''
        }
        confirmLabel="Remove"
        danger
        onConfirm={async () => {
          const name = confirmRemoveMcp()
          setConfirmRemoveMcp(null)
          if (name) {
            const ok = await props.store.removeMcp(name)
            if (ok) toast.success(`MCP server "${name}" removed`)
            else toast.error(props.store.state.error ?? 'Failed to remove MCP server')
          }
        }}
        onCancel={() => setConfirmRemoveMcp(null)}
      />
    </Show>
  )
}
