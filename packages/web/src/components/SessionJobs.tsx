import { createSignal, createEffect, Show, For, onCleanup, onMount } from 'solid-js'
import type { AppStore } from '../stores/app'
import { api, type Job } from '../api/client'
import { JobRow } from './JobRow'
import { toast } from './Toast'

/**
 * SessionJobs — per-session background-job list (P2-2 slice 1).
 *
 * Polls `api.listJobs(sessionId)` on session change + every 3s (same rhythm
 * as QueueRail) and renders one `JobRow` per job. Opening a child session
 * reuses the store's `selectSession`; cancelling posts `api.cancelJob`
 * then refreshes. No live tail display (slice 2).
 */
export function SessionJobs(props: { store: AppStore }) {
  const sessionId = () => props.store.state.currentId
  const [jobs, setJobs] = createSignal<Job[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const load = async () => {
    const id = sessionId()
    if (!id) {
      setJobs([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const list = await api.listJobs(id)
      setJobs(list ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    void load()
  })

  onMount(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (!sessionId()) return
      void load()
    }, 3000)
    onCleanup(() => clearInterval(timer))
  })

  const handleOpenChild = (childId: string) => {
    void props.store.selectSession(childId).catch(() => {})
  }

  const handleCancel = async (jobId: string) => {
    try {
      await api.cancelJob(jobId)
      await load()
    } catch (e) {
      setError((e as Error).message)
      toast.error(`Cancel failed: ${(e as Error).message}`)
    }
  }

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          'margin-bottom': '2px',
        }}
      >
        <span
          style={{
            'font-size': 'var(--fs-xs)',
            'font-weight': '700',
            color: 'var(--fg-muted)',
            'letter-spacing': '0.05em',
            'text-transform': 'uppercase',
          }}
        >
          Jobs
          <Show when={jobs().length > 0}>
            <span style={{ color: 'var(--fg-faint)', 'font-weight': '400' }}>
              {' '}
              · {jobs().length}
            </span>
          </Show>
        </span>
        <Show when={sessionId()}>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => void load()}
            title="Refresh jobs"
            aria-label="Refresh jobs"
            style={{
              padding: '2px 7px',
              'font-size': 'var(--fs-xs)',
              border: '1px solid var(--border)',
              'border-radius': 'var(--r-full)',
            }}
          >
            ↻
          </button>
        </Show>
      </div>

      <Show when={error()}>
        <div
          class="alert"
          style={{
            padding: '9px 11px',
            'border-radius': 'var(--r-md)',
            background: 'var(--danger-soft)',
            border: '1px solid var(--danger-border)',
            color: 'var(--danger)',
            'font-size': 'var(--fs-xs)',
          }}
        >
          {error()}
        </div>
      </Show>

      <Show when={!sessionId()}>
        <div
          style={{
            padding: '14px',
            border: '1px dashed var(--border-strong)',
            'border-radius': 'var(--r-md)',
            color: 'var(--fg-faint)',
            'font-size': 'var(--fs-xs)',
            'text-align': 'center',
          }}
        >
          Select a session to view its jobs.
        </div>
      </Show>

      <Show when={sessionId() && !loading() && jobs().length === 0 && !error()}>
        <div
          style={{
            padding: '14px',
            border: '1px dashed var(--border-strong)',
            'border-radius': 'var(--r-md)',
            color: 'var(--fg-faint)',
            'font-size': 'var(--fs-xs)',
            'text-align': 'center',
          }}
        >
          No background jobs for this session.
        </div>
      </Show>

      <Show when={loading() && jobs().length === 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <For each={[0, 1]}>
            {() => (
              <div class="skeleton" style={{ height: '64px', 'border-radius': 'var(--r-md)' }} />
            )}
          </For>
        </div>
      </Show>

      <Show when={jobs().length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <For each={jobs()}>
            {(job) => <JobRow job={job} onOpenChild={handleOpenChild} onCancel={handleCancel} />}
          </For>
        </div>
      </Show>
    </div>
  )
}
