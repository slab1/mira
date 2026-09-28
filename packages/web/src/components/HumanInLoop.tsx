/**
 * HumanInLoop — correction, undo, editing, and behavior adjustment patterns.
 *
 * Components:
 *   TeachAgent     — inline form to correct agent behavior
 *   UndoRollback   — one-click undo with confirmation
 *   EditableDraft   — inline editing of agent output
 *   BehaviorAdjust  — slider or toggle for real-time adjustment
 */

import { createSignal, Show } from 'solid-js'
import type { JSX } from 'solid-js'

/* ── Teach Agent ────────────────────────────────────────────────────────── */

export function TeachAgent(props: {
  onSubmit: (correction: string) => void
  onCancel?: () => void
}) {
  const [value, setValue] = createSignal('')

  function submit(e: Event): void {
    e.preventDefault()
    const trimmed = value().trim()
    if (!trimmed) return
    props.onSubmit(trimmed)
    setValue('')
  }

  return (
    <form
      onSubmit={submit}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
        padding: '12px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        'border-radius': 'var(--r-md)',
      }}
    >
      <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-muted)', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' }}>
        Teach Agent
      </div>
      <textarea
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        placeholder="Correct the agent's behavior..."
        rows={3}
        style={{
          width: '100%',
          background: 'var(--bg-app)',
          border: '1px solid var(--border-strong)',
          'border-radius': 'var(--r-md)',
          color: 'var(--fg)',
          'font-family': 'var(--font-sans)',
          'font-size': 'var(--fs-sm)',
          padding: '8px 10px',
          resize: 'vertical',
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
        <Show when={props.onCancel}>
          <button
            type="button"
            onClick={props.onCancel}
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
            Cancel
          </button>
        </Show>
        <button
          type="submit"
          disabled={!value().trim()}
          style={{
            padding: '6px 12px',
            'border-radius': 'var(--r-md)',
            border: '1px solid var(--accent)',
            background: value().trim() ? 'var(--accent)' : 'var(--bg-surface)',
            color: value().trim() ? 'var(--on-accent)' : 'var(--fg-faint)',
            'font-size': 'var(--fs-xs)',
            'font-weight': '600',
            cursor: value().trim() ? 'pointer' : 'not-allowed',
            opacity: value().trim() ? 1 : 0.5,
          }}
        >
          Submit Correction
        </button>
      </div>
    </form>
  )
}

/* ── Undo / Rollback ────────────────────────────────────────────────────── */

export function UndoRollback(props: {
  onUndo: () => void
  onCancel?: () => void
  description?: string
}) {
  const [confirming, setConfirming] = createSignal(false)

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
        padding: '12px',
        background: 'var(--warn-soft)',
        border: '1px solid var(--warn-border)',
        'border-radius': 'var(--r-md)',
      }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
        <span style={{ color: 'var(--warn)', 'font-weight': '700' }}>⚠</span>
        <span style={{ 'font-size': 'var(--fs-sm)', color: 'var(--warn)', 'font-weight': '600' }}>
          Undo Last Action
        </span>
      </div>
      <Show when={props.description}>
        <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-muted)', 'line-height': '1.5' }}>
          {props.description}
        </div>
      </Show>
      <Show when={!confirming()}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setConfirming(true)}
            style={{
              padding: '6px 12px',
              'border-radius': 'var(--r-md)',
              border: '1px solid var(--warn-border)',
              background: 'var(--warn)',
              color: 'var(--on-accent)',
              'font-size': 'var(--fs-xs)',
              'font-weight': '600',
              cursor: 'pointer',
            }}
          >
            Undo
          </button>
          <Show when={props.onCancel}>
            <button
              onClick={props.onCancel}
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
              Cancel
            </button>
          </Show>
        </div>
      </Show>
      <Show when={confirming()}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--warn)' }}>
            Are you sure? This will revert the last change.
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => {
                props.onUndo()
                setConfirming(false)
              }}
              style={{
                padding: '6px 12px',
                'border-radius': 'var(--r-md)',
                border: '1px solid var(--danger-border)',
                background: 'var(--danger)',
                color: 'var(--on-accent)',
                'font-size': 'var(--fs-xs)',
                'font-weight': '600',
                cursor: 'pointer',
              }}
            >
              Confirm Undo
            </button>
            <button
              onClick={() => setConfirming(false)}
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
              Keep
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

/* ── Editable Draft ─────────────────────────────────────────────────────── */

export function EditableDraft(props: {
  content: string
  onSave: (content: string) => void
  onCancel?: () => void
}) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal(props.content)

  function save(): void {
    props.onSave(draft())
    setEditing(false)
  }

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <Show when={!editing()}>
        <div
          onClick={() => {
            setDraft(props.content)
            setEditing(true)
          }}
          role="button"
          tabindex="0"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDraft(props.content); setEditing(true) } }}
          style={{
            padding: '10px 12px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            'border-radius': 'var(--r-md)',
            'font-size': 'var(--fs-sm)',
            color: 'var(--fg)',
            'white-space': 'pre-wrap',
            cursor: 'pointer',
            transition: 'border-color var(--dur-fast) var(--ease)',
          }}
        >
          {props.content}
          <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'margin-top': '4px' }}>
            Click to edit
          </div>
        </div>
      </Show>
      <Show when={editing()}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <textarea
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            rows={6}
            style={{
              width: '100%',
              background: 'var(--bg-app)',
              border: '1px solid var(--accent-border)',
              'border-radius': 'var(--r-md)',
              color: 'var(--fg)',
              'font-family': 'var(--font-mono)',
              'font-size': 'var(--fs-sm)',
              padding: '8px 10px',
              resize: 'vertical',
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
            <Show when={props.onCancel}>
              <button
                onClick={() => {
                  setDraft(props.content)
                  setEditing(false)
                  props.onCancel?.()
                }}
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
                Cancel
              </button>
            </Show>
            <button
              onClick={save}
              style={{
                padding: '6px 12px',
                'border-radius': 'var(--r-md)',
                border: '1px solid var(--accent)',
                background: 'var(--accent)',
                color: 'var(--on-accent)',
                'font-size': 'var(--fs-xs)',
                'font-weight': '600',
                cursor: 'pointer',
              }}
            >
              Save
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

/* ── Behavior Adjust ────────────────────────────────────────────────────── */

export function BehaviorAdjust(props: {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  description?: string
}) {
  const min = () => props.min ?? 0
  const max = () => props.max ?? 100
  const step = () => props.step ?? 1

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
        <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', color: 'var(--fg)' }}>
          {props.label}
        </span>
        <span style={{ 'font-size': 'var(--fs-sm)', color: 'var(--accent)', 'font-family': 'var(--font-mono)', 'font-weight': '700' }}>
          {props.value}
        </span>
      </div>
      <Show when={props.description}>
        <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-faint)', 'line-height': '1.4' }}>
          {props.description}
        </div>
      </Show>
      <input
        type="range"
        min={min()}
        max={max()}
        step={step()}
        value={props.value}
        onInput={(e) => props.onChange(Number(e.currentTarget.value))}
        style={{
          width: '100%',
          'accent-color': 'var(--accent)',
          cursor: 'pointer',
        }}
      />
    </div>
  )
}
