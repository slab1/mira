/**
 * DesignSystem — shared primitives for Mira Web.
 *
 * Spacing scale, card, section header, metric card, status badge,
 * and status row. All styling uses CSS custom properties (var(--*))
 * from index.css — no ad-hoc hex values.
 *
 * Color variants map to semantic tokens:
 *   success → --ok, warning → --warn, error → --danger,
 *   info → --accent, muted → --fg-muted
 */

import type { JSX } from 'solid-js'
import { Show } from 'solid-js'

/* ── Spacing scale (4px base) ─────────────────────────────────────────── */

export const SPACING = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
} as const

/* ── Card ──────────────────────────────────────────────────────────────── */

export function Card(props: {
  children: JSX.Element
  padding?: string
  gap?: string
  style?: Record<string, string>
}) {
  const pad = props.padding ?? SPACING.lg
  const gap = props.gap
  return (
    <div
      class="card"
      style={{
        padding: pad,
        ...(gap ? { display: 'flex', 'flex-direction': 'column', gap } : {}),
        ...props.style,
      }}
    >
      {props.children}
    </div>
  )
}

/* ── SectionHeader ────────────────────────────────────────────────────── */

export function SectionHeader(props: {
  title: string
  sub?: string
  right?: JSX.Element
}) {
  return (
    <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'margin-bottom': SPACING.md }}>
      <div>
        <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.04em', color: 'var(--fg-muted)' }}>
          {props.title}
        </div>
        <Show when={props.sub}>
          <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'margin-top': '2px' }}>{props.sub}</div>
        </Show>
      </div>
      <Show when={props.right}>{props.right}</Show>
    </div>
  )
}

/* ── Metric Card ───────────────────────────────────────────────────────── */

export function MetricCard(props: {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'success' | 'warning' | 'error' | 'info'
}) {
  const valueColor =
    props.tone === 'success' ? 'var(--ok)' :
    props.tone === 'warning' ? 'var(--warn)' :
    props.tone === 'error' ? 'var(--danger)' :
    props.tone === 'info' ? 'var(--accent)' :
    'var(--fg)'

  return (
    <div
      class="card"
      style={{
        padding: `${SPACING.md} ${SPACING.lg}`,
        display: 'flex',
        'flex-direction': 'column',
        gap: SPACING.xs,
      }}
    >
      <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-muted)', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' }}>
        {props.label}
      </div>
      <div style={{ 'font-size': 'var(--fs-lg)', 'font-weight': '700', color: valueColor }}>
        {props.value}
      </div>
      <Show when={props.sub}>
        <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>{props.sub}</div>
      </Show>
    </div>
  )
}

/* ── Status Badge ──────────────────────────────────────────────────────── */

export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'muted'

const TONE_COLOR: Record<StatusTone, string> = {
  success: 'var(--ok)',
  warning: 'var(--warn)',
  error: 'var(--danger)',
  info: 'var(--accent)',
  muted: 'var(--fg-muted)',
}

const TONE_BG: Record<StatusTone, string> = {
  success: 'var(--ok-soft)',
  warning: 'var(--warn-soft)',
  error: 'var(--danger-soft)',
  info: 'var(--accent-soft)',
  muted: 'var(--bg-active)',
}

const TONE_BORDER: Record<StatusTone, string> = {
  success: 'var(--ok-border)',
  warning: 'var(--warn-border)',
  error: 'var(--danger-border)',
  info: 'var(--accent-border)',
  muted: 'var(--border-strong)',
}

export function StatusBadge(props: {
  label: string
  tone?: StatusTone
}) {
  const tone = props.tone ?? 'muted'
  return (
    <span
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '4px',
        padding: '2px 8px',
        'border-radius': 'var(--r-full)',
        'font-size': 'var(--fs-2xs)',
        'font-weight': '600',
        'letter-spacing': '0.04em',
        color: TONE_COLOR[tone],
        background: TONE_BG[tone],
        'border': `1px solid ${TONE_BORDER[tone]}`,
        'white-space': 'nowrap',
      }}
    >
      {props.label}
    </span>
  )
}

/* ── Status Row ────────────────────────────────────────────────────────── */

export function StatusRow(props: {
  label: string
  value: string
  ok?: boolean
}) {
  const valueColor =
    props.ok === true ? 'var(--ok)' :
    props.ok === false ? 'var(--danger)' :
    'var(--fg-subtle)'

  return (
    <div style={{ display: 'flex', 'justify-content': 'space-between', 'padding': '6px 0', 'border-bottom': '1px solid var(--border)' }}>
      <span style={{ 'font-size': 'var(--fs-sm)' }}>{props.label}</span>
      <span style={{ 'font-size': 'var(--fs-sm)', color: valueColor }}>{props.value}</span>
    </div>
  )
}
