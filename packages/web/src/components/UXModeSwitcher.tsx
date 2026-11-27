import { For } from 'solid-js'
import { UX_MODES, uxMode, setUxMode } from '../stores/uxMode'

export function UXModeSwitcher(props: { compact?: boolean }) {
  return (
    <div
      data-slot="ux-mode-switcher"
      role="radiogroup"
      aria-label="Interface mode"
      title="Interface complexity — switch anytime; your preference is remembered"
      style={{
        display: 'grid',
        'grid-template-columns': `repeat(${UX_MODES.length}, minmax(0, 1fr))`,
        gap: '3px',
        padding: '3px',
        background: 'var(--bg-app)',
        border: '1px solid var(--border)',
        'border-radius': 'var(--r-md)',
        'flex-shrink': '0',
      }}
    >
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
              style={{
                padding: props.compact ? '4px 6px' : '5px 8px',
                'border-radius': 'calc(var(--r-md) - 3px)',
                border: active() ? '1px solid var(--accent-border)' : '1px solid transparent',
                background: active() ? 'var(--bg-surface)' : 'transparent',
                color: active() ? 'var(--accent)' : 'var(--fg-muted)',
                'font-size': 'var(--fs-2xs)',
                'font-weight': active() ? '700' : '500',
                cursor: 'pointer',
                'white-space': 'nowrap',
                'text-align': 'center',
                transition: 'opacity var(--dur-fast) var(--ease)',
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
