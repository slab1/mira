/**
 * InfoHierarchy — structured information display with clear visual priority.
 *
 * Layers information by importance:
 *   AlertSection      — critical alerts at top (max 3)
 *   KeyMetricsSection — 5-7 key metrics in a responsive grid
 *   DetailsSection    — expandable sections for detailed data
 *
 * Each section has clear visual separation to guide processing.
 */

import { createSignal, Show, For, type JSX } from 'solid-js'
import { Card, SectionHeader, MetricCard, StatusBadge, StatusTone } from './DesignSystem'

/* ── Alert Section ─────────────────────────────────────────────────────── */

export interface AlertItem {
  message: string
  tone?: StatusTone
}

export function AlertSection(props: {
  alerts: AlertItem[]
}) {
  const visible = () => props.alerts.slice(0, 3)

  return (
    <Show when={visible().length > 0}>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
        <For each={visible()}>
          {(alert) => (
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                padding: '10px 12px',
                'border-radius': 'var(--r-md)',
                'font-size': 'var(--fs-sm)',
                border: `1px solid ${alert.tone === 'error' ? 'var(--danger-border)' : alert.tone === 'warning' ? 'var(--warn-border)' : 'var(--accent-border)'}`,
                background: alert.tone === 'error' ? 'var(--danger-soft)' : alert.tone === 'warning' ? 'var(--warn-soft)' : 'var(--accent-soft)',
                color: alert.tone === 'error' ? 'var(--danger)' : alert.tone === 'warning' ? 'var(--warn)' : 'var(--accent)',
              }}
            >
              <span aria-hidden="true">●</span>
              <span>{alert.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

/* ── Key Metrics Section ───────────────────────────────────────────────── */

export interface KeyMetric {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'success' | 'warning' | 'error' | 'info'
}

export function KeyMetricsSection(props: {
  metrics: KeyMetric[]
  maxVisible?: number
}) {
  const [showAll, setShowAll] = createSignal(false)
  const max = () => props.maxVisible ?? 7
  const visible = () => showAll() ? props.metrics : props.metrics.slice(0, max())
  const hasHidden = () => props.metrics.length > max()

  return (
    <div>
      <div
        style={{
          display: 'grid',
          'grid-template-columns': 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '10px',
        }}
      >
        <For each={visible()}>
          {(m) => (
            <MetricCard
              label={m.label}
              value={m.value}
              sub={m.sub}
              tone={m.tone}
            />
          )}
        </For>
      </div>
      <Show when={hasHidden()}>
        <div style={{ 'margin-top': '10px', 'text-align': 'center' }}>
          <button
            onClick={() => setShowAll(!showAll())}
            style={{
              padding: '6px 14px',
              'border-radius': 'var(--r-md)',
              border: '1px solid var(--border-strong)',
              background: 'var(--bg-surface)',
              color: 'var(--fg-muted)',
              'font-size': 'var(--fs-xs)',
              'font-weight': '600',
              cursor: 'pointer',
              transition: 'background var(--dur-fast) var(--ease)',
            }}
          >
            {showAll() ? 'Show less' : `Show ${props.metrics.length - max()} more`}
          </button>
        </div>
      </Show>
    </div>
  )
}

/* ── Details Section ───────────────────────────────────────────────────── */

export function DetailsSection(props: {
  title: string
  sub?: string
  children: JSX.Element
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = createSignal(props.defaultExpanded ?? false)

  return (
    <Card padding="0">
      <div
        onClick={() => setExpanded(!expanded())}
        role="button"
        tabindex="0"
        aria-expanded={expanded()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded()) } }}
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '12px 16px',
          cursor: 'pointer',
          transition: 'background var(--dur-fast) var(--ease)',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '' }}
      >
        <div>
          <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.04em', color: 'var(--fg-muted)' }}>
            {props.title}
          </div>
          <Show when={props.sub}>
            <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'margin-top': '2px' }}>{props.sub}</div>
          </Show>
        </div>
        <span
          style={{
            'font-size': '9px',
            color: 'var(--fg-faint)',
            transition: 'transform var(--dur-fast) var(--ease)',
            transform: expanded() ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          ▶
        </span>
      </div>
      <Show when={expanded()}>
        <div style={{ padding: '0 16px 16px', 'border-top': '1px solid var(--border)' }}>
          {props.children}
        </div>
      </Show>
    </Card>
  )
}
