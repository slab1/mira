/**
 * ProgressiveDisclosure — summary-first, drill-down pattern.
 *
 * Reduces cognitive load by showing only the essential summary upfront.
 * Users expand to see full details, diffs, and evidence on demand.
 *
 * Components:
 *   SummaryCard   — collapsed row: title + key metric + status badge
 *   ExpandedView  — expanded detail body (diffs, evidence, metadata)
 *   CollapseButton — toggle control with chevron
 *
 * Default state: collapsed (summary only).
 */

import { createSignal, Show, type JSX } from 'solid-js'
import { StatusBadge, StatusTone } from './DesignSystem'

/* ── Collapse Button ────────────────────────────────────────────────────── */

export function CollapseButton(props: {
  expanded: boolean
  onToggle: () => void
  label?: string
}) {
  return (
    <button
      onClick={props.onToggle}
      aria-expanded={props.expanded}
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '4px',
        padding: '4px 8px',
        'border-radius': 'var(--r-sm)',
        border: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        color: 'var(--fg-muted)',
        'font-size': 'var(--fs-xs)',
        'font-weight': '600',
        cursor: 'pointer',
        'white-space': 'nowrap',
        transition: 'background var(--dur-fast) var(--ease)',
      }}
    >
      <span
        style={{
          'font-size': '9px',
          transition: 'transform var(--dur-fast) var(--ease)',
          transform: props.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}
      >
        ▶
      </span>
      {props.label ?? (props.expanded ? 'Less' : 'More')}
    </button>
  )
}

/* ── Summary Card ──────────────────────────────────────────────────────── */

export function SummaryCard(props: {
  title: string
  metric: string | number
  badgeLabel?: string
  badgeTone?: StatusTone
  onExpand: () => void
  expanded: boolean
}) {
  return (
    <div
      onClick={props.onExpand}
      role="button"
      tabindex="0"
      aria-expanded={props.expanded}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onExpand() } }}
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '12px',
        padding: '10px 12px',
        'border-bottom': '1px solid var(--border)',
        cursor: 'pointer',
        transition: 'background var(--dur-fast) var(--ease)',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '' }}
    >
      <div style={{ flex: '1', 'min-width': '0' }}>
        <div style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', color: 'var(--fg)' }}>
          {props.title}
        </div>
      </div>
      <Show when={props.badgeLabel}>
        <StatusBadge label={props.badgeLabel!} tone={props.badgeTone ?? 'muted'} />
      </Show>
      <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '700', color: 'var(--fg-muted)', 'font-family': 'var(--font-mono)' }}>
        {props.metric}
      </span>
      <span
        style={{
          'font-size': '9px',
          color: 'var(--fg-faint)',
          transition: 'transform var(--dur-fast) var(--ease)',
          transform: props.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          'flex-shrink': '0',
        }}
      >
        ▶
      </span>
    </div>
  )
}

/* ── Expanded View ─────────────────────────────────────────────────────── */

export function ExpandedView(props: {
  children: JSX.Element
}) {
  return (
    <div
      style={{
        padding: '12px',
        'border-bottom': '1px solid var(--border)',
        background: 'var(--bg-app)',
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
      }}
    >
      {props.children}
    </div>
  )
}

/* ── Progressive Disclosure Container ──────────────────────────────────── */

export function ProgressiveDisclosure(props: {
  title: string
  metric: string | number
  badgeLabel?: string
  badgeTone?: StatusTone
  children: JSX.Element
}) {
  const [expanded, setExpanded] = createSignal(false)

  return (
    <div>
      <SummaryCard
        title={props.title}
        metric={props.metric}
        badgeLabel={props.badgeLabel}
        badgeTone={props.badgeTone}
        expanded={expanded()}
        onExpand={() => setExpanded(!expanded())}
      />
      <Show when={expanded()}>
        <ExpandedView>{props.children}</ExpandedView>
      </Show>
    </div>
  )
}
