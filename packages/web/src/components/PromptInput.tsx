// @ts-nocheck
import { For, Show, createSignal, createEffect, createMemo, onCleanup, onMount } from 'solid-js'
import type { SettingsStore } from '../stores/settings'
import { filterCommands } from './CommandPalette'
import type { CommandEntry } from '../api/client'
import { providerModelId, api } from '../api/client'
import { toast } from './Toast'

// ── File pill ────────────────────────────────────────────────────────

export type FilePill = { path: string }

function FilePillChip(props: { pill: FilePill; onRemove: () => void }) {
  return (
    <span
      data-slot="file-pill"
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '4px',
        padding: '2px 8px',
        'border-radius': 'var(--r-full)',
        background: 'var(--accent-soft)',
        border: '1px solid var(--accent-border)',
        color: 'var(--accent)',
        'font-size': 'var(--fs-xs)',
        'font-family': 'var(--font-mono)',
        'font-weight': '500',
        'max-width': '180px',
      }}
    >
      <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>
        @{props.pill.path}
      </span>
      <button
        type="button"
        onClick={props.onRemove}
        aria-label={`Remove ${props.pill.path}`}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'inherit',
          'font-size': '11px',
          padding: '0 2px',
          'line-height': '1',
        }}
      >
        ✕
      </button>
    </span>
  )
}

// ── @ mention autocomplete ───────────────────────────────────────────

function filterFiles(query: string, files: string[]): string[] {
  const q = query.toLowerCase().trim()
  if (!q) return files.slice(0, 8)
  return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8)
}

function AtMentionAutocomplete(props: {
  query: string
  files: string[]
  selected: number
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const filtered = createMemo(() => filterFiles(props.query, props.files))
  return (
    <Show when={filtered().length > 0}>
      <div
        data-slot="at-autocomplete"
        role="listbox"
        aria-label="File suggestions"
        style={{
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          left: '0',
          right: '0',
          background: 'var(--bg-canvas)',
          border: '1px solid var(--border-strong)',
          'border-radius': 'var(--r-md)',
          'box-shadow': 'var(--shadow-pop)',
          overflow: 'hidden',
          'z-index': '10',
          'max-height': '200px',
          display: 'flex',
          'flex-direction': 'column',
        }}
      >
        <div
          style={{
            padding: '6px 10px',
            'font-size': 'var(--fs-2xs)',
            color: 'var(--fg-faint)',
            'font-weight': '600',
            'letter-spacing': '0.04em',
            'text-transform': 'uppercase',
            'border-bottom': '1px solid var(--border)',
          }}
        >
          Files · @{props.query || '…'}
        </div>
        <div
          style={{
            overflow: 'auto',
            padding: '4px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '2px',
          }}
        >
          <For each={filtered()}>
            {(file, i) => (
              <button
                type="button"
                role="option"
                aria-selected={props.selected === i() ? 'true' : 'false'}
                onClick={() => props.onSelect(file)}
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '8px',
                  padding: '6px 9px',
                  'border-radius': 'var(--r-sm)',
                  border: '1px solid transparent',
                  background: props.selected === i() ? 'var(--accent-soft)' : 'transparent',
                  'border-color': props.selected === i() ? 'var(--accent-border)' : 'transparent',
                  color: 'var(--fg)',
                  'font-size': 'var(--fs-sm)',
                  'font-family': 'var(--font-mono)',
                  cursor: 'pointer',
                  width: '100%',
                  'text-align': 'left',
                }}
              >
                <span style={{ 'font-size': '11px', color: 'var(--fg-faint)' }}>📄</span>
                <span
                  style={{
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                  }}
                >
                  {file}
                </span>
              </button>
            )}
          </For>
        </div>
        <div
          style={{
            padding: '6px 10px',
            'border-top': '1px solid var(--border)',
            'font-size': 'var(--fs-2xs)',
            color: 'var(--fg-faint)',
            display: 'flex',
            gap: '6px',
          }}
        >
          <span>
            <span class="kbd">↑↓</span> nav
          </span>
          <span>·</span>
          <span>
            <span class="kbd">Tab</span> select
          </span>
          <span>·</span>
          <span>
            <span class="kbd">Esc</span> close
          </span>
        </div>
      </div>
    </Show>
  )
}

// ── Model selector ───────────────────────────────────────────────────

