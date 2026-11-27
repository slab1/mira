// @ts-nocheck
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import {
  api,
  type ResearchPlanTrack,
  type ResearchRunDTO,
} from '../api/client'
import { toast } from './Toast'

import {
  formatResearchModeLabel as formatModeLabel,
  parseResearchMarkdownBlocks,
  safeHttpHref,
  tokenizeInline,
} from './researchHelpers'

export { parseResearchMarkdownBlocks, safeHttpHref }

const STEP_LABELS: Record<string, string> = {
  thought: 'Plan & Reason',
  search_query: 'Web Search',
  url_read: 'Read Source',
  synthesis: 'Synthesize',
  error: 'Error',
}

function statusColor(status: string): string {
  if (status === 'completed') return 'var(--ok)'
  if (status === 'running' || status === 'planning') return 'var(--accent)'
  if (status === 'awaiting_approval') return 'var(--warn)'
  if (status === 'failed') return 'var(--danger)'
  return 'var(--fg-subtle)'
}

function renderInlineWithCitations(
  text: string,
  onCitationClick: (idx: number) => void,
) {
  const parts = tokenizeInline(text)
  return (
    <For each={parts}>
      {(seg) => {
        if (seg.kind === 'cite') {
          return (
            <button
              type="button"
              onClick={() => seg.index && onCitationClick(seg.index)}
              title={`Jump to citation [${seg.index}]`}
              style={{
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
                border: '1px solid var(--accent-border)',
                'border-radius': '4px',
                padding: '0 4px',
                margin: '0 1px',
                'font-size': 'var(--fs-2xs)',
                'font-family': 'var(--font-mono)',
                cursor: 'pointer',
                'vertical-align': 'baseline',
              }}
            >
              {seg.value}
            </button>
          )
        }
        if (seg.kind === 'link') {
          return (
            <a
              href={seg.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: 'var(--accent)',
                'text-decoration': 'underline',
                'text-underline-offset': '2px',
              }}
            >
              {seg.label}
            </a>
          )
        }
        if (seg.kind === 'code') {
          return (
            <code
              style={{
                'font-family': 'var(--font-mono)',
                'font-size': '0.9em',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                'border-radius': '3px',
                padding: '1px 4px',
                color: 'var(--fg)',
              }}
            >
              {seg.value}
            </code>
          )
        }
        if (seg.kind === 'bold') {
          return <strong style={{ color: 'var(--fg)', 'font-weight': '600' }}>{seg.value}</strong>
        }
        if (seg.kind === 'italic') {
          return <em style={{ 'font-style': 'italic' }}>{seg.value}</em>
        }
        return <span>{seg.value}</span>
      }}
    </For>
  )
}


