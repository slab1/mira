/**
 * Shared OperationalState type + DataState component.
 *
 * Every operational value in Mira Web must have an explicit state.
 * The UI must visually distinguish these states — never silently
 * transform "unavailable" into "0" or "demo" into "live".
 *
 * States:
 *   LIVE       — real data from the backend
 *   LOADING    — fetch in progress
 *   STALE      — data is older than threshold
 *   EMPTY      — no data available (valid empty state)
 *   ERROR      — fetch failed
 *   UNAVAILABLE — backend/feature not available
 *   DEMO       — synthetic/demo data (must be visually distinct)
 */

import { Show, type JSX } from 'solid-js'

export type OperationalState = 'live' | 'loading' | 'stale' | 'empty' | 'error' | 'unavailable' | 'demo'

export const OPERATIONAL_STATE_META: Record<OperationalState, { label: string; color: string; icon: string }> = {
  live: { label: 'LIVE', color: 'var(--fg-success)', icon: '●' },
  loading: { label: 'LOADING', color: 'var(--fg-muted)', icon: '◌' },
  stale: { label: 'STALE', color: 'var(--fg-warning)', icon: '◐' },
  empty: { label: 'EMPTY', color: 'var(--fg-subtle)', icon: '○' },
  error: { label: 'ERROR', color: 'var(--fg-danger)', icon: '✕' },
  unavailable: { label: 'UNAVAILABLE', color: 'var(--fg-faint)', icon: '⊘' },
  demo: { label: 'DEMO', color: 'var(--fg-accent)', icon: '◈' },
}

export function DataStateBadge(props: { state: OperationalState }) {
  const meta = OPERATIONAL_STATE_META[props.state]
  return (
    <span
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        'gap': '4px',
        'font-family': 'var(--font-mono)',
        'font-size': 'var(--fs-2xs)',
        'font-weight': '700',
        color: meta.color,
        'letter-spacing': '0.06em',
      }}
    >
      <span aria-hidden="true">{meta.icon}</span>
      {meta.label}
    </span>
  )
}

export function DataStateWrapper(props: {
  state: OperationalState
  children: JSX.Element
  fallback?: JSX.Element
}) {
  return (
    <Show
      when={props.state !== 'loading' && props.state !== 'error' && props.state !== 'unavailable'}
      fallback={
        props.fallback ?? (
          <div style={{ padding: '12px 16px', color: 'var(--fg-muted)', 'font-size': 'var(--fs-sm)' }}>
            <DataStateBadge state={props.state} />
          </div>
        )
      }
    >
      {props.children}
    </Show>
  )
}

/**
 * Wraps a value with its operational state.
 * Usage: <OperationalValue state={v.state} value={v.value} />
 */
export function OperationalValue(props: {
  state: OperationalState
  value: string | number | null | undefined
  unit?: string
}) {
  return (
    <div style={{ display: 'flex', 'align-items': 'baseline', gap: '6px' }}>
      <Show when={props.state === 'live' || props.state === 'stale'}>
        <span style={{ 'font-size': 'var(--fs-xl)', 'font-weight': '700' }}>
          {props.value ?? '—'}
          <Show when={props.unit}>
            <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '400', color: 'var(--fg-subtle)' }}> {props.unit}</span>
          </Show>
        </span>
      </Show>
      <Show when={props.state !== 'live' && props.state !== 'stale'}>
        <span style={{ 'font-size': 'var(--fs-sm)', color: 'var(--fg-muted)' }}>
          <DataStateBadge state={props.state} />
        </span>
      </Show>
    </div>
  )
}
