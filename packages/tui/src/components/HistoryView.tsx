/**
 * HistoryView — Snapshot list + diff modal + revert (TUI port of web/src/components/ToolView.tsx:483-716)
 *
 * Lists file snapshots for a session, previews diff via getSnapshot, and reverts via revertSession.
 * Used standalone or inside Inspector's History tab.
 */

import { For, Show, createSignal, createEffect } from 'solid-js'
import { rpc } from '../rpc/client'

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
    } finally {
      setLoadingDetail(null)
    }
  }

  const closeDiff = () => {
    setDetail(null)
    setDetailSnapId(null)
  }

  const doRevert = async (snap: Snapshot) => {
    const id = props.sessionId
    if (!id) return
    setReverting(snap.id)
    setError(null)
    try {
      await rpc.revertSession(id, snap.messageID ?? undefined)
      await loadSnapshots()
      props.onReverted?.()
    } catch (e) {
      setError((e as Error).message ?? String(e))
    } finally {
      setReverting(null)
    }
  }

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
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                <For each={snapshots()}>
                  {(snap) => (
                    <div
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
                            {snap.messageID ? ` · ${snap.messageID.slice(0, 8)}` : ''}
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
                        <button
                          type="button"
                          disabled={reverting() === snap.id}
                          onClick={() => void doRevert(snap)}
                          title={
                            snap.messageID
                              ? `Rewind to message ${snap.messageID.slice(0, 8)} (reverts this + later)`
                              : 'Undo last mutation'
                          }
                          style={{
                            padding: '4px 8px',
                            'font-size': '11px',
                            border: '1px solid rgba(255,255,255,0.12)',
                            'border-radius': '999px',
                            background: 'rgba(255,255,255,0.06)',
                            color: '#e5e7eb',
                            cursor: reverting() === snap.id ? 'not-allowed' : 'pointer',
                            flex: 'none',
                            opacity: reverting() === snap.id ? '0.5' : '1',
                          }}
                        >
                          {reverting() === snap.id ? '…' : '↩ revert'}
                        </button>
                      </div>
                      {/* Inline diff preview when this snapshot is selected */}
                      <Show when={detailSnapId() === snap.id && detail()}>
                        {(d) => (
                          <div
                            style={{
                              'margin-top': '4px',
                              'font-family': 'ui-monospace, monospace',
                              'font-size': '10px',
                              'white-space': 'pre-wrap',
                              background: 'rgba(0,0,0,0.25)',
                              padding: '8px',
                              'border-radius': '6px',
                              border: '1px solid rgba(255,255,255,0.06)',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                'justify-content': 'space-between',
                                'align-items': 'center',
                                'margin-bottom': '4px',
                              }}
                            >
                              <span style={{ 'font-weight': '600', color: '#e5e7eb' }}>
                                Diff preview for {d().path}
                              </span>
                              <button
                                type="button"
                                onClick={closeDiff}
                                style={{
                                  padding: '2px 6px',
                                  'font-size': '10px',
                                  border: '1px solid rgba(255,255,255,0.12)',
                                  'border-radius': '999px',
                                  background: 'transparent',
                                  color: '#9ca3af',
                                  cursor: 'pointer',
                                }}
                              >
                                ✕ close
                              </button>
                            </div>
                            <div style={{ color: '#9ca3af' }}>
                              Snapshot ({d().existedBefore ? 'edit' : 'new file'}):
                            </div>
                            <pre
                              style={{
                                margin: '4px 0',
                                'white-space': 'pre-wrap',
                                color: '#d1d5db',
                              }}
                            >
                              {d().snapshotContent ?? '(empty)'}
                            </pre>
                            <div style={{ color: '#9ca3af' }}>Current:</div>
                            <pre
                              style={{
                                margin: '4px 0',
                                'white-space': 'pre-wrap',
                                color: '#d1d5db',
                              }}
                            >
                              {d().currentContent ?? '(file missing)'}
                            </pre>
                          </div>
                        )}
                      </Show>
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
            <div
              style={{
                'font-family': 'ui-monospace, monospace',
                'font-size': '11px',
                'white-space': 'pre-wrap',
                display: 'flex',
                'flex-direction': 'column',
                gap: '8px',
              }}
            >
              <div>
                <div style={{ color: '#9ca3af', 'font-size': '10px', 'margin-bottom': '4px' }}>
                  Snapshot ({detail()?.existedBefore ? 'edit' : 'new file'}):
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
                    'max-height': '260px',
                    overflow: 'auto',
                  }}
                >
                  {detail()?.snapshotContent ?? '(empty)'}
                </pre>
              </div>
              <div>
                <div style={{ color: '#9ca3af', 'font-size': '10px', 'margin-bottom': '4px' }}>
                  Current:
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
                    'max-height': '260px',
                    overflow: 'auto',
                  }}
                >
                  {detail()?.currentContent ?? '(file missing)'}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
