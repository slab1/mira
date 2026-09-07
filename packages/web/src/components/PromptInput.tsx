import { For, Show, createSignal, createEffect, createMemo, onCleanup } from 'solid-js'
import type { SettingsStore } from '../stores/settings'
import { filterCommands } from './CommandPalette'
import type { CommandEntry } from '../api/client'

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
      <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>@{props.pill.path}</span>
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

const MOCK_FILES = [
  'src/App.tsx',
  'src/components/ChatView.tsx',
  'src/components/SessionList.tsx',
  'src/components/ActivityPanel.tsx',
  'src/components/ToolView.tsx',
  'src/stores/app.ts',
  'src/stores/settings.ts',
  'src/api/client.ts',
  'src/index.css',
  'package.json',
  'README.md',
  'vite.config.ts',
  'tsconfig.json',
]

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
        <div style={{ padding: '6px 10px', 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'font-weight': '600', 'letter-spacing': '0.04em', 'text-transform': 'uppercase', 'border-bottom': '1px solid var(--border)' }}>
          Files · @{props.query || '…'}
        </div>
        <div style={{ overflow: 'auto', padding: '4px', display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
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
                <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{file}</span>
              </button>
            )}
          </For>
        </div>
        <div style={{ padding: '6px 10px', 'border-top': '1px solid var(--border)', 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', display: 'flex', gap: '6px' }}>
          <span><span class="kbd">↑↓</span> nav</span>
          <span>·</span>
          <span><span class="kbd">Tab</span> select</span>
          <span>·</span>
          <span><span class="kbd">Esc</span> close</span>
        </div>
      </div>
    </Show>
  )
}

// ── Model selector ───────────────────────────────────────────────────

function ModelSelector(props: { settings?: SettingsStore; value?: string; onSelect?: (model: string) => void }) {
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
      const models = (p.models ?? []).filter((m) => !q || m.toLowerCase().includes(q))
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
        <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{currentLabel()}</span>
        <span style={{ 'font-size': '9px', color: 'var(--fg-faint)', transform: open() ? 'rotate(180deg)' : 'none', transition: 'transform var(--dur-fast) var(--ease)' }}>▾</span>
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
          <div style={{ overflow: 'auto', padding: '4px', display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
            <Show
              when={grouped().length > 0}
              fallback={<div style={{ padding: '12px', 'text-align': 'center', 'font-size': 'var(--fs-sm)', color: 'var(--fg-faint)' }}>No models found</div>}
            >
              <For each={grouped()}>
                {(group) => (
                  <div>
                    <div style={{ padding: '4px 8px', 'font-size': 'var(--fs-2xs)', 'font-weight': '700', color: 'var(--fg-faint)', 'letter-spacing': '0.04em', 'text-transform': 'uppercase' }}>
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
                            background: currentLabel() === model ? 'var(--accent-soft)' : 'transparent',
                            'border-color': currentLabel() === model ? 'var(--accent-border)' : 'transparent',
                            color: currentLabel() === model ? 'var(--accent)' : 'var(--fg)',
                            'font-size': 'var(--fs-sm)',
                            'font-family': 'var(--font-mono)',
                            cursor: 'pointer',
                            'text-align': 'left',
                          }}
                        >
                          <span style={{ flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{model}</span>
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
                            {model.includes('sonnet') || model.includes('opus') ? 'reasoning' : model.includes('haiku') ? 'fast' : 'general'}
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
  filePills?: FilePill[]
  onRemovePill?: (index: number) => void
  onAddPill?: (path: string) => void
}) {
  let textareaRef: HTMLTextAreaElement | undefined
  const [atQuery, setAtQuery] = createSignal('')
  const [atIndex, setAtIndex] = createSignal(0)
  const [atVisible, setAtVisible] = createSignal(false)
  const [atDismissed, setAtDismissed] = createSignal(false)

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

  const atFiltered = createMemo(() => filterFiles(atQuery(), MOCK_FILES))

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
      // Let parent decide if slash autocomplete should intercept
      // If no slash handling needed, submit
      const v = props.value
      if (!v.startsWith('/')) {
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
    <div data-slot="prompt-input" style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', position: 'relative' }}>
      {/* File pills */}
      <Show when={(props.filePills ?? []).length > 0}>
        <div data-slot="file-pills" style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap', 'align-items': 'center' }}>
          <For each={props.filePills ?? []}>
            {(pill, i) => <FilePillChip pill={pill} onRemove={() => props.onRemovePill?.(i())} />}
          </For>
        </div>
      </Show>

      {/* @ autocomplete */}
      <Show when={atVisible() && atFiltered().length > 0 && !atDismissed()}>
        <AtMentionAutocomplete query={atQuery()} files={MOCK_FILES} selected={atIndex()} onSelect={handleAtSelect} onClose={() => { setAtVisible(false); setAtDismissed(true) }} />
      </Show>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        data-slot="prompt-textarea"
        value={props.value}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        placeholder={props.placeholder ?? 'Message Mira…  ( / for commands · @ for files · ⌘K palette · ⌘↵ send )'}
        aria-label="Message Mira"
        aria-autocomplete="list"
        rows={1}
        style={{ 'min-height': '24px', 'max-height': '160px' }}
      />

      {/* Bottom bar: model selector + send */}
      <div data-slot="prompt-actions" style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '10px' }}>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <ModelSelector settings={props.settings} value={props.selectedModel} onSelect={props.onModelSelect} />
          <span aria-hidden="true" style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', display: 'flex', gap: '5px', 'align-items': 'center' }}>
            <span class="kbd">↵</span> send <span style={{ opacity: '0.5' }}>·</span> <span class="kbd">⇧↵</span> newline
          </span>
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
                  style={{ padding: '7px 12px', 'font-size': 'var(--fs-sm)', 'border-radius': 'var(--r-md)', 'min-height': '36px' }}
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
                style={{ padding: '7px 12px', 'font-size': 'var(--fs-sm)', 'border-radius': 'var(--r-md)', 'min-height': '36px' }}
              >
                ■ Stop
              </button>
            </div>
          }
        >
          <button
            type="submit"
            data-slot="prompt-send"
            class="btn btn-solid"
            disabled={!props.value.trim() || props.disabled}
            onClick={(e) => { e.preventDefault(); props.onSubmit() }}
            aria-label="Send message"
            style={{ padding: '7px 16px', 'font-size': 'var(--fs-sm)', flex: 'none', 'min-height': '36px' }}
          >
            Send ↵
          </button>
        </Show>
      </div>
    </div>
  )
}
