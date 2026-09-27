/**
 * Phase 2 — Mission Control (MIRA_UI_IMPLEMENTATION_ROADMAP.md)
 *
 * Autonomous execution cockpit: parent → child mission tree, live agent
 * states, current operation, tool activity, files changed, token usage &
 * cost, pause/cancel and an inline transcript — backed by EXISTING endpoints
 * only (no server changes):
 *
 *   GET  /session                 mission tree (Session.parentID → parent/child)
 *   GET  /session/:id/jobs        background jobs (3s poll fallback)
 *   GET  /session/:id/message     transcript + tool parts
 *   GET  /session/:id/snapshots   files changed (api.listSnapshots)
 *   GET  /session/:id/cost        tokens & cost (api.getSessionCost)
 *   POST /session/:id/abort       pause/abort the active turn (api.abortPrompt)
 *   POST /job/:id/cancel          cancel one job (api.cancelJob)
 *   WS   BusEvent                 session.created/updated/abort +
 *                                  job.created/updated/cancelled → live UI
 *
 * Design follows pages/Evolution.tsx: token-only inline styles on the
 * .card / .pill / .skeleton / .alert primitives, and a strict
 * skeleton → empty → error+retry → ready state matrix per section.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import {
  api,
  sessionParentId,
  type Job,
  type Message,
  type Part,
  type Session,
  type SessionCost,
  type Snapshot,
} from '../api/client'
import type { AppStore } from '../stores/app'
import { TurnList } from '../components/SessionTurn'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { toast } from '../components/Toast'

// ── Constants ─────────────────────────────────────────────────────────
type TabId = 'overview' | 'tools' | 'files' | 'transcript'
type MissionState = 'running' | 'failed' | 'idle'
type ConfirmState =
  | { kind: 'abort'; sessionId: string; label: string }
  | { kind: 'cancel'; jobId: string; sessionId: string; label: string }

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'tools', label: 'Tool activity' },
  { id: 'files', label: 'Files changed' },
  { id: 'transcript', label: 'Transcript' },
]
const TRANSCRIPT_LIMIT = 150
const TOOL_LIMIT = 8
const FILE_LIMIT = 20
/** Recent sessions whose jobs we hydrate so list state chips are honest
 *  before any BusEvent arrives (there is no global jobs endpoint). */
const HYDRATE_LIMIT = 8
const POLL_JOBS_MS = 3000
const POLL_LIST_MS = 15_000

