/**
 * UXModeSwitcher — segmented control for the Beginner/Pro/Expert interface
 * tiers (P2.4). Always visible so users can discover the full surface at
 * any time; preference persists via stores/uxMode.ts (localStorage).
 */
import { For } from 'solid-js'
import { UX_MODES, uxMode, setUxMode } from '../stores/uxMode'

export function UXModeSwitcher() {
  return (
    <div
      data-slot="ux-mode-switcher"
      role="radiogroup"
      aria-label="Interface mode"
      title="Interface complexity — switch anytime; your preference is remembered"
      style={{
        display: 'flex',
        gap: '2px',
        'align-items': 'center',
        padding: '4px var(--sp-3)',
        'border-bottom': '1px solid var(--border)',
        'font-size': 'var(--fs-2xs)',
        'flex-shrink': '0',
      }}
    >
      <span
        style={{
          'margin-right': '6px',
          color: 'var(--fg-faint)',
          'text-transform': 'uppercase',
          'letter-spacing': '0.04em',
        }}
      >
        mode
      </span>
      <For each={UX_MODES}>
        {(m) => {
          const active = () => uxMode() === m.id
          return (
            <button
              type="button"
              role="radio"
              aria-checked={active() ? 'true' : 'false'}
              title={m.hint}
              onClick={() => setUxMode(m.id)}
              class="chip"
              style={{
                'font-size': 'var(--fs-2xs)',
                padding: '2px 10px',
                ...(active()
                  ? {
                      background: 'var(--accent)',
                      color: 'var(--bg-app)',
                      'border-color': 'var(--accent)',
                      'font-weight': '600',
                    }
                  : { color: 'var(--fg-muted)' }),
              }}
            >
              {m.label}
            </button>
          )
        }}
      </For>
    </div>
  )
}
