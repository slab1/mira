/**
 * Focus Management — 2026 TUI Best Practices
 *
 * - Focus groups: TabGroup/TabStop, logical Tab order
 * - Hotkeys with underlined chars
 * - Arrow keys for fine-grained nav
 * - Focus trap in modals
 * - Clearly visible focus indicators
 */

import { createSignal, onCleanup, onMount } from 'solid-js'

// ── Focus groups ────────────────────────────────────────────────
export type FocusGroup = 'sidebar' | 'messages' | 'input' | 'inspector' | 'header'
export type FocusState = {
  active: FocusGroup
  sidebarIndex: number
  messageIndex: number
}

export function createFocusManager(initial: FocusGroup = 'input') {
  const [active, setActive] = createSignal<FocusGroup>(initial)
  const [sidebarIndex, setSidebarIndex] = createSignal(0)
  const [messageIndex, setMessageIndex] = createSignal(0)

  const cycle = (dir: 1 | -1 = 1) => {
    const order: FocusGroup[] = ['sidebar', 'messages', 'input']
    const idx = order.indexOf(active())
    const next = (idx + dir + order.length) % order.length
    setActive(order[next])
  }

  const focus = (group: FocusGroup) => setActive(group)

  return {
    active,
    setActive,
    sidebarIndex,
    setSidebarIndex,
    messageIndex,
    setMessageIndex,
    cycle,
    focus,
  }
}

export type FocusManager = ReturnType<typeof createFocusManager>

// ── Focus trap for modals ───────────────────────────────────────
export function createFocusTrap(dialogRef: () => HTMLElement | undefined, enabled: () => boolean) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!enabled()) return
    const el = dialogRef()
    if (!el) return
    if (e.key === 'Tab') {
      const focusable = el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  onMount(() => {
    if (enabled()) window.addEventListener('keydown', onKeyDown)
  })

  // Reactive attach/detach
  const attach = () => {
    if (enabled()) window.addEventListener('keydown', onKeyDown)
    else window.removeEventListener('keydown', onKeyDown)
  }

  onCleanup(() => window.removeEventListener('keydown', onKeyDown))

  return { onKeyDown, attach }
}

// ── Roving tabindex helper ──────────────────────────────────────
export function rovingIndex(current: number, key: string, len: number): number {
  switch (key) {
    case 'ArrowDown':
    case 'j':
      return Math.min(current + 1, len - 1)
    case 'ArrowUp':
    case 'k':
      return Math.max(current - 1, 0)
    case 'Home':
    case 'g':
      return 0
    case 'End':
    case 'G':
      return len - 1
    case 'PageDown':
      return Math.min(current + 10, len - 1)
    case 'PageUp':
      return Math.max(current - 10, 0)
    default:
      return current
  }
}

// ── Focus indicator style ───────────────────────────────────────
export function focusRingStyle(isFocused: boolean): Record<string, string> {
  if (!isFocused) return {}
  return {
    outline: '2px solid rgba(99,102,241,0.6)',
    'outline-offset': '1px',
    'box-shadow': '0 0 0 2px rgba(99,102,241,0.15)',
  }
}

export function focusGroupStyle(isActive: boolean): Record<string, string> {
  if (!isActive) return {}
  return {
    border: '1px solid rgba(99,102,241,0.35)',
    'box-shadow': '0 0 0 1px rgba(99,102,241,0.15)',
  }
}
