/**
 * Layout — Unified layout system for Mira TUI (2026 TUI Best Practices)
 *
 * Grid: header (Mira, connection, model, health) | sidebar (sessions) | main (messages) | status bar (input, streaming, cost)
 * Focus groups: sidebar (TabGroup), main (TabGroup), input (TabStop)
 * Focus indicator: clearly visible border/background change
 * Responsive: handle narrow terminals (80 cols) gracefully
 *
 * Uses @opentui/solid Box/Text primitives where possible, fallback to div/span for DOM preview.
 */

import { Show, type JSX } from 'solid-js'
import { Box, Text } from '../shim/opentui-solid'
import { surface, space, font, text, focus, grid, semantic } from '../lib/tokens'
import { getColorMode } from '../lib/a11y'
import type { FocusGroup } from '../lib/focus'
import { focusGroupStyle } from '../lib/focus'

// ── Header ──────────────────────────────────────────────────────
export function Header(props: {
  connected: boolean
  model?: string
  version?: string
  tools?: number
  costUSD?: number
  costCap?: number
  tokensIn?: number | null
  tokensOut?: number | null
  score?: number | null
  queued?: number
  onUndo?: () => void
  hasSession?: boolean
  children?: JSX.Element
}) {
  const colorMode = getColorMode()
  return (
    <Box
      style={{
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'space-between',
        padding: '10px 14px',
        border: `1px solid ${surface.border}`,
        'border-radius': '10px',
        margin: `${space.xs} ${space.sm} 0 ${space.sm}`,
        background:
          colorMode === 'no-color' || colorMode === 'dumb'
            ? 'transparent'
            : 'linear-gradient(135deg, rgba(99,102,241,0.14), rgba(168,85,247,0.10))',
        'flex-shrink': '0',
        'flex-wrap': 'wrap',
        gap: space.sm,
      }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'flex-wrap': 'wrap' }}>
        <span
          style={{
            width: '28px',
            height: '28px',
            display: 'inline-flex',
            'align-items': 'center',
            'justify-content': 'center',
            'border-radius': '8px',
            background: 'rgba(99,102,241,0.9)',
            color: 'white',
            'font-weight': '800',
            'font-size': '14px',
            'letter-spacing': '-0.02em',
          }}
        >
          <Text>M</Text>
        </span>
        <div style={{ display: 'flex', 'flex-direction': 'column' }}>
          <span style={{ 'font-weight': '800', 'letter-spacing': '-0.02em', 'font-size': '14px' }}>
            <Text>Mira</Text>
          </span>
          <span style={{ 'font-size': '11px', opacity: '0.6' }}>
            <Text>better than all — agent platform</Text>
          </span>
        </div>
        <span
          style={{
            margin: '0 8px',
            padding: '3px 8px',
            'border-radius': '999px',
            background: props.connected ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.12)',
            border: props.connected ? '1px solid rgba(16,185,129,0.25)' : '1px solid rgba(239,68,68,0.25)',
            color: props.connected ? '#6ee7b7' : '#fca5a5',
            'font-size': '11px',
            'font-weight': '600',
          }}
          title={props.connected ? 'WebSocket connected (GlobalBus)' : 'WebSocket disconnected — reconnecting…'}
          role="status"
          aria-live="polite"
        >
          <Text>{props.connected ? '● live' : '○ offline'}</Text>
        </span>
      </div>

      <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'font-size': '11px', 'flex-wrap': 'wrap' }}>
        <Show when={(props.queued ?? 0) > 0}>
          <span style={{ color: '#c4b5fd', 'font-weight': '600' }} role="status">
            <Text>⏳ {props.queued} queued</Text>
          </span>
        </Show>
        <Show when={props.hasSession}>
          <button
            type="button"
            onClick={props.onUndo}
            title="Undo last file mutation (u)"
            aria-label="Undo last mutation"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: '#fdba74',
              'font-weight': '600',
              'font-size': '11px',
              padding: '2px 6px',
              'border-radius': '4px',
            }}
          >
            <Text>↩ undo</Text>
          </button>
        </Show>
        <Show when={props.score !== undefined && props.score !== null}>
          <span
            style={{
              padding: '3px 8px',
              'border-radius': '999px',
              border: '1px solid rgba(255,255,255,0.12)',
              background:
                (props.score ?? 0) >= 80
                  ? 'rgba(52,211,153,0.15)'
                  : (props.score ?? 0) >= 60
                    ? 'rgba(251,191,36,0.15)'
                    : 'rgba(248,113,113,0.15)',
              color: (props.score ?? 0) >= 80 ? '#6ee7b7' : (props.score ?? 0) >= 60 ? '#fbbf24' : '#fca5a5',
              'font-size': '11px',
              'font-weight': '700',
              'font-family': font.mono,
            }}
          >
            <Text>◈ {props.score}/100</Text>
          </span>
        </Show>
        <Show when={props.costUSD !== undefined}>
          {(() => {
            const cost = props.costUSD ?? 0
            const cap = props.costCap
            const over = cap != null && cost >= cap
            const pct = cap ? Math.min(100, (cost / cap) * 100) : 0
            const sparkW = 24
            const sparkH = 8
            const points = cap
              ? [0, cost * 0.3, cost * 0.6, cost].map(
                  (v, i) => `${(i * sparkW) / 3},${sparkH - (v / cap) * sparkH}`,
                )
              : []
            return (
              <span
                title={`${cap ? `cap $${cap} (${pct.toFixed(0)}%)` : ''}${props.tokensIn != null ? ` · ${props.tokensIn} in / ${props.tokensOut ?? 0} out` : ''}${over ? ' · ⚠ Budget cap exceeded' : ''}`}
                style={{
                  padding: cap != null ? '3px 6px 3px 8px' : '3px 8px',
                  'border-radius': '999px',
                  background: over ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.15)',
                  border: over ? '1px solid rgba(239,68,68,0.35)' : '1px solid rgba(59,130,246,0.25)',
                  color: over ? '#fca5a5' : '#93c5fd',
                  'font-family': font.mono,
                  'font-weight': '600',
                  display: 'inline-flex',
                  'align-items': 'center',
                  gap: '6px',
                }}
              >
                <Text>${cost.toFixed(4)}{over ? ' ⚠' : ''}</Text>
                <Show when={cap != null}>
                  <span style={{ display: 'inline-flex', 'align-items': 'center', gap: '4px', 'font-size': '10px', opacity: '0.9' }}>
                    <span style={{ width: '32px', height: '4px', background: 'rgba(255,255,255,0.15)', 'border-radius': '2px', overflow: 'hidden', display: 'inline-block' }}>
                      <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: over ? '#f87171' : pct > 80 ? '#fbbf24' : '#60a5fa', 'border-radius': '2px' }} />
                    </span>
                    <Show when={points.length}>
                      <svg width={sparkW} height={sparkH} viewBox={`0 0 ${sparkW} ${sparkH}`} style={{ display: 'block' }} aria-hidden="true">
                        <polyline fill="none" stroke={over ? '#f87171' : '#60a5fa'} stroke-width="1.2" points={points.join(' ')} />
                      </svg>
                    </Show>
                    <Text>{over ? '⚠' : `${pct.toFixed(0)}%`}</Text>
                  </span>
                </Show>
              </span>
            )
          })()}
        </Show>
        <Show when={props.version}>
          <span style={{ opacity: '0.7' }}>
            <Text>v{props.version} · {props.tools ?? 0} tools</Text>
          </span>
        </Show>
        <Show when={props.model}>
          <span
            style={{
              opacity: '0.55',
              'max-width': '220px',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
            }}
          >
            <Text>{props.model}</Text>
          </span>
        </Show>
        {props.children}
      </div>
    </Box>
  )
}

