/**
 * AutonomyDial — variable autonomy control (Watch / Assist / Autonomous).
 *
 * Based on ProCreator Design research: users expect variable control levels,
 * not binary on/off. Persists selection to localStorage and emits change events.
 *
 * Keyboard: Arrow keys to move between modes, Enter/Space to select.
 */

import { createSignal, onMount, onCleanup } from 'solid-js'

export type AutonomyMode = 'watch' | 'assist' | 'autonomous'

interface ModeDef {
  id: AutonomyMode
  label: string
  icon: string
  desc: string
}

const MODES: ModeDef[] = [
  { id: 'watch', label: 'Watch', icon: '👁', desc: 'Observe actions only' },
  { id: 'assist', label: 'Assist', icon: '✋', desc: 'Suggest next steps' },
  { id: 'autonomous', label: 'Autonomous', icon: '⚡', desc: 'Execute independently' },
]

const STORAGE_KEY = 'mira.autonomyMode'

export function AutonomyDial(props: {
  onChange?: (mode: AutonomyMode) => void
}) {
  const [mode, setMode] = createSignal<AutonomyMode>('assist')

  onMount(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'watch' || stored === 'assist' || stored === 'autonomous') {
        setMode(stored)
      }
    } catch {}
  })

  function select(next: AutonomyMode): void {
    setMode(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {}
    props.onChange?.(next)
  }

  function onKeyDown(e: KeyboardEvent): void {
    const idx = MODES.findIndex((m) => m.id === mode())
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      select(MODES[(idx + 1) % MODES.length].id)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      select(MODES[(idx - 1 + MODES.length) % MODES.length].id)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      select(mode())
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Autonomy level"
      onKeyDown={onKeyDown}
      style={{
        display: 'inline-flex',
        gap: '2px',
        padding: '3px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        'border-radius': 'var(--r-md)',
      }}
    >
      {MODES.map((m) => {
        const active = mode() === m.id
        return (
          <button
            
            role="radio"
            aria-checked={active}
            title={`${m.label}: ${m.desc}`}
            onClick={() => select(m.id)}
            style={{
              display: 'inline-flex',
              'align-items': 'center',
              gap: '5px',
              padding: '5px 10px',
              border: 'none',
              'border-radius': '7px',
              background: active ? 'var(--accent-soft)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--fg-muted)',
              'font-size': 'var(--fs-xs)',
              'font-weight': active ? '600' : '500',
              cursor: 'pointer',
              transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
            }}
          >
            <span aria-hidden="true">{m.icon}</span>
            {m.label}
          </button>
        )
      })}
    </div>
  )
}