export function ResearchReportMarkdown(props: {
  markdown: string
  onCitationClick: (idx: number) => void
}) {
  const blocks = createMemo(() => parseResearchMarkdownBlocks(props.markdown))

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', 'line-height': '1.65' }}>
      <For each={blocks()}>
        {(b) => {
          if (b.kind === 'spacer') return <div style={{ height: '4px' }} />
          if (b.kind === 'h1' || b.kind === 'h2') {
            return (
              <div
                style={{
                  'font-size': b.kind === 'h1' ? 'var(--fs-lg)' : 'var(--fs-md)',
                  'font-weight': '700',
                  color: 'var(--fg)',
                  'margin-top': '8px',
                }}
              >
                {renderInlineWithCitations(b.text, props.onCitationClick)}
              </div>
            )
          }
          if (b.kind === 'h3') {
            return (
              <div
                style={{
                  'font-size': 'var(--fs-sm)',
                  'font-weight': '600',
                  color: 'var(--fg)',
                  'margin-top': '6px',
                }}
              >
                {renderInlineWithCitations(b.text, props.onCitationClick)}
              </div>
            )
          }
          if (b.kind === 'quote') {
            return (
              <div
                style={{
                  'border-left': '2px solid var(--accent-border)',
                  'padding-left': '10px',
                  color: 'var(--fg-subtle)',
                  'font-size': 'var(--fs-sm)',
                }}
              >
                {renderInlineWithCitations(b.text, props.onCitationClick)}
              </div>
            )
          }
          if (b.kind === 'code') {
            return (
              <pre
                style={{
                  margin: '4px 0',
                  padding: '10px 12px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-sm)',
                  'font-family': 'var(--font-mono)',
                  'font-size': 'var(--fs-xs)',
                  overflow: 'auto',
                  color: 'var(--fg)',
                  'line-height': '1.5',
                }}
              >
                <code>{b.code}</code>
              </pre>
            )
          }
          if (b.kind === 'table') {
            return (
              <div
                style={{
                  'overflow-x': 'auto',
                  margin: '4px 0',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-sm)',
                }}
              >
                <table
                  style={{
                    width: '100%',
                    'border-collapse': 'collapse',
                    'font-size': 'var(--fs-xs)',
                    'text-align': 'left',
                  }}
                >
                  <thead>
                    <tr style={{ background: 'var(--bg-surface)', 'border-bottom': '1px solid var(--border)' }}>
                      <For each={b.headers}>
                        {(h) => (
                          <th
                            style={{
                              padding: '7px 10px',
                              'font-weight': '600',
                              color: 'var(--fg)',
                              'white-space': 'nowrap',
                            }}
                          >
                            {renderInlineWithCitations(h, props.onCitationClick)}
                          </th>
                        )}
                      </For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={b.rows}>
                      {(row) => (
                        <tr style={{ 'border-top': '1px solid var(--border)' }}>
                          <For each={b.headers}>
                            {(_, ci) => (
                              <td
                                style={{
                                  padding: '6px 10px',
                                  color: 'var(--fg-muted)',
                                  'vertical-align': 'top',
                                }}
                              >
                                {renderInlineWithCitations(row[ci()] ?? '', props.onCitationClick)}
                              </td>
                            )}
                          </For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            )
          }
          if (b.kind === 'li') {
            return (
              <div
                style={{
                  display: 'flex',
                  gap: '8px',
                  'padding-left': '6px',
                  'font-size': 'var(--fs-sm)',
                  color: 'var(--fg-muted)',
                }}
              >
                <span style={{ color: 'var(--accent)', 'flex-shrink': '0', 'font-family': b.bullet !== '•' ? 'var(--font-mono)' : undefined }}>
                  {b.bullet}
                </span>
                <div style={{ flex: '1', 'min-width': '0' }}>
                  {renderInlineWithCitations(b.text, props.onCitationClick)}
                </div>
              </div>
            )
          }
          return (
            <div style={{ 'font-size': 'var(--fs-sm)', color: 'var(--fg-muted)' }}>
              {renderInlineWithCitations(b.text, props.onCitationClick)}
            </div>
          )
        }}
      </For>
    </div>
  )
}