// ── Sidebar ─────────────────────────────────────────────────────
export function Sidebar(props: {
  focused: boolean
  collapsed?: boolean
  width?: string
  children: JSX.Element
  label?: string
}) {
  return (
    <Box
      style={{
        width: props.collapsed ? '44px' : (props.width ?? '260px'),
        'min-width': props.collapsed ? '44px' : '200px',
        display: 'flex',
        'flex-direction': 'column',
        gap: space.sm,
        border: `1px solid ${surface.border}`,
        'border-radius': '10px',
        padding: props.collapsed ? '8px 4px' : '10px',
        background: surface.card,
        overflow: 'hidden',
        'flex-shrink': '0',
        transition: 'width 0.2s ease, border-color 0.15s',
        ...(props.focused ? focusGroupStyle(true) : {}),
      }}
      role="complementary"
      aria-label={props.label ?? 'Sidebar'}
      data-focused={props.focused ? 'true' : 'false'}
      data-tab-group="sidebar"
    >
      {props.children}
    </Box>
  )
}

// ── Main ────────────────────────────────────────────────────────
export function Main(props: {
  focused: boolean
  children: JSX.Element
  label?: string
}) {
  return (
    <Box
      style={{
        flex: '1',
        display: 'flex',
        'flex-direction': 'column',
        gap: '4px',
        border: `1px solid ${surface.border}`,
        'border-radius': '10px',
        padding: '10px',
        background: surface.card,
        overflow: 'hidden',
        position: 'relative',
        'min-width': '0',
        transition: 'border-color 0.15s',
        ...(props.focused ? focusGroupStyle(true) : {}),
      }}
      role="main"
      aria-label={props.label ?? 'Main content'}
      data-focused={props.focused ? 'true' : 'false'}
      data-tab-group="main"
    >
      {props.children}
    </Box>
  )
}

