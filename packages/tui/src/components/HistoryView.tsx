/**
 * HistoryView — Snapshot list + diff modal + revert (TUI port of web/src/components/ToolView.tsx:483-716)
 *
 * Lists file snapshots for a session, previews diff via getSnapshot, and reverts via revertSession.
 * Used standalone or inside Inspector's History tab.
 * Grouped by messageID (__no_message__ sentinel) — port of web ToolView.tsx:580-610.
 */

import { For, Show, createSignal, createEffect, createMemo } from 'solid-js'
import { rpc } from '../rpc/client'
import { toast } from './Toast'

type Snapshot = {
  id: string
  sessionID: string
  messageID: string | null
  path: string
  existedBefore: boolean
  createdAt: number
}

type SnapshotDetail = {
  path: string
  snapshotContent: string | null
  currentContent: string | null
  existedBefore: boolean
}

type Props = {
  sessionId: string | null
  onReverted?: () => void
}

function DiffViewer(props: { path: string; before: string | null; after: string | null }) {
  const snapLines = () => (props.before ?? '').split('\n').length
  const currLines = () => (props.after ?? '').split('\n').length
  const added = () => Math.max(0, currLines() - snapLines())
  const removed = () => Math.max(0, snapLines() - currLines())
  return (
    <div
      data-slot="snapshot-diff"
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
        width: '100%',
        'margin-top': '6px',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: '6px',
          'align-items': 'center',
          'font-size': '10px',
          color: '#6b7280',
          'font-family': 'ui-monospace, monospace',
        }}
      >
        <span style={{ 'font-weight': '600', color: '#e5e7eb' }}>{props.path}</span>
        <span style={{ 'margin-left': 'auto', display: 'inline-flex', gap: '6px' }}>
          <Show when={added() > 0}>
            <span style={{ color: '#34d399', 'font-weight': '600' }}>+{added()} lines</span>
          </Show>
          <Show when={removed() > 0}>
            <span style={{ color: '#f87171', 'font-weight': '600' }}>-{removed()} lines</span>
          </Show>
          <span>
            {snapLines()} → {currLines()} lines
          </span>
        </span>
      </div>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
        <div>
          <div style={{ color: '#9ca3af', 'font-size': '10px', 'margin-bottom': '4px' }}>
            Before (snapshot):
          </div>
          <pre
            style={{
              margin: '0',
              padding: '8px',
              background: 'rgba(0,0,0,0.30)',
              'border-radius': '6px',
              border: '1px solid rgba(255,255,255,0.06)',
              color: '#d1d5db',
              'white-space': 'pre-wrap',
              'max-height': '200px',
              overflow: 'auto',
              'font-family': 'ui-monospace, monospace',
              'font-size': '11px',
            }}
          >
            {props.before ?? '(empty)'}
          </pre>
        </div>
        <div>
          <div style={{ color: '#9ca3af', 'font-size': '10px', 'margin-bottom': '4px' }}>After (current):</div>
          <pre
            style={{
              margin: '0',
              padding: '8px',
              background: 'rgba(0,0,0,0.30)',
              'border-radius': '6px',
              border: '1px solid rgba(255,255,255,0.06)',
              color: '#d1d5db',
              'white-space': 'pre-wrap',
              'max-height': '200px',
              overflow: 'auto',
              'font-family': 'ui-monospace, monospace',
              'font-size': '11px',
            }}
          >
            {props.after ?? '(file missing)'}
          </pre>
        </div>
      </div>
    </div>
  )
}

