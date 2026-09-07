import { createSignal, createEffect, For, Show, onCleanup } from 'solid-js'
import type { SettingsStore } from '../stores/settings'
import { toast } from './Toast'
import { useFocusTrap } from '../hooks/useFocusTrap'

type ProviderPreset = {
  id: string
  label: string
  desc: string
  baseURL: string
  placeholder: string
}

const PRESETS: ProviderPreset[] = [
  { id: 'openrouter', label: 'OpenRouter', desc: 'Unified API — Claude, GPT, Gemini, DeepSeek', baseURL: 'https://openrouter.ai/api/v1', placeholder: 'sk-or-v1-…' },
  { id: 'anthropic', label: 'Anthropic', desc: 'Claude direct', baseURL: 'https://api.anthropic.com', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', desc: 'GPT-4o, o1, etc.', baseURL: 'https://api.openai.com/v1', placeholder: 'sk-…' },
  { id: 'google', label: 'Google', desc: 'Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', placeholder: 'AIza…' },
  { id: 'deepseek', label: 'DeepSeek', desc: 'DeepSeek Chat / Reasoner', baseURL: 'https://api.deepseek.com', placeholder: 'sk-…' },
  { id: 'nvidia', label: 'NVIDIA', desc: 'NIM API', baseURL: 'https://integrate.api.nvidia.com/v1', placeholder: 'nvapi-…' },
  { id: 'custom', label: 'Custom', desc: 'Any OpenAI-compatible endpoint', baseURL: '', placeholder: 'sk-…' },
]

function findPreset(id: string): ProviderPreset | undefined {
  const low = id.toLowerCase().trim()
  return PRESETS.find((p) => p.id === low)
}

export function ConnectModal(props: {
  open: boolean
  onClose: () => void
  initialProvider?: string
  settings: SettingsStore
}) {
  const [step, setStep] = createSignal<'pick' | 'key'>('pick')
  const [selected, setSelected] = createSignal<ProviderPreset | null>(null)
  const [customId, setCustomId] = createSignal('')
  const [apiKey, setApiKey] = createSignal('')
  const [baseURL, setBaseURL] = createSignal('')
  const [saving, setSaving] = createSignal(false)
  const [showKey, setShowKey] = createSignal(false)

  let dialogRef!: HTMLDivElement
  let titleRef!: HTMLDivElement
  let previouslyFocused: HTMLElement | null = null

  // Init from initialProvider
  createEffect(() => {
    if (!props.open) return
    const init = props.initialProvider?.trim().toLowerCase() ?? ''
    if (init) {
      const preset = findPreset(init)
      if (preset) {
        if (preset.id === 'custom') {
          setSelected(preset)
          setCustomId('')
          setBaseURL('')
          setStep('key')
        } else {
          setSelected(preset)
          setBaseURL(preset.baseURL)
          setStep('key')
        }
      } else {
        // unknown provider → treat as custom with that id
        const custom = PRESETS.find((p) => p.id === 'custom')!
        setSelected(custom)
        setCustomId(init)
        setBaseURL('')
        setStep('key')
      }
    } else {
      setStep('pick')
      setSelected(null)
      setCustomId('')
      setApiKey('')
      setBaseURL('')
    }
    setApiKey('')
    setShowKey(false)
  })

  // Focus trap
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
        queueMicrotask(() => previouslyFocused?.focus())
      })
    }
  })

  const pickProvider = (preset: ProviderPreset) => {
    setSelected(preset)
    if (preset.id === 'custom') {
      setBaseURL('')
    } else {
      setBaseURL(preset.baseURL)
    }
    setApiKey('')
    setStep('key')
  }

  const handleSave = async (e?: Event) => {
    e?.preventDefault()
    const preset = selected()
    if (!preset) return
    const isCustom = preset.id === 'custom'
    const id = isCustom ? customId().trim().toLowerCase() : preset.id
    const key = apiKey().trim()
    if (!id) {
      toast.error('Provider id is required')
      return
    }
    if (!/^[a-z0-9_-]+$/i.test(id)) {
      toast.error('Provider id must be alphanumeric, dash or underscore')
      return
    }
    if (!key) {
      toast.error('API key is required')
      return
    }
    const urlTrimmed = baseURL().trim()
    if (urlTrimmed) {
      try {
        const u = new URL(urlTrimmed)
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad')
      } catch {
        toast.error('Base URL must be a valid http(s) URL')
        return
      }
    }
    setSaving(true)
    try {
      const cfg = props.settings.state.config
      const existingProvider = (cfg?.provider ?? {}) as Record<string, unknown>
      const patch = {
        provider: {
          ...existingProvider,
          [id]: {
            npm: '@ai-sdk/openai-compatible',
            name: id,
            options: { baseURL: urlTrimmed || preset.baseURL || 'https://api.openai.com/v1', apiKey: key },
            models: {},
          },
        },
      }
      const res = await props.settings.saveConfig(patch as never)
      if (res) {
        await props.settings.loadProviders()
        toast.success(`Connected to ${id} ✓`)
        props.onClose()
      } else {
        toast.error(props.settings.state.error ?? 'Failed to save provider')
      }
    } finally {
      setSaving(false)
    }
  }

  const providerId = () => {
    const s = selected()
    if (!s) return ''
    if (s.id === 'custom') return customId().trim() || 'custom'
    return s.id
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
          class="modal modal-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Connect provider"
          onClick={(e) => e.stopPropagation()}
          style={{ width: 'min(480px, 96vw)', 'max-height': 'min(78vh, 560px)' }}
        >
          <div class="modal-header">
            <div
              ref={(el) => (titleRef = el)}
              class="modal-title"
              tabIndex={-1}
              style={{ outline: 'none' }}
            >
              {step() === 'pick' ? 'Connect provider' : `Connect ${selected()?.label ?? providerId()}`}
            </div>
            <button type="button" class="modal-close" onClick={() => props.onClose()} aria-label="Close">
              ✕
            </button>
          </div>

          <div class="scroll" style={{ padding: '16px', display: 'flex', 'flex-direction': 'column', gap: '14px', overflow: 'auto' }}>
            <Show
              when={step() === 'pick'}
              fallback={
                <form
                  onSubmit={handleSave}
                  style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}
                >
                  <Show when={selected()?.id === 'custom'}>
                    <div class="settings-field">
                      <label for="connect-custom-id" class="settings-label">
                        Provider ID
                      </label>
                      <input
                        id="connect-custom-id"
                        class="input"
                        value={customId()}
                        onInput={(e) => setCustomId(e.currentTarget.value)}
                        placeholder="my-provider"
                        spellcheck={false}
                        autocomplete="off"
                      />
                      <span class="settings-hint">Lowercase, alphanumeric + dash/underscore. Used as provider/model prefix.</span>
                    </div>
                  </Show>

                  <div class="settings-field">
                    <label for="connect-api-key" class="settings-label">
                      API key
                    </label>
                    <div style={{ position: 'relative', display: 'flex', 'align-items': 'center' }}>
                      <input
                        id="connect-api-key"
                        class="input"
                        type={showKey() ? 'text' : 'password'}
                        value={apiKey()}
                        onInput={(e) => setApiKey(e.currentTarget.value)}
                        placeholder={selected()?.placeholder ?? 'sk-…'}
                        spellcheck={false}
                        autocomplete="off"
                        style={{ 'padding-right': '64px' }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey(!showKey())}
                        aria-label={showKey() ? 'Hide API key' : 'Show API key'}
                        style={{
                          position: 'absolute',
                          right: '6px',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          padding: '4px 8px',
                          'font-size': 'var(--fs-xs)',
                          border: '1px solid var(--border)',
                          'border-radius': 'var(--r-sm)',
                          background: 'var(--bg-surface)',
                          color: 'var(--fg-subtle)',
                          cursor: 'pointer',
                        }}
                      >
                        {showKey() ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <span class="settings-hint">Stored via PATCH /config → provider.{providerId()}.options.apiKey. Never logged.</span>
                  </div>

                  <div class="settings-field">
                    <label for="connect-base-url" class="settings-label">
                      Base URL <span style={{ 'font-weight': '400', color: 'var(--fg-faint)' }}>(optional)</span>
                    </label>
                    <input
                      id="connect-base-url"
                      class="input"
                      type="url"
                      value={baseURL()}
                      onInput={(e) => setBaseURL(e.currentTarget.value)}
                      placeholder={selected()?.baseURL || 'https://api.openai.com/v1'}
                      spellcheck={false}
                      autocomplete="off"
                    />
                    <span class="settings-hint">Override for proxies or custom endpoints. Leave blank for default.</span>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', 'justify-content': 'space-between', 'align-items': 'center', 'margin-top': '4px' }}>
                    <button type="button" class="btn btn-ghost" onClick={() => setStep('pick')} style={{ padding: '7px 12px', 'font-size': 'var(--fs-sm)', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)' }}>
                      ← Back
                    </button>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button type="button" class="btn btn-ghost" onClick={() => props.onClose()} style={{ padding: '7px 12px', 'font-size': 'var(--fs-sm)' }}>
                        Cancel
                      </button>
                      <button type="submit" class="btn btn-solid" disabled={saving() || !apiKey().trim()} style={{ padding: '7px 14px', 'font-size': 'var(--fs-sm)', opacity: saving() ? '0.7' : '1' }}>
                        {saving() ? 'Saving…' : 'Connect →'}
                      </button>
                    </div>
                  </div>
                </form>
              }
            >
              <div style={{ 'font-size': 'var(--fs-sm)', color: 'var(--fg-muted)', 'line-height': '1.5' }}>
                Pick a provider to add its API key. Keys are saved to your Mira server via <code style={{ 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-xs)' }}>PATCH /config</code>.
              </div>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                <For each={PRESETS}>
                  {(preset) => (
                    <button
                      type="button"
                      onClick={() => pickProvider(preset)}
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: '10px',
                        padding: '10px 12px',
                        'border-radius': 'var(--r-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-surface)',
                        cursor: 'pointer',
                        'text-align': 'left',
                        width: '100%',
                        transition: 'border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-border)')}
                      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
                    >
                      <span
                        style={{
                          width: '32px',
                          height: '32px',
                          display: 'grid',
                          'place-items': 'center',
                          'border-radius': 'var(--r-sm)',
                          background: 'var(--bg-app)',
                          border: '1px solid var(--border)',
                          'font-size': '14px',
                          flex: 'none',
                        }}
                      >
                        {preset.id === 'openrouter' ? '◈' : preset.id === 'anthropic' ? '✦' : preset.id === 'openai' ? '○' : preset.id === 'google' ? '◎' : preset.id === 'deepseek' ? '⬢' : preset.id === 'nvidia' ? '⬣' : '＋'}
                      </span>
                      <span style={{ display: 'flex', 'flex-direction': 'column', gap: '2px', 'min-width': '0', flex: '1' }}>
                        <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', color: 'var(--fg)' }}>{preset.label}</span>
                        <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{preset.desc}</span>
                      </span>
                      <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-faint)', flex: 'none' }}>→</span>
                    </button>
                  )}
                </For>
              </div>
              <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'text-align': 'center' }}>
                Tip: type <code style={{ 'font-family': 'var(--font-mono)' }}>/connect openai</code> to jump straight to a provider.
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