function ModelSelector(props: {
  settings?: SettingsStore
  value?: string
  onSelect?: (model: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [search, setSearch] = createSignal('')
  let containerRef: HTMLDivElement | undefined

  const providers = () => props.settings?.state.providers ?? []
  const configModel = () => props.settings?.state.config?.model ?? ''

  // Flatten models grouped by provider
  const grouped = createMemo(() => {
    const q = search().toLowerCase().trim()
    const groups: Array<{ provider: string; models: string[] }> = []
    for (const p of providers()) {
      const models = (p.models ?? [])
        .map(providerModelId)
        .filter((m) => !q || m.toLowerCase().includes(q))
      if (models.length > 0) groups.push({ provider: p.name || p.id, models })
    }
    // Also include config model if not in any provider
    if (configModel() && !groups.some((g) => g.models.includes(configModel()))) {
      const match = !q || configModel().toLowerCase().includes(q)
      if (match) groups.unshift({ provider: 'configured', models: [configModel()] })
    }
    return groups
  })

  const currentLabel = () => props.value || configModel() || 'auto'

  createEffect(() => {
    if (!open()) return
    const onDown = (e: MouseEvent) => {
      if (!containerRef?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    onCleanup(() => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    })
  })

  return (
    <div ref={containerRef} data-slot="model-selector" style={{ position: 'relative' }}>
      <button
        type="button"
        data-slot="model-selector-trigger"
        onClick={() => setOpen(!open())}
        aria-expanded={open() ? 'true' : 'false'}
        aria-haspopup="listbox"
        title="Select model"
        style={{
          display: 'inline-flex',
          'align-items': 'center',
          gap: '6px',
          padding: '4px 8px',
          'font-size': 'var(--fs-xs)',
          border: '1px solid var(--border)',
          'border-radius': 'var(--r-md)',
          background: open() ? 'var(--bg-active)' : 'var(--bg-surface)',
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          'font-family': 'var(--font-mono)',
          'max-width': '200px',
        }}
      >
        <span style={{ 'font-size': '10px', color: 'var(--accent)' }}>◈</span>
        <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>
          {currentLabel()}
        </span>
        <span
          style={{
            'font-size': '9px',
            color: 'var(--fg-faint)',
            transform: open() ? 'rotate(180deg)' : 'none',
            transition: 'transform var(--dur-fast) var(--ease)',
          }}
        >
          ▾
        </span>
      </button>
      <Show when={open()}>
        <div
          data-slot="model-selector-dropdown"
          role="listbox"
          aria-label="Select model"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: '0',
            'min-width': '280px',
            'max-width': '360px',
            background: 'var(--bg-canvas)',
            border: '1px solid var(--border-strong)',
            'border-radius': 'var(--r-md)',
            'box-shadow': 'var(--shadow-pop)',
            overflow: 'hidden',
            'z-index': '20',
            display: 'flex',
            'flex-direction': 'column',
            'max-height': '320px',
          }}
        >
          <div style={{ padding: '8px', 'border-bottom': '1px solid var(--border)' }}>
            <input
              type="search"
              placeholder="Search models…"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              aria-label="Search models"
              style={{
                width: '100%',
                padding: '6px 8px',
                'font-size': 'var(--fs-sm)',
                border: '1px solid var(--border)',
                'border-radius': 'var(--r-sm)',
                background: 'var(--bg-app)',
                color: 'var(--fg)',
                outline: 'none',
              }}
            />
          </div>
          <div
            style={{
              overflow: 'auto',
              padding: '4px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '4px',
            }}
          >
            <Show
              when={grouped().length > 0}
              fallback={
                <div
                  style={{
                    padding: '12px',
                    'text-align': 'center',
                    'font-size': 'var(--fs-sm)',
                    color: 'var(--fg-faint)',
                  }}
                >
                  No models found
                </div>
              }
            >
              <For each={grouped()}>
                {(group) => (
                  <div>
                    <div
                      style={{
                        padding: '4px 8px',
                        'font-size': 'var(--fs-2xs)',
                        'font-weight': '700',
                        color: 'var(--fg-faint)',
                        'letter-spacing': '0.04em',
                        'text-transform': 'uppercase',
                      }}
                    >
                      {group.provider}
                    </div>
                    <For each={group.models}>
                      {(model) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={currentLabel() === model ? 'true' : 'false'}
                          onClick={() => {
                            props.onSelect?.(model)
                            setOpen(false)
                          }}
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '8px',
                            width: '100%',
                            padding: '6px 8px',
                            'border-radius': 'var(--r-sm)',
                            border: '1px solid transparent',
                            background:
                              currentLabel() === model ? 'var(--accent-soft)' : 'transparent',
                            'border-color':
                              currentLabel() === model ? 'var(--accent-border)' : 'transparent',
                            color: currentLabel() === model ? 'var(--accent)' : 'var(--fg)',
                            'font-size': 'var(--fs-sm)',
                            'font-family': 'var(--font-mono)',
                            cursor: 'pointer',
                            'text-align': 'left',
                          }}
                        >
                          <span
                            style={{
                              flex: '1',
                              overflow: 'hidden',
                              'text-overflow': 'ellipsis',
                              'white-space': 'nowrap',
                            }}
                          >
                            {model}
                          </span>
                          <Show when={currentLabel() === model}>
                            <span style={{ 'font-size': '10px', color: 'var(--accent)' }}>✓</span>
                          </Show>
                          <span
                            style={{
                              'font-size': 'var(--fs-2xs)',
                              padding: '1px 5px',
                              'border-radius': 'var(--r-full)',
                              background: 'var(--bg-surface)',
                              border: '1px solid var(--border)',
                              color: 'var(--fg-faint)',
                              flex: 'none',
                            }}
                          >
                            {model.includes('sonnet') || model.includes('opus')
                              ? 'reasoning'
                              : model.includes('haiku')
                                ? 'fast'
                                : 'general'}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

// ── Agent selector ────────────────────────────────────────────────────

function AgentSelector(props: {
  value?: string
  onSelect?: (agent: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  let containerRef: HTMLDivElement | undefined

  const lanes = [
    { id: 'general', label: 'general', icon: '◈', desc: 'General Partner' },
    { id: 'code', label: 'code', icon: '⌨', desc: 'Coding & Implementation' },
    { id: 'ask', label: 'ask', icon: '?', desc: 'Q&A & Explanations' },
    { id: 'plan', label: 'plan', icon: '▤', desc: 'Architecture & Planning' },
    { id: 'explorer', label: 'explorer', icon: '⌕', desc: 'Search & Discovery' },
    { id: 'fixer', label: 'fixer', icon: '⚒', desc: 'Bug & Error Fixing' },
    { id: 'review', label: 'review', icon: '◎', desc: 'Code Review' },
    { id: 'debug', label: 'debug', icon: '◷', desc: 'Deep Diagnostics' },
    { id: 'architect', label: 'architect', icon: '⬢', desc: 'System Design' },
    { id: 'security', label: 'security', icon: '⬣', desc: 'Security & Audit' },
  ]

  const currentLane = () => lanes.find((l) => l.id === (props.value || 'general')) ?? lanes[0]

  createEffect(() => {
    if (!open()) return
    const onDown = (e: MouseEvent) => {
      if (!containerRef?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    onCleanup(() => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    })
  })

  return (
    <div ref={containerRef} data-slot="agent-selector" style={{ position: 'relative' }}>
      <button
        type="button"
        data-slot="agent-selector-trigger"
        onClick={() => setOpen(!open())}
        aria-expanded={open() ? 'true' : 'false'}
        aria-haspopup="listbox"
        title="Select agent lane"
        style={{
          display: 'inline-flex',
          'align-items': 'center',
          gap: '6px',
          padding: '4px 8px',
          'font-size': 'var(--fs-xs)',
          border: '1px solid var(--border)',
          'border-radius': 'var(--r-md)',
          background: open() ? 'var(--bg-active)' : 'var(--bg-surface)',
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          'font-family': 'var(--font-mono)',
        }}
      >
        <span style={{ 'font-size': '11px' }}>{currentLane().icon}</span>
        <span>{currentLane().label}</span>
        <span style={{ 'font-size': '9px', color: 'var(--fg-faint)' }}>▾</span>
      </button>
      <Show when={open()}>
        <div
          data-slot="agent-selector-dropdown"
          role="listbox"
          aria-label="Select agent lane"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: '0',
            width: '220px',
            background: 'var(--bg-canvas)',
            border: '1px solid var(--border-strong)',
            'border-radius': 'var(--r-md)',
            'box-shadow': 'var(--shadow-pop)',
            overflow: 'hidden',
            'z-index': '20',
            display: 'flex',
            'flex-direction': 'column',
            padding: '4px',
            gap: '2px',
          }}
        >
          <For each={lanes}>
            {(lane) => (
              <button
                type="button"
                role="option"
                aria-selected={currentLane().id === lane.id ? 'true' : 'false'}
                onClick={() => {
                  props.onSelect?.(lane.id)
                  setOpen(false)
                }}
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '6px 8px',
                  'border-radius': 'var(--r-sm)',
                  border: '1px solid transparent',
                  background: currentLane().id === lane.id ? 'var(--accent-soft)' : 'transparent',
                  color: currentLane().id === lane.id ? 'var(--accent)' : 'var(--fg)',
                  'font-size': 'var(--fs-xs)',
                  'font-family': 'var(--font-mono)',
                  cursor: 'pointer',
                  'text-align': 'left',
                }}
              >
                <span>{lane.icon}</span>
                <div style={{ display: 'flex', 'flex-direction': 'column', flex: '1', 'min-width': '0' }}>
                  <span style={{ 'font-weight': '600' }}>{lane.label}</span>
                  <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-subtle)' }}>{lane.desc}</span>
                </div>
                <Show when={currentLane().id === lane.id}>
                  <span style={{ 'font-size': '10px', color: 'var(--accent)' }}>✓</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

// ── PromptInput ──────────────────────────────────────────────────────

export function PromptInput(props: {
  value: string
  onInput: (value: string) => void
  onSubmit: () => void
  onQueue?: () => void
  onStop?: () => void
  streaming?: boolean
  disabled?: boolean
  placeholder?: string
  settings?: SettingsStore
  slashCommands?: CommandEntry[]
  selectedModel?: string
  onModelSelect?: (model: string) => void
  selectedAgent?: string
  onAgentSelect?: (agent: string) => void
  filePills?: FilePill[]
  onRemovePill?: (index: number) => void
  onAddPill?: (path: string) => void
  cwd?: string | null
  researchMode?: 'off' | 'quick-grounded' | 'deep-investigation'
  onResearchModeChange?: (mode: 'off' | 'quick-grounded' | 'deep-investigation') => void
}) {
  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let audioFileInputRef: HTMLInputElement | undefined
  const [isListening, setIsListening] = createSignal(false)
  const [isTranscribing, setIsTranscribing] = createSignal(false)
  const [voiceAvailable, setVoiceAvailable] = createSignal(false)
  let speechRec: any = null
  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let audioChunks: BlobPart[] = []
  let speechBaseText = ''
  let audioCtx: AudioContext | null = null
  let silenceMonitorTimer: number | undefined
  let peakLevel = 0
  let silenceSampleCount = 0

  onMount(() => {
    void api
      .voiceStatus()
      .then((res) => {
        if (res?.available) setVoiceAvailable(true)
      })
      .catch(() => {})
  })

  const stopSilenceMonitor = () => {
    if (silenceMonitorTimer !== undefined) {
      window.clearInterval(silenceMonitorTimer)
      silenceMonitorTimer = undefined
    }
    if (audioCtx) {
      try {
        void audioCtx.close()
      } catch {}
      audioCtx = null
    }
    silenceSampleCount = 0
  }

  const stopMediaTracks = () => {
    stopSilenceMonitor()
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        try {
          track.stop()
        } catch {}
      }
      mediaStream = null
    }
  }

  onCleanup(() => {
    try {
      speechRec?.stop()
    } catch {}
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop()
      }
    } catch {}
    stopMediaTracks()
  })

  const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const res = String(reader.result ?? '')
        const idx = res.indexOf('base64,')
        resolve(idx >= 0 ? res.slice(idx + 7) : res)
      }
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read audio'))
      reader.readAsDataURL(blob)
    })

  const appendTranscript = (text: string) => {
    const clean = text.trim()
    if (!clean) return
    const cur = props.value
    const sep = cur && !/\s$/.test(cur) ? ' ' : ''
    props.onInput(`${cur}${sep}${clean}`)
    queueMicrotask(() => {
      textareaRef?.focus()
      autoGrow()
    })
  }

  const transcribeAudioBlob = async (blob: Blob, rawMime: string, wasSilent = false) => {
    if (blob.size < 256) {
      toast.info('Audio clip too short to transcribe.')
      return
    }
    setIsTranscribing(true)
    try {
      const audioBase64 = await blobToBase64(blob)
      const res = await api.transcribeVoice({
        audioBase64,
        mimeType: rawMime.split(';')[0] || 'audio/webm',
        language: navigator.language || 'en-US',
      })
      if (res.ok && res.text?.trim()) {
        appendTranscript(res.text)
      } else if (wasSilent) {
        toast.withAction(
          'Microphone captured only silence. Check your mic input device or upload an audio clip.',
          'Upload Audio',
          () => audioFileInputRef?.click(),
          'warn',
          8000,
        )
      } else {
        toast.withAction(
          'No speech detected in audio. Try speaking closer to the mic or upload an audio clip.',
          'Upload Audio',
          () => audioFileInputRef?.click(),
          'info',
          7000,
        )
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      if (msg.includes('501') || msg.includes('NO_VOICE_PROVIDER')) {
        setVoiceAvailable(false)
        toast.warn('Server voice provider unavailable — using browser speech recognition next time.')
      } else {
        toast.error(`Transcription failed: ${msg}`)
      }
    } finally {
      setIsTranscribing(false)
    }
  }

  const handleAudioFileUpload = (e: Event & { currentTarget: HTMLInputElement }) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    void transcribeAudioBlob(file, file.type || 'audio/webm')
  }

  const isMicPolicyBlocked = (): boolean => {
    try {
      const doc = document as Document & {
        permissionsPolicy?: { allowsFeature?: (f: string) => boolean }
        featurePolicy?: { allowsFeature?: (f: string) => boolean }
      }
      const policy = doc.permissionsPolicy ?? doc.featurePolicy
      if (policy && typeof policy.allowsFeature === 'function') {
        return !policy.allowsFeature('microphone')
      }
    } catch {}
    return false
  }

  const notifyMicUnavailable = (kind: 'denied' | 'missing') => {
    const msg =
      kind === 'missing'
        ? 'No microphone detected.'
        : 'Microphone access is blocked or denied. Allow mic permission in browser settings.'
    if (voiceAvailable()) {
      toast.withAction(
        `${msg} You can also upload an audio clip.`,
        'Upload Audio',
        () => audioFileInputRef?.click(),
        'warn',
        8000,
      )
    } else {
      toast.warn(msg)
    }
  }

  const startSpeechFallback = () => {
    if (isMicPolicyBlocked()) {
      notifyMicUnavailable('denied')
      return
    }
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRec) {
      toast.warn('Voice dictation requires a Gemini/OpenAI API key on the server or browser SpeechRecognition.')
      return
    }
    try {
      speechBaseText = props.value.trimEnd()
      speechRec = new SpeechRec()
      speechRec.continuous = true
      speechRec.interimResults = true
      speechRec.lang = navigator.language || 'en-US'
      speechRec.onresult = (ev: any) => {
        let finalSeg = ''
        let interimSeg = ''
        for (let i = 0; i < ev.results.length; i++) {
          const piece = ev.results[i]?.[0]?.transcript ?? ''
          if (ev.results[i]?.isFinal) finalSeg += piece + ' '
          else interimSeg += piece
        }
        const combined = `${finalSeg}${interimSeg}`.trim()
        if (combined) {
          props.onInput(speechBaseText ? `${speechBaseText} ${combined}` : combined)
          queueMicrotask(autoGrow)
        }
      }
      speechRec.onerror = (ev: any) => {
        setIsListening(false)
        const err = String(ev?.error ?? '')
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          notifyMicUnavailable('denied')
        } else if (err === 'audio-capture') {
          notifyMicUnavailable('missing')
        } else if (err && err !== 'no-speech' && err !== 'aborted') {
          toast.warn(`Speech recognition failed: ${err}`)
        }
      }
      speechRec.onend = () => {
        setIsListening(false)
        speechRec = null
      }
      speechRec.start()
      setIsListening(true)
    } catch (e) {
      setIsListening(false)
      toast.warn(`Voice recognition failed: ${(e as Error).message}`)
    }
  }

  const startServerRecording = async () => {
    if (isMicPolicyBlocked()) {
      notifyMicUnavailable('denied')
      return
    }
    try {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
      } catch (constraintErr) {
        const cname = (constraintErr as Error)?.name ?? ''
        if (cname === 'OverconstrainedError' || cname === 'ConstraintNotSatisfiedError') {
          mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } else {
          throw constraintErr
        }
      }

      peakLevel = 0
      silenceSampleCount = 0
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (AudioCtx) {
          audioCtx = new AudioCtx()
          void audioCtx.resume().catch(() => {})
          const source = audioCtx.createMediaStreamSource(mediaStream)
          const analyser = audioCtx.createAnalyser()
          analyser.fftSize = 1024
          source.connect(analyser)
          const sampleBuf = new Float32Array(analyser.fftSize)
          silenceMonitorTimer = window.setInterval(() => {
            if (!audioCtx || audioCtx.state !== 'running') return
            silenceSampleCount += 1
            analyser.getFloatTimeDomainData(sampleBuf)
            for (let i = 0; i < sampleBuf.length; i++) {
              const abs = Math.abs(sampleBuf[i])
              if (abs > peakLevel) peakLevel = abs
            }
          }, 100)
        }
      } catch {}

      const preferredTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ]
      const mimeType =
        preferredTypes.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) ||
        ''
      audioChunks = []
      mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream)
      mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) audioChunks.push(ev.data)
      }
      mediaRecorder.onstop = async () => {
        const recMime = mediaRecorder?.mimeType || mimeType || 'audio/webm'
        const chunks = audioChunks.slice()
        audioChunks = []
        const recordedPeak = peakLevel
        const hadSilenceSamples = silenceSampleCount > 0
        stopMediaTracks()
        setIsListening(false)

        if (chunks.length === 0) return
        const blob = new Blob(chunks, { type: recMime })
        const wasSilent = hadSilenceSamples && recordedPeak < 0.002
        await transcribeAudioBlob(blob, recMime, wasSilent)
      }
      mediaRecorder.start()
      setIsListening(true)
    } catch (err) {
      stopMediaTracks()
      setIsListening(false)
      const name = (err as Error)?.name ?? ''
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        notifyMicUnavailable('denied')
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        notifyMicUnavailable('missing')
      } else {
        // Fallback to browser SpeechRecognition if MediaRecorder fails
        startSpeechFallback()
      }
    }
  }

  const toggleVoice = () => {
    if (isTranscribing()) return
    if (isListening()) {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try {
          mediaRecorder.stop()
        } catch {
          stopMediaTracks()
          setIsListening(false)
        }
        return
      }
      try {
        speechRec?.stop()
      } catch {}
      setIsListening(false)
      return
    }

    const canRecord =
      voiceAvailable() &&
      typeof MediaRecorder !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia
    if (canRecord) {
      void startServerRecording()
    } else {
      startSpeechFallback()
    }
  }

  const handleFileUpload = (e: Event & { currentTarget: HTMLInputElement }) => {
    const files = e.currentTarget.files
    if (!files || files.length === 0) return
    for (let i = 0; i < files.length; i++) {
      props.onAddPill?.(files[i].name)
    }
    e.currentTarget.value = ''
  }

  const [atQuery, setAtQuery] = createSignal('')
  const [atIndex, setAtIndex] = createSignal(0)
  const [atVisible, setAtVisible] = createSignal(false)
  const [atDismissed, setAtDismissed] = createSignal(false)
  // Empty initial state — real files are fetched from the server on focus/mount.
  // MOCK_FILES removed: showing placeholder paths to users is a UX bug.
  const [workspaceFiles, setWorkspaceFiles] = createSignal<string[]>([])
  let workspaceFetchedForCwd: string | null = null
  let workspaceFetching: Promise<void> | null = null
  const resolveCwd = () => {
    if (props.cwd) return props.cwd
    try {
      const v = localStorage.getItem('mira.selectedWorkspace')
      if (v) return v
    } catch {}
    return undefined
  }
  const fetchWorkspaceFiles = (forceCwd?: string | null) => {
    const cwd = forceCwd !== undefined ? (forceCwd ?? undefined) : resolveCwd()
    const cacheKey = cwd ?? '__default__'
    if (workspaceFetchedForCwd === cacheKey || workspaceFetching)
      return workspaceFetching ?? Promise.resolve()
    workspaceFetching = api
      .getWorkspaceTree(cwd)
      .then((files) => {
        if (files.length > 0) setWorkspaceFiles(files)
        workspaceFetchedForCwd = cacheKey
      })
      .catch(() => {
        workspaceFetchedForCwd = cacheKey
      })
      .finally(() => {
        workspaceFetching = null
      })
    return workspaceFetching
  }
  onMount(() => {
    void fetchWorkspaceFiles()
  })
  createEffect(() => {
    if (atVisible()) void fetchWorkspaceFiles()
  })
  createEffect(() => {
    const cwd = props.cwd ?? null
    if (cwd !== workspaceFetchedForCwd && workspaceFetchedForCwd !== null) {
      workspaceFetchedForCwd = null
      void fetchWorkspaceFiles(cwd)
    }
  })

  // Detect @ mention in progress
  const detectAtMention = (text: string, cursorPos: number): string | null => {
    const before = text.slice(0, cursorPos)
    const atIdx = before.lastIndexOf('@')
    if (atIdx === -1) return null
    // Must be at start or after whitespace, and no space after @
    if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) return null
    const after = before.slice(atIdx + 1)
    if (after.includes(' ') || after.includes('\n')) return null
    return after
  }

  const handleInput = (e: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
    const val = e.currentTarget.value
    props.onInput(val)
    const cursor = e.currentTarget.selectionStart ?? val.length
    const at = detectAtMention(val, cursor)
    if (at !== null && !atDismissed()) {
      setAtQuery(at)
      setAtVisible(true)
      setAtIndex(0)
    } else {
      setAtVisible(false)
    }
    autoGrow()
  }

  createEffect(() => {
    // Reset dismissed when @ is no longer present
    const v = props.value
    if (!v.includes('@')) setAtDismissed(false)
  })

  const handleAtSelect = (path: string) => {
    const val = props.value
    const cursor = textareaRef?.selectionStart ?? val.length
    const before = val.slice(0, cursor)
    const atIdx = before.lastIndexOf('@')
    if (atIdx !== -1) {
      const after = val.slice(cursor)
      const next = before.slice(0, atIdx) + `@${path} ` + after
      props.onInput(next)
    }
    props.onAddPill?.(path)
    setAtVisible(false)
    setAtDismissed(false)
    textareaRef?.focus()
    queueMicrotask(autoGrow)
  }

  const atFiltered = createMemo(() => filterFiles(atQuery(), workspaceFiles()))

  const handleKeyDown = (e: KeyboardEvent) => {
    if (atVisible() && atFiltered().length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtIndex((i) => Math.min(i + 1, atFiltered().length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const pick = atFiltered()[atIndex()]
        if (pick) {
          e.preventDefault()
          handleAtSelect(pick)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtVisible(false)
        setAtDismissed(true)
        return
      }
    }

    // Slash handling is done by parent; just handle submit
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      props.onSubmit()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !atVisible()) {
      const v = props.value.trimStart()
      if (!v.startsWith('/') || v.includes(' ')) {
        e.preventDefault()
        props.onSubmit()
      }
    }
  }

  const autoGrow = () => {
    const el = textareaRef
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  return (
    <div
      data-slot="prompt-input"
      style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', position: 'relative' }}
    >
      {/* File pills */}
      <Show when={(props.filePills ?? []).length > 0}>
        <div
          data-slot="file-pills"
          style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap', 'align-items': 'center' }}
        >
          <For each={props.filePills ?? []}>
            {(pill, i) => <FilePillChip pill={pill} onRemove={() => props.onRemovePill?.(i())} />}
          </For>
        </div>
      </Show>

      {/* @ autocomplete */}
      <Show when={atVisible() && atFiltered().length > 0 && !atDismissed()}>
        <AtMentionAutocomplete
          query={atQuery()}
          files={workspaceFiles()}
          selected={atIndex()}
          onSelect={handleAtSelect}
          onClose={() => {
            setAtVisible(false)
            setAtDismissed(true)
          }}
        />
      </Show>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        data-slot="prompt-textarea"
        value={props.value}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={() => fetchWorkspaceFiles()}
        placeholder={
          props.researchMode && props.researchMode !== 'off'
            ? `Live Online Research (${props.researchMode === 'deep-investigation' ? 'Deep Plan' : 'Quick Grounded'}) — ask anything to search the web…`
            : props.placeholder ??
              'Message Mira…  ( / for commands · /research · /fanout · @ for files · ⌘K palette )'
        }
        aria-label="Message Mira"
        aria-autocomplete="list"
        rows={1}
        style={{ 'min-height': '24px', 'max-height': '165px' }}
      />

      {/* Bottom bar: model selector + agent selector + send */}
      <div
        data-slot="prompt-actions"
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'flex-wrap': 'wrap' }}>
          <ModelSelector
            settings={props.settings}
            value={props.selectedModel}
            onSelect={props.onModelSelect}
          />
          <AgentSelector
            value={props.selectedAgent}
            onSelect={props.onAgentSelect}
          />
          <Show when={props.onResearchModeChange}>
            <button
              type="button"
              onClick={() => {
                const cur = props.researchMode ?? 'off'
                const next =
                  cur === 'off'
                    ? 'quick-grounded'
                    : cur === 'quick-grounded'
                      ? 'deep-investigation'
                      : 'off'
                props.onResearchModeChange?.(next)
              }}
              title="Toggle live web research mode (Off → Quick Grounded → Deep Investigation)"
              aria-label="Toggle live web research mode"
              style={{
                display: 'inline-flex',
                'align-items': 'center',
                gap: '5px',
                padding: '4px 9px',
                'font-size': 'var(--fs-xs)',
                border:
                  props.researchMode && props.researchMode !== 'off'
                    ? '1px solid var(--accent-border)'
                    : '1px solid var(--border)',
                'border-radius': 'var(--r-md)',
                background:
                  props.researchMode && props.researchMode !== 'off'
                    ? 'var(--accent-soft)'
                    : 'var(--bg-surface)',
                color:
                  props.researchMode && props.researchMode !== 'off'
                    ? 'var(--accent)'
                    : 'var(--fg-muted)',
                'font-weight':
                  props.researchMode && props.researchMode !== 'off' ? '600' : '500',
                cursor: 'pointer',
                'min-height': '32px',
              }}
            >
              <span>🌐</span>
              <span>
                {props.researchMode === 'deep-investigation'
                  ? 'Deep Research'
                  : props.researchMode === 'quick-grounded'
                    ? 'Web Search'
                    : 'Research'}
              </span>
            </button>
          </Show>

          {/* Attachment File Input Button */}
          <button
            type="button"
            onClick={() => fileInputRef?.click()}
            title="Attach files or screenshots (@pill)"
            aria-label="Attach files"
            style={{
              display: 'inline-flex',
              'align-items': 'center',
              gap: '5px',
              padding: '4px 9px',
              'font-size': 'var(--fs-xs)',
              border: '1px solid var(--border)',
              'border-radius': 'var(--r-md)',
              background: 'var(--bg-surface)',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
              'min-height': '32px',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            <span>Attach</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileUpload}
          />

          {/* Voice Recognition Dictation Button */}
          <button
            type="button"
            disabled={isTranscribing()}
            onClick={toggleVoice}
            title={
              isTranscribing()
                ? 'Transcribing audio…'
                : isListening()
                  ? 'Stop recording & transcribe'
                  : voiceAvailable()
                    ? 'Record voice note (Server AI transcription)'
                    : 'Start voice dictation (Speech-to-text)'
            }
            aria-label={isTranscribing() ? 'Transcribing audio' : isListening() ? 'Stop voice dictation' : 'Start voice recognition'}
            aria-pressed={isListening() ? 'true' : 'false'}
            style={{
              display: 'inline-flex',
              'align-items': 'center',
              gap: '5px',
              padding: '4px 9px',
              'font-size': 'var(--fs-xs)',
              border: isListening() ? '1px solid var(--danger)' : isTranscribing() ? '1px solid var(--accent-border)' : '1px solid var(--border)',
              'border-radius': 'var(--r-md)',
              background: isListening() ? 'var(--danger-soft)' : isTranscribing() ? 'var(--accent-soft)' : 'var(--bg-surface)',
              color: isListening() ? 'var(--danger)' : isTranscribing() ? 'var(--accent)' : 'var(--fg-muted)',
              cursor: isTranscribing() ? 'wait' : 'pointer',
              'font-weight': isListening() || isTranscribing() ? '700' : '500',
              'min-height': '32px',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" x2="12" y1="19" y2="22" />
            </svg>
            <span>{isTranscribing() ? 'Transcribing…' : isListening() ? 'Stop' : 'Voice'}</span>
          </button>
          <input
            ref={audioFileInputRef}
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={handleAudioFileUpload}
          />
        </div>
        <Show
          when={!props.streaming}
          fallback={
            <div style={{ display: 'flex', gap: '8px', flex: 'none' }}>
              <Show when={props.onQueue}>
                <button
                  type="button"
                  data-slot="prompt-queue"
                  class="btn btn-warn-ghost"
                  disabled={!props.value.trim()}
                  onClick={() => props.onQueue?.()}
                  title="Queue this message — it runs after the current turn"
                  aria-label="Queue message"
                  style={{
                    padding: '7px 12px',
                    'font-size': 'var(--fs-sm)',
                    'border-radius': 'var(--r-md)',
                    'min-height': '36px',
                  }}
                >
                  Queue ↵
                </button>
              </Show>
              <button
                type="button"
                data-slot="prompt-stop"
                class="btn btn-danger-ghost"
                onClick={() => props.onStop?.()}
                title="Stop the current response"
                aria-label="Stop response"
                style={{
                  padding: '7px 12px',
                  'font-size': 'var(--fs-sm)',
                  'border-radius': 'var(--r-md)',
                  'min-height': '36px',
                }}
              >
                ■ Stop
              </button>
            </div>
          }
        >
          <button
            type="button"
            data-slot="prompt-send"
            class="btn btn-solid"
            disabled={!props.value.trim() || props.disabled}
            onClick={() => props.onSubmit()}
            aria-label="Send message"
            style={{
              padding: '7px 16px',
              'font-size': 'var(--fs-sm)',
              flex: 'none',
              'min-height': '36px',
            }}
          >
            Send ↵
          </button>
        </Show>
      </div>
    </div>
  )
}
