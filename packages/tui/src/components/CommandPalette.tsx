/**
 * CommandPalette — TUI command mode for Mira
 *
 * Ported from web/src/components/CommandPalette.tsx:
 *  - fuzzyScore + filterCommands (fuzzy matching with prefix/consecutive bonuses)
 *  - Global palette (Ctrl+P) + SlashAutocomplete inline 8-item dropdown
 *  - SettingsStore.allCommands() merges commands+skills via rpc listCommands/listSkills
 */

import { createSignal, createMemo, createEffect, onMount, onCleanup, For, Show } from 'solid-js'
import type { SettingsStore } from '../stores/settings'
import { rpc } from '../rpc/client'
import type { CommandEntry } from '../stores/settings'

type Props = {
  open: boolean
  onClose: () => void
  onExecute: (cmd: string) => void
  settings?: SettingsStore
}

// ── Fuzzy ──────────────────────────────────────────────────────────

/**
 * Simple fuzzy score: characters of `query` must appear in order in `target`.
 * Higher score = better match. Prefix and consecutive bonuses.
 * Returns 0 if no match.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (!q) return 1
  if (t.includes(q)) return 100 + (t.startsWith(q) ? 50 : 0) - t.length * 0.1

  let qi = 0
  let ti = 0
  let score = 0
  let consecutive = 0
  let lastMatch = -2

  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      const bonus = ti === 0 ? 10 : 0
      const contBonus = ti === lastMatch + 1 ? 5 + consecutive : 0
      score += 10 + bonus + contBonus
      consecutive = ti === lastMatch + 1 ? consecutive + 1 : 0
      lastMatch = ti
      qi++
    } else {
      consecutive = 0
    }
    ti++
  }
  if (qi < q.length) return 0
  score -= t.length * 0.2
  return score
}

export function filterCommands(query: string, commands: CommandEntry[]): CommandEntry[] {
  const q = query.trim().toLowerCase().replace(/^\//, '')
  if (!q) return commands.slice(0, 20)
  const scored = commands
    .map((c) => {
      const nameScore = fuzzyScore(q, c.name.replace(/^\//, ''))
      const descScore = fuzzyScore(q, c.description) * 0.5
      const s = Math.max(nameScore, descScore)
      return { c, s }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
  return scored.slice(0, 20).map((x) => x.c)
}

// Fallback hardcoded commands when server fetch fails / offline
const FALLBACK_COMMANDS: CommandEntry[] = [
  { name: '/cost', description: 'Show current spend & token usage', source: 'command' },
  { name: '/undo', description: 'Undo last file mutation', source: 'command' },
  { name: '/queue', description: 'Show queued prompts', source: 'command' },
  { name: '/jobs', description: 'List background jobs', source: 'command' },
  { name: '/fork', description: 'Fork current session', source: 'command' },
  { name: '/export', description: 'Export session transcript', source: 'command' },
  {
    name: '/autopilot',
    description: 'Autopilot — scheduler, eval delta, patches',
    source: 'command',
  },
]

export default function CommandPalette(props: Props) {
  const [query, setQuery] = createSignal('')
  const [index, setIndex] = createSignal(0)
  const [fetched, setFetched] = createSignal<CommandEntry[] | null>(null)

  const commands = (): CommandEntry[] => {
    if (props.settings) {
      const all = props.settings.allCommands()
      if (all.length > 0) return all
    }
    return fetched() ?? FALLBACK_COMMANDS
  }

  const filtered = createMemo(() => filterCommands(query(), commands()))

  // Fetch commands+skills via rpc when palette opens and settings has no data
  const ensureCommands = async () => {
    if (props.settings) {
      if (props.settings.allCommands().length === 0) {
        try {
          await props.settings.loadAll()
        } catch {}
      }
      return
    }
    if (fetched() !== null) return
    try {
      const [cmds, skills] = await Promise.all([
        rpc.listCommands().catch(() => [] as unknown as CommandEntry[]),
        rpc.listSkills().catch(() => [] as unknown as CommandEntry[]),
      ])
      const normalize = (raw: unknown): CommandEntry[] => {
        if (!Array.isArray(raw) || raw.length === 0) return []
        if (typeof raw[0] === 'string') {
          return (raw as string[]).map((n) => ({
            name: n.startsWith('/') ? n : `/${n}`,
            description: '',
            source: 'command' as const,
          }))
        }
        return raw as CommandEntry[]
      }
      const cmdEntries = normalize(cmds)
      const skillEntries = normalize(skills).map((s) => ({
        name: s.name.startsWith('/') ? s.name : `/${s.name}`,
        description: s.description || `Skill: ${s.name}`,
        source: 'skill' as const,
      }))
      const seen = new Set<string>()
      const merged: CommandEntry[] = []
      for (const c of [...cmdEntries, ...skillEntries]) {
        if (!seen.has(c.name)) {
          seen.add(c.name)
          merged.push(c)
        }
      }
      setFetched(merged.length > 0 ? merged : FALLBACK_COMMANDS)
    } catch {
      setFetched(FALLBACK_COMMANDS)
    }
  }

  createEffect(() => {
    if (props.open) void ensureCommands()
  })

  const execute = (cmd: string) => {
    // strip leading '/' for onExecute compatibility (App handleCommand expects id without slash)
    const id = cmd.replace(/^\//, '')
    props.onExecute(id)
    props.onClose()
  }

  let dialogRef: HTMLDivElement | undefined
  const onKeyDown = (e: KeyboardEvent) => {
    const items = filtered()
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
      return
    }
    if (e.key === 'Tab' && dialogRef) {
      const focusable = dialogRef.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length > 0) {
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
        return
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[index()]
      if (item) execute(item.name)
      return
    }
    if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key) - 1
      const item = items[n]
      if (item) {
        e.preventDefault()
        execute(item.name)
      }
    }
  }

  onMount(() => {
    if (props.open) {
      setQuery('')
      setIndex(0)
      window.addEventListener('keydown', onKeyDown)
    }
  })

  onCleanup(() => window.removeEventListener('keydown', onKeyDown))

  // Re-attach when open changes
  createEffect(() => {
    if (props.open) {
      setQuery('')
      setIndex(0)
      window.addEventListener('keydown', onKeyDown)
      void ensureCommands()
    } else {
      window.removeEventListener('keydown', onKeyDown)
    }
  })

  // Global Ctrl+P / Cmd+P listener
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isModP = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p'
      if (isModP) {
        e.preventDefault()
        if (props.open) props.onClose()
        else window.dispatchEvent(new CustomEvent('mira:open-palette'))
      }
    }
    window.addEventListener('keydown', handler)
    onCleanup(() => window.removeEventListener('keydown', handler))
  })

  return (
    <Show when={props.open}>
      <div
        style={{
          position: 'fixed',
          inset: '0',
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          'align-items': 'flex-start',
          'justify-content': 'center',
          'padding-top': '20vh',
          'z-index': '1000',
        }}
        onClick={props.onClose}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          tabindex="-1"
          style={{
            width: 'min(560px, 92vw)',
            'border-radius': '12px',
            background: '#0f1117',
            border: '1px solid rgba(255,255,255,0.12)',
            'box-shadow': '0 16px 48px rgba(0,0,0,0.55)',
            overflow: 'hidden',
            color: '#e5e7eb',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
              padding: '12px 14px',
              border: '1px solid rgba(255,255,255,0.08)',
              'border-left': 'none',
              'border-right': 'none',
              background: 'rgba(255,255,255,0.02)',
            }}
          >
            <span style={{ 'font-size': '16px' }}>⌘</span>
            <input
              autofocus
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value)
                setIndex(0)
              }}
              placeholder="Type a command or skill…  (/ for slash commands)"
              style={{
                flex: '1',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#e5e7eb',
                'font-size': '14px',
              }}
            />
            <span style={{ 'font-size': '11px', opacity: '0.5' }}>ESC to close</span>
          </div>

          <div style={{ 'max-height': '320px', overflow: 'auto', padding: '6px' }}>
            <For each={filtered()}>
              {(cmd, i) => {
                const active = () => index() === i()
                return (
                  <div
                    onMouseEnter={() => setIndex(i())}
                    onClick={() => execute(cmd.name)}
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '10px',
                      padding: '10px 12px',
                      'border-radius': '8px',
                      cursor: 'pointer',
                      background: active() ? 'rgba(99,102,241,0.18)' : 'transparent',
                      border: active()
                        ? '1px solid rgba(99,102,241,0.35)'
                        : '1px solid transparent',
                    }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        'flex-direction': 'column',
                        gap: '2px',
                        flex: '1',
                        'min-width': '0',
                      }}
                    >
                      <span
                        style={{
                          'font-family': 'ui-monospace, monospace',
                          'font-weight': '700',
                          color: '#a5b4fc',
                        }}
                      >
                        {cmd.name}
                      </span>
                      <Show when={cmd.description}>
                        <span style={{ 'font-size': '12px', opacity: '0.7' }}>
                          {cmd.description}
                        </span>
                      </Show>
                    </span>
                    <span
                      style={{
                        'font-size': '10px',
                        padding: '2px 6px',
                        'border-radius': '999px',
                        background: 'rgba(255,255,255,0.08)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        opacity: '0.7',
                      }}
                    >
                      {cmd.source}
                    </span>
                    <span
                      style={{
                        'font-size': '11px',
                        opacity: '0.45',
                        'font-family': 'ui-monospace',
                      }}
                    >
                      {i() + 1}
                    </span>
                  </div>
                )
              }}
            </For>
            <Show when={filtered().length === 0}>
              <div
                style={{
                  padding: '20px',
                  'text-align': 'center',
                  opacity: '0.5',
                  'font-size': '13px',
                }}
              >
                No commands match “{query()}” — try{' '}
                <code style={{ 'font-family': 'ui-monospace' }}>/</code> to see all.
              </div>
            </Show>
          </div>

          <div
            style={{
              padding: '8px 12px',
              'border-top': '1px solid rgba(255,255,255,0.06)',
              'font-size': '11px',
              opacity: '0.55',
              display: 'flex',
              'justify-content': 'space-between',
            }}
          >
            <span>↑↓ navigate · Enter insert · 1-9 quick pick</span>
            <span>{filtered().length} results · ⌘P to open</span>
          </div>
        </div>
      </div>
    </Show>
  )
}

// ── Inline slash autocomplete (for App.tsx composer) ──────────────

export function SlashAutocomplete(props: {
  query: string
  commands: CommandEntry[]
  selected?: number
  onSelect: (name: string) => void
  onClose: () => void
}) {
  const filtered = () => filterCommands(props.query, props.commands).slice(0, 8)
  const selected = () => props.selected ?? 0

  return (
    <Show when={props.query.startsWith('/') && filtered().length > 0}>
      <div
        role="listbox"
        aria-label="Slash commands"
        style={{
          position: 'absolute',
          bottom: '100%',
          left: '0',
          right: '0',
          'margin-bottom': '8px',
          background: '#0f1117',
          border: '1px solid rgba(255,255,255,0.12)',
          'border-radius': '10px',
          'box-shadow': '0 12px 32px rgba(0,0,0,0.45)',
          overflow: 'hidden',
          'z-index': '20',
        }}
      >
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            padding: '6px',
            gap: '2px',
            'max-height': '280px',
            overflow: 'auto',
          }}
        >
          <For each={filtered()}>
            {(cmd, i) => (
              <button
                type="button"
                role="option"
                aria-selected={selected() === i() ? 'true' : 'false'}
                onClick={() => props.onSelect(cmd.name)}
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '10px',
                  padding: '8px 10px',
                  'border-radius': '8px',
                  border:
                    selected() === i()
                      ? '1px solid rgba(99,102,241,0.35)'
                      : '1px solid transparent',
                  background: selected() === i() ? 'rgba(99,102,241,0.18)' : 'transparent',
                  cursor: 'pointer',
                  'text-align': 'left',
                  width: '100%',
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '1px',
                    'min-width': '0',
                    flex: '1',
                    'text-align': 'left',
                  }}
                >
                  <span
                    style={{
                      'font-family': 'ui-monospace, monospace',
                      'font-size': '13px',
                      'font-weight': '600',
                      color: '#a5b4fc',
                    }}
                  >
                    {cmd.name}
                  </span>
                  <Show when={cmd.description}>
                    <span
                      style={{
                        'font-size': '11px',
                        color: 'rgba(229,231,235,0.6)',
                        'white-space': 'nowrap',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                        'max-width': '36ch',
                      }}
                    >
                      {cmd.description}
                    </span>
                  </Show>
                </span>
                <span
                  style={{
                    'font-size': '10px',
                    padding: '2px 6px',
                    'border-radius': '999px',
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    color: 'rgba(229,231,235,0.7)',
                    'flex-shrink': '0',
                  }}
                >
                  {cmd.source}
                </span>
              </button>
            )}
          </For>
        </div>
        <div
          style={{
            padding: '6px 10px',
            'border-top': '1px solid rgba(255,255,255,0.06)',
            'font-size': '10px',
            color: 'rgba(229,231,235,0.45)',
            display: 'flex',
            gap: '6px',
          }}
        >
          <span>↑↓ nav</span>
          <span>·</span>
          <span>Tab complete</span>
          <span>·</span>
          <span>Esc close</span>
        </div>
      </div>
    </Show>
  )
}