export default function HistoryView(props: Props) {
  const [snapshots, setSnapshots] = createSignal<Snapshot[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // diff modal state
  const [detail, setDetail] = createSignal<SnapshotDetail | null>(null)
  const [detailSnapId, setDetailSnapId] = createSignal<string | null>(null)
  const [loadingDetail, setLoadingDetail] = createSignal<string | null>(null)
  const [reverting, setReverting] = createSignal<string | null>(null)

  const loadSnapshots = async () => {
    const id = props.sessionId
    if (!id) {
      setSnapshots([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await rpc.listSnapshots(id)
      setSnapshots((data as Snapshot[]) ?? [])
    } catch (e) {
      setError((e as Error).message ?? String(e))
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    void props.sessionId
    void loadSnapshots()
  })

  const openDiff = async (snap: Snapshot) => {
    const id = props.sessionId
    if (!id) return
    setLoadingDetail(snap.id)
    try {
      const d = await rpc.getSnapshot(id, snap.id)
      setDetail(d)
      setDetailSnapId(snap.id)
    } catch (e) {
      setError((e as Error).message ?? String(e))
      toast.error(`Snapshot detail failed: ${(e as Error).message}`)
    } finally {
      setLoadingDetail(null)
    }
  }

  const closeDiff = () => {
    setDetail(null)
    setDetailSnapId(null)
  }

  const doRevertGroup = async (messageID: string | null, count: number) => {
    const id = props.sessionId
    if (!id) return
    const key = messageID ?? '__no_message__'
    setReverting(key)
    setError(null)
    try {
      await rpc.revertSession(id, messageID ?? undefined)
      await loadSnapshots()
      props.onReverted?.()
      toast.success(
        messageID ? `Rewound to ${messageID.slice(0, 8)} — ${count} file(s) restored` : `Reverted last mutation`,
      )
    } catch (e) {
      const msg = (e as Error).message ?? String(e)
      setError(msg)
      toast.error(`Rewind failed: ${msg}`)
    } finally {
      setReverting(null)
    }
  }

  const grouped = createMemo(() => {
    const snaps = snapshots()
    const map = new Map<string, Snapshot[]>()
    const order: string[] = []
    for (const sn of snaps) {
      const key = sn.messageID ?? '__no_message__'
      if (!map.has(key)) {
        map.set(key, [])
        order.push(key)
      }
      map.get(key)!.push(sn)
    }
    return order.map((k) => ({
      messageID: k === '__no_message__' ? null : k,
      snaps: map.get(k)!,
    }))
  })

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          gap: '8px',
        }}
      >
        <span
          style={{
            'font-size': '11px',
            'font-weight': '700',
            color: '#9ca3af',
            'letter-spacing': '0.05em',
            'text-transform': 'uppercase',
          }}
        >
          History · {loading() ? '…' : snapshots().length}
        </span>
        <Show when={props.sessionId}>
          <button
            type="button"
            onClick={() => void loadSnapshots()}
            title="Refresh snapshots"
            style={{
              padding: '2px 7px',
              'font-size': '11px',
              border: '1px solid rgba(255,255,255,0.12)',
              'border-radius': '999px',
              background: 'rgba(255,255,255,0.06)',
              color: '#9ca3af',
              cursor: 'pointer',
            }}
          >
            ↻
          </button>
        </Show>
      </div>

      <Show when={error()}>
        <div
          style={{
            padding: '8px 10px',
            'border-radius': '8px',
            background: 'rgba(239,68,68,0.10)',
            border: '1px solid rgba(239,68,68,0.22)',
            color: '#fecaca',
            'font-size': '11px',
          }}
        >
          {error()}
        </div>
      </Show>

      <Show
        when={!props.sessionId}
        fallback={
          <Show
            when={!loading()}
            fallback={
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                <For each={[0, 1]}>
                  {() => (
                    <div
                      style={{
                        height: '52px',
                        'border-radius': '8px',
                        background: 'rgba(255,255,255,0.06)',
                      }}
                    />
                  )}
                </For>
              </div>
            }
          >
            <Show
              when={snapshots().length > 0}
              fallback={
                <div
                  style={{
                    padding: '14px',
                    border: '1px dashed rgba(255,255,255,0.12)',
                    'border-radius': '8px',
                    color: '#6b7280',
                    'font-size': '11px',
                    'text-align': 'center',
                    'line-height': '1.5',
                  }}
                >
                  No file mutations yet — edits are snapshotted before they land.
                </div>
              }
            >
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                <For each={grouped()}>
                  {(group) => (
                    <div
                      data-slot="snapshot-group"
                      style={{
                        padding: '8px',
                        display: 'flex',
                        'flex-direction': 'column',
                        gap: '6px',
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        'border-radius': '8px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '8px',
                          'flex-wrap': 'wrap',
                        }}
                      >
                        <span
                          style={{
                            'font-size': '10px',
                            'font-weight': '700',
                            color: '#9ca3af',
                            'font-family': 'ui-monospace, monospace',
                            'letter-spacing': '0.04em',
                            'text-transform': 'uppercase',
                          }}
                        >
                          {group.messageID ? `msg ${group.messageID.slice(0, 8)}` : 'no message'}
                        </span>
                        <span
                          style={{
                            'font-size': '10px',
                            color: '#6b7280',
                            'font-family': 'ui-monospace, monospace',
                          }}
                        >
                          {new Date(Math.min(...group.snaps.map((s) => s.createdAt))).toLocaleTimeString()} ·{' '}
                          {group.snaps.length} file{group.snaps.length === 1 ? '' : 's'}
                        </span>
                        <button
                          type="button"
                          disabled={reverting() === (group.messageID ?? '__no_message__')}
                          onClick={() => void doRevertGroup(group.messageID, group.snaps.length)}
                          title={
                            group.messageID
                              ? `↩ rewind to here — reverts this message and all later ones`
                              : 'Undo last mutation'
                          }
                          aria-label={
                            group.messageID
                              ? `Rewind to message ${group.messageID.slice(0, 8)}`
                              : 'Undo last mutation'
                          }
                          style={{
                            padding: '4px 10px',
                            'font-size': '11px',
                            border: '1px solid rgba(255,255,255,0.12)',
                            'border-radius': '999px',
                            'margin-left': 'auto',
                            flex: 'none',
                            background: group.messageID ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.06)',
                            color: group.messageID ? '#a5b4fc' : '#e5e7eb',
                            'border-color': group.messageID ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.12)',
                            'font-weight': '600',
                            cursor: reverting() === (group.messageID ?? '__no_message__') ? 'not-allowed' : 'pointer',
                            opacity: reverting() === (group.messageID ?? '__no_message__') ? '0.5' : '1',
                          }}
                        >
                          {reverting() === (group.messageID ?? '__no_message__') ? '…' : '↩ rewind to here'}
                        </button>
                      </div>
                      <For each={group.snaps}>
                        {(snap) => (
                          <div
                            data-slot="snapshot-card"
                            style={{
                              padding: '9px 11px',
                              'border-radius': '8px',
                              background: 'rgba(255,255,255,0.03)',
                              border: '1px solid rgba(255,255,255,0.08)',
                              display: 'flex',
                              'flex-direction': 'column',
                              gap: '6px',
                            }}
                          >
                            <div style={{ display: 'flex', gap: '9px', 'align-items': 'center' }}>
                              <div style={{ flex: '1', 'min-width': '0' }}>
                                <div
                                  style={{
                                    'font-size': '12px',
                                    'font-weight': '600',
                                    color: '#e5e7eb',
                                    'font-family': 'ui-monospace, monospace',
                                    'white-space': 'nowrap',
                                    overflow: 'hidden',
                                    'text-overflow': 'ellipsis',
                                  }}
                                  title={snap.path}
                                >
                                  {snap.path}
                                </div>
                                <div
                                  style={{
                                    'font-size': '10px',
                                    color: '#6b7280',
                                    'margin-top': '2px',
                                    'font-family': 'ui-monospace, monospace',
                                  }}
                                >
                                  {new Date(snap.createdAt).toLocaleTimeString()} ·{' '}
                                  {snap.existedBefore ? 'edit' : 'new file'}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => void openDiff(snap)}
                                title="Preview diff"
                                style={{
                                  padding: '4px 8px',
                                  'font-size': '11px',
                                  border: '1px solid rgba(255,255,255,0.12)',
                                  'border-radius': '999px',
                                  background: 'rgba(255,255,255,0.06)',
                                  color: '#9ca3af',
                                  cursor: 'pointer',
                                  flex: 'none',
                                }}
                              >
                                {loadingDetail() === snap.id ? '…' : 'diff'}
                              </button>
                            </div>
                            <Show when={detailSnapId() === snap.id && detail()}>
                              {(d) => (
                                <DiffViewer
                                  path={d().path}
                                  before={d().snapshotContent}
                                  after={d().currentContent}
                                />
                              )}
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        }
      >
        <div style={{ color: '#6b7280', 'font-size': '12px', padding: '4px 0' }}>
          Select a session to see its file history.
        </div>
      </Show>

      {/* Modal overlay for diff when opened — also supports inline above, but modal for focus */}
      <Show when={detail() && detailSnapId()}>
        <div
          onClick={closeDiff}
          style={{
            position: 'fixed',
            inset: '0',
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            'z-index': '50',
            padding: '16px',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(720px, 90vw)',
              'max-height': '80vh',
              overflow: 'auto',
              background: '#1a1a1f',
              border: '1px solid rgba(255,255,255,0.12)',
              'border-radius': '10px',
              padding: '14px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '8px',
            }}
          >
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
              }}
            >
              <span style={{ 'font-size': '12px', 'font-weight': '700', color: '#e5e7eb' }}>
                Snapshot diff — {detail()?.path}
              </span>
              <button
                type="button"
                onClick={closeDiff}
                style={{
                  padding: '4px 10px',
                  'font-size': '11px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  'border-radius': '999px',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#9ca3af',
                  cursor: 'pointer',
                }}
              >
                ✕ Close
              </button>
            </div>
            <Show when={detail()}>
              {(d) => <DiffViewer path={d().path} before={d().snapshotContent} after={d().currentContent} />}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