// ── Status Bar ──────────────────────────────────────────────────
export function StatusBar(props: {
  focused?: boolean
  streaming?: boolean
  cost?: string
  sessionCount?: number
  children?: JSX.Element
}) {
  return (
    <Box
      style={{
        display: 'flex',
        'justify-content': 'space-between',
        padding: `0 ${space.sm} ${space.sm} ${space.sm}`,
        'font-size': text.xs,
        opacity: '0.42',
        'flex-shrink': '0',
        'flex-wrap': 'wrap',
        gap: '8px',
      }}
      role="status"
      aria-live="polite"
    >
      <span>
        <Text>
          Mira TUI · SolidJS + @opentui/solid · WS RPC to :4096 · {props.sessionCount ?? 0} sessions
          {props.streaming ? ' · ● streaming' : ''}
        </Text>
      </span>
      <span>
        <Text>Tab switch · ? help · : palette · q quit · Enter send · Esc stop</Text>
      </span>
      {props.children}
    </Box>
  )
}

// ── Input Bar ───────────────────────────────────────────────────
export function InputBar(props: {
  focused: boolean
  children: JSX.Element
}) {
  return (
    <Box
      style={{
        display: 'flex',
        gap: space.sm,
        padding: '10px',
        border: `1px solid ${surface.border}`,
        'border-radius': '10px',
        margin: `0 ${space.sm} ${space.sm} ${space.sm}`,
        background: 'rgba(255,255,255,0.03)',
        'align-items': 'flex-end',
        position: 'relative',
        'flex-shrink': '0',
        transition: 'border-color 0.15s',
        ...(props.focused ? focusGroupStyle(true) : {}),
      }}
      role="group"
      aria-label="Prompt input"
      data-focused={props.focused ? 'true' : 'false'}
      data-tab-stop="input"
    >
      {props.children}
    </Box>
  )
}

// ── Shell — 12-col grid wrapper with responsive handling ────────
export function Shell(props: {
  narrow?: boolean
  children: JSX.Element
}) {
  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100vh',
        'min-height': '420px',
        background: surface.bg,
        color: '#e5e7eb',
        'font-family': font.sans,
        'font-size': text.md,
        overflow: 'hidden',
      }}
      data-narrow={props.narrow ? 'true' : 'false'}
    >
      {props.children}
    </div>
  )
}

// ── Dual Pane — 30/70 split, responsive to narrow ──────────────
export function DualPane(props: {
  narrow: boolean
  sidebar: JSX.Element
  main: JSX.Element
  inspector?: JSX.Element
}) {
  if (props.narrow) {
    return (
      <div
        style={{
          flex: '1',
          overflow: 'hidden',
          display: 'flex',
          'flex-direction': 'column',
          gap: space.sm,
          padding: space.sm,
        }}
      >
        {props.sidebar}
        {props.main}
        {props.inspector}
      </div>
    )
  }
  return (
    <div
      style={{
        flex: '1',
        overflow: 'hidden',
        display: 'flex',
        'flex-direction': 'row',
        gap: space.sm,
        padding: space.sm,
      }}
    >
      {props.sidebar}
      <div
        style={{
          flex: '1',
          overflow: 'hidden',
          display: 'flex',
          'flex-direction': 'column',
          gap: space.sm,
          'min-width': '0',
        }}
      >
        {props.main}
      </div>
      {props.inspector}
    </div>
  )
}

// ── Banner ──────────────────────────────────────────────────────
export function Banner(props: {
  kind: 'warn' | 'error' | 'info'
  message: string
  onDismiss?: () => void
}) {
  const bg =
    props.kind === 'error' ? semantic.danger.bg : props.kind === 'warn' ? semantic.warn.bg : semantic.info.bg
  const borderColor =
    props.kind === 'error' ? semantic.danger.border : props.kind === 'warn' ? semantic.warn.border : semantic.info.border
  const fg =
    props.kind === 'error' ? semantic.danger.fg : props.kind === 'warn' ? semantic.warn.fg : semantic.info.fg
  return (
    <div
      style={{
        margin: `${space.sm} ${space.sm} 0 ${space.sm}`,
        padding: '8px 12px',
        'border-radius': '8px',
        background: bg,
        border: `1px solid ${borderColor}`,
        color: fg,
        'font-size': text.base,
        display: 'flex',
        'justify-content': 'space-between',
        'align-items': 'center',
        'flex-shrink': '0',
      }}
      role={props.kind === 'error' ? 'alert' : 'status'}
    >
      <span>
        <Text>{props.kind === 'error' ? '✗ ' : props.kind === 'warn' ? '⚠ ' : 'ℹ '}{props.message}</Text>
      </span>
      <Show when={props.onDismiss}>
        <button
          onClick={props.onDismiss}
          aria-label="Dismiss"
          style={{
            background: 'transparent',
            border: 'none',
            color: fg,
            cursor: 'pointer',
            'font-size': text.base,
            padding: '2px 6px',
          }}
        >
          <Text>✕</Text>
        </button>
      </Show>
    </div>
  )
}
