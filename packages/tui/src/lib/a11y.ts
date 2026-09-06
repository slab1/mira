/**
 * Accessibility — 2026 TUI Best Practices
 *
 * - Honor NO_COLOR and TERM=dumb
 * - Offer --json / --plain structured output
 * - Clear headings, consistent formatting, predictable spacing
 * - Avoid color-only information, provide text alternatives
 * - Document keyboard shortcuts in help overlay
 */

import { isNoColor, isDumbTerm } from './tokens'

// ── Color mode ──────────────────────────────────────────────────
export type ColorMode = 'full' | 'no-color' | 'dumb'

export function getColorMode(): ColorMode {
  if (isDumbTerm()) return 'dumb'
  if (isNoColor()) return 'no-color'
  return 'full'
}

// ── Screen reader helpers ───────────────────────────────────────
export function srOnlyStyle(): Record<string, string> {
  return {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: '0',
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    'white-space': 'nowrap',
    border: '0',
  }
}

// ── Keyboard help registry ──────────────────────────────────────
export type Keybinding = {
  key: string
  desc: string
  context: 'global' | 'sidebar' | 'messages' | 'input' | 'modal' | 'palette'
}

export const KEYBINDINGS: Keybinding[] = [
  // Global
  { key: 'Tab', desc: 'Cycle focus: sidebar → messages → input', context: 'global' },
  { key: 'Shift+Tab', desc: 'Reverse focus cycle', context: 'global' },
  { key: '?', desc: 'Toggle help overlay', context: 'global' },
  { key: ':', desc: 'Open command palette', context: 'global' },
  { key: 'Ctrl+P', desc: 'Open command palette (alt)', context: 'global' },
  { key: 'q', desc: 'Quit (when no modal)', context: 'global' },
  { key: 'Esc', desc: 'Close modal / stop streaming', context: 'global' },
  // Sidebar
  { key: 'j / ↓', desc: 'Next session', context: 'sidebar' },
  { key: 'k / ↑', desc: 'Previous session', context: 'sidebar' },
  { key: 'Enter', desc: 'Select session', context: 'sidebar' },
  { key: 'n', desc: 'New session', context: 'sidebar' },
  { key: 'd', desc: 'Delete session (with confirm)', context: 'sidebar' },
  { key: '/', desc: 'Search sessions', context: 'sidebar' },
  { key: 'g / G', desc: 'Top / bottom of list', context: 'sidebar' },
  // Messages
  { key: 'j / k', desc: 'Scroll messages', context: 'messages' },
  { key: 'G', desc: 'Jump to latest', context: 'messages' },
  { key: '/', desc: 'Search in messages', context: 'messages' },
  { key: 'c', desc: 'Collapse/expand tool calls', context: 'messages' },
  // Input
  { key: 'Enter', desc: 'Send prompt', context: 'input' },
  { key: 'Shift+Enter', desc: 'New line', context: 'input' },
  { key: '↑ / ↓', desc: 'History (when empty)', context: 'input' },
  { key: '/', desc: 'Slash commands', context: 'input' },
  // Modal
  { key: 'Tab', desc: 'Next field', context: 'modal' },
  { key: 'Shift+Tab', desc: 'Previous field', context: 'modal' },
  { key: 'Enter', desc: 'Confirm', context: 'modal' },
  { key: 'Esc', desc: 'Cancel / close', context: 'modal' },
  { key: '1-9', desc: 'Quick pick option', context: 'modal' },
  // Palette
  { key: '↑ / ↓', desc: 'Navigate results', context: 'palette' },
  { key: 'Enter', desc: 'Execute', context: 'palette' },
  { key: 'Esc', desc: 'Close palette', context: 'palette' },
]

export function keybindingsByContext(context: Keybinding['context']): Keybinding[] {
  return KEYBINDINGS.filter((k) => k.context === context)
}

export function allKeybindingsGrouped(): Record<string, Keybinding[]> {
  const groups: Record<string, Keybinding[]> = {}
  for (const kb of KEYBINDINGS) {
    if (!groups[kb.context]) groups[kb.context] = []
    groups[kb.context].push(kb)
  }
  return groups
}

// ── Plain output mode ───────────────────────────────────────────
export function formatPlainText(sessions: Array<{ id: string; title: string }>, messages: Array<{ role: string; text: string }>): string {
  const lines: string[] = []
  lines.push('# Mira — Sessions')
  for (const s of sessions) lines.push(`- ${s.id.slice(0, 8)}  ${s.title || 'Untitled'}`)
  lines.push('')
  lines.push('# Messages')
  for (const m of messages) lines.push(`[${m.role}] ${m.text}`)
  return lines.join('\n')
}

// ── Announce for screen readers ─────────────────────────────────
export function announce(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
  if (typeof document === 'undefined') return
  const el = document.getElementById('a11y-announcer')
  if (el) {
    el.textContent = message
    el.setAttribute('aria-live', priority)
  } else {
    const div = document.createElement('div')
    div.id = 'a11y-announcer'
    div.setAttribute('aria-live', priority)
    div.setAttribute('aria-atomic', 'true')
    Object.assign(div.style, srOnlyStyle())
    div.textContent = message
    document.body.appendChild(div)
    setTimeout(() => div.remove(), 3000)
  }
}

// ── Help text for --help ────────────────────────────────────────
export function helpText(): string {
  const groups = allKeybindingsGrouped()
  const lines: string[] = []
  lines.push('Mira TUI — Keyboard Reference')
  lines.push('==============================')
  lines.push('')
  for (const [ctx, bindings] of Object.entries(groups)) {
    lines.push(`[${ctx.toUpperCase()}]`)
    for (const b of bindings) {
      lines.push(`  ${b.key.padEnd(16)} ${b.desc}`)
    }
    lines.push('')
  }
  lines.push('Environment:')
  lines.push('  NO_COLOR=1     Disable colors')
  lines.push('  TERM=dumb      Plain output mode')
  lines.push('  --json         Structured JSON output (where supported)')
  lines.push('  --plain        Plain text output')
  lines.push('  --help         Show this help')
  return lines.join('\n')
}
