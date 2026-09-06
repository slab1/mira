import { Show } from 'solid-js'
import { addPermissionRule } from '../rpc/client'

export type DoomLoopInfo = {
  tool: string
  reason: string
  pattern?: string[]
  sessionID?: string
}

export default function DoomLoopBanner(props: {
  doomLoop: DoomLoopInfo | null
  onRewind: () => void
  onDismiss: () => void
}) {
  return (
    <Show when={props.doomLoop}>
      {(dl) => (
        <div
          role="alert"
          style={{
            margin: '8px 8px 0 8px',
            padding: '8px 12px',
            'border-radius': '8px',
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.30)',
            color: '#fecaca',
            'font-size': '12px',
            display: 'flex',
            'justify-content': 'space-between',
            'align-items': 'center',
            gap: '8px',
          }}
        >
          <span style={{ flex: '1', 'min-width': '0' }}>
            ⚠ Doom loop detected: {dl().tool} — {dl().reason}
            {dl().pattern ? ` [${dl().pattern!.slice(0, 3).join(' → ')}]` : ''}
          </span>
          <div style={{ display: 'flex', gap: '8px', 'flex-shrink': '0' }}>
            <button
              type="button"
              onClick={() => props.onRewind()}
              style={{
                padding: '4px 8px',
                'border-radius': '6px',
                border: '1px solid rgba(239,68,68,0.4)',
                background: 'rgba(239,68,68,0.15)',
                color: '#fecaca',
                cursor: 'pointer',
                'font-size': '11px',
                'font-weight': '600',
              }}
            >
              Rewind
            </button>
            <button
              type="button"
              onClick={async () => {
                const tool = dl().tool
                try {
                  await addPermissionRule(tool, '*', 'deny')
                  props.onDismiss()
                } catch (e) {
                  console.error('[mira] addPermissionRule failed:', (e as Error).message)
                }
              }}
              title="Never repeat this pattern — add deny rule"
              style={{
                padding: '4px 8px',
                'border-radius': '6px',
                border: '1px solid rgba(239,68,68,0.4)',
                background: 'rgba(239,68,68,0.10)',
                color: '#fecaca',
                cursor: 'pointer',
                'font-size': '11px',
                'font-weight': '600',
              }}
            >
              ⛔ Never repeat
            </button>
            <button
              type="button"
              onClick={() => props.onDismiss()}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#fecaca',
                cursor: 'pointer',
                'font-size': '12px',
              }}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </Show>
  )
}
