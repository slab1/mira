/**
 * ProvenanceView — TUI port of web/src/components/ProvenancePanel.tsx
 *
 * Renders provenance (memory sources) attached to a Message.
 * Shows tier-colored nodes with inject/forget/promote actions.
 */

import { createSignal, Show, For } from 'solid-js'
import type { Message } from '../rpc/client'
import { rpc } from '../rpc/client'

type Props = {
  message: Message
}

function tierColor(tier: string): string {
  switch (tier) {
    case 'episodic':
      return '#8b5cf6'
    case 'semantic':
      return '#10b981'
    case 'procedural':
      return '#f59e0b'
    default:
      return '#6b7280'
  }
}

function fmtTime(ts: number): string {
  try {
    const d = new Date(ts)
    return (
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' · ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    )
  } catch {
    return ''
  }
}

export default function ProvenanceView(props: Props) {
  const prov = () => props.message.provenance ?? []
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal<Record<string, boolean>>({})
  const [confirmForget, setConfirmForget] = createSignal<string | null>(null)

  const setBusyFor = (id: string, v: boolean) => {
    setBusy((prev) => ({ ...prev, [id]: v }))
  }

  const handleInject = async (id: string) => {
    setBusyFor(id, true)
    try {
      await rpc.touchKnowledge(id)
    } catch (e) {
      console.warn('[mira] touch failed', e)
    }
    setBusyFor(id, false)
  }

  const handleForget = async (id: string) => {
    setConfirmForget(id)
  }

  const performForget = async () => {
    const id = confirmForget()
    setConfirmForget(null)
    if (!id) return
    setBusyFor(id, true)
    try {
      await rpc.deleteKnowledge(id)
    } catch (e) {
      console.warn('[mira] forget failed', e)
    } finally {
      setBusyFor(id, false)
    }
  }

  const handlePromote = async (id: string) => {
    setBusyFor(id, true)
    try {
      await rpc.promoteFinding(id)
    } catch (e) {
      console.warn('[mira] promote failed', e)
    }
    setBusyFor(id, false)
  }

  return (
    <Show when={prov().length > 0}>
      <div style={{ 'margin-top': '8px' }}>
        <button
          type="button"
          aria-expanded={open() ? 'true' : 'false'}
          aria-controls={`prov-${props.message.id}`}
          onClick={() => setOpen(!open())}
          style={{
            padding: '3px 8px',
            'border-radius': '999px',
            border: '1px solid rgba(255,255,255,0.12)',
            background: open() ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.06)',
            color: open() ? '#a5b4fc' : '#9ca3af',
            cursor: 'pointer',
            'font-size': '11px',
            display: 'inline-flex',
            'align-items': 'center',
            gap: '4px',
          }}
        >
          <span>📚</span>
          Sources
          <span style={{ 'margin-left': '4px', 'font-size': '10px', color: '#6b7280' }}>
            {prov().length}
          </span>
          <span style={{ 'margin-left': '4px' }}>{open() ? '▼' : '▶'}</span>
        </button>

        <Show when={open()}>
          <div
            id={`prov-${props.message.id}`}
            role="region"
            aria-label="Memory provenance"
            style={{
              'margin-top': '6px',
              padding: '8px 10px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              'border-radius': '8px',
            }}
          >
            <For each={prov()}>
              {(node) => (
                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '4px',
                    padding: '6px 0',
                    'border-bottom': '1px solid rgba(255,255,255,0.06)',
                    'font-size': '12px',
                  }}
                >
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: '8px',
                        height: '8px',
                        'border-radius': '50%',
                        background: tierColor(node.tier),
                        flex: 'none',
                        'box-shadow': `0 0 0 2px color-mix(in srgb, ${tierColor(node.tier)} 20%, transparent)`,
                      }}
                    />
                    <strong style={{ 'font-weight': '600', color: '#e5e7eb' }}>{node.label}</strong>
                    <span
                      style={{
                        'font-size': '10px',
                        color: '#6b7280',
                        'text-transform': 'capitalize',
                      }}
                    >
                      {node.tier} · {node.kind}
                    </span>
                    <span
                      style={{
                        'margin-left': 'auto',
                        'font-size': '10px',
                        color: '#6b7280',
                        'font-family': 'ui-monospace, monospace',
                      }}
                    >
                      {fmtTime(node.updatedAt)} · {node.accessCount} hits
                    </span>
                  </div>
                  <div style={{ 'font-size': '10px', color: '#9ca3af', 'margin-left': '16px' }}>
                    source: {node.source}
                    <Show when={node.tags && node.tags.length}>
                      <span style={{ 'margin-left': '8px' }}>
                        {node.tags!.map((t) => `#${t}`).join(' ')}
                      </span>
                    </Show>
                  </div>
                  <Show when={node.snippet}>
                    <div
                      style={{
                        'font-size': '10px',
                        color: '#9ca3af',
                        'margin-left': '16px',
                        'white-space': 'pre-wrap',
                        'word-break': 'break-word',
                        background: 'rgba(0,0,0,0.28)',
                        padding: '4px 6px',
                        'border-radius': '4px',
                        border: '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      {node.snippet}
                    </div>
                  </Show>
                  <div
                    style={{
                      display: 'flex',
                      gap: '6px',
                      'margin-left': '16px',
                      'margin-top': '2px',
                    }}
                  >
                    <button
                      type="button"
                      disabled={busy()[node.nodeId]}
                      onClick={() => void handleInject(node.nodeId)}
                      style={{
                        padding: '2px 8px',
                        'font-size': '10px',
                        'border-radius': '4px',
                        border: '1px solid rgba(255,255,255,0.08)',
                        background: 'transparent',
                        color: '#9ca3af',
                        cursor: 'pointer',
                      }}
                      title="Touch / refresh access"
                    >
                      {busy()[node.nodeId] ? '…' : 'Inject'}
                    </button>
                    <button
                      type="button"
                      disabled={busy()[node.nodeId]}
                      onClick={() => void handleForget(node.nodeId)}
                      style={{
                        padding: '2px 8px',
                        'font-size': '10px',
                        'border-radius': '4px',
                        border: '1px solid rgba(239,68,68,0.18)',
                        background: 'transparent',
                        color: '#fca5a5',
                        cursor: 'pointer',
                      }}
                      title="Delete node"
                    >
                      Forget
                    </button>
                    <Show when={node.kind === 'finding'}>
                      <button
                        type="button"
                        disabled={busy()[node.nodeId]}
                        onClick={() => void handlePromote(node.nodeId)}
                        style={{
                          padding: '2px 8px',
                          'font-size': '10px',
                          'border-radius': '4px',
                          border: '1px solid rgba(255,255,255,0.08)',
                          background: 'transparent',
                          color: '#9ca3af',
                          cursor: 'pointer',
                        }}
                        title="Promote finding to memory"
                      >
                        Promote
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* confirm forget dialog */}
        <Show when={confirmForget()}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm forget"
            style={{
              position: 'fixed',
              inset: '0',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              background: 'rgba(0,0,0,0.5)',
              'z-index': '50',
            }}
            onClick={() => setConfirmForget(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                padding: '16px',
                'border-radius': '10px',
                background: '#1a1a1f',
                border: '1px solid rgba(255,255,255,0.12)',
                display: 'flex',
                'flex-direction': 'column',
                gap: '12px',
                'min-width': '280px',
              }}
            >
              <div style={{ 'font-size': '13px', 'font-weight': '600', color: '#e5e7eb' }}>
                Forget this memory?
              </div>
              <div style={{ 'font-size': '12px', color: '#9ca3af' }}>
                This will permanently delete the knowledge entry.
              </div>
              <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setConfirmForget(null)}
                  style={{
                    padding: '6px 12px',
                    'border-radius': '6px',
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'transparent',
                    color: '#9ca3af',
                    cursor: 'pointer',
                    'font-size': '12px',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void performForget()}
                  style={{
                    padding: '6px 12px',
                    'border-radius': '6px',
                    border: '1px solid rgba(239,68,68,0.35)',
                    background: 'rgba(239,68,68,0.15)',
                    color: '#fecaca',
                    cursor: 'pointer',
                    'font-size': '12px',
                    'font-weight': '600',
                  }}
                >
                  Forget
                </button>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}
