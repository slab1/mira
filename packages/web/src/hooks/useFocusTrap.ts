import { createEffect, onCleanup } from 'solid-js'

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export function useFocusTrap(
  open: () => boolean,
  containerRef: () => HTMLElement | undefined,
  onClose: () => void,
): void {
  createEffect(() => {
    if (!open()) return
    queueMicrotask(() => {
      const root = containerRef()
      if (!root) return
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE)
      const first = focusables[0]
      if (first) first.focus()
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const root = containerRef()
      if (!root) return
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    onCleanup(() => document.removeEventListener('keydown', onKey, true))
  })
}