export function ResearchTimeline(props: {
  run: ResearchRunDTO
  onUpdated?: (run: ResearchRunDTO) => void
  onPromoted?: (entryId: string) => void
  onOpenBranch?: (sessionId: string) => void
  onRetry?: (run: ResearchRunDTO) => void
  onInsertToChat?: (run: ResearchRunDTO) => void
  onDismiss?: (runId: string) => void
}) {
  const [editablePlan, setEditablePlan] = createSignal<ResearchPlanTrack[]>([])
  const [approving, setApproving] = createSignal(false)
  const [cancelling, setCancelling] = createSignal(false)
  const [promoting, setPromoting] = createSignal(false)
  const [memoryTitle, setMemoryTitle] = createSignal('')
  const [highlightedCitation, setHighlightedCitation] = createSignal<number | null>(null)
  const [stepsExpanded, setStepsExpanded] = createSignal(true)

  let syncedRunId = ''
  let syncedPlanSeeded = false

  createEffect(() => {
    const r = props.run
    const incomingPlan = r.plan ?? []
    if (r.id !== syncedRunId) {
      syncedRunId = r.id
      syncedPlanSeeded = incomingPlan.length > 0
      setEditablePlan(incomingPlan.map((t) => ({ ...t })))
      setMemoryTitle(`Research: ${r.query.slice(0, 72)}`)
      setHighlightedCitation(null)
      return
    }
    if (!syncedPlanSeeded && incomingPlan.length > 0) {
      syncedPlanSeeded = true
      setEditablePlan(incomingPlan.map((t) => ({ ...t })))
    }
  })

  const durationSec = createMemo(() => {
    const end = props.run.completedAt ?? props.run.updatedAt
    if (!end || !props.run.createdAt) return null
    return Math.max(0.1, (end - props.run.createdAt) / 1000).toFixed(1)
  })

  const handleUpdateTrack = (idx: number, field: keyof ResearchPlanTrack, value: string) => {
    setEditablePlan((prev) =>
      prev.map((t, i) => (i === idx ? { ...t, [field]: value } : t)),
    )
  }

  const handleAddTrack = () => {
    if (editablePlan().length >= 4) return
    setEditablePlan((prev) => [
      ...prev,
      {
        id: `track-${prev.length + 1}`,
        title: `Track ${prev.length + 1}`,
        query: props.run.query,
        focus: 'Additional verification & sources',
      },
    ])
  }

  const handleRemoveTrack = (idx: number) => {
    if (editablePlan().length <= 1) return
    setEditablePlan((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleApprove = async () => {
    const cleaned = editablePlan()
      .map((t, i) => ({
        id: t.id || `track_${i + 1}`,
        title: t.title.trim() || `Track ${i + 1}`,
        query: t.query.trim() || props.run.query,
        focus: t.focus.trim(),
      }))
    setApproving(true)
    try {
      const updated = await api.approveResearchRun(props.run.id, cleaned)
      props.onUpdated?.(updated)
      toast.success('Research plan approved — running live investigation')
    } catch (e) {
      toast.error(`Failed to start research: ${(e as Error).message}`)
    } finally {
      setApproving(false)
    }
  }

  const handleCancel = async () => {
    setCancelling(true)
    try {
      const updated = await api.cancelResearchRun(props.run.id)
      props.onUpdated?.(updated)
      toast.success('Research cancelled')
    } catch (e) {
      toast.error(`Cancel failed: ${(e as Error).message}`)
    } finally {
      setCancelling(false)
    }
  }

  const handlePromote = async () => {
    setPromoting(true)
    try {
      const res = await api.promoteResearchToMemory(
        props.run.id,
        memoryTitle().trim() || undefined,
      )
      props.onUpdated?.({ ...props.run, promotedMemoryId: res.entry.id })
      props.onPromoted?.(res.entry.id)
      toast.success('Saved research brief & citations to Semantic Memory')
    } catch (e) {
      toast.error(`Promote failed: ${(e as Error).message}`)
    } finally {
      setPromoting(false)
    }
  }

  const handleCopyReport = async () => {
    const md = props.run.reportMarkdown
    if (!md) return
    const cites = (props.run.citations ?? [])
      .map((c) => `[${c.index}] ${c.title || c.url} — ${c.url}`)
      .join('\n')
    try {
      await navigator.clipboard.writeText(cites ? `${md}\n\nSources:\n${cites}` : md)
      toast.success('Copied research report')
    } catch {
      toast.error('Failed to copy report to clipboard')
    }
  }

  const jumpToCitation = (idx: number) => {
    setHighlightedCitation(idx)
    const el = document.getElementById(`research-cite-${props.run.id}-${idx}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  return (
    <div
      class="card"
      data-slot="research-timeline"
      style={{
        padding: '16px',
        display: 'flex',
        'flex-direction': 'column',
        gap: '14px',
        border: '1px solid var(--border)',
        background: 'var(--bg-surface)',
      }}
    >
      {/* Header & flat metadata strip */}
      <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '12px', 'flex-wrap': 'wrap', 'align-items': 'flex-start' }}>
        <div style={{ flex: '1', 'min-width': '220px', display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
          <div style={{ 'font-size': 'var(--fs-md)', 'font-weight': '600', color: 'var(--fg)' }}>
            {props.run.query}
          </div>
          <div
            class="tabular-nums"
            style={{
              display: 'flex',
              gap: '8px',
              'flex-wrap': 'wrap',
              'align-items': 'center',
              'font-size': 'var(--fs-xs)',
              color: 'var(--fg-subtle)',
              'font-family': 'var(--font-mono)',
            }}
          >
            <span style={{ color: statusColor(props.run.status), 'font-weight': '600' }}>
              ● {props.run.status.replace('_', ' ')}
            </span>
            <span>·</span>
            <span>{formatModeLabel(props.run.mode)}</span>
            <Show when={props.run.provider}>
              <span>·</span>
              <span>{props.run.provider}</span>
            </Show>
            <span>·</span>
            <span>{(props.run.steps ?? []).length} steps</span>
            <span>·</span>
            <span>{(props.run.citations ?? []).length} sources</span>
            <Show when={durationSec()}>
              <span>·</span>
              <span>{durationSec()}s</span>
            </Show>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap', 'align-items': 'center' }}>
          <Show when={props.run.branchSessionID && props.onOpenBranch}>
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => props.onOpenBranch?.(props.run.branchSessionID!)}
              style={{
                padding: '5px 10px',
                'font-size': 'var(--fs-xs)',
                border: '1px solid var(--accent-border)',
                color: 'var(--accent)',
                'border-radius': 'var(--r-sm)',
              }}
            >
              ⎇ Open Branch in Work
            </button>
          </Show>
          <Show when={props.run.status === 'running' || props.run.status === 'planning' || props.run.status === 'awaiting_approval'}>
            <button
              type="button"
              class="btn btn-danger-ghost"
              disabled={cancelling()}
              onClick={() => void handleCancel()}
              style={{
                padding: '5px 10px',
                'font-size': 'var(--fs-xs)',
                'border-radius': 'var(--r-sm)',
              }}
            >
              {cancelling() ? 'Cancelling…' : '■ Cancel'}
            </button>
          </Show>
          <Show when={(props.run.status === 'failed' || props.run.status === 'cancelled') && props.onRetry}>
            <button
              type="button"
              class="btn btn-outline"
              onClick={() => props.onRetry?.(props.run)}
              style={{
                padding: '5px 10px',
                'font-size': 'var(--fs-xs)',
                'border-radius': 'var(--r-sm)',
              }}
            >
              ↻ Retry
            </button>
          </Show>
          <Show when={props.run.reportMarkdown}>
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => void handleCopyReport()}
              style={{
                padding: '5px 10px',
                'font-size': 'var(--fs-xs)',
                border: '1px solid var(--border)',
                'border-radius': 'var(--r-sm)',
              }}
            >
              ⧉ Copy Report
            </button>
          </Show>
          <Show when={props.run.reportMarkdown && props.onInsertToChat}>
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => props.onInsertToChat?.(props.run)}
              style={{
                padding: '5px 10px',
                'font-size': 'var(--fs-xs)',
                border: '1px solid var(--accent-border)',
                color: 'var(--accent)',
                'border-radius': 'var(--r-sm)',
              }}
            >
              ↵ Use in Chat
            </button>
          </Show>
          <Show when={props.onDismiss}>
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => props.onDismiss?.(props.run.id)}
              title="Hide research card"
              aria-label="Hide research card"
              style={{
                padding: '5px 8px',
                'font-size': 'var(--fs-xs)',
                border: '1px solid var(--border)',
                'border-radius': 'var(--r-sm)',
                color: 'var(--fg-subtle)',
              }}
            >
              ✕
            </button>
          </Show>
        </div>
      </div>

      {/* Collaborative Plan Editor (when awaiting approval) */}
      <Show when={props.run.status === 'awaiting_approval'}>
        <div
          style={{
            padding: '12px',
            background: 'var(--bg-app)',
            border: '1px solid var(--warn-border)',
            'border-radius': 'var(--r-md)',
            display: 'flex',
            'flex-direction': 'column',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
            <div>
              <div style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', color: 'var(--fg)' }}>
                Review Investigation Plan
              </div>
              <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                Edit search tracks before Mira runs live web grounding and synthesis.
              </div>
            </div>
            <Show when={editablePlan().length < 4}>
              <button
                type="button"
                class="btn btn-ghost"
                onClick={handleAddTrack}
                style={{
                  padding: '4px 10px',
                  'font-size': 'var(--fs-xs)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-sm)',
                }}
              >
                + Add Track
              </button>
            </Show>
          </div>
          <For each={editablePlan()}>
            {(track, idx) => (
              <div
                style={{
                  padding: '10px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-sm)',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '6px',
                }}
              >
                <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                  <input
                    type="text"
                    value={track.title}
                    onInput={(e) => handleUpdateTrack(idx(), 'title', e.currentTarget.value)}
                    placeholder="Track title"
                    style={{
                      flex: '1',
                      padding: '5px 8px',
                      background: 'var(--bg-app)',
                      border: '1px solid var(--border)',
                      'border-radius': 'var(--r-sm)',
                      color: 'var(--fg)',
                      'font-size': 'var(--fs-xs)',
                      'font-weight': '600',
                    }}
                  />
                  <Show when={editablePlan().length > 1}>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      onClick={() => handleRemoveTrack(idx())}
                      aria-label="Remove track"
                      style={{ padding: '4px 8px', 'font-size': 'var(--fs-xs)', color: 'var(--danger)' }}
                    >
                      ✕
                    </button>
                  </Show>
                </div>
                <input
                  type="text"
                  value={track.query}
                  onInput={(e) => handleUpdateTrack(idx(), 'query', e.currentTarget.value)}
                  placeholder="Exact web search query"
                  style={{
                    padding: '5px 8px',
                    background: 'var(--bg-app)',
                    border: '1px solid var(--border)',
                    'border-radius': 'var(--r-sm)',
                    color: 'var(--fg)',
                    'font-size': 'var(--fs-xs)',
                    'font-family': 'var(--font-mono)',
                  }}
                />
                <input
                  type="text"
                  value={track.focus}
                  onInput={(e) => handleUpdateTrack(idx(), 'focus', e.currentTarget.value)}
                  placeholder="Verification focus"
                  style={{
                    padding: '4px 8px',
                    background: 'var(--bg-app)',
                    border: '1px solid var(--border)',
                    'border-radius': 'var(--r-sm)',
                    color: 'var(--fg-subtle)',
                    'font-size': 'var(--fs-xs)',
                  }}
                />
              </div>
            )}
          </For>
          <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: '8px' }}>
            <button
              type="button"
              class="btn btn-solid"
              disabled={approving()}
              onClick={() => void handleApprove()}
              style={{ padding: '7px 14px', 'font-size': 'var(--fs-xs)' }}
            >
              {approving() ? 'Starting…' : 'Approve & Run Investigation →'}
            </button>
          </div>
        </div>
      </Show>

      {/* Error banner */}
      <Show when={props.run.error}>
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--danger-soft)',
            border: '1px solid var(--danger-border)',
            'border-radius': 'var(--r-sm)',
            color: 'var(--danger)',
            'font-size': 'var(--fs-xs)',
            'line-height': '1.5',
          }}
        >
          {props.run.error}
        </div>
      </Show>

      {/* Proof-of-Work Live Steps */}
      <Show when={(props.run.steps ?? []).length > 0}>
        <div
          style={{
            background: 'var(--bg-app)',
            border: '1px solid var(--border)',
            'border-radius': 'var(--r-md)',
            overflow: 'hidden',
          }}
        >
          <button
            type="button"
            onClick={() => setStepsExpanded(!stepsExpanded())}
            style={{
              width: '100%',
              display: 'flex',
              'justify-content': 'space-between',
              'align-items': 'center',
              padding: '9px 12px',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--fg)',
              'font-size': 'var(--fs-xs)',
              'font-weight': '600',
            }}
          >
            <span>
              {stepsExpanded() ? '▼' : '▶'} Live Proof-of-Work Timeline ({props.run.steps.length})
            </span>
            <Show when={props.run.status === 'running' || props.run.status === 'planning'}>
              <span style={{ color: 'var(--accent)', 'font-weight': '500' }}>Streaming…</span>
            </Show>
          </button>
          <Show when={stepsExpanded()}>
            <div
              style={{
                padding: '0 12px 10px',
                display: 'flex',
                'flex-direction': 'column',
                gap: '8px',
                'border-top': '1px solid var(--border)',
              }}
            >
              <For each={props.run.steps}>
                {(step, i) => {
                  const stepHref = safeHttpHref(step.url)
                  return (
                    <div
                      style={{
                        display: 'flex',
                        gap: '10px',
                        'align-items': 'flex-start',
                        'padding-top': i() === 0 ? '8px' : '0',
                        'font-size': 'var(--fs-xs)',
                      }}
                    >
                      <span
                        class="tabular-nums"
                        style={{
                          color: step.kind === 'error' ? 'var(--danger)' : 'var(--accent)',
                          'font-family': 'var(--font-mono)',
                          'min-width': '92px',
                          'flex-shrink': '0',
                        }}
                      >
                        {STEP_LABELS[step.kind] ?? step.kind}
                      </span>
                      <div style={{ flex: '1', 'min-width': '0' }}>
                        <div style={{ color: 'var(--fg)', 'font-weight': '500' }}>{step.title}</div>
                        <Show when={step.detail}>
                          <div style={{ color: 'var(--fg-subtle)', 'margin-top': '2px' }}>
                            {step.detail}
                          </div>
                        </Show>
                        <Show when={stepHref}>
                          {(href) => (
                            <a
                              href={href()}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                display: 'inline-block',
                                'margin-top': '2px',
                                color: 'var(--accent)',
                                'font-family': 'var(--font-mono)',
                                'word-break': 'break-all',
                              }}
                            >
                              {step.url}
                            </a>
                          )}
                        </Show>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* Final Synthesis Report */}
      <Show when={props.run.reportMarkdown}>
        <div
          style={{
            padding: '14px',
            background: 'var(--bg-app)',
            border: '1px solid var(--border)',
            'border-radius': 'var(--r-md)',
          }}
        >
          <ResearchReportMarkdown
            markdown={props.run.reportMarkdown}
            onCitationClick={jumpToCitation}
          />
        </div>
      </Show>

      {/* Citations & Promote-to-Memory */}
      <Show when={(props.run.citations ?? []).length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg)' }}>
            Verified Sources ({props.run.citations.length})
          </div>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <For each={props.run.citations}>
              {(cite) => {
                const isHit = () => highlightedCitation() === cite.index
                const citeHref = safeHttpHref(cite.url)
                return (
                  <div
                    id={`research-cite-${props.run.id}-${cite.index}`}
                    style={{
                      padding: '8px 10px',
                      background: isHit() ? 'var(--accent-soft)' : 'var(--bg-app)',
                      border: isHit() ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                      'border-radius': 'var(--r-sm)',
                      'font-size': 'var(--fs-xs)',
                    }}
                  >
                    <div style={{ display: 'flex', gap: '8px', 'align-items': 'baseline', 'flex-wrap': 'wrap' }}>
                      <span class="tabular-nums" style={{ 'font-family': 'var(--font-mono)', color: 'var(--accent)', 'font-weight': '600' }}>
                        [{cite.index}]
                      </span>
                      <Show
                        when={citeHref}
                        fallback={
                          <span style={{ color: 'var(--fg)', 'font-weight': '600' }}>
                            {cite.title || cite.url}
                          </span>
                        }
                      >
                        {(href) => (
                          <a
                            href={href()}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'var(--fg)', 'font-weight': '600', 'text-decoration': 'none' }}
                          >
                            {cite.title || cite.url}
                          </a>
                        )}
                      </Show>
                      <span style={{ color: 'var(--fg-faint)', 'font-family': 'var(--font-mono)' }}>
                        {cite.domain}
                      </span>
                    </div>
                    <Show when={cite.snippet}>
                      <div style={{ color: 'var(--fg-subtle)', 'margin-top': '3px', 'line-height': '1.45' }}>
                        {cite.snippet}
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      </Show>

      {/* Promote to Semantic Memory Bar */}
      <Show when={props.run.status === 'completed' && props.run.reportMarkdown}>
        <div
          style={{
            display: 'flex',
            gap: '8px',
            'align-items': 'center',
            'flex-wrap': 'wrap',
            'padding-top': '10px',
            'border-top': '1px solid var(--border)',
          }}
        >
          <Show
            when={!props.run.promotedMemoryId}
            fallback={
              <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--ok)', 'font-weight': '600' }}>
                ✓ Saved to Semantic Memory ({props.run.promotedMemoryId?.slice(0, 12)})
              </span>
            }
          >
            <input
              type="text"
              value={memoryTitle()}
              onInput={(e) => setMemoryTitle(e.currentTarget.value)}
              placeholder="Title for Semantic Memory"
              style={{
                flex: '1',
                'min-width': '180px',
                padding: '6px 10px',
                background: 'var(--bg-app)',
                border: '1px solid var(--border)',
                'border-radius': 'var(--r-sm)',
                color: 'var(--fg)',
                'font-size': 'var(--fs-xs)',
              }}
            />
            <button
              type="button"
              class="btn btn-solid"
              disabled={promoting()}
              onClick={() => void handlePromote()}
              style={{ padding: '6px 12px', 'font-size': 'var(--fs-xs)' }}
            >
              {promoting() ? 'Saving…' : 'Save to Semantic Memory'}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
