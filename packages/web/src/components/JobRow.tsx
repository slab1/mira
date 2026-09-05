import { createSignal, onCleanup, Show } from 'solid-js'
import type { Job } from '../api/client'

type Props = {
  job: Job
  onOpenChild: (childId: string, jobId: string, parentId: string) => void
  onCancel: (jobId: string) => void
}

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function JobRow(props: Props) {
  const [elapsed, setElapsed] = createSignal(0)

  const update = () => {
    const now = Date.now()
    const created = props.job.createdAt
    setElapsed(now - created)
  }

  update()
  const iv = setInterval(update, 1000)
  onCleanup(() => clearInterval(iv))

  const job = () => props.job
  const status = () => job().status
  const isRunning = () => status() === 'running'
  const canOpen = () => !!job().childSessionID

  const statusColor = () => {
    switch (status()) {
      case 'running':
        return 'var(--warn)'
      case 'completed':
        return 'var(--ok)'
      case 'failed':
        return 'var(--danger)'
      default:
        return 'var(--fg-faint)'
    }
  }

  const badgeBg = () => {
    switch (status()) {
      case 'running':
        return 'var(--warn-soft)'
      case 'completed':
        return 'var(--ok-soft)'
      case 'failed':
        return 'var(--danger-soft)'
      default:
        return 'var(--bg-surface)'
    }
  }

  const badgeBorder = () => {
    switch (status()) {
      case 'running':
        return 'var(--warn-border)'
      case 'completed':
        return 'var(--ok-border)'
      case 'failed':
        return 'var(--danger-border)'
      default:
        return 'var(--border)'
    }
  }

  const badgeColor = () => {
    switch (status()) {
      case 'running':
        return 'var(--warn)'
      case 'completed':
        return 'var(--ok)'
      case 'failed':
        return 'var(--danger)'
      default:
        return 'var(--fg-faint)'
    }
  }

  const handleRowClick = () => {
    if (canOpen()) {
      props.onOpenChild(job().childSessionID!, job().id, job().parentSessionID)
    }
  }

  const handleCancel = (e: MouseEvent) => {
    e.stopPropagation()
    props.onCancel(job().id)
  }

  const preview = () => {
    const p = job().prompt
    if (p.length <= 160) return p
    return p.slice(0, 157) + '…'
  }

  return (
    <div
      class="card"
      style={{
        padding: '9px 11px',
        display: 'flex',
        gap: '9px',
        'align-items': 'flex-start',
        cursor: canOpen() ? 'pointer' : 'default',
      }}
      onClick={handleRowClick}
      title={canOpen() ? 'Open child session' : undefined}
    >
      <span
        style={{
          width: '8px',
          height: '8px',
          'border-radius': '50%',
          background: statusColor(),
          flex: 'none',
          'margin-top': '6px',
        }}
      />
      <div style={{ flex: '1', 'min-width': '0' }}>
        <div
          style={{
            display: 'flex',
            gap: '6px',
            'align-items': 'center',
            'margin-bottom': '2px',
            'flex-wrap': 'wrap',
          }}
        >
          <span
            style={{
              'font-size': 'var(--fs-2xs)',
              'font-weight': '700',
              padding: '1px 6px',
              'border-radius': 'var(--r-full)',
              background: badgeBg(),
              color: badgeColor(),
              border: `1px solid ${badgeBorder()}`,
            }}
          >
            {status()}
          </span>
          <span
            style={{
              'font-size': 'var(--fs-2xs)',
              color: 'var(--fg-faint)',
              'font-family': 'var(--font-mono)',
            }}
          >
            {job().agent ?? 'general'} · {new Date(job().createdAt).toLocaleTimeString()}
          </span>
          <span
            style={{
              'font-size': 'var(--fs-2xs)',
              color: 'var(--fg-subtle)',
              'font-family': 'var(--font-mono)',
            }}
          >
            {formatElapsed(elapsed())}
          </span>
          <Show when={canOpen()}>
            <span
              style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--accent)', 'font-weight': '600' }}
            >
              child →
            </span>
          </Show>
        </div>
        <div
          style={{
            'font-size': 'var(--fs-xs)',
            color: 'var(--fg)',
            'line-height': '1.4',
            'white-space': 'pre-wrap',
            'word-break': 'break-word',
          }}
        >
          {preview()}
        </div>
        <Show when={status() === 'completed' && job().result}>
          <div
            style={{
              'font-size': 'var(--fs-2xs)',
              color: 'var(--fg-subtle)',
              'margin-top': '4px',
              'white-space': 'pre-wrap',
              'word-break': 'break-word',
              background: 'var(--bg-app)',
              padding: '4px 6px',
              'border-radius': '4px',
              border: '1px solid var(--border)',
            }}
          >
            {String(job().result).slice(0, 200)}
            {String(job().result ?? '').length > 200 ? '…' : ''}
          </div>
        </Show>
        <Show when={status() === 'failed' && job().error}>
          <div
            style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--danger)', 'margin-top': '4px' }}
          >
            {String(job().error).slice(0, 200)}
          </div>
        </Show>
      </div>
      <Show when={isRunning()}>
        <button
          type="button"
          class="btn btn-ghost"
          onClick={handleCancel}
          title="Cancel job"
          style={{
            padding: '4px 8px',
            'font-size': 'var(--fs-xs)',
            border: '1px solid var(--border)',
            'border-radius': 'var(--r-full)',
            flex: 'none',
          }}
        >
          ✕ cancel
        </button>
      </Show>
    </div>
  )
}