// ── Small helpers ─────────────────────────────────────────────────────
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function ts(v: string | number | undefined | null): number {
  const n = typeof v === 'number' ? v : Date.parse(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function relTime(target: number, nowMs: number): string {
  const diff = nowMs - target
  if (!Number.isFinite(target) || target <= 0) return 'unknown'
  if (diff < 45_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(target).toLocaleDateString()
}

function usd(n: number | null | undefined): string {
  const v = n ?? 0
  if (v === 0) return '$0.00'
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
}

function fmtInt(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString()
}

function fmtTokens(n: number | null | undefined): string {
  const v = n ?? 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`
  return v.toLocaleString()
}

function summaryOf(v: unknown, limit = 140): string {
  if (v === undefined || v === null) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (!s) return ''
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s
}

/** tool part types across wire shapes: spec `tool`, SSE `tool_call`, DB `tool-call`. */
function isToolCallType(t: string): boolean {
  return t === 'tool' || t === 'tool_call' || t === 'tool-call'
}

function isToolResultType(t: string): boolean {
  return t === 'tool_result' || t === 'tool-result'
}

type RawPart = Part & {
  args?: Part['input']
  result?: Part['output']
  isError?: boolean
  toolCallID?: string
}

/**
 * Persisted parts use `tool-call`/`tool-result` + `args`/`result`/`isError`
 * (storage schema), while every renderer expects `tool_call`/`tool_result` +
 * `input`/`output`. Pair each call with its result (by toolCallID) so a call
 * never renders as a permanently-running spinner, then drop the matched
 * result rows (one card per tool call, not two).
 */
function normalizeMessages(msgs: Message[]): Message[] {
  return msgs.map((m) => {
    if (!m.parts || m.parts.length === 0) return m
    const raw = m.parts as RawPart[]
    const results = new Map<string, RawPart>()
    for (const p of raw) {
      if (p.toolCallID && isToolResultType(String(p.type))) results.set(p.toolCallID, p)
    }
    const callIds = new Set(
      raw.filter((p) => p.toolCallID && isToolCallType(String(p.type))).map((p) => p.toolCallID!),
    )
    const parts: Part[] = []
    for (const p of raw) {
      const t = String(p.type)
      if (isToolCallType(t)) {
        const res = p.toolCallID ? results.get(p.toolCallID) : undefined
        parts.push({
          ...p,
          type: 'tool_call',
          input: p.input ?? p.args,
          output: p.output ?? res?.result ?? res?.output,
          isError: p.isError ?? res?.isError,
        })
      } else if (isToolResultType(t)) {
        // Orphan result (no matching call in this message) — keep it visible.
        if (!p.toolCallID || !callIds.has(p.toolCallID)) {
          parts.push({
            ...p,
            type: 'tool_result',
            input: p.input ?? p.args,
            output: p.output ?? p.result,
            isError: p.isError,
          })
        }
      } else {
        parts.push(p)
      }
    }
    return { ...m, parts }
  })
}

// ── Presentational sub-components ─────────────────────────────────────

/** 1s local ticker — mirrors JobRow.tsx elapsed handling. */
function Elapsed(props: { since: number }) {
  const [now, setNow] = createSignal(Date.now())
  const iv = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(iv))
  return <span style={{ 'font-family': 'var(--font-mono)' }}>{formatElapsed(now() - props.since)}</span>
}

function StateChip(props: { state: MissionState }) {
  const cfg = createMemo(() => {
    switch (props.state) {
      case 'running':
        return { cls: 'pill-warn', dot: 'var(--warn)', pulse: true, label: 'running' }
      case 'failed':
        return { cls: 'pill-danger', dot: 'var(--danger)', pulse: false, label: 'job failed' }
      default:
        return { cls: '', dot: 'var(--fg-faint)', pulse: false, label: 'idle' }
    }
  })
  return (
    <span
      class={`pill ${cfg().cls}`}
      style={{ 'font-size': 'var(--fs-2xs)', padding: '1px 6px', gap: '4px' }}
      data-mission-state={props.state}
    >
      <span
        class={`dot ${cfg().pulse ? 'dot-pulse' : ''}`}
        style={{ background: cfg().dot }}
        aria-hidden="true"
      />
      {cfg().label}
    </span>
  )
}

function MissionRow(props: {
  session: Session
  selected: boolean
  state: MissionState
  jobCount: number
  runningJobs: number
  childCount: number
  updatedLabel: string
  onSelect: () => void
}) {
  const title = () => props.session.title?.trim() || 'Untitled session'
  return (
    <div class={`session-row ${props.selected ? 'active' : ''}`} role="listitem">
      <button
        type="button"
        class="session-main"
        aria-current={props.selected ? 'true' : undefined}
        onClick={props.onSelect}
        title={`${title()} — ${props.state}`}
        style={{ padding: '8px 10px' }}
      >
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            'margin-bottom': '3px',
            'flex-wrap': 'wrap',
          }}
        >
          <StateChip state={props.state} />
          <span
            style={{
              'font-size': 'var(--fs-2xs)',
              color: 'var(--fg-faint)',
              'font-family': 'var(--font-mono)',
            }}
          >
            {props.session.agent ?? 'general'} · {props.updatedLabel}
          </span>
        </div>
        <div
          style={{
            'font-size': 'var(--fs-sm)',
            'font-weight': 600,
            color: 'var(--fg)',
            'white-space': 'nowrap',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
          }}
        >
          {title()}
        </div>
        <div
          style={{
            display: 'flex',
            gap: '6px',
            'margin-top': '3px',
            'font-size': 'var(--fs-2xs)',
            color: 'var(--fg-subtle)',
            'font-family': 'var(--font-mono)',
            'flex-wrap': 'wrap',
          }}
        >
          <Show when={props.jobCount > 0}>
            <span>
              {props.runningJobs > 0
                ? `${props.runningJobs}/${props.jobCount} job${props.jobCount === 1 ? '' : 's'} running`
                : `${props.jobCount} job${props.jobCount === 1 ? '' : 's'}`}
            </span>
          </Show>
          <Show when={props.childCount > 0}>
            <span style={{ color: 'var(--accent)' }}>
              {props.childCount} sub-agent{props.childCount === 1 ? '' : 's'}
            </span>
          </Show>
        </div>
      </button>
    </div>
  )
}

function StatTile(props: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'accent' | 'ok' | 'warn' | 'danger'
  loading?: boolean
}) {
  const valueColor = () => {
    switch (props.tone) {
      case 'accent':
        return 'var(--accent)'
      case 'ok':
        return 'var(--ok)'
      case 'warn':
        return 'var(--warn)'
      case 'danger':
        return 'var(--danger)'
      default:
        return 'var(--fg)'
    }
  }
  return (
    <div
      class="card"
      style={{
        padding: '10px 12px',
        background: 'var(--bg-app)',
        border: '1px solid var(--border)',
        'min-height': '64px',
        display: 'flex',
        'flex-direction': 'column',
        gap: '2px',
        'min-width': 0,
      }}
    >
      <div
        style={{
          'font-size': 'var(--fs-2xs)',
          'font-weight': 700,
          'letter-spacing': '0.04em',
          'text-transform': 'uppercase',
          color: 'var(--fg-faint)',
        }}
      >
        {props.label}
      </div>
      <Show
        when={!props.loading}
        fallback={<div class="skeleton" style={{ height: '20px', width: '70%' }} />}
      >
        <div
          style={{
            'font-size': 'var(--fs-lg)',
            'font-weight': 700,
            'letter-spacing': '-0.02em',
            color: valueColor(),
            'font-family': 'var(--font-mono)',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
          }}
        >
          {props.value}
        </div>
      </Show>
      <Show when={props.hint}>
        <div
          style={{
            'font-size': 'var(--fs-2xs)',
            color: 'var(--fg-faint)',
            'font-family': 'var(--font-mono)',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
          }}
        >
          {props.hint}
        </div>
      </Show>
    </div>
  )
}

function EmptyBox(props: { children: string; action?: unknown }) {
  return (
    <div
      style={{
        padding: '16px 12px',
        border: '1px dashed var(--border-strong)',
        'border-radius': 'var(--r-md)',
        color: 'var(--fg-faint)',
        'font-size': 'var(--fs-xs)',
        'text-align': 'center',
        'line-height': '1.6',
      }}
    >
      {props.children}
    </div>
  )
}

function SectionError(props: { message: string; onRetry: () => void }) {
  return (
    <div class="alert" role="alert" style={{ 'align-items': 'center', 'font-size': 'var(--fs-xs)' }}>
      <span style={{ flex: '1', 'min-width': 0, 'word-break': 'break-word' }}>⚠ {props.message}</span>
      <button
        type="button"
        class="btn btn-ghost"
        onClick={props.onRetry}
        style={{
          padding: '4px 10px',
          'font-size': 'var(--fs-xs)',
          border: '1px solid var(--danger-border)',
          'border-radius': 'var(--r-md)',
          flex: 'none',
        }}
      >
        Retry
      </button>
    </div>
  )
}

function SkeletonRows(props: { rows: number; height: string }) {
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }} aria-hidden="true">
      <For each={Array.from({ length: props.rows }, (_, i) => i)}>
        {() => <div class="skeleton" style={{ height: props.height, 'border-radius': 'var(--r-md)' }} />}
      </For>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────

export default function MissionsPage(props: {
  store: AppStore
  /** Open the full session in the Work workspace (ChatView composer). */
  onOpenInChat?: (sessionId: string) => void
}) {
  // Mission tree
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [listLoading, setListLoading] = createSignal(true)
  const [listError, setListError] = createSignal<string | null>(null)
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

  // Detail
  const [tab, setTab] = createSignal<TabId>('overview')
  const [jobsBySession, setJobsBySession] = createSignal<Record<string, Job[]>>({})
  const [jobsLoading, setJobsLoading] = createSignal(false)
  const [messages, setMessages] = createSignal<Message[]>([])
  const [messagesLoading, setMessagesLoading] = createSignal(false)
  const [messagesError, setMessagesError] = createSignal<string | null>(null)
  const [snapshots, setSnapshots] = createSignal<Snapshot[]>([])
  const [snapshotsLoading, setSnapshotsLoading] = createSignal(false)
  const [snapshotsError, setSnapshotsError] = createSignal<string | null>(null)
  const [cost, setCost] = createSignal<SessionCost | null>(null)
  const [costLoading, setCostLoading] = createSignal(false)
  const [costError, setCostError] = createSignal<string | null>(null)

  // Actions
  const [confirm, setConfirm] = createSignal<ConfirmState | null>(null)
  const [busy, setBusy] = createSignal<string | null>(null)

  // Clock for relative timestamps (5s — rows don't need 1s churn)
  const [clock, setClock] = createSignal(Date.now())

  // ── Session tree ───────────────────────────────────────────────────
  const tree = createMemo(() => {
    const list = sessions()
    const ids = new Set(list.map((s) => s.id))
    const children = new Map<string, Session[]>()
    const roots: Session[] = []
    for (const s of list) {
      const pid = sessionParentId(s)
      if (pid && pid !== s.id && ids.has(pid)) {
        const arr = children.get(pid) ?? []
        arr.push(s)
        children.set(pid, arr)
      } else {
        roots.push(s)
      }
    }
    return { roots, children }
  })

  const selected = createMemo(() => {
    const id = selectedId()
    return id ? (sessions().find((s) => s.id === id) ?? null) : null
  })

  const jobsFor = (id: string): Job[] => jobsBySession()[id] ?? []

  const selectedJobs = createMemo(() => (selectedId() ? jobsFor(selectedId()!) : []))

  function stateOf(s: Session): MissionState {
    if (props.store.state.streaming && props.store.state.currentId === s.id) return 'running'
    const jobs = jobsFor(s.id)
    if (jobs.some((j) => j.status === 'running')) return 'running'
    const latest = jobs[0]
    if (latest && latest.status === 'failed') return 'failed'
    return 'idle'
  }

  const stats = createMemo(() => {
    const list = sessions()
    const ids = new Set(list.map((s) => s.id))
    let running = 0
    let failed = 0
    let children = 0
    for (const s of list) {
      const pid = sessionParentId(s)
      if (pid && pid !== s.id && ids.has(pid)) children++
      const st = stateOf(s)
      if (st === 'running') running++
      else if (st === 'failed') failed++
    }
    return { total: list.length, running, failed, children }
  })

  // ── Loads ──────────────────────────────────────────────────────────
  const loadSessions = async (showSkeleton = false) => {
    if (showSkeleton) setListLoading(true)
    setListError(null)
    try {
      const list = await api.listSessions()
      setSessions(list ?? [])
      setSelectedId((prev) => {
        if (prev && (list ?? []).some((s) => s.id === prev)) return prev
        const ids = new Set((list ?? []).map((s) => s.id))
        const roots = (list ?? []).filter((s) => {
          const pid = sessionParentId(s)
          return !pid || !ids.has(pid)
        })
        return roots[0]?.id ?? (list ?? [])[0]?.id ?? null
      })
    } catch (e) {
      setListError(errMsg(e))
    } finally {
      setListLoading(false)
    }
  }

  /** Server truth for one session's jobs; keeps live rows the server has not
   *  committed yet (a job.created event can land before the row is queryable). */
  function setJobsFor(id: string, list: Job[]) {
    setJobsBySession((prev) => {
      const existing = prev[id] ?? []
      if (list.length === 0 && existing.some((j) => j.status === 'running')) return prev
      return { ...prev, [id]: list }
    })
  }

  const pollJobs = async (id: string) => {
    if (!id) return
    try {
      const list = await api.listJobs(id)
      if (selectedId() === id || jobsBySession()[id]) setJobsFor(id, list ?? [])
    } catch {
      // 404 (deleted) / transient — next tick retries
    }
  }

  const loadMessagesFor = async (id: string) => {
    if (!id) return
    setMessagesLoading(true)
    setMessagesError(null)
    try {
      const list = await api.getMessages(id)
      if (selectedId() === id) setMessages(list ?? [])
    } catch (e) {
      if (selectedId() === id) setMessagesError(errMsg(e))
    } finally {
      if (selectedId() === id) setMessagesLoading(false)
    }
  }

  const loadSnapshotsFor = async (id: string) => {
    if (!id) return
    setSnapshotsLoading(true)
    setSnapshotsError(null)
    try {
      const list = await api.listSnapshots(id)
      if (selectedId() === id) setSnapshots(list ?? [])
    } catch (e) {
      if (selectedId() === id) setSnapshotsError(errMsg(e))
    } finally {
      if (selectedId() === id) setSnapshotsLoading(false)
    }
  }

  const loadCostFor = async (id: string) => {
    if (!id) return
    setCostLoading(true)
    setCostError(null)
    try {
      const c = await api.getSessionCost(id)
      if (selectedId() === id) setCost(c)
    } catch (e) {
      if (selectedId() === id) setCostError(errMsg(e))
    } finally {
      if (selectedId() === id) setCostLoading(false)
    }
  }

  async function loadDetail(id: string) {
    setMessages([])
    setSnapshots([])
    setCost(null)
    setJobsBySession((prev) => ({ ...prev, [id]: prev[id] ?? [] }))
    setJobsLoading(true)
    await Promise.allSettled([
      loadMessagesFor(id),
      loadSnapshotsFor(id),
      loadCostFor(id),
      pollJobs(id),
    ])
    setJobsLoading(false)
  }

  /** Hydrate jobs for the most recent sessions so state chips are honest on
   *  first paint (there is no global jobs endpoint — bounded fan-out). */
  const hydrateJobs = async () => {
    const recent = sessions().slice(0, HYDRATE_LIMIT)
    await Promise.allSettled(
      recent.map((s) =>
        api.listJobs(s.id).then((list) => {
          setJobsFor(s.id, list ?? [])
        }),
      ),
    )
  }

  async function reloadAll() {
    setListLoading(true)
    await Promise.allSettled([loadSessions(), hydrateJobs()])
    const id = selectedId()
    if (id) await loadDetail(id)
    setListLoading(false)
  }

  // Selection → detail reload
  createEffect(() => {
    const id = selectedId()
    if (id) void loadDetail(id)
    else {
      setMessages([])
      setSnapshots([])
      setCost(null)
    }
  })

  onMount(() => {
    void (async () => {
      await loadSessions(true)
      await hydrateJobs()
    })()

    // Fallback polling (SessionJobs.tsx pattern): jobs for the selected
    // mission every 3s, list + recent jobs every 15s — visible tab only.
    const jobsIv = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      const id = selectedId()
      if (id) void pollJobs(id)
    }, POLL_JOBS_MS)
    const listIv = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      void loadSessions()
      void hydrateJobs()
    }, POLL_LIST_MS)
    const clockIv = setInterval(() => setClock(Date.now()), 5000)
    onCleanup(() => clearInterval(jobsIv))
    onCleanup(() => clearInterval(listIv))
    onCleanup(() => clearInterval(clockIv))
  })

  // ── Live BusEvent stream (shared socket from the app store) ────────
  onMount(() => {
    const refreshSoon = (() => {
      let timer: ReturnType<typeof setTimeout> | null = null
      return () => {
        if (timer) return
        timer = setTimeout(() => {
          timer = null
          void loadSessions()
        }, 600)
      }
    })()

    const mergeJob = (sessionID: string, type: string, p: Record<string, unknown>) => {
      const jobID = typeof p.jobID === 'string' ? p.jobID : null
      if (!jobID) {
        void pollJobs(sessionID)
        return
      }
      setJobsBySession((prev) => {
        const list = [...(prev[sessionID] ?? [])]
        const idx = list.findIndex((j) => j.id === jobID)
        if (type === 'job.created') {
          if (idx >= 0) return prev
          list.unshift({
            id: jobID,
            parentSessionID: sessionID,
            childSessionID: typeof p.childSessionID === 'string' ? p.childSessionID : null,
            agent: typeof p.agent === 'string' ? p.agent : null,
            prompt: String(p.title ?? p.prompt ?? ''),
            status: 'running',
            result: null,
            error: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        } else if (idx >= 0) {
          const job: Job = { ...list[idx]! }
          if (typeof p.status === 'string') job.status = p.status as Job['status']
          if (typeof p.childSessionID === 'string') job.childSessionID = p.childSessionID
          if (typeof p.preview === 'string') job.result = p.preview
          if (typeof p.title === 'string' && p.title) job.prompt = p.title
          job.updatedAt = Date.now()
          list[idx] = job
        } else {
          // Patch for a job we never saw — ask the server instead of guessing.
          void pollJobs(sessionID)
          return prev
        }
        return { ...prev, [sessionID]: list }
      })
    }

    const unsubscribe = props.store.subscribeBus((e) => {
      switch (e.type) {
        case 'session.created': {
          const s = e.payload as unknown as Session
          if (s && typeof s.id === 'string') {
            setSessions((prev) => [s, ...prev.filter((x) => x.id !== s.id)])
          }
          break
        }
        case 'session.updated':
        case 'session.abort': {
          refreshSoon()
          if (e.sessionID) void pollJobs(e.sessionID)
          break
        }
        case 'job.created':
        case 'job.updated':
        case 'job.cancelled': {
          const sid = e.sessionID
          if (!sid) break
          const payload = (e.payload ?? {}) as Record<string, unknown>
          mergeJob(sid, e.type, payload)
          break
        }
      }
    })
    onCleanup(unsubscribe)
  })

  // ── Derived detail data ────────────────────────────────────────────
  const normMessages = createMemo(() => normalizeMessages(messages()))

  const transcriptMessages = createMemo(() => {
    const m = normMessages()
    return m.length > TRANSCRIPT_LIMIT ? m.slice(-TRANSCRIPT_LIMIT) : m
  })

  const toolActivity = createMemo(() => {
    const out: Array<{
      id: string
      tool: string
      status: 'running' | 'done' | 'error'
      at: number
      summary: string
    }> = []
    for (const m of normMessages()) {
      for (const p of m.parts ?? []) {
        if (!isToolCallType(String(p.type))) continue
        const running = p.output === undefined
        const status: 'running' | 'done' | 'error' = p.isError
          ? 'error'
          : running
            ? 'running'
            : 'done'
        out.push({
          id: `${m.id}-${p.tool ?? 'tool'}-${out.length}`,
          tool: p.tool ?? 'tool',
          status,
          at: ts(m.createdAt),
          summary: summaryOf(p.input) || summaryOf(p.output),
        })
      }
    }
    return out.reverse().slice(0, TOOL_LIMIT)
  })

  const fileChanges = createMemo(() => {
    const map = new Map<string, { path: string; at: number; isNew: boolean }>()
    for (const s of snapshots()) {
      const at = ts(s.createdAt)
      const prev = map.get(s.path)
      if (!prev || at > prev.at) map.set(s.path, { path: s.path, at, isNew: !s.existedBefore })
    }
    return [...map.values()].sort((a, b) => b.at - a.at)
  })

  const currentOp = createMemo(() => {
    const running = selectedJobs().find((j) => j.status === 'running')
    if (running) return { kind: 'job' as const, job: running }
    const id = selectedId()
    if (id && props.store.state.streaming && props.store.state.currentId === id) {
      return { kind: 'streaming' as const, job: null }
    }
    return null
  })

  const childOfSelected = createMemo(() => {
    const id = selectedId()
    return id ? (tree().children.get(id) ?? []) : []
  })

  const parentOfSelected = createMemo(() => {
    const s = selected()
    if (!s) return null
    const pid = sessionParentId(s)
    return pid ? (sessions().find((x) => x.id === pid) ?? null) : null
  })

  const isRunningSelected = createMemo(() => {
    const s = selected()
    if (!s) return false
    if (props.store.state.streaming && props.store.state.currentId === s.id) return true
    return selectedJobs().some((j) => j.status === 'running')
  })

  const titleOf = (s: Session) => s.title?.trim() || 'Untitled session'

  const selectMission = (id: string) => {
    if (selectedId() === id) return
    setSelectedId(id)
    // Narrow screens stack list → detail, so bring the detail pane into view.
    try {
      if (window.matchMedia('(max-width: 900px)').matches) {
        queueMicrotask(() =>
          document.getElementById('mc-detail')?.scrollIntoView({ block: 'start' }),
        )
      }
    } catch {
      /* matchMedia unavailable — skip the scroll */
    }
  }

  // ── Actions ────────────────────────────────────────────────────────
  async function runConfirm() {
    const c = confirm()
    if (!c) return
    setBusy(c.kind)
    try {
      if (c.kind === 'abort') {
        const res = await api.abortPrompt(c.sessionId)
        if (res.ok) toast.success('Abort sent — stopping the active turn')
        else toast.warn('Server did not accept the abort — try again')
        await Promise.all([pollJobs(c.sessionId), loadSessions()])
      } else {
        await api.cancelJob(c.jobId)
        toast.success('Job cancelled')
        await pollJobs(c.sessionId)
      }
    } catch (e) {
      toast.error(`${c.kind === 'abort' ? 'Abort' : 'Cancel'} failed: ${errMsg(e)}`)
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  const onTabKeyDown = (e: KeyboardEvent) => {
    const idx = TABS.findIndex((t) => t.id === tab())
    const focusTab = (next: number) => {
      const target = TABS[(next + TABS.length) % TABS.length]
      if (!target) return
      setTab(target.id)
      queueMicrotask(() =>
        (document.querySelector(`[data-mc-tab="${target.id}"]`) as HTMLElement | null)?.focus(),
      )
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      focusTab(idx + 1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focusTab(idx - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusTab(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusTab(TABS.length - 1)
    }
  }

  const confirmTitle = () => {
    const c = confirm()
    if (!c) return ''
    return c.kind === 'abort' ? 'Abort the active turn?' : 'Cancel this job?'
  }
  const confirmMessage = () => {
    const c = confirm()
    if (!c) return ''
    return c.kind === 'abort'
      ? `“${c.label}” stops now — in-flight output for this session is discarded. Completed work and snapshots are kept.`
      : `“${c.label}” stops the running sub-agent. Its partial result is discarded.`
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div
      data-slot="missions-page"
      style={{
        flex: '1',
        display: 'flex',
        'flex-direction': 'column',
        overflow: 'auto',
        background: 'var(--bg-canvas)',
        'min-width': '0',
      }}
    >
      <div class="scroll" style={{ flex: '1', overflow: 'auto', padding: '18px 14px 28px' }}>
        <div
          style={{
            'max-width': '1280px',
            margin: '0 auto',
            display: 'flex',
            'flex-direction': 'column',
            gap: '14px',
          }}
        >
          {/* Header */}
          <div
            class="card"
            style={{
              padding: '14px 16px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '10px',
              background: 'var(--bg-surface)',
            }}
          >
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '10px',
                'flex-wrap': 'wrap',
                'justify-content': 'space-between',
              }}
            >
              <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'min-width': 0 }}>
                <div
                  style={{
                    width: '28px',
                    height: '28px',
                    'border-radius': '8px',
                    background: 'var(--grad-brand)',
                    display: 'grid',
                    'place-items': 'center',
                    color: 'var(--on-accent)',
                    'font-weight': 800,
                    'font-size': '14px',
                    flex: 'none',
                  }}
                  aria-hidden="true"
                >
                  ⬢
                </div>
                <div style={{ 'min-width': 0 }}>
                  <div
                    style={{
                      'font-size': 'var(--fs-lg)',
                      'font-weight': 700,
                      'letter-spacing': '-0.02em',
                    }}
                  >
                    MISSION CONTROL
                  </div>
                  <div
                    style={{
                      'font-size': 'var(--fs-xs)',
                      color: 'var(--fg-subtle)',
                      'line-height': '1.4',
                    }}
                  >
                    Parent → child agents · live state · tool activity · files · cost
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                <button
                  type="button"
                  class="btn btn-ghost"
                  onClick={() => void reloadAll()}
                  disabled={listLoading()}
                  aria-busy={listLoading() ? 'true' : 'false'}
                  style={{
                    padding: '6px 10px',
                    'font-size': 'var(--fs-xs)',
                    border: '1px solid var(--border)',
                    'border-radius': 'var(--r-md)',
                    'min-height': '32px',
                  }}
                >
                  ↻ Refresh
                </button>
                <span
                  class={`pill ${props.store.state.connected ? 'pill-ok' : 'pill-warn'}`}
                  style={{ 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-2xs)' }}
                  title={
                    props.store.state.connected
                      ? 'Live — receiving BusEvent updates'
                      : 'Bus stream down — falling back to polling'
                  }
                >
                  <span
                    class={`dot ${props.store.state.connected ? 'dot-pulse' : ''}`}
                    style={{
                      background: props.store.state.connected ? 'var(--ok)' : 'var(--warn)',
                    }}
                    aria-hidden="true"
                  />
                  {props.store.state.connected ? 'live' : 'polling'}
                </span>
              </div>
            </div>
            <Show when={listError()}>
              <SectionError message={listError()!} onRetry={() => void reloadAll()} />
            </Show>
          </div>

          {/* Mission overview strip */}
          <div
            style={{
              display: 'grid',
              'grid-template-columns': 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '10px',
            }}
          >
            <StatTile
              label="Missions"
              value={listLoading() && sessions().length === 0 ? '' : String(stats().total)}
              hint="sessions in this workspace"
              loading={listLoading() && sessions().length === 0}
            />
            <StatTile
              label="Running"
              value={String(stats().running)}
              tone={stats().running > 0 ? 'warn' : 'default'}
              hint="streaming or job in flight"
              loading={listLoading() && sessions().length === 0}
            />
            <StatTile
              label="Sub-agents"
              value={String(stats().children)}
              tone="accent"
              hint="child sessions (parent_id)"
              loading={listLoading() && sessions().length === 0}
            />
            <StatTile
              label="Needs attention"
              value={String(stats().failed)}
              tone={stats().failed > 0 ? 'danger' : 'default'}
              hint="latest job failed"
              loading={listLoading() && sessions().length === 0}
            />
          </div>

          {/* Master / detail cockpit */}
          <div class="mc-layout">
            {/* ── Mission tree ── */}
            <section
              class="card mc-list"
              aria-labelledby="mc-list-title"
              style={{
                padding: '10px',
                display: 'flex',
                'flex-direction': 'column',
                gap: '8px',
                'min-width': '0',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '8px',
                  'justify-content': 'space-between',
                }}
              >
                <span
                  id="mc-list-title"
                  style={{
                    'font-size': 'var(--fs-xs)',
                    'font-weight': 700,
                    'letter-spacing': '0.05em',
                    'text-transform': 'uppercase',
                    color: 'var(--fg-muted)',
                  }}
                >
                  Missions
                  <Show when={sessions().length > 0}>
                    <span style={{ color: 'var(--fg-faint)', 'font-weight': 400 }}>
                      {' '}
                      · {sessions().length}
                    </span>
                  </Show>
                </span>
                <button
                  type="button"
                  class="btn btn-ghost"
                  onClick={() => void loadSessions(true)}
                  title="Refresh mission list"
                  aria-label="Refresh mission list"
                  style={{
                    padding: '2px 8px',
                    'font-size': 'var(--fs-xs)',
                    border: '1px solid var(--border)',
                    'border-radius': 'var(--r-full)',
                  }}
                >
                  ↻
                </button>
              </div>

              <Show when={listLoading() && sessions().length === 0}>
                <SkeletonRows rows={4} height="56px" />
              </Show>

              <Show when={listError() && sessions().length === 0 && !listLoading()}>
                <SectionError message={listError()!} onRetry={() => void reloadAll()} />
              </Show>

              <Show
                when={!listLoading() && !listError() && sessions().length === 0}
                fallback={
                  <Show when={sessions().length > 0}>
                    <div
                      class="mc-list-rows scroll"
                      role="list"
                      aria-label="Missions"
                      style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}
                    >
                      <For each={tree().roots}>
                        {(s) => (
                          <div role="listitem">
                            <MissionRow
                              session={s}
                              selected={selectedId() === s.id}
                              state={stateOf(s)}
                              jobCount={jobsFor(s.id).length}
                              runningJobs={jobsFor(s.id).filter((j) => j.status === 'running').length}
                              childCount={tree().children.get(s.id)?.length ?? 0}
                              updatedLabel={relTime(ts(s.updatedAt || s.createdAt), clock())}
                              onSelect={() => selectMission(s.id)}
                            />
                            <Show when={(tree().children.get(s.id)?.length ?? 0) > 0}>
                              <div
                                role="list"
                                aria-label={`Sub-agents of ${titleOf(s)}`}
                                style={{
                                  'margin-left': '14px',
                                  'padding-left': '8px',
                                  'border-left': '1px solid var(--border)',
                                  'margin-top': '4px',
                                  display: 'flex',
                                  'flex-direction': 'column',
                                  gap: '4px',
                                }}
                              >
                                <For each={tree().children.get(s.id)}>
                                  {(c) => (
                                    <MissionRow
                                      session={c}
                                      selected={selectedId() === c.id}
                                      state={stateOf(c)}
                                      jobCount={jobsFor(c.id).length}
                                      runningJobs={jobsFor(c.id).filter((j) => j.status === 'running').length}
                                      childCount={0}
                                      updatedLabel={relTime(ts(c.updatedAt || c.createdAt), clock())}
                                      onSelect={() => selectMission(c.id)}
                                    />
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                }
              >
                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '10px',
                    padding: '6px 2px 2px',
                  }}
                >
                  <EmptyBox>
                    No missions yet. Sessions created in Work appear here with their sub-agents.
                  </EmptyBox>
                  <button
                    type="button"
                    class="btn btn-solid"
                    onClick={() => {
                      void props.store
                        .createSession('New mission')
                        .then((s) => {
                          if (s) {
                            selectMission(s.id)
                            toast.success('Session created — it will show up as a mission')
                          }
                        })
                        .catch((e) => toast.error(`Create failed: ${errMsg(e)}`))
                    }}
                    style={{ 'min-height': '36px' }}
                  >
                    ＋ New session
                  </button>
                  <Show when={props.onOpenInChat}>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      onClick={() => props.onOpenInChat?.(selectedId() ?? '')}
                      style={{ 'min-height': '36px', border: '1px solid var(--border)' }}
                    >
                      Open Work
                    </button>
                  </Show>
                </div>
              </Show>
            </section>

            {/* ── Detail pane ── */}
            <section
              id="mc-detail"
              aria-label="Mission detail"
              class="card"
              style={{
                padding: '14px 16px',
                display: 'flex',
                'flex-direction': 'column',
                gap: '12px',
                'min-width': '0',
                'min-height': '340px',
              }}
            >
              <Show
                when={selected()}
                fallback={
                  <div
                    style={{
                      margin: 'auto',
                      padding: '32px 16px',
                      'text-align': 'center',
                      color: 'var(--fg-faint)',
                      'font-size': 'var(--fs-sm)',
                      'line-height': '1.6',
                      'max-width': '380px',
                    }}
                  >
                    Select a mission to inspect its agents, tool activity, files, cost and
                    transcript.
                  </div>
                }
              >
                {(s) => {
                  const meta = () => {
                    const parts = [
                      s().agent ?? 'general',
                      s().model || 'default model',
                      `updated ${relTime(ts(s().updatedAt || s().createdAt), clock())}`,
                    ]
                    return parts.join(' · ')
                  }
                  return (
                    <>
                      {/* Detail header */}
                      <div
                        style={{
                          display: 'flex',
                          gap: '10px',
                          'align-items': 'flex-start',
                          'justify-content': 'space-between',
                          'flex-wrap': 'wrap',
                        }}
                      >
                        <div style={{ 'min-width': 0, flex: '1 1 260px' }}>
                          <Show when={parentOfSelected()}>
                            {(p) => (
                              <button
                                type="button"
                                class="btn btn-ghost"
                                onClick={() => selectMission(p().id)}
                                title={`Open parent mission: ${titleOf(p())}`}
                                style={{
                                  padding: '1px 6px',
                                  'font-size': 'var(--fs-2xs)',
                                  'font-family': 'var(--font-mono)',
                                  color: 'var(--accent)',
                                  'border-radius': 'var(--r-sm)',
                                  'margin-bottom': '3px',
                                }}
                              >
                                ⬅ {titleOf(p())}
                              </button>
                            )}
                          </Show>
                          <div
                            style={{
                              display: 'flex',
                              gap: '8px',
                              'align-items': 'center',
                              'flex-wrap': 'wrap',
                            }}
                          >
                            <h2
                              style={{
                                'font-size': 'var(--fs-lg)',
                                'font-weight': 700,
                                'letter-spacing': '-0.02em',
                                margin: 0,
                                overflow: 'hidden',
                                'text-overflow': 'ellipsis',
                                'white-space': 'nowrap',
                                'max-width': '100%',
                              }}
                            >
                              {titleOf(s())}
                            </h2>
                            <StateChip state={stateOf(s())} />
                            <Show when={childOfSelected().length > 0}>
                              <span class="pill pill-accent" style={{ 'font-size': 'var(--fs-2xs)' }}>
                                {childOfSelected().length} sub-agent
                                {childOfSelected().length === 1 ? '' : 's'}
                              </span>
                            </Show>
                          </div>
                          <div
                            style={{
                              'font-size': 'var(--fs-2xs)',
                              color: 'var(--fg-faint)',
                              'font-family': 'var(--font-mono)',
                              'margin-top': '3px',
                              'word-break': 'break-word',
                            }}
                          >
                            {meta()}
                          </div>
                        </div>

                        <div
                          role="group"
                          aria-label="Mission actions"
                          style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}
                        >
                          <button
                            type="button"
                            class="btn btn-ghost"
                            onClick={() => void loadDetail(s().id)}
                            aria-label="Refresh mission detail"
                            style={{
                              padding: '6px 10px',
                              'font-size': 'var(--fs-xs)',
                              border: '1px solid var(--border)',
                              'border-radius': 'var(--r-md)',
                              'min-height': '32px',
                            }}
                          >
                            ↻
                          </button>
                          <Show when={props.onOpenInChat}>
                            <button
                              type="button"
                              class="btn btn-ghost"
                              onClick={() => props.onOpenInChat?.(s().id)}
                              title="Open this session in the Work workspace"
                              style={{
                                padding: '6px 10px',
                                'font-size': 'var(--fs-xs)',
                                border: '1px solid var(--border)',
                                'border-radius': 'var(--r-md)',
                                'min-height': '32px',
                              }}
                            >
                              Open in Work
                            </button>
                          </Show>
                          <button
                            type="button"
                            class="btn btn-danger-ghost"
                            disabled={!isRunningSelected() || busy() !== null}
                            aria-busy={busy() === 'abort' ? 'true' : 'false'}
                            onClick={() =>
                              setConfirm({
                                kind: 'abort',
                                sessionId: s().id,
                                label: titleOf(s()),
                              })
                            }
                            title="POST /session/:id/abort — stop the active turn"
                            style={{
                              padding: '6px 12px',
                              'font-size': 'var(--fs-xs)',
                              'min-height': '32px',
                              border: '1px solid var(--danger-border)',
                            }}
                          >
                            {busy() === 'abort' ? 'Aborting…' : '⏸ Abort turn'}
                          </button>
                        </div>
                      </div>

                      {/* Tabs */}
                      <div
                        role="tablist"
                        aria-label="Mission detail views"
                        onKeyDown={onTabKeyDown}
                        class="mc-tabs"
                        style={{
                          display: 'flex',
                          gap: '4px',
                          'overflow-x': 'auto',
                          'border-bottom': '1px solid var(--border)',
                          'padding-bottom': '6px',
                        }}
                      >
                        <For each={TABS}>
                          {(t) => {
                            const active = () => tab() === t.id
                            return (
                              <button
                                type="button"
                                role="tab"
                                data-mc-tab={t.id}
                                id={`mc-tab-${t.id}`}
                                aria-selected={active() ? 'true' : 'false'}
                                aria-controls={`mc-panel-${t.id}`}
                                tabIndex={active() ? 0 : -1}
                                onClick={() => setTab(t.id)}
                                style={{
                                  padding: '6px 11px',
                                  'border-radius': 'var(--r-md)',
                                  border: active()
                                    ? '1px solid var(--accent-border)'
                                    : '1px solid transparent',
                                  background: active() ? 'var(--accent-soft)' : 'transparent',
                                  color: active() ? 'var(--accent)' : 'var(--fg-muted)',
                                  'font-size': 'var(--fs-xs)',
                                  'font-weight': active() ? 700 : 500,
                                  cursor: 'pointer',
                                  'white-space': 'nowrap',
                                  'min-height': '32px',
                                  transition:
                                    'background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
                                }}
                              >
                                {t.label}
                              </button>
                            )
                          }}
                        </For>
                      </div>

                      {/* ── Overview ── */}
                      <Show when={tab() === 'overview'}>
                        <div
                          id="mc-panel-overview"
                          role="tabpanel"
                          aria-labelledby="mc-tab-overview"
                          tabIndex={0}
                          style={{
                            display: 'flex',
                            'flex-direction': 'column',
                            gap: '12px',
                            outline: 'none',
                          }}
                        >
                          {/* Current operation */}
                          <div
                            aria-label="Current operation"
                            style={{
                              padding: '11px 12px',
                              'border-radius': 'var(--r-md)',
                              border: currentOp()
                                ? '1px solid var(--accent-border)'
                                : '1px dashed var(--border-strong)',
                              background: currentOp() ? 'var(--accent-soft)' : 'var(--bg-app)',
                              display: 'flex',
                              'flex-direction': 'column',
                              gap: '7px',
                              'min-height': '78px',
                            }}
                          >
                            <div
                              style={{
                                'font-size': 'var(--fs-2xs)',
                                'font-weight': 700,
                                'letter-spacing': '0.05em',
                                'text-transform': 'uppercase',
                                color: currentOp() ? 'var(--accent)' : 'var(--fg-faint)',
                              }}
                            >
                              Current operation
                            </div>
                            <Show
                              when={currentOp()}
                              fallback={
                                <div
                                  style={{
                                    'font-size': 'var(--fs-sm)',
                                    color: 'var(--fg-subtle)',
                                    'line-height': '1.5',
                                  }}
                                >
                                  Idle — no active turn or job for this mission.
                                  <Show when={selectedJobs().length > 0}>
                                    <span
                                      style={{
                                        color: 'var(--fg-faint)',
                                        'font-family': 'var(--font-mono)',
                                        'font-size': 'var(--fs-2xs)',
                                      }}
                                    >
                                      {' '}
                                      · last job {selectedJobs()[0]?.status}
                                    </span>
                                  </Show>
                                </div>
                              }
                            >
                              {(op) =>
                                op().kind === 'job' ? (
                                  <div
                                    style={{
                                      display: 'flex',
                                      gap: '9px',
                                      'align-items': 'flex-start',
                                      'flex-wrap': 'wrap',
                                    }}
                                  >
                                    <div style={{ flex: '1 1 220px', 'min-width': 0 }}>
                                      <div
                                        style={{
                                          display: 'flex',
                                          gap: '6px',
                                          'align-items': 'center',
                                          'flex-wrap': 'wrap',
                                          'margin-bottom': '3px',
                                        }}
                                      >
                                        <span
                                          class="pill pill-warn"
                                          style={{ 'font-size': 'var(--fs-2xs)', padding: '1px 6px' }}
                                        >
                                          <span class="dot dot-pulse" style={{ background: 'var(--warn)' }} aria-hidden="true" />
                                          running
                                        </span>
                                        <span
                                          style={{
                                            'font-size': 'var(--fs-2xs)',
                                            color: 'var(--fg-subtle)',
                                            'font-family': 'var(--font-mono)',
                                          }}
                                        >
                                          {op().job?.agent ?? 'general'} ·{' '}
                                          <Elapsed since={ts(op().job?.createdAt)} />
                                        </span>
                                      </div>
                                      <div
                                        style={{
                                          'font-size': 'var(--fs-sm)',
                                          color: 'var(--fg)',
                                          'line-height': '1.5',
                                          'word-break': 'break-word',
                                        }}
                                      >
                                        {op().job?.prompt?.slice(0, 220) || 'Untitled job'}
                                        {(op().job?.prompt?.length ?? 0) > 220 ? '…' : ''}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      class="btn btn-danger-ghost"
                                      disabled={busy() !== null}
                                      onClick={() =>
                                        op().job &&
                                        setConfirm({
                                          kind: 'cancel',
                                          jobId: op().job!.id,
                                          sessionId: s().id,
                                          label: op().job!.prompt?.slice(0, 80) || 'this job',
                                        })
                                      }
                                      title="POST /job/:id/cancel"
                                      style={{
                                        padding: '5px 11px',
                                        'font-size': 'var(--fs-xs)',
                                        'min-height': '32px',
                                        border: '1px solid var(--danger-border)',
                                        flex: 'none',
                                      }}
                                    >
                                      ✕ Cancel job
                                    </button>
                                  </div>
                                ) : (
                                  <div
                                    style={{
                                      display: 'flex',
                                      gap: '8px',
                                      'align-items': 'center',
                                      'font-size': 'var(--fs-sm)',
                                      color: 'var(--fg)',
                                    }}
                                  >
                                    <span class="streaming-indicator" aria-hidden="true">
                                      <span class="streaming-dot" />
                                      <span class="streaming-dot" />
                                      <span class="streaming-dot" />
                                    </span>
                                    Streaming a response — in the active turn.
                                  </div>
                                )
                              }
                            </Show>
                          </div>

                          {/* Cost / usage tiles */}
                          <div
                            style={{
                              display: 'grid',
                              'grid-template-columns': 'repeat(auto-fit, minmax(150px, 1fr))',
                              gap: '8px',
                            }}
                          >
                            <StatTile
                              label="Tokens"
                              value={
                                costError()
                                  ? '—'
                                  : `${fmtTokens(cost()?.persisted?.tokensIn ?? cost()?.tokensIn)} in · ${fmtTokens(cost()?.persisted?.tokensOut ?? cost()?.tokensOut)} out`
                              }
                              hint={costError() ? 'unavailable' : 'persisted totals'}
                              loading={costLoading() && !cost()}
                            />
                            <StatTile
                              label="Cost"
                              value={costError() ? '—' : usd(cost()?.persisted?.costUSD ?? cost()?.costUSD)}
                              hint={
                                cost()?.requests
                                  ? `live: ${cost()!.requests} request${cost()!.requests === 1 ? '' : 's'} · ${usd(cost()?.costUSD)}`
                                  : 'persisted session total'
                              }
                              tone="accent"
                              loading={costLoading() && !cost()}
                            />
                            <StatTile
                              label="Files changed"
                              value={costLoading() && !snapshots() ? '' : String(fileChanges().length)}
                              hint={`${snapshots().length} snapshot${snapshots().length === 1 ? '' : 's'}`}
                              loading={snapshotsLoading() && snapshots().length === 0}
                            />
                            <StatTile
                              label="Jobs"
                              value={String(selectedJobs().length)}
                              hint={`${selectedJobs().filter((j) => j.status === 'running').length} running`}
                              loading={jobsLoading() && selectedJobs().length === 0}
                            />
                            <StatTile
                              label="Sub-agents"
                              value={String(childOfSelected().length)}
                              tone="accent"
                              hint="spawned child sessions"
                            />
                            <StatTile
                              label="Messages"
                              value={String(messages().length)}
                              hint={`${toolActivity().length} recent tool calls`}
                              loading={messagesLoading() && messages().length === 0}
                            />
                          </div>

                          <Show when={costError()}>
                            <SectionError message={costError()!} onRetry={() => void loadCostFor(s().id)} />
                          </Show>

                          {/* Sub-agents */}
                          <div
                            style={{
                              display: 'flex',
                              'flex-direction': 'column',
                              gap: '6px',
                              'padding-top': '4px',
                              'border-top': '1px dashed var(--border)',
                            }}
                          >
                            <div
                              style={{
                                'font-size': 'var(--fs-xs)',
                                'font-weight': 700,
                                'letter-spacing': '0.05em',
                                'text-transform': 'uppercase',
                                color: 'var(--fg-muted)',
                              }}
                            >
                              Parent / child agents
                            </div>
                            <Show
                              when={childOfSelected().length > 0}
                              fallback={
                                <div
                                  style={{
                                    'font-size': 'var(--fs-xs)',
                                    color: 'var(--fg-faint)',
                                    'line-height': '1.5',
                                  }}
                                >
                                  No sub-agents spawned for this mission.
                                  <Show when={parentOfSelected()}>
                                    <span> Parent: </span>
                                    <button
                                      type="button"
                                      class="btn btn-ghost"
                                      onClick={() => parentOfSelected() && selectMission(parentOfSelected()!.id)}
                                      style={{
                                        padding: '1px 6px',
                                        'font-size': 'var(--fs-xs)',
                                        color: 'var(--accent)',
                                        'border-radius': 'var(--r-sm)',
                                      }}
                                    >
                                      {titleOf(parentOfSelected()!)}
                                    </button>
                                  </Show>
                                </div>
                              }
                            >
                              <div
                                role="list"
                                aria-label="Child agents"
                                style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}
                              >
                                <For each={childOfSelected()}>
                                  {(c) => (
                                    <button
                                      type="button"
                                      role="listitem"
                                      onClick={() => selectMission(c.id)}
                                      aria-label={`Open sub-agent ${titleOf(c)}`}
                                      style={{
                                        display: 'flex',
                                        gap: '8px',
                                        'align-items': 'center',
                                        'justify-content': 'space-between',
                                        padding: '7px 9px',
                                        'border-radius': 'var(--r-sm)',
                                        background: 'var(--bg-app)',
                                        border: '1px solid var(--border)',
                                        cursor: 'pointer',
                                        'text-align': 'left',
                                        'min-height': '34px',
                                      }}
                                    >
                                      <span
                                        style={{
                                          'font-size': 'var(--fs-xs)',
                                          color: 'var(--fg)',
                                          'font-weight': 600,
                                          overflow: 'hidden',
                                          'text-overflow': 'ellipsis',
                                          'white-space': 'nowrap',
                                          'min-width': 0,
                                          flex: 1,
                                        }}
                                      >
                                        {titleOf(c)}
                                      </span>
                                      <StateChip state={stateOf(c)} />
                                    </button>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </Show>

                      {/* ── Tool activity ── */}
                      <Show when={tab() === 'tools'}>
                        <div
                          id="mc-panel-tools"
                          role="tabpanel"
                          aria-labelledby="mc-tab-tools"
                          tabIndex={0}
                          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px', outline: 'none' }}
                        >
                          <div
                            style={{
                              'font-size': 'var(--fs-2xs)',
                              color: 'var(--fg-faint)',
                              'font-family': 'var(--font-mono)',
                            }}
                          >
                            Last {TOOL_LIMIT} tool calls · parts.type = tool / tool_call
                          </div>
                          <Show when={messagesLoading() && normMessages().length === 0}>
                            <SkeletonRows rows={3} height="44px" />
                          </Show>
                          <Show when={messagesError()}>
                            <SectionError
                              message={messagesError()!}
                              onRetry={() => void loadMessagesFor(s().id)}
                            />
                          </Show>
                          <Show
                            when={!messagesLoading() && !messagesError()}
                            fallback={
                              <Show when={!messagesLoading() && !messagesError()}>
                                <EmptyBox>No tool calls recorded for this mission yet.</EmptyBox>
                              </Show>
                            }
                          >
                            <Show
                              when={toolActivity().length > 0}
                              fallback={
                                <EmptyBox>No tool calls recorded for this mission yet.</EmptyBox>
                              }
                            >
                              <div
                                role="list"
                                aria-label="Recent tool calls"
                                style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}
                              >
                                <For each={toolActivity()}>
                                  {(t) => (
                                    <div
                                      role="listitem"
                                      style={{
                                        display: 'flex',
                                        gap: '9px',
                                        'align-items': 'flex-start',
                                        padding: '8px 10px',
                                        background: 'var(--bg-app)',
                                        border: `1px solid ${
                                          t.status === 'error'
                                            ? 'var(--danger-border)'
                                            : t.status === 'running'
                                              ? 'var(--warn-border)'
                                              : 'var(--border)'
                                        }`,
                                        'border-radius': 'var(--r-sm)',
                                      }}
                                    >
                                      <span
                                        style={{
                                          width: '8px',
                                          height: '8px',
                                          'border-radius': '50%',
                                          flex: 'none',
                                          'margin-top': '5px',
                                          background:
                                            t.status === 'error'
                                              ? 'var(--danger)'
                                              : t.status === 'running'
                                                ? 'var(--warn)'
                                                : 'var(--ok)',
                                        }}
                                        aria-hidden="true"
                                      />
                                      <div style={{ flex: 1, 'min-width': 0 }}>
                                        <div
                                          style={{
                                            display: 'flex',
                                            gap: '6px',
                                            'align-items': 'center',
                                            'flex-wrap': 'wrap',
                                            'margin-bottom': '2px',
                                          }}
                                        >
                                          <span
                                            style={{
                                              'font-size': 'var(--fs-xs)',
                                              'font-weight': 700,
                                              color: 'var(--fg)',
                                              'font-family': 'var(--font-mono)',
                                            }}
                                          >
                                            {t.tool}
                                          </span>
                                          <span
                                            style={{
                                              'font-size': 'var(--fs-2xs)',
                                              color:
                                                t.status === 'error'
                                                  ? 'var(--danger)'
                                                  : t.status === 'running'
                                                    ? 'var(--warn)'
                                                    : 'var(--fg-faint)',
                                              'font-weight': 600,
                                            }}
                                          >
                                            {t.status}
                                          </span>
                                          <span
                                            style={{
                                              'font-size': 'var(--fs-2xs)',
                                              color: 'var(--fg-faint)',
                                              'font-family': 'var(--font-mono)',
                                              'margin-left': 'auto',
                                            }}
                                          >
                                            {relTime(t.at, clock())}
                                          </span>
                                        </div>
                                        <Show when={t.summary}>
                                          <div
                                            style={{
                                              'font-size': 'var(--fs-2xs)',
                                              color: 'var(--fg-subtle)',
                                              'font-family': 'var(--font-mono)',
                                              'white-space': 'pre-wrap',
                                              'word-break': 'break-word',
                                              'line-height': 1.5,
                                            }}
                                          >
                                            {t.summary}
                                          </div>
                                        </Show>
                                      </div>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </Show>
                        </div>
                      </Show>

                      {/* ── Files changed ── */}
                      <Show when={tab() === 'files'}>
                        <div
                          id="mc-panel-files"
                          role="tabpanel"
                          aria-labelledby="mc-tab-files"
                          tabIndex={0}
                          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px', outline: 'none' }}
                        >
                          <div
                            style={{
                              'font-size': 'var(--fs-2xs)',
                              color: 'var(--fg-faint)',
                              'font-family': 'var(--font-mono)',
                            }}
                          >
                            GET /session/:id/snapshots · {fileChanges().length} distinct file
                            {fileChanges().length === 1 ? '' : 's'} · {snapshots().length} mutation
                            {snapshots().length === 1 ? '' : 's'}
                          </div>
                          <Show when={snapshotsLoading() && snapshots().length === 0}>
                            <SkeletonRows rows={3} height="40px" />
                          </Show>
                          <Show when={snapshotsError()}>
                            <SectionError
                              message={snapshotsError()!}
                              onRetry={() => void loadSnapshotsFor(s().id)}
                            />
                          </Show>
                          <Show when={!snapshotsLoading() && !snapshotsError()}>
                            <Show
                              when={fileChanges().length > 0}
                              fallback={
                                <EmptyBox>No file changes recorded for this mission.</EmptyBox>
                              }
                            >
                              <div
                                role="list"
                                aria-label="Files changed"
                                style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}
                              >
                                <For each={fileChanges().slice(0, FILE_LIMIT)}>
                                  {(f) => (
                                    <div
                                      role="listitem"
                                      style={{
                                        display: 'flex',
                                        gap: '8px',
                                        'align-items': 'center',
                                        'justify-content': 'space-between',
                                        padding: '7px 9px',
                                        background: 'var(--bg-app)',
                                        border: '1px solid var(--border)',
                                        'border-radius': 'var(--r-sm)',
                                      }}
                                    >
                                      <span
                                        style={{
                                          'font-size': 'var(--fs-xs)',
                                          'font-family': 'var(--font-mono)',
                                          color: 'var(--fg)',
                                          overflow: 'hidden',
                                          'text-overflow': 'ellipsis',
                                          'white-space': 'nowrap',
                                          'min-width': 0,
                                          flex: 1,
                                        }}
                                        title={f.path}
                                      >
                                        {f.path}
                                      </span>
                                      <span
                                        class={`pill ${f.isNew ? 'pill-ok' : ''}`}
                                        style={{
                                          'font-size': 'var(--fs-2xs)',
                                          padding: '1px 6px',
                                          flex: 'none',
                                        }}
                                      >
                                        {f.isNew ? 'new' : 'modified'}
                                      </span>
                                      <span
                                        style={{
                                          'font-size': 'var(--fs-2xs)',
                                          color: 'var(--fg-faint)',
                                          'font-family': 'var(--font-mono)',
                                          flex: 'none',
                                        }}
                                      >
                                        {relTime(f.at, clock())}
                                      </span>
                                    </div>
                                  )}
                                </For>
                              </div>
                              <Show when={fileChanges().length > FILE_LIMIT}>
                                <div
                                  style={{
                                    'font-size': 'var(--fs-2xs)',
                                    color: 'var(--fg-faint)',
                                    'font-family': 'var(--font-mono)',
                                  }}
                                >
                                  Showing {FILE_LIMIT} of {fileChanges().length} files.
                                </div>
                              </Show>
                            </Show>
                          </Show>
                        </div>
                      </Show>

                      {/* ── Transcript ── */}
                      <Show when={tab() === 'transcript'}>
                        <div
                          id="mc-panel-transcript"
                          role="tabpanel"
                          aria-labelledby="mc-tab-transcript"
                          tabIndex={0}
                          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px', outline: 'none' }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              gap: '8px',
                              'align-items': 'center',
                              'justify-content': 'space-between',
                              'flex-wrap': 'wrap',
                            }}
                          >
                            <span
                              style={{
                                'font-size': 'var(--fs-2xs)',
                                color: 'var(--fg-faint)',
                                'font-family': 'var(--font-mono)',
                              }}
                            >
                              <Show
                                when={messages().length > TRANSCRIPT_LIMIT}
                                fallback={`${messages().length} message${messages().length === 1 ? '' : 's'} · read-only preview`}
                              >
                                last {TRANSCRIPT_LIMIT} of {messages().length} messages
                              </Show>
                            </span>
                            <Show when={props.onOpenInChat}>
                              <button
                                type="button"
                                class="btn btn-ghost"
                                onClick={() => props.onOpenInChat?.(s().id)}
                                style={{
                                  padding: '3px 9px',
                                  'font-size': 'var(--fs-2xs)',
                                  border: '1px solid var(--border)',
                                  'border-radius': 'var(--r-full)',
                                }}
                              >
                                Edit in Work →
                              </button>
                            </Show>
                          </div>

                          <Show when={messagesLoading() && normMessages().length === 0}>
                            <SkeletonRows rows={3} height="56px" />
                          </Show>
                          <Show when={messagesError()}>
                            <SectionError
                              message={messagesError()!}
                              onRetry={() => void loadMessagesFor(s().id)}
                            />
                          </Show>
                          <Show when={!messagesLoading() && !messagesError()}>
                            <Show
                              when={transcriptMessages().length > 0}
                              fallback={
                                <EmptyBox>
                                  No messages yet — send the first prompt from the Work workspace.
                                </EmptyBox>
                              }
                            >
                              <div
                                class="scroll"
                                style={{
                                  'max-height': '460px',
                                  overflow: 'auto',
                                  padding: '2px 2px 8px',
                                }}
                              >
                                <TurnList messages={transcriptMessages()} streaming={false} />
                              </div>
                            </Show>
                          </Show>
                        </div>
                      </Show>
                    </>
                  )
                }}
              </Show>
            </section>
          </div>

          {/* Endpoint footer */}
          <div
            class="card"
            style={{
              padding: '10px 12px',
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              'flex-wrap': 'wrap',
              background: 'var(--bg-app)',
              border: '1px dashed var(--border-strong)',
              'font-size': 'var(--fs-xs)',
              color: 'var(--fg-subtle)',
              'line-height': '1.5',
            }}
          >
            <span style={{ 'font-weight': 700, color: 'var(--fg-muted)' }}>Live:</span>
            BusEvent session.created / session.updated / session.abort + job.created /
            job.updated / job.cancelled — 3s job poll is the fallback.
            <span
              style={{
                'margin-left': 'auto',
                'font-family': 'var(--font-mono)',
                'font-size': 'var(--fs-2xs)',
                color: 'var(--fg-faint)',
              }}
            >
              GET /session · /jobs · /snapshots · /cost · POST abort + /job/:id/cancel
            </span>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={() => confirm() !== null}
        title={confirmTitle()}
        message={confirmMessage()}
        confirmLabel={confirm()?.kind === 'abort' ? 'Abort turn' : 'Cancel job'}
        cancelLabel="Keep running"
        danger
        onConfirm={() => void runConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}
