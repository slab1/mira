/**
 * CustomizationPanel — user preferences for layout, metrics, and theme.
 *
 * Persists to localStorage and applies changes immediately.
 * Based on dashboard research: users want personalization without complexity.
 */

import { createSignal, For, Show } from 'solid-js'
import { Card, SectionHeader } from './DesignSystem'

type LayoutMode = 'compact' | 'comfortable' | 'spacious'
type ThemeChoice = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'mira.customization'

interface CustomizationState {
  layout: LayoutMode
  theme: ThemeChoice
  hiddenMetrics: string[]
}

function loadState(): CustomizationState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CustomizationState>
      return {
        layout: parsed.layout === 'compact' || parsed.layout === 'spacious' ? parsed.layout : 'comfortable',
        theme: parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system' ? parsed.theme : 'system',
        hiddenMetrics: Array.isArray(parsed.hiddenMetrics) ? parsed.hiddenMetrics : [],
      }
    }
  } catch {}
  return { layout: 'comfortable', theme: 'system', hiddenMetrics: [] }
}

function saveState(state: CustomizationState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {}
}

const METRIC_OPTIONS = [
  { id: 'agents', label: 'Agents' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'memories', label: 'Memories' },
  { id: 'openItems', label: 'Open Items' },
  { id: 'repoNodes', label: 'Repo Nodes' },
  { id: 'cost', label: 'Total Cost' },
]

export function CustomizationPanel(props: {
  onLayoutChange?: (layout: LayoutMode) => void
  onThemeChange?: (theme: ThemeChoice) => void
}) {
  const [state, setState] = createSignal<CustomizationState>(loadState())

  function update(partial: Partial<CustomizationState>): void {
    const next = { ...state(), ...partial }
    setState(next)
    saveState(next)
    if (partial.layout) props.onLayoutChange?.(partial.layout)
    if (partial.theme) props.onThemeChange?.(partial.theme)
  }

  function toggleMetric(id: string): void {
    const hidden = state().hiddenMetrics
    const next = hidden.includes(id) ? hidden.filter((m) => m !== id) : [...hidden, id]
    update({ hiddenMetrics: next })
  }

  function reset(): void {
    const defaults: CustomizationState = { layout: 'comfortable', theme: 'system', hiddenMetrics: [] }
    setState(defaults)
    saveState(defaults)
    props.onLayoutChange?.(defaults.layout)
    props.onThemeChange?.(defaults.theme)
  }

  return (
    <Card padding="16px">
      <SectionHeader title="Customization" sub="Personalize your dashboard" />

      {/* Layout */}
      <div style={{ 'margin-bottom': '16px' }}>
        <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-muted)', 'margin-bottom': '8px', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' }}>
          Layout
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {(['compact', 'comfortable', 'spacious'] as const).map((mode) => (
            <button
              onClick={() => update({ layout: mode })}
              style={{
                flex: 1,
                padding: '8px 0',
                'border-radius': 'var(--r-md)',
                border: `1px solid ${state().layout === mode ? 'var(--accent-border)' : 'var(--border)'}`,
                background: state().layout === mode ? 'var(--accent-soft)' : 'var(--bg-surface)',
                color: state().layout === mode ? 'var(--accent)' : 'var(--fg-muted)',
                'font-size': 'var(--fs-xs)',
                'font-weight': '600',
                cursor: 'pointer',
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Theme */}
      <div style={{ 'margin-bottom': '16px' }}>
        <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-muted)', 'margin-bottom': '8px', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' }}>
          Theme
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {(['light', 'dark', 'system'] as const).map((theme) => (
            <button
              onClick={() => update({ theme })}
              style={{
                flex: 1,
                padding: '8px 0',
                'border-radius': 'var(--r-md)',
                border: `1px solid ${state().theme === theme ? 'var(--accent-border)' : 'var(--border)'}`,
                background: state().theme === theme ? 'var(--accent-soft)' : 'var(--bg-surface)',
                color: state().theme === theme ? 'var(--accent)' : 'var(--fg-muted)',
                'font-size': 'var(--fs-xs)',
                'font-weight': '600',
                cursor: 'pointer',
              }}
            >
              {theme}
            </button>
          ))}
        </div>
      </div>

      {/* Metric visibility */}
      <div style={{ 'margin-bottom': '16px' }}>
        <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-muted)', 'margin-bottom': '8px', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' }}>
          Visible Metrics
        </div>
        <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '6px' }}>
          <For each={METRIC_OPTIONS}>
            {(opt) => {
              const visible = !state().hiddenMetrics.includes(opt.id)
              return (
                <button
                  onClick={() => toggleMetric(opt.id)}
                  style={{
                    padding: '4px 10px',
                    'border-radius': 'var(--r-full)',
                    border: `1px solid ${visible ? 'var(--ok-border)' : 'var(--border)'}`,
                    background: visible ? 'var(--ok-soft)' : 'var(--bg-surface)',
                    color: visible ? 'var(--ok)' : 'var(--fg-faint)',
                    'font-size': 'var(--fs-xs)',
                    'font-weight': '600',
                    cursor: 'pointer',
                  }}
                >
                  {opt.label}
                </button>
              )
            }}
          </For>
        </div>
      </div>

      {/* Reset */}
      <div style={{ 'text-align': 'right' }}>
        <button
          onClick={reset}
          style={{
            padding: '6px 12px',
            'border-radius': 'var(--r-md)',
            border: '1px solid var(--border-strong)',
            background: 'transparent',
            color: 'var(--fg-muted)',
            'font-size': 'var(--fs-xs)',
            'font-weight': '600',
            cursor: 'pointer',
          }}
        >
          Reset to Default
        </button>
      </div>
    </Card>
  )
}
