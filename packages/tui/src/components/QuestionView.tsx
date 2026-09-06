/**
 * QuestionView — HITL question prompt (keyboard-first rebuild)
 *
 * Focus trap, arrow keys for options, Enter to select, Space for multi-select.
 * Respects NO_COLOR / TERM=dumb.
 */

import { Show, For, createSignal, createEffect, onCleanup } from 'solid-js'
import type { PendingQuestion } from '../stores/session'
import { getColorMode } from '../lib/a11y'

type Props = {
  request: PendingQuestion | null
  onSubmit: (answers: Array<{ header: string; selections: string[] }>) => void
}

export default function QuestionView(props: Props) {
  const q = () => props.request
  const [selections, setSelections] = createSignal<Record<string, string[]>>({})
  const [focusedOpt, setFocusedOpt] = createSignal(0)
  let dialogRef: HTMLDivElement | undefined

  const toggle = (header: string, label: string, multiple?: boolean) => {
    setSelections((prev) => {
      const cur = prev[header] ?? []
      if (multiple) {
        return {
          ...prev,
          [header]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
        }
      }
      return { ...prev, [header]: cur.includes(label) ? [] : [label] }
    })
  }

  const submit = () => {
    const req = q()
    if (!req) return
    props.onSubmit(
      req.questions.map((qq) => ({ header: qq.header, selections: selections()[qq.header] ?? [] })),
    )
    setSelections({})
  }

  // Flatten options for keyboard nav
  const flatOptions = () => {
    const req = q()
    if (!req) return [] as Array<{ header: string; label: string; multiple?: boolean; qIdx: number; oIdx: number }>
    const out: Array<{ header: string; label: string; multiple?: boolean; qIdx: number; oIdx: number }> = []
    req.questions.forEach((qq, qIdx) => {
      qq.options.forEach((opt, oIdx) => {
        out.push({ header: qq.header, label: opt.label, multiple: qq.multiple, qIdx, oIdx })
      })
    })
    return out
  }

  createEffect(() => {
    if (!q()) return
    queueMicrotask(() => {
      const el = dialogRef?.querySelector<HTMLElement>('[data-opt-idx="0"]')
      el?.focus()
      setFocusedOpt(0)
    })
    const onKey = (e: KeyboardEvent) => {
      const req = q()
      if (!req) return
      const flat = flatOptions()
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select'

      if (e.key === 'Tab' && dialogRef) {
        const focusable = dialogRef.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        if (focusable.length > 0) {
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
        return
      }
      if (e.key === 'Escape') {
        // Don't submit on Esc — just blur
        ;(e.target as HTMLElement)?.blur()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        const next = Math.min(focusedOpt() + 1, flat.length - 1)
        setFocusedOpt(next)
        dialogRef?.querySelector<HTMLElement>(`[data-opt-idx="${next}"]`)?.focus()
        return
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        const next = Math.max(focusedOpt() - 1, 0)
        setFocusedOpt(next)
        dialogRef?.querySelector<HTMLElement>(`[data-opt-idx="${next}"]`)?.focus()
        return
      }
      if (e.key === 'Enter') {
        const active = document.activeElement as HTMLElement | null
        const idx = active?.getAttribute('data-opt-idx')
        if (idx !== null && idx !== undefined) {
          e.preventDefault()
          const opt = flat[Number(idx)]
          if (opt) toggle(opt.header, opt.label, opt.multiple)
          return
        }
        // Enter on submit button
        if (active?.getAttribute('data-submit') === 'true') {
          e.preventDefault()
          submit()
          return
        }
      }
      if (e.key === ' ') {
        const active = document.activeElement as HTMLElement | null
        const idx = active?.getAttribute('data-opt-idx')
        if (idx !== null && idx !== undefined) {
          e.preventDefault()
          const opt = flat[Number(idx)]
          if (opt) toggle(opt.header, opt.label, opt.multiple)
          return
        }
      }
      if (!isTyping && /^[1-9]$/.test(e.key)) {
        const n = Number(e.key) - 1
        const opt = flat[n]
        if (opt) {
          e.preventDefault()
          toggle(opt.header, opt.label, opt.multiple)
          setFocusedOpt(n)
          dialogRef?.querySelector<HTMLElement>(`[data-opt-idx="${n}"]`)?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    onCleanup(() => document.removeEventListener('keydown', onKey, true))
  })

  return (
    <Show when={q()}>
      {(req) => (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="question-title"
          tabindex={-1}
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '10px',
            padding: '14px',
            'border-radius': '12px',
            background: 'rgba(124,58,237,0.10)',
            border: '1px solid rgba(124,58,237,0.35)',
            'box-shadow': '0 8px 24px rgba(0,0,0,0.35)',
          }}
        >
          <div id="question-title" style={{ 'font-size': '12px', 'font-weight': '700', color: '#c4b5fd', 'letter-spacing': '0.04em' }}>
            QUESTION — {req().questions.length} {req().questions.length === 1 ? 'prompt' : 'prompts'} · arrow keys to navigate · Enter/Space to select
          </div>
          <For each={req().questions}>
            {(question, qIdx) => (
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                  <span
                    style={{
                      'font-size': '11px',
                      'font-weight': '700',
                      color: '#c4b5fd',
                      background: '#2e1065',
                      padding: '2px 7px',
                      'border-radius': '999px',
                    }}
                  >
                    {question.header}
                  </span>
                  <span style={{ 'font-size': '13px', color: '#fafafa', 'font-weight': '600' }}>
                    {question.question}
                  </span>
                  <Show when={question.multiple}>
                    <span style={{ 'font-size': '10px', color: '#9ca3af', 'font-style': 'italic' }}>(multi-select)</span>
                  </Show>
                </div>
                <div role="group" aria-label={question.header} style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                  <For each={question.options}>
                    {(opt, oIdx) => {
                      const selected = () => (selections()[question.header] ?? []).includes(opt.label)
                      // Compute flat index
                      const flatIdx = () => {
                        let idx = 0
                        for (let qi = 0; qi < qIdx(); qi++) idx += req().questions[qi].options.length
                        return idx + oIdx()
                      }
                      const isFocused = () => focusedOpt() === flatIdx()
                      return (
                        <div
                          data-opt-idx={flatIdx()}
                          role={question.multiple ? 'checkbox' : 'radio'}
                          aria-checked={selected() ? 'true' : 'false'}
                          tabindex={0}
                          onClick={() => toggle(question.header, opt.label, question.multiple)}
                          onFocus={() => setFocusedOpt(flatIdx())}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              toggle(question.header, opt.label, question.multiple)
                            }
                          }}
                          style={{
                            cursor: 'pointer',
                            padding: '7px 10px',
                            'border-radius': '8px',
                            border: selected()
                              ? '1px solid #7c3aed'
                              : isFocused()
                                ? '1px solid rgba(124,58,237,0.45)'
                                : '1px solid rgba(255,255,255,0.12)',
                            background: selected() ? '#2e1065' : isFocused() ? 'rgba(124,58,237,0.12)' : 'transparent',
                            'box-shadow': isFocused() ? '0 0 0 1px rgba(124,58,237,0.15)' : 'none',
                            'font-size': '12.5px',
                            color: '#e4e4e7',
                            outline: 'none',
                            display: 'flex',
                            'align-items': 'center',
                            gap: '8px',
                          }}
                        >
                          <span aria-hidden="true" style={{ 'font-weight': '700' }}>
                            {selected() ? '◉' : '○'}
                          </span>
                          <span style={{ 'font-weight': '600' }}>
                            {flatIdx() + 1}. {opt.label}
                          </span>
                          <span style={{ color: '#a1a1aa', 'font-size': '11.5px' }}>
                            {opt.description}
                          </span>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </div>
            )}
          </For>

          <button
            data-submit="true"
            type="button"
            onClick={submit}
            aria-label="Submit answers"
            style={{
              cursor: 'pointer',
              padding: '7px 12px',
              'border-radius': '8px',
              border: 'none',
              background: 'linear-gradient(135deg,#7c3aed,#ec4899)',
              color: '#fff',
              'font-size': '12.5px',
              'font-weight': '700',
            }}
          >
            Submit answer (Enter)
          </button>
          <span style={{ 'font-size': '10px', opacity: '0.45' }}>
            ↑↓ or j/k to navigate · Enter/Space to toggle · 1-9 quick pick · Tab to submit
          </span>
        </div>
      )}
    </Show>
  )
}
