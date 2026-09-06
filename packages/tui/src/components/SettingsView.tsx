/**
 * SettingsView — TUI port of web/src/components/SettingsPanel.tsx
 *
 * 7 tabs: General/Providers/Permissions/Connectors/Agents/Commands/Terminal
 * Tab nav via Tab/1-7, forms with input/select, TUI Box/Text styling (dark overlay)
 * Focus trap + Escape handling
 */

import { createSignal, createEffect, For, Show, onCleanup } from 'solid-js'
import type { SettingsStore, ThemeChoice } from '../stores/settings'
import { rpc } from '../rpc/client'
import type { MiraConfig, SchedulerStatus, EvalDelta, Patch } from '../rpc/client'
import { getColorMode } from '../lib/a11y'

type TabId =
  | 'general'
  | 'providers'
  | 'permissions'
  | 'connectors'
  | 'agents'
  | 'commands'
  | 'terminal'
  | 'autopilot'

const TABS: Array<{ id: TabId; label: string; icon: string; desc: string }> = [
  { id: 'general', label: 'General', icon: '⚙', desc: 'Model & appearance' },
  { id: 'providers', label: 'Providers', icon: '🔑', desc: 'API keys' },
  { id: 'permissions', label: 'Permissions', icon: '🛡', desc: 'Tool access' },
  { id: 'connectors', label: 'Connectors', icon: '🔌', desc: 'MCP servers' },
  { id: 'agents', label: 'Agents', icon: '🤖', desc: 'Lane personas' },
  { id: 'commands', label: 'Commands', icon: '⌘', desc: 'Slash & skills' },
  { id: 'terminal', label: 'Terminal', icon: '▣', desc: 'PTY & sandbox' },
  { id: 'autopilot', label: 'Autopilot', icon: '✦', desc: 'Scheduler & patches' },
]

function AutopilotInline() {
  const [status, setStatus] = createSignal<SchedulerStatus | null>(null)
  const [delta, setDelta] = createSignal<EvalDelta | null>(null)
  const [patches, setPatches] = createSignal<Patch[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [approving, setApproving] = createSignal<string | null>(null)
  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, d, p] = await Promise.all([
        rpc.getLearningSchedulerStatus().catch(() => ({ status: 'idle' }) as SchedulerStatus),
        rpc.getLearningLastEvalDelta().catch(() => ({ delta: 0, sessionID: '' }) as EvalDelta),
        rpc.listPendingPatches().catch(() => [] as Patch[]),
      ])
      setStatus(s as SchedulerStatus)
      setDelta(d as EvalDelta)
      setPatches(p as Patch[])
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load autopilot')
    } finally {
      setLoading(false)
    }
  }
  createEffect(() => {
    void load()
  })
  const approve = async (id: string) => {
    setApproving(id)
    try {
      await rpc.approvePatch(id)
      setPatches((ps) => ps.filter((p) => p.id !== id))
    } catch (e) {
      setError((e as Error).message ?? 'Failed to approve patch')
    } finally {
      setApproving(null)
    }
  }
  const fmt = (iso?: string | number | null) => {
    if (iso == null || iso === '') return '—'
    try {
      if (typeof iso === 'number') return new Date(iso).toLocaleString()
      return new Date(iso).toLocaleString()
    } catch {
      return String(iso)
    }
  }
  const statusLabel = () => {
    const s = status()
    if (!s) return 'idle'
    if (typeof s.status === 'string') return s.status
    return 'idle'
  }
  const isRunning = () => statusLabel() === 'running'
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
      <Show when={loading()}>
        <div
          style={{
            padding: '12px',
            'border-radius': '8px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.06)',
            color: '#9ca3af',
            'font-size': '12px',
          }}
        >
          Loading autopilot…
        </div>
      </Show>
      <Show when={error()}>
        <div
          role="alert"
          style={{
            padding: '8px 10px',
            'border-radius': '8px',
            background: 'rgba(239,68,68,0.10)',
            border: '1px solid rgba(239,68,68,0.22)',
            color: '#fecaca',
            'font-size': '12px',
          }}
        >
          ⚠ {error()}
        </div>
      </Show>
      <Show when={!loading() && !error()}>
        <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}>
          <div
            style={{
              padding: '12px',
              'border-radius': '8px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              'flex-direction': 'column',
              gap: '8px',
            }}
          >
            <div
              style={{
                'font-size': '11px',
                'font-weight': '700',
                color: '#9ca3af',
                'letter-spacing': '0.04em',
                'text-transform': 'uppercase',
              }}
            >
              Schedule
            </div>
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '6px',
                'font-size': '12px',
              }}
            >
              <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px' }}>
                <span style={{ color: '#6b7280' }}>Status</span>
                <span
                  style={{
                    padding: '2px 8px',
                    'border-radius': '999px',
                    'font-size': '11px',
                    'font-weight': '600',
                    background: isRunning() ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.06)',
                    border: isRunning()
                      ? '1px solid rgba(52,211,153,0.25)'
                      : '1px solid rgba(255,255,255,0.08)',
                    color: isRunning() ? '#6ee7b7' : '#9ca3af',
                  }}
                >
                  {statusLabel()}
                </span>
              </div>
              <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px' }}>
                <span style={{ color: '#6b7280' }}>Next run</span>
                <span
                  style={{
                    color: '#e5e7eb',
                    'font-family': 'ui-monospace, monospace',
                    'font-size': '11px',
                  }}
                >
                  {fmt(status()?.nextRunAt ?? null)}
                </span>
              </div>
              <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px' }}>
                <span style={{ color: '#6b7280' }}>Last run</span>
                <span
                  style={{
                    color: '#e5e7eb',
                    'font-family': 'ui-monospace, monospace',
                    'font-size': '11px',
                  }}
                >
                  {fmt(status()?.lastRunAt ?? null)}
                </span>
              </div>
            </div>
          </div>
          <div
            style={{
              padding: '12px',
              'border-radius': '8px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              'flex-direction': 'column',
              gap: '8px',
            }}
          >
            <div
              style={{
                'font-size': '11px',
                'font-weight': '700',
                color: '#9ca3af',
                'letter-spacing': '0.04em',
                'text-transform': 'uppercase',
              }}
            >
              Last eval delta
            </div>
            <Show
              when={delta()}
              fallback={
                <div style={{ 'font-size': '12px', color: '#6b7280' }}>No eval data yet</div>
              }
            >
              <div>
                <div
                  style={{
                    'font-size': '18px',
                    'font-weight': '700',
                    color: (delta()?.delta ?? 0) >= 0 ? '#6ee7b7' : '#fca5a5',
                    'font-family': 'ui-monospace, monospace',
                  }}
                >
                  {(delta()?.delta ?? 0) >= 0 ? '+' : ''}
                  {(delta()?.delta ?? 0).toFixed(2)}
                </div>
                <div
                  style={{
                    'font-size': '11px',
                    color: '#6b7280',
                    'font-family': 'ui-monospace, monospace',
                  }}
                >
                  Session {(delta()?.sessionID ?? '').slice(0, 8) || '—'}
                </div>
              </div>
            </Show>
          </div>
        </div>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <div
            style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}
          >
            <div style={{ 'font-size': '12px', 'font-weight': '700', color: '#e5e7eb' }}>
              Pending patches
            </div>
            <button
              type="button"
              onClick={() => void load()}
              style={{
                padding: '4px 8px',
                'border-radius': '6px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.06)',
                color: '#9ca3af',
                cursor: 'pointer',
                'font-size': '11px',
              }}
            >
              ↻ Refresh
            </button>
          </div>
          <Show when={patches().length === 0}>
            <div
              style={{
                padding: '14px',
                border: '1px dashed rgba(255,255,255,0.12)',
                'border-radius': '8px',
                color: '#6b7280',
                'font-size': '11px',
                'text-align': 'center',
              }}
            >
              No pending patches
            </div>
          </Show>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
            <For each={patches()}>
              {(p) => (
                <div
                  style={{
                    padding: '10px 12px',
                    'border-radius': '8px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex',
                    gap: '10px',
                    'align-items': 'flex-start',
                    'justify-content': 'space-between',
                  }}
                >
                  <div
                    style={{
                      flex: '1',
                      'min-width': '0',
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '4px',
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        padding: '1px 6px',
                        'border-radius': '999px',
                        background: 'rgba(99,102,241,0.15)',
                        border: '1px solid rgba(99,102,241,0.25)',
                        color: '#a5b4fc',
                        'font-size': '10px',
                        'font-weight': '600',
                        'font-family': 'ui-monospace, monospace',
                        'align-self': 'flex-start',
                      }}
                    >
                      {p.painPointId}
                    </span>
                    <div
                      style={{
                        'font-size': '11px',
                        color: '#9ca3af',
                        'line-height': '1.4',
                        'word-break': 'break-word',
                      }}
                    >
                      {p.reason}
                    </div>
                    <pre
                      style={{
                        margin: '0',
                        padding: '6px 8px',
                        'border-radius': '6px',
                        background: 'rgba(0,0,0,0.28)',
                        border: '1px solid rgba(255,255,255,0.06)',
                        'font-size': '10px',
                        'font-family': 'ui-monospace, monospace',
                        'white-space': 'pre-wrap',
                        'word-break': 'break-word',
                        color: '#d1d5db',
                        'max-height': '80px',
                        overflow: 'auto',
                      }}
                    >
                      {p.change.slice(0, 300)}
                    </pre>
                  </div>
                  <button
                    type="button"
                    disabled={approving() === p.id}
                    onClick={() => void approve(p.id)}
                    style={{
                      padding: '6px 12px',
                      'border-radius': '6px',
                      border: '1px solid rgba(99,102,241,0.5)',
                      background:
                        approving() === p.id ? 'rgba(255,255,255,0.06)' : 'rgba(99,102,241,0.85)',
                      color: approving() === p.id ? 'rgba(255,255,255,0.5)' : 'white',
                      cursor: approving() === p.id ? 'not-allowed' : 'pointer',
                      'font-size': '11px',
                      'font-weight': '600',
                      'flex-shrink': '0',
                    }}
                  >
                    {approving() === p.id ? 'Approving…' : 'Approve'}
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default function SettingsView(props: {
  store: SettingsStore
  open: boolean
  onClose: () => void
}) {
  const [tab, setTab] = createSignal<TabId>('general')
  const s = () => props.store.state

  // Form state for General
  const [model, setModel] = createSignal('')
  const [smallModel, setSmallModel] = createSignal('')
  const [loopMaxSteps, setLoopMaxSteps] = createSignal('')
  const [loopContextLimit, setLoopContextLimit] = createSignal('')
  const [loopThreshold, setLoopThreshold] = createSignal('')
  const [loopSmallModel, setLoopSmallModel] = createSignal('')
  const [theme, setThemeLocal] = createSignal<ThemeChoice>('system')

  // Providers add form
  const [provName, setProvName] = createSignal('')
  const [provKey, setProvKey] = createSignal('')
  const [provUrl, setProvUrl] = createSignal('')
  const [provTesting, setProvTesting] = createSignal<string | null>(null)
  const [provResult, setProvResult] = createSignal<Record<string, string>>({})

  // MCP add form
  const [mcpName, setMcpName] = createSignal('')
  const [mcpType, setMcpType] = createSignal<'local' | 'remote'>('local')
  const [mcpCommand, setMcpCommand] = createSignal('')
  const [mcpUrl, setMcpUrl] = createSignal('')
  const [mcpEnv, setMcpEnv] = createSignal('')
  const [mcpHeaders, setMcpHeaders] = createSignal('')
  const [mcpTesting, setMcpTesting] = createSignal<string | null>(null)
  const [mcpResult, setMcpResult] = createSignal<Record<string, string>>({})

  // Permission add form
  const [permTool, setPermTool] = createSignal('')
  const [permPattern, setPermPattern] = createSignal('')
  const [permAction, setPermAction] = createSignal<'allow' | 'deny' | 'ask'>('allow')

  // Permission dry-run
  const [permTestTool, setPermTestTool] = createSignal('bash')
  const [permTestArgs, setPermTestArgs] = createSignal('{"command":"ls -la"}')
  const [permTestAgent, setPermTestAgent] = createSignal('')
  const [permTesting, setPermTesting] = createSignal(false)
  const [permTestResult, setPermTestResult] = createSignal('')

  // Guardrails
  const [guardEnforce, setGuardEnforce] = createSignal(false)
  const [guardAllowedRoots, setGuardAllowedRoots] = createSignal('')
  const [guardBlockedPaths, setGuardBlockedPaths] = createSignal('')
  const [guardMaxBytes, setGuardMaxBytes] = createSignal('')
  const [guardTestTool, setGuardTestTool] = createSignal('read')
  const [guardTestPath, setGuardTestPath] = createSignal('')
  const [guardTesting, setGuardTesting] = createSignal(false)
  const [guardResult, setGuardResult] = createSignal('')

  // Lane contract preview
  const [agentPreview, setAgentPreview] = createSignal<string | null>(null)
  const [agentPreviewResult, setAgentPreviewResult] = createSignal<Record<string, string>>({})

  // Terminal
  const [termEnabled, setTermEnabled] = createSignal(true)
  const [termSandbox, setTermSandbox] = createSignal(true)
  const [termAllowed, setTermAllowed] = createSignal('')
  const [termTimeout, setTermTimeout] = createSignal('')
  const [termTesting, setTermTesting] = createSignal(false)
  const [termResult, setTermResult] = createSignal('')

  // Features
  const [featInject, setFeatInject] = createSignal(true)
  const [featLane, setFeatLane] = createSignal(true)
  const [featPerAgent, setFeatPerAgent] = createSignal(true)
  const [budgetCapEnabled, setBudgetCapEnabled] = createSignal(false)
  const [budgetCapAmount, setBudgetCapAmount] = createSignal(100)

  let dialogRef: HTMLDivElement | undefined
  let titleRef: HTMLDivElement | undefined

  // Sync form from loaded config — only on modal OPEN transition
  let wasOpen = false
  createEffect(() => {
    const open = props.open
    if (open && !wasOpen && s().config) {
      try {
        const enabled = localStorage.getItem('mira.budgetCap.enabled')
        const amount = localStorage.getItem('mira.budgetCap.amount')
        if (enabled != null) setBudgetCapEnabled(enabled === 'true')
        if (amount != null) setBudgetCapAmount(Number(amount) || 100)
      } catch {}
      setModel(s().config?.model ?? '')
      setSmallModel(s().config?.smallModel ?? '')
      const loop = s().config?.loop ?? {}
      setLoopMaxSteps(loop.maxSteps != null ? String(loop.maxSteps) : '')
      setLoopContextLimit(loop.contextLimit != null ? String(loop.contextLimit) : '')
      setLoopThreshold(loop.compactionThreshold != null ? String(loop.compactionThreshold) : '')
      setLoopSmallModel(loop.smallModel ?? '')
      const guard = s().config?.guardrails ?? {}
      setGuardEnforce(!!(guard as Record<string, unknown>).enforce)
      setGuardAllowedRoots(
        (((guard as Record<string, unknown>).allowedRoots as string[]) ?? []).join(', '),
      )
      setGuardBlockedPaths(
        (((guard as Record<string, unknown>).blockedPaths as string[]) ?? []).join(', '),
      )
      setGuardMaxBytes(
        (guard as Record<string, unknown>).maxOutputBytes != null
          ? String((guard as Record<string, unknown>).maxOutputBytes)
          : '',
      )
      const tools = (
        s().config as {
          tools?: {
            terminal?: {
              enabled?: boolean
              sandbox?: boolean
              allowedCommands?: string[]
              timeoutMs?: number
            }
          }
        }
      )?.tools
      const term = tools?.terminal
      if (term) {
        setTermEnabled(term.enabled ?? true)
        setTermSandbox(term.sandbox ?? true)
        setTermAllowed((term.allowedCommands ?? []).join(', '))
        setTermTimeout(term.timeoutMs != null ? String(term.timeoutMs) : '')
      }
      const feats = s().config?.features ?? {}
      setFeatInject((feats as Record<string, boolean>).injectTodosIntoLoadContext ?? true)
      setFeatLane((feats as Record<string, boolean>).enforceLaneContracts ?? true)
      setFeatPerAgent((feats as Record<string, boolean>).perAgentPermissionProfiles ?? true)
    }
    if (open && !wasOpen) setThemeLocal(s().theme as ThemeChoice)
    wasOpen = open
  })

  // Focus trap & keyboard nav: Tab, 1-8, arrows, Escape
  createEffect(() => {
    if (!props.open) return
    queueMicrotask(() => titleRef?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
        return
      }
      const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const isTyping =
        targetTag === 'input' ||
        targetTag === 'textarea' ||
        targetTag === 'select' ||
        (e.target as HTMLElement)?.isContentEditable

      // 1-8 quick tab pick when not typing
      if (!isTyping && e.key >= '1' && e.key <= '8') {
        e.preventDefault()
        const idx = Number(e.key) - 1
        const t = TABS[idx]
        if (t) {
          setTab(t.id)
          // Move focus to the newly active tab
          queueMicrotask(() => {
            const el = dialogRef?.querySelector<HTMLElement>(`#settings-tab-${t.id}`)
            el?.focus()
          })
        }
        return
      }

      // Arrow keys to cycle tabs when tablist is focused or body
      if (!isTyping && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const tablist = dialogRef?.querySelector('[role="tablist"]')
        const activeInsideTablist = tablist?.contains(document.activeElement)
        const activeIsBody = document.activeElement === document.body
        if (activeInsideTablist || activeIsBody || dialogRef?.contains(document.activeElement) && !isTyping) {
          // Only cycle if focus is on tablist or no input focused
          const focusedTab = document.activeElement?.getAttribute('role') === 'tab'
          if (focusedTab || activeIsBody || activeInsideTablist) {
            e.preventDefault()
            const idx = TABS.findIndex((t) => t.id === tab())
            const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
            const next = (idx + dir + TABS.length) % TABS.length
            setTab(TABS[next].id)
            queueMicrotask(() => {
              const el = dialogRef?.querySelector<HTMLElement>(`#settings-tab-${TABS[next].id}`)
              el?.focus()
            })
            return
          }
        }
      }

      // Focus trap for dialog
      if (e.key === 'Tab' && dialogRef) {
        const focusable = dialogRef.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        if (focusable.length === 0) return
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
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    onCleanup(() => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    })
  })

  // Load on open
  createEffect(() => {
    if (props.open) void props.store.loadAll()
  })

  const handleSaveGeneral = async (e: Event) => {
    e.preventDefault()
    const patch: Partial<MiraConfig> = {}
    if (model().trim()) patch.model = model().trim()
    if (smallModel().trim()) patch.smallModel = smallModel().trim()
    const loopPatch: Record<string, string | number> = {}
    const maxSteps = parseInt(loopMaxSteps().trim(), 10)
    if (loopMaxSteps().trim() && Number.isFinite(maxSteps) && maxSteps > 0)
      loopPatch.maxSteps = maxSteps
    const ctxLimit = parseInt(loopContextLimit().trim(), 10)
    if (loopContextLimit().trim() && Number.isFinite(ctxLimit) && ctxLimit > 0)
      loopPatch.contextLimit = ctxLimit
    const thresh = parseFloat(loopThreshold().trim())
    if (loopThreshold().trim() && Number.isFinite(thresh) && thresh > 0 && thresh <= 1)
      loopPatch.compactionThreshold = thresh
    if (loopSmallModel().trim()) loopPatch.smallModel = loopSmallModel().trim()
    if (Object.keys(loopPatch).length > 0) patch.loop = loopPatch as MiraConfig['loop']
    const guardPatch: Record<string, string | number | boolean | string[]> = {}
    const guardOrig = (s().config?.guardrails ?? {}) as Record<string, unknown>
    if (guardEnforce() !== !!guardOrig.enforce) guardPatch.enforce = guardEnforce()
    const roots = guardAllowedRoots()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const rootsOrig = ((guardOrig.allowedRoots as string[] | undefined) ?? []).join(', ')
    if (guardAllowedRoots().trim() !== rootsOrig) guardPatch.allowedRoots = roots
    const blocked = guardBlockedPaths()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const blockedOrig = ((guardOrig.blockedPaths as string[] | undefined) ?? []).join(', ')
    if (guardBlockedPaths().trim() !== blockedOrig) guardPatch.blockedPaths = blocked
    const maxBytes = parseInt(guardMaxBytes().trim(), 10)
    const maxOrig = guardOrig.maxOutputBytes != null ? String(guardOrig.maxOutputBytes) : ''
    if (guardMaxBytes().trim() !== maxOrig) {
      if (guardMaxBytes().trim() === '') guardPatch.maxOutputBytes = 0
      else if (Number.isFinite(maxBytes) && maxBytes > 0) guardPatch.maxOutputBytes = maxBytes
    }
    if (Object.keys(guardPatch).length > 0)
      patch.guardrails = guardPatch as unknown as MiraConfig['guardrails']
    const feats = s().config?.features ?? {}
    const featPatch: Record<string, boolean> = {}
    if (featInject() !== ((feats as Record<string, boolean>).injectTodosIntoLoadContext ?? true))
      featPatch.injectTodosIntoLoadContext = featInject()
    if (featLane() !== ((feats as Record<string, boolean>).enforceLaneContracts ?? true))
      featPatch.enforceLaneContracts = featLane()
    if (featPerAgent() !== ((feats as Record<string, boolean>).perAgentPermissionProfiles ?? true))
      featPatch.perAgentPermissionProfiles = featPerAgent()
    if (Object.keys(featPatch).length > 0) patch.features = { ...feats, ...featPatch }
    if (Object.keys(patch).length > 0) {
      await props.store.saveConfig(patch)
    }
    try {
      localStorage.setItem('mira.budgetCap.enabled', String(budgetCapEnabled()))
      localStorage.setItem('mira.budgetCap.amount', String(budgetCapAmount()))
    } catch {}
    props.store.setTheme(theme())
  }

  const handleAddProvider = async (e: Event) => {
    e.preventDefault()
    const name = provName().trim()
    const key = provKey().trim()
    if (!name || !key) return
    const baseURL = provUrl().trim() || undefined
    const providerPatch = {
      provider: {
        ...(s().config?.provider ?? {}),
        [name]: {
          npm: '@ai-sdk/openai-compatible',
          name,
          options: { baseURL: baseURL ?? 'https://api.openai.com/v1', apiKey: key },
          models: {},
        },
      },
    }
    const res = await props.store.saveConfig(providerPatch as Partial<MiraConfig>)
    if (res) {
      setProvName('')
      setProvKey('')
      setProvUrl('')
      void props.store.loadProviders()
    }
  }

  const handleTestProvider = async (id: string) => {
    setProvTesting(id)
    const r = await props.store.testProvider(id)
    setProvResult((prev) => ({
      ...prev,
      [id]: r.ok ? `✓ ok${r.latencyMs ? ` · ${r.latencyMs}ms` : ''}` : `✗ ${r.error ?? 'failed'}`,
    }))
    setProvTesting(null)
  }

  const handleAddMcp = async (e: Event) => {
    e.preventDefault()
    const name = mcpName().trim()
    if (!name) return
    const parseRecord = (raw: string): Record<string, string> | undefined => {
      const s = raw.trim()
      if (!s) return undefined
      try {
        const j = JSON.parse(s)
        if (j && typeof j === 'object' && !Array.isArray(j)) {
          const out: Record<string, string> = {}
          for (const [k, v] of Object.entries(j as Record<string, string>)) out[k] = String(v)
          return out
        }
      } catch {}
      const out: Record<string, string> = {}
      for (const pair of s.split(/[,\n]+/)) {
        const i = pair.indexOf('=')
        if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
      }
      return Object.keys(out).length ? out : undefined
    }
    const env = parseRecord(mcpEnv())
    const headers = parseRecord(mcpHeaders())
    const body: {
      name: string
      type: 'local' | 'remote'
      command?: string[]
      url?: string
      enabled?: boolean
      env?: Record<string, string>
      headers?: Record<string, string>
    } = {
      name,
      type: mcpType(),
      enabled: true,
      env,
      headers,
    }
    if (mcpType() === 'local') {
      const cmd = mcpCommand().trim()
      if (!cmd) return
      body.command = cmd.split(/\s+/).filter(Boolean)
    } else {
      const url = mcpUrl().trim()
      if (!url) return
      body.url = url
    }
    const created = await props.store.addMcp(body)
    if (created) {
      setMcpName('')
      setMcpCommand('')
      setMcpUrl('')
      setMcpEnv('')
      setMcpHeaders('')
    }
  }

  const handleAddPermission = async (e: Event) => {
    e.preventDefault()
    const tool = permTool().trim()
    const pattern = permPattern().trim()
    const action = permAction()
    if (!tool) return
    const current = { ...(s().config?.permission ?? {}) } as Record<
      string,
      string | Record<string, string>
    >
    let next: Record<string, string | Record<string, string>>
    if (pattern) {
      const existing = current[tool]
      const rec =
        typeof existing === 'object' && existing !== null
          ? { ...(existing as Record<string, string>), [pattern]: action }
          : { [pattern]: action }
      next = { ...current, [tool]: rec }
    } else {
      next = { ...current, [tool]: action }
    }
    await props.store.saveConfig({ permission: next } as Partial<MiraConfig>)
    setPermTool('')
    setPermPattern('')
  }

  const handleRemovePermission = async (tool: string, pattern?: string) => {
    const current = { ...(s().config?.permission ?? {}) } as Record<
      string,
      string | Record<string, string>
    >
    if (pattern) {
      const rec = current[tool]
      if (typeof rec === 'object' && rec !== null) {
        const copy = { ...(rec as Record<string, string>) }
        delete copy[pattern]
        if (Object.keys(copy).length === 0) delete current[tool]
        else current[tool] = copy
      }
    } else {
      delete current[tool]
    }
    await props.store.saveConfig({ permission: current } as Partial<MiraConfig>)
  }

  const handleSaveTerminal = async (e: Event) => {
    e.preventDefault()
    const allowed = termAllowed()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const timeout = parseInt(termTimeout().trim(), 10)
    const patch = {
      tools: {
        ...(s().config as { tools?: Record<string, unknown> })?.tools,
        terminal: {
          enabled: termEnabled(),
          sandbox: termSandbox(),
          allowedCommands: allowed.length ? allowed : undefined,
          timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
        },
      },
    }
    await props.store.saveConfig(patch as Partial<MiraConfig>)
  }

  const handleTestTerminal = async () => {
    setTermTesting(true)
    setTermResult('')
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${location.host}/terminal`)
      let done = false
      const t = setTimeout(() => {
        if (!done) {
          try {
            ws.close()
          } catch {}
          setTermResult('✗ timeout (no terminal.connected)')
          setTermTesting(false)
        }
      }, 6000)
      ws.onopen = () => {}
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data))
          if (m.type === 'terminal.connected') {
            ws.send(JSON.stringify({ type: 'terminal.input', data: 'echo mira-terminal-ok\n' }))
          } else if (
            m.type === 'terminal.output' &&
            String(m.payload?.data).includes('mira-terminal-ok')
          ) {
            done = true
            clearTimeout(t)
            setTermResult('✓ terminal ok — echo returned')
            try {
              ws.close()
            } catch {}
            setTermTesting(false)
          } else if (m.type === 'terminal.output' && String(m.payload?.data).includes('sandbox:')) {
            done = true
            clearTimeout(t)
            setTermResult(`✗ sandbox blocked: ${String(m.payload.data).slice(0, 120)}`)
            try {
              ws.close()
            } catch {}
            setTermTesting(false)
          }
        } catch {}
      }
      ws.onerror = () => {
        clearTimeout(t)
        setTermResult('✗ WS error')
        setTermTesting(false)
      }
      ws.onclose = () => {
        clearTimeout(t)
        if (!done && !termResult()) {
          setTermResult('✗ closed without output')
          setTermTesting(false)
        }
      }
    } catch (err) {
      setTermResult(`✗ ${(err as Error).message}`)
      setTermTesting(false)
    }
  }

  const handleToggleMcp = async (name: string, enabled: boolean) => {
    await props.store.toggleMcp(name, enabled)
  }

  const handleTestMcp = async (name: string) => {
    setMcpTesting(name)
    const r = await props.store.testMcp(name)
    setMcpResult((prev) => ({
      ...prev,
      [name]: r.ok ? `✓ ${r.toolCount ?? 0} tools` : `✗ ${r.error ?? 'failed'}`,
    }))
    setMcpTesting(null)
  }

  const handleTestPermission = async () => {
    setPermTesting(true)
    setPermTestResult('')
    try {
      const tool = permTestTool().trim() || 'bash'
      let args: Record<string, unknown> = {}
      const raw = permTestArgs().trim()
      if (raw) {
        try {
          args = JSON.parse(raw) as Record<string, unknown>
        } catch {
          args = { command: raw }
        }
      }
      const agent = permTestAgent().trim() || undefined
      const body: Record<string, unknown> = { tool, args, sessionID: 'preview' }
      if (agent) body.agent = agent
      const res = await rpc.checkPermission(body as Parameters<typeof rpc.checkPermission>[0])
      const lane = (res as unknown as { lane?: { agent: string; permissions: string } }).lane
        ? ` · lane:${(res as unknown as { lane: { agent: string; permissions: string } }).lane.agent}/${(res as unknown as { lane: { agent: string; permissions: string } }).lane.permissions}`
        : ''
      const pat = (res as { matchedPattern?: string }).matchedPattern
        ? ` · pattern:${(res as { matchedPattern: string }).matchedPattern}`
        : ''
      const arity =
        (res as { arity?: number }).arity != null
          ? ` · arity:${(res as { arity: number }).arity}`
          : ''
      const act =
        ((res as { action?: string }).action ?? (res as { allowed?: boolean }).allowed)
          ? 'allow'
          : 'deny'
      const icon = act === 'allow' ? '✓' : act === 'deny' ? '✗' : '?'
      setPermTestResult(`${icon} ${act}${lane}${pat}${arity} — ${res.reason ?? ''}`)
    } catch (err) {
      setPermTestResult(`✗ ${(err as Error).message}`)
    } finally {
      setPermTesting(false)
    }
  }

  const handleTestGuardrails = async () => {
    setGuardTesting(true)
    setGuardResult('')
    try {
      const tool = guardTestTool().trim() || 'read'
      const path = guardTestPath().trim()
      let args: Record<string, unknown> = {}
      if (tool === 'bash') args = { command: path }
      else if (['read', 'write', 'edit', 'glob', 'grep', 'patch'].includes(tool)) args = { path }
      else if (tool === 'webfetch') args = { url: path }
      else args = { path }
      // Use fetch directly for guardrails check (not in tui rpc yet, fallback to /guardrails/check)
      const res = await fetch(`${rpc as unknown as { baseUrl?: () => string }}`, {
        method: 'GET',
      }).catch(() => null)
      void res
      // Try via rpc if available, else direct fetch
      const base = (() => {
        try {
          return (rpc as unknown as { baseUrl?: string }).baseUrl ? '' : ''
        } catch {
          return ''
        }
      })()
      void base
      // Use generic fetch to /guardrails/check
      const token = (() => {
        try {
          return localStorage.getItem('mira_token') ?? ''
        } catch {
          return ''
        }
      })()
      const url = `${location.origin}/guardrails/check`
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ tool, args, sessionID: 'preview' }),
      })
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      const j = (await r.json()) as { decision: string; reason?: string }
      const icon = j.decision === 'allow' ? '✓' : j.decision === 'deny' ? '✗' : '⚠'
      setGuardResult(`${icon} ${j.decision}${j.reason ? ` — ${j.reason}` : ''}`)
    } catch (err) {
      setGuardResult(`✗ ${(err as Error).message}`)
    } finally {
      setGuardTesting(false)
    }
  }

  const handlePreviewAgent = async (name: string) => {
    setAgentPreview(name)
    try {
      const res = await fetch(`${location.origin}/agents/${encodeURIComponent(name)}/preview`, {
        headers: (() => {
          const headers: Record<string, string> = {}
          try {
            const t = localStorage.getItem('mira_token')
            if (t) headers.Authorization = `Bearer ${t}`
          } catch {}
          return headers
        })(),
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const j = (await res.json()) as { permissions: string; allowed: string[]; blocked: string[] }
      setAgentPreviewResult((prev) => ({
        ...prev,
        [name]: `✓ ${j.permissions} · ${j.allowed.length} allowed / ${j.blocked.length} blocked — allowed: ${j.allowed.slice(0, 8).join(', ')}${j.allowed.length > 8 ? '…' : ''}`,
      }))
    } catch (err) {
      setAgentPreviewResult((prev) => ({ ...prev, [name]: `✗ ${(err as Error).message}` }))
    } finally {
      setAgentPreview(null)
    }
  }

  const inputStyle = {
    flex: '1',
    padding: '7px 10px',
    'border-radius': '6px',
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(0,0,0,0.28)',
    color: '#e5e7eb',
    outline: 'none',
    'font-size': '12px',
    'font-family': 'ui-monospace, monospace',
  } as Record<string, string>

  const labelStyle = {
    'font-size': '11px',
    'font-weight': '600',
    color: '#9ca3af',
    'letter-spacing': '0.04em',
    'text-transform': 'uppercase',
  } as Record<string, string>

  const cardStyle = {
    padding: '12px',
    'border-radius': '8px',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    display: 'flex',
    'flex-direction': 'column',
    gap: '10px',
  } as Record<string, string>

  return (
    <Show when={props.open}>
      <div
        style={{
          position: 'fixed',
          inset: '0',
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          'z-index': '1000',
          padding: '16px',
        }}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 'min(860px, 96vw)',
            'max-height': '90vh',
            display: 'flex',
            'flex-direction': 'column',
            'border-radius': '12px',
            background: '#0f1117',
            border: '1px solid rgba(255,255,255,0.12)',
            'box-shadow': '0 16px 48px rgba(0,0,0,0.55)',
            overflow: 'hidden',
            color: '#e5e7eb',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              'justify-content': 'space-between',
              'align-items': 'flex-start',
              padding: '14px 16px',
              'border-bottom': '1px solid rgba(255,255,255,0.08)',
              'flex-shrink': '0',
            }}
          >
            <div>
              <div
                ref={titleRef}
                id="settings-title"
                tabindex="-1"
                style={{
                  'font-weight': '700',
                  'font-size': '15px',
                  'letter-spacing': '0.02em',
                  outline: 'none',
                }}
              >
                Settings
              </div>
              <div style={{ 'font-size': '11px', color: '#9ca3af', 'margin-top': '2px' }}>
                Configure Mira — models, providers, permissions, and connectors.{' '}
                <span style={{ opacity: '0.5' }}>Tab / 1-7 to switch · Esc to close</span>
              </div>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Close settings"
              style={{
                padding: '5px 10px',
                'border-radius': '6px',
                border: '1px solid rgba(255,255,255,0.10)',
                background: 'transparent',
                color: '#9ca3af',
                cursor: 'pointer',
                'font-size': '14px',
              }}
            >
              ×
            </button>
          </div>

          {/* Tab bar */}
          <div
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="horizontal"
            style={{
              display: 'flex',
              gap: '4px',
              padding: '8px 12px',
              'border-bottom': '1px solid rgba(255,255,255,0.06)',
              overflow: 'auto',
              'flex-shrink': '0',
              background: 'rgba(255,255,255,0.02)',
            }}
          >
            <For each={TABS}>
              {(t, i) => {
                const active = () => tab() === t.id
                return (
                  <button
                    type="button"
                    role="tab"
                    id={`settings-tab-${t.id}`}
                    aria-selected={active() ? 'true' : 'false'}
                    aria-controls={`settings-panel-${t.id}`}
                    tabindex={active() ? 0 : -1}
                    onClick={() => setTab(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                        e.preventDefault()
                        const next = (i() + 1) % TABS.length
                        setTab(TABS[next].id)
                        queueMicrotask(() => document.getElementById(`settings-tab-${TABS[next].id}`)?.focus())
                      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        const prev = (i() - 1 + TABS.length) % TABS.length
                        setTab(TABS[prev].id)
                        queueMicrotask(() => document.getElementById(`settings-tab-${TABS[prev].id}`)?.focus())
                      } else if (e.key === 'Home') {
                        e.preventDefault()
                        setTab(TABS[0].id)
                        queueMicrotask(() => document.getElementById(`settings-tab-${TABS[0].id}`)?.focus())
                      } else if (e.key === 'End') {
                        e.preventDefault()
                        setTab(TABS[TABS.length - 1].id)
                        queueMicrotask(() => document.getElementById(`settings-tab-${TABS[TABS.length - 1].id}`)?.focus())
                      }
                    }}
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '6px',
                      padding: '6px 10px',
                      'border-radius': '6px',
                      border: active()
                        ? '1px solid rgba(99,102,241,0.35)'
                        : '1px solid transparent',
                      background: active() ? 'rgba(99,102,241,0.18)' : 'transparent',
                      color: active() ? '#a5b4fc' : '#9ca3af',
                      cursor: 'pointer',
                      'font-size': '12px',
                      'font-weight': active() ? '700' : '500',
                      'white-space': 'nowrap',
                    }}
                  >
                    <span aria-hidden="true" style={{ 'font-size': '12px' }}>
                      {t.icon}
                    </span>
                    <span>
                      {i() + 1} {t.label}
                    </span>
                  </button>
                )
              }}
            </For>
          </div>

          {/* Content */}
          <div
            style={{
              flex: '1',
              overflow: 'auto',
              padding: '14px 16px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '12px',
            }}
          >
            <Show when={s().loading}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                <div
                  style={{
                    height: '48px',
                    'border-radius': '8px',
                    background: 'rgba(255,255,255,0.06)',
                  }}
                />
                <div
                  style={{
                    height: '48px',
                    'border-radius': '8px',
                    background: 'rgba(255,255,255,0.04)',
                  }}
                />
              </div>
            </Show>

            <Show when={s().error}>
              <div
                role="alert"
                style={{
                  padding: '8px 10px',
                  'border-radius': '8px',
                  background: 'rgba(239,68,68,0.10)',
                  border: '1px solid rgba(239,68,68,0.22)',
                  color: '#fecaca',
                  'font-size': '12px',
                }}
              >
                ⚠ {s().error}
              </div>
            </Show>

            {/* ── General ── */}
            <Show when={tab() === 'general'}>
              <div
                id="settings-panel-general"
                role="tabpanel"
                aria-labelledby="settings-tab-general"
              >
                <div
                  style={{
                    'font-size': '13px',
                    'font-weight': '700',
                    color: '#e5e7eb',
                    'margin-bottom': '10px',
                  }}
                >
                  General
                </div>
                <form
                  onSubmit={handleSaveGeneral}
                  style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}
                >
                  <div style={cardStyle}>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="settings-model" style={labelStyle}>
                        Model
                      </label>
                      <input
                        id="settings-model"
                        value={model()}
                        onInput={(e) => setModel(e.currentTarget.value)}
                        placeholder="openrouter/anthropic/claude-sonnet-4"
                        spellcheck={false}
                        autocomplete="off"
                        style={inputStyle}
                      />
                      <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                        Primary model for turns. Format: provider/model-id.
                      </span>
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="settings-small-model" style={labelStyle}>
                        Small model (compaction)
                      </label>
                      <input
                        id="settings-small-model"
                        value={smallModel()}
                        onInput={(e) => setSmallModel(e.currentTarget.value)}
                        placeholder="openrouter/deepseek/deepseek-v3.2-exp"
                        spellcheck={false}
                        autocomplete="off"
                        style={inputStyle}
                      />
                      <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                        Used for context compaction and summaries.
                      </span>
                    </div>

                    <div
                      style={{
                        'font-size': '11px',
                        'font-weight': '700',
                        color: '#9ca3af',
                        'letter-spacing': '0.04em',
                        'text-transform': 'uppercase',
                        'margin-top': '4px',
                      }}
                    >
                      Loop limits
                    </div>
                    <div
                      style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}
                    >
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                        <label for="settings-loop-maxsteps" style={labelStyle}>
                          Max steps
                        </label>
                        <input
                          id="settings-loop-maxsteps"
                          type="number"
                          min="1"
                          value={loopMaxSteps()}
                          onInput={(e) => setLoopMaxSteps(e.currentTarget.value)}
                          placeholder="32"
                          autocomplete="off"
                          style={inputStyle}
                        />
                        <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                          LLM turns per prompt.
                        </span>
                      </div>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                        <label for="settings-loop-ctx" style={labelStyle}>
                          Context limit
                        </label>
                        <input
                          id="settings-loop-ctx"
                          type="number"
                          min="1000"
                          value={loopContextLimit()}
                          onInput={(e) => setLoopContextLimit(e.currentTarget.value)}
                          placeholder="128000"
                          autocomplete="off"
                          style={inputStyle}
                        />
                        <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                          Tokens before compaction.
                        </span>
                      </div>
                    </div>
                    <div
                      style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}
                    >
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                        <label for="settings-loop-thresh" style={labelStyle}>
                          Compaction threshold
                        </label>
                        <input
                          id="settings-loop-thresh"
                          type="number"
                          min="0.1"
                          max="1"
                          step="0.05"
                          value={loopThreshold()}
                          onInput={(e) => setLoopThreshold(e.currentTarget.value)}
                          placeholder="0.8"
                          autocomplete="off"
                          style={inputStyle}
                        />
                        <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                          0–1 fraction of limit.
                        </span>
                      </div>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                        <label for="settings-loop-small" style={labelStyle}>
                          Loop small model
                        </label>
                        <input
                          id="settings-loop-small"
                          value={loopSmallModel()}
                          onInput={(e) => setLoopSmallModel(e.currentTarget.value)}
                          placeholder="openrouter/deepseek/..."
                          autocomplete="off"
                          spellcheck={false}
                          style={inputStyle}
                        />
                        <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                          Overrides smallModel for loops.
                        </span>
                      </div>
                    </div>

                    <div
                      style={{
                        'font-size': '11px',
                        'font-weight': '700',
                        color: '#9ca3af',
                        'letter-spacing': '0.04em',
                        'text-transform': 'uppercase',
                        'margin-top': '4px',
                      }}
                    >
                      Spend cockpit
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: '8px',
                        'flex-wrap': 'wrap',
                      }}
                    >
                      <label
                        style={{
                          display: 'inline-flex',
                          'align-items': 'center',
                          gap: '6px',
                          'font-size': '12px',
                          color: '#e5e7eb',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={budgetCapEnabled()}
                          onChange={(e) => setBudgetCapEnabled(e.currentTarget.checked)}
                        />
                        Enable budget cap
                      </label>
                      <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                        Warn when monthly spend exceeds
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="10"
                        value={budgetCapAmount()}
                        onInput={(e) => setBudgetCapAmount(Number(e.currentTarget.value) || 0)}
                        style={{ ...inputStyle, width: '80px', flex: 'none' }}
                      />
                      <span style={{ 'font-size': '11px', color: '#6b7280' }}>USD / month</span>
                    </div>

                    <div
                      style={{
                        'font-size': '11px',
                        'font-weight': '700',
                        color: '#9ca3af',
                        'letter-spacing': '0.04em',
                        'text-transform': 'uppercase',
                        'margin-top': '4px',
                      }}
                    >
                      Guardrails
                    </div>
                    <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                      <label
                        style={{
                          display: 'inline-flex',
                          'align-items': 'center',
                          gap: '6px',
                          'font-size': '12px',
                          color: '#e5e7eb',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={guardEnforce()}
                          onChange={(e) => setGuardEnforce(e.currentTarget.checked)}
                        />
                        Enforce
                      </label>
                      <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                        Block outside allowed roots.
                      </span>
                    </div>
                    <div
                      style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}
                    >
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                        <label for="settings-guard-roots" style={labelStyle}>
                          Allowed roots
                        </label>
                        <input
                          id="settings-guard-roots"
                          value={guardAllowedRoots()}
                          onInput={(e) => setGuardAllowedRoots(e.currentTarget.value)}
                          placeholder="/srv/projects, /home/me/code"
                          autocomplete="off"
                          spellcheck={false}
                          style={inputStyle}
                        />
                        <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                          Comma separated.
                        </span>
                      </div>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                        <label for="settings-guard-blocked" style={labelStyle}>
                          Blocked paths
                        </label>
                        <input
                          id="settings-guard-blocked"
                          value={guardBlockedPaths()}
                          onInput={(e) => setGuardBlockedPaths(e.currentTarget.value)}
                          placeholder="**/.env, **/secrets/**"
                          autocomplete="off"
                          spellcheck={false}
                          style={inputStyle}
                        />
                        <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                          Glob patterns.
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="settings-guard-max" style={labelStyle}>
                        Max output bytes
                      </label>
                      <input
                        id="settings-guard-max"
                        type="number"
                        min="1024"
                        value={guardMaxBytes()}
                        onInput={(e) => setGuardMaxBytes(e.currentTarget.value)}
                        placeholder="1048576"
                        autocomplete="off"
                        style={inputStyle}
                      />
                      <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                        Truncate tool output.
                      </span>
                    </div>

                    <div
                      style={{
                        ...cardStyle,
                        background: 'rgba(0,0,0,0.18)',
                        border: '1px dashed rgba(255,255,255,0.12)',
                      }}
                    >
                      <div
                        style={{
                          'font-size': '11px',
                          'font-weight': '700',
                          color: '#9ca3af',
                          'letter-spacing': '0.04em',
                          'text-transform': 'uppercase',
                        }}
                      >
                        Guardrails audit preview
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          'grid-template-columns': '110px 1fr auto',
                          gap: '8px',
                          'align-items': 'end',
                        }}
                      >
                        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                          <label style={labelStyle} for="guard-test-tool">
                            Tool
                          </label>
                          <select
                            id="guard-test-tool"
                            value={guardTestTool()}
                            onChange={(e) => setGuardTestTool(e.currentTarget.value)}
                            style={inputStyle}
                          >
                            <option value="read">read</option>
                            <option value="write">write</option>
                            <option value="edit">edit</option>
                            <option value="bash">bash</option>
                            <option value="glob">glob</option>
                            <option value="webfetch">webfetch</option>
                          </select>
                        </div>
                        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                          <label style={labelStyle} for="guard-test-path">
                            Path / command / URL
                          </label>
                          <input
                            id="guard-test-path"
                            value={guardTestPath()}
                            onInput={(e) => setGuardTestPath(e.currentTarget.value)}
                            placeholder="/path/to/file or rm -rf /"
                            spellcheck={false}
                            autocomplete="off"
                            style={inputStyle}
                          />
                        </div>
                        <button
                          type="button"
                          disabled={guardTesting()}
                          onClick={() => void handleTestGuardrails()}
                          style={{
                            padding: '7px 12px',
                            'border-radius': '6px',
                            border: '1px solid rgba(255,255,255,0.12)',
                            background: 'rgba(255,255,255,0.06)',
                            color: '#e5e7eb',
                            cursor: guardTesting() ? 'not-allowed' : 'pointer',
                            'font-size': '12px',
                            height: '34px',
                          }}
                        >
                          {guardTesting() ? 'Testing…' : 'Test'}
                        </button>
                      </div>
                      <Show when={guardResult()}>
                        <span
                          style={{
                            'font-size': '11px',
                            color: guardResult().startsWith('✓')
                              ? '#6ee7b7'
                              : guardResult().startsWith('✗')
                                ? '#fca5a5'
                                : '#fbbf24',
                            'font-family': 'ui-monospace, monospace',
                            'word-break': 'break-word',
                          }}
                        >
                          {guardResult()}
                        </span>
                      </Show>
                    </div>

                    <div
                      style={{
                        'font-size': '11px',
                        'font-weight': '700',
                        color: '#9ca3af',
                        'letter-spacing': '0.04em',
                        'text-transform': 'uppercase',
                        'margin-top': '4px',
                      }}
                    >
                      Features
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                      <label
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '8px',
                          'font-size': '12px',
                          color: '#e5e7eb',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={featInject()}
                          onChange={(e) => setFeatInject(e.currentTarget.checked)}
                        />
                        Inject todos into loadContext
                      </label>
                      <label
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '8px',
                          'font-size': '12px',
                          color: '#e5e7eb',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={featLane()}
                          onChange={(e) => setFeatLane(e.currentTarget.checked)}
                        />
                        Enforce lane contracts (tool allowlist)
                      </label>
                      <label
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '8px',
                          'font-size': '12px',
                          color: '#e5e7eb',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={featPerAgent()}
                          onChange={(e) => setFeatPerAgent(e.currentTarget.checked)}
                        />
                        Per-agent permission profiles
                      </label>
                    </div>

                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <span id="settings-theme-label" style={labelStyle}>
                        Theme
                      </span>
                      <div
                        role="radiogroup"
                        aria-labelledby="settings-theme-label"
                        style={{ display: 'flex', gap: '6px' }}
                      >
                        <For each={['light', 'dark', 'system'] as ThemeChoice[]}>
                          {(choice) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={theme() === choice ? 'true' : 'false'}
                              tabindex={theme() === choice ? 0 : -1}
                              onClick={() => setThemeLocal(choice)}
                              style={{
                                flex: '1',
                                padding: '8px 10px',
                                'border-radius': '6px',
                                border:
                                  theme() === choice
                                    ? '1px solid rgba(99,102,241,0.5)'
                                    : '1px solid rgba(255,255,255,0.12)',
                                background:
                                  theme() === choice ? 'rgba(99,102,241,0.18)' : 'rgba(0,0,0,0.18)',
                                color: theme() === choice ? '#a5b4fc' : '#9ca3af',
                                'font-size': '12px',
                                'font-weight': theme() === choice ? '700' : '500',
                                cursor: 'pointer',
                              }}
                            >
                              {choice === 'light'
                                ? '☀ Light'
                                : choice === 'dark'
                                  ? '☾ Dark'
                                  : '◐ System'}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
                    <button
                      type="button"
                      onClick={props.onClose}
                      style={{
                        padding: '7px 14px',
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
                      type="submit"
                      disabled={props.store.saving()}
                      style={{
                        padding: '7px 14px',
                        'border-radius': '6px',
                        border: '1px solid rgba(99,102,241,0.5)',
                        background: 'rgba(99,102,241,0.85)',
                        color: 'white',
                        cursor: props.store.saving() ? 'not-allowed' : 'pointer',
                        'font-size': '12px',
                        'font-weight': '700',
                        opacity: props.store.saving() ? '0.6' : '1',
                      }}
                    >
                      {props.store.saving() ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </form>
              </div>
            </Show>

            {/* ── Providers ── */}
            <Show when={tab() === 'providers'}>
              <div
                id="settings-panel-providers"
                role="tabpanel"
                aria-labelledby="settings-tab-providers"
              >
                <div
                  style={{
                    'font-size': '13px',
                    'font-weight': '700',
                    color: '#e5e7eb',
                    'margin-bottom': '6px',
                  }}
                >
                  Providers
                </div>
                <div style={{ 'font-size': '11px', color: '#6b7280', 'margin-bottom': '12px' }}>
                  API keys are masked. Add a provider to PATCH /config — keys never leave your
                  server.
                </div>

                <Show when={s().providers.length === 0 && !s().loading}>
                  <div
                    style={{
                      padding: '14px',
                      border: '1px dashed rgba(255,255,255,0.12)',
                      'border-radius': '8px',
                      'text-align': 'center',
                      color: '#6b7280',
                      'font-size': '12px',
                      'margin-bottom': '12px',
                    }}
                  >
                    No providers configured. Add one below or set keys in{' '}
                    <code
                      style={{
                        'font-family': 'ui-monospace, monospace',
                        background: 'rgba(255,255,255,0.08)',
                        padding: '1px 4px',
                        'border-radius': '4px',
                      }}
                    >
                      mira.json
                    </code>
                    .
                  </div>
                </Show>

                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '8px',
                    'margin-bottom': '16px',
                  }}
                >
                  <For each={s().providers}>
                    {(p) => (
                      <div
                        style={{
                          padding: '10px 12px',
                          'border-radius': '8px',
                          background: 'rgba(255,255,255,0.03)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          display: 'flex',
                          'justify-content': 'space-between',
                          'align-items': 'center',
                          gap: '10px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            'flex-direction': 'column',
                            gap: '2px',
                            'min-width': '0',
                          }}
                        >
                          <span
                            style={{ 'font-size': '12px', 'font-weight': '600', color: '#e5e7eb' }}
                          >
                            {p.name || p.id}
                          </span>
                          <span
                            style={{
                              'font-size': '11px',
                              color: '#6b7280',
                              'font-family': 'ui-monospace, monospace',
                            }}
                          >
                            {p.baseURL || '—'}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            gap: '6px',
                            'align-items': 'center',
                            'flex-shrink': '0',
                            'flex-wrap': 'wrap',
                          }}
                        >
                          <span
                            style={{
                              'font-size': '11px',
                              color: '#9ca3af',
                              'font-family': 'ui-monospace, monospace',
                              background: 'rgba(0,0,0,0.25)',
                              padding: '2px 6px',
                              'border-radius': '4px',
                            }}
                          >
                            {p.maskedKey ?? '—'}
                          </span>
                          <button
                            type="button"
                            disabled={provTesting() === p.id}
                            onClick={() => void handleTestProvider(p.id)}
                            style={{
                              padding: '5px 10px',
                              'border-radius': '6px',
                              border: '1px solid rgba(255,255,255,0.12)',
                              background: 'rgba(255,255,255,0.06)',
                              color: '#e5e7eb',
                              cursor: provTesting() === p.id ? 'not-allowed' : 'pointer',
                              'font-size': '11px',
                            }}
                          >
                            {provTesting() === p.id ? 'Testing…' : 'Test'}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void props.store
                                .removeProvider(p.id)
                                .then(() => void props.store.loadProviders())
                            }
                            title={`Remove ${p.id}`}
                            style={{
                              padding: '5px 8px',
                              'border-radius': '6px',
                              border: '1px solid rgba(239,68,68,0.25)',
                              background: 'rgba(239,68,68,0.10)',
                              color: '#fca5a5',
                              cursor: 'pointer',
                              'font-size': '11px',
                            }}
                          >
                            Remove
                          </button>
                          <Show when={provResult()[p.id]}>
                            <span
                              style={{
                                'font-size': '11px',
                                color: provResult()[p.id].startsWith('✓') ? '#6ee7b7' : '#fca5a5',
                              }}
                            >
                              {provResult()[p.id]}
                            </span>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>

                <form onSubmit={handleAddProvider} style={cardStyle}>
                  <div style={{ 'font-size': '12px', 'font-weight': '600', color: '#e5e7eb' }}>
                    Add provider
                  </div>
                  <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="prov-name" style={labelStyle}>
                        Provider id
                      </label>
                      <input
                        id="prov-name"
                        value={provName()}
                        onInput={(e) => setProvName(e.currentTarget.value)}
                        placeholder="openrouter"
                        autocomplete="off"
                        spellcheck={false}
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="prov-url" style={labelStyle}>
                        Base URL (optional)
                      </label>
                      <input
                        id="prov-url"
                        value={provUrl()}
                        onInput={(e) => setProvUrl(e.currentTarget.value)}
                        placeholder="https://openrouter.ai/api/v1"
                        autocomplete="off"
                        spellcheck={false}
                        style={inputStyle}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                    <label for="prov-key" style={labelStyle}>
                      API key
                    </label>
                    <input
                      id="prov-key"
                      type="password"
                      value={provKey()}
                      onInput={(e) => setProvKey(e.currentTarget.value)}
                      placeholder="sk-…"
                      autocomplete="off"
                      spellcheck={false}
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
                    <button
                      type="submit"
                      disabled={!provName().trim() || !provKey().trim()}
                      style={{
                        padding: '6px 12px',
                        'border-radius': '6px',
                        border: '1px solid rgba(99,102,241,0.5)',
                        background:
                          !provName().trim() || !provKey().trim()
                            ? 'rgba(255,255,255,0.06)'
                            : 'rgba(99,102,241,0.85)',
                        color:
                          !provName().trim() || !provKey().trim()
                            ? 'rgba(255,255,255,0.35)'
                            : 'white',
                        cursor: !provName().trim() || !provKey().trim() ? 'not-allowed' : 'pointer',
                        'font-size': '12px',
                        'font-weight': '600',
                      }}
                    >
                      Add provider
                    </button>
                  </div>
                </form>
              </div>
            </Show>

            {/* ── Permissions ── */}
            <Show when={tab() === 'permissions'}>
              <div
                id="settings-panel-permissions"
                role="tabpanel"
                aria-labelledby="settings-tab-permissions"
              >
                <div
                  style={{
                    'font-size': '13px',
                    'font-weight': '700',
                    color: '#e5e7eb',
                    'margin-bottom': '6px',
                  }}
                >
                  Permissions
                </div>
                <div style={{ 'font-size': '11px', color: '#6b7280', 'margin-bottom': '12px' }}>
                  7-layer config: explicit deny → allow → pattern → BashArity → default ask. Read
                  from{' '}
                  <code style={{ 'font-family': 'ui-monospace, monospace' }}>GET /permission</code>.
                </div>

                <Show
                  when={s().permission !== null && Object.keys(s().permission ?? {}).length > 0}
                  fallback={
                    <div
                      style={{
                        padding: '14px',
                        border: '1px dashed rgba(255,255,255,0.12)',
                        'border-radius': '8px',
                        'text-align': 'center',
                        color: '#6b7280',
                        'font-size': '12px',
                      }}
                    >
                      No permission rules found. Configure in{' '}
                      <code style={{ 'font-family': 'ui-monospace, monospace' }}>
                        mira.json → permission
                      </code>
                      .
                    </div>
                  }
                >
                  <div style={{ ...cardStyle, padding: '0', overflow: 'hidden' }}>
                    <For
                      each={Object.entries(
                        (s().permission ?? {}) as Record<string, string | Record<string, string>>,
                      )}
                    >
                      {([tool, rule]) => {
                        const isRecord = typeof rule === 'object' && rule !== null
                        return (
                          <>
                            <Show
                              when={!isRecord}
                              fallback={
                                <For each={Object.entries(rule as Record<string, string>)}>
                                  {([pattern, action]) => (
                                    <div
                                      style={{
                                        display: 'flex',
                                        'justify-content': 'space-between',
                                        'align-items': 'center',
                                        padding: '8px 12px',
                                        border: '1px solid rgba(255,255,255,0.06)',
                                        'border-radius': '6px',
                                        background: 'rgba(0,0,0,0.18)',
                                        'margin-bottom': '4px',
                                      }}
                                    >
                                      <div
                                        style={{
                                          display: 'flex',
                                          gap: '8px',
                                          'align-items': 'center',
                                        }}
                                      >
                                        <span
                                          style={{
                                            'font-family': 'ui-monospace, monospace',
                                            'font-size': '11px',
                                            color: '#e5e7eb',
                                          }}
                                        >
                                          {tool}
                                        </span>
                                        <span style={{ color: '#6b7280', 'font-size': '11px' }}>
                                          {pattern}
                                        </span>
                                        <span
                                          style={{
                                            padding: '1px 6px',
                                            'border-radius': '999px',
                                            'font-size': '10px',
                                            'font-weight': '700',
                                            background:
                                              action === 'allow'
                                                ? 'rgba(52,211,153,0.15)'
                                                : action === 'deny'
                                                  ? 'rgba(239,68,68,0.15)'
                                                  : 'rgba(251,191,36,0.15)',
                                            color:
                                              action === 'allow'
                                                ? '#6ee7b7'
                                                : action === 'deny'
                                                  ? '#fca5a5'
                                                  : '#fbbf24',
                                            border: `1px solid ${action === 'allow' ? 'rgba(52,211,153,0.25)' : action === 'deny' ? 'rgba(239,68,68,0.25)' : 'rgba(251,191,36,0.25)'}`,
                                          }}
                                        >
                                          {action}
                                        </span>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => void handleRemovePermission(tool, pattern)}
                                        title={`Remove ${tool}:${pattern}`}
                                        style={{
                                          padding: '2px 6px',
                                          'border-radius': '4px',
                                          border: '1px solid rgba(239,68,68,0.25)',
                                          background: 'transparent',
                                          color: '#fca5a5',
                                          cursor: 'pointer',
                                          'font-size': '11px',
                                        }}
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  )}
                                </For>
                              }
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  'justify-content': 'space-between',
                                  'align-items': 'center',
                                  padding: '8px 12px',
                                  border: '1px solid rgba(255,255,255,0.06)',
                                  'border-radius': '6px',
                                  background: 'rgba(0,0,0,0.18)',
                                  'margin-bottom': '4px',
                                }}
                              >
                                <div
                                  style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}
                                >
                                  <span
                                    style={{
                                      'font-family': 'ui-monospace, monospace',
                                      'font-size': '11px',
                                      color: '#e5e7eb',
                                    }}
                                  >
                                    {tool}
                                  </span>
                                  <span
                                    style={{
                                      padding: '1px 6px',
                                      'border-radius': '999px',
                                      'font-size': '10px',
                                      'font-weight': '700',
                                      background:
                                        rule === 'allow'
                                          ? 'rgba(52,211,153,0.15)'
                                          : rule === 'deny'
                                            ? 'rgba(239,68,68,0.15)'
                                            : 'rgba(251,191,36,0.15)',
                                      color:
                                        rule === 'allow'
                                          ? '#6ee7b7'
                                          : rule === 'deny'
                                            ? '#fca5a5'
                                            : '#fbbf24',
                                      border: `1px solid ${rule === 'allow' ? 'rgba(52,211,153,0.25)' : rule === 'deny' ? 'rgba(239,68,68,0.25)' : 'rgba(251,191,36,0.25)'}`,
                                    }}
                                  >
                                    {String(rule)}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => void handleRemovePermission(tool)}
                                  title={`Remove ${tool}`}
                                  style={{
                                    padding: '2px 6px',
                                    'border-radius': '4px',
                                    border: '1px solid rgba(239,68,68,0.25)',
                                    background: 'transparent',
                                    color: '#fca5a5',
                                    cursor: 'pointer',
                                    'font-size': '11px',
                                  }}
                                >
                                  ✕
                                </button>
                              </div>
                            </Show>
                          </>
                        )
                      }}
                    </For>
                  </div>
                </Show>

                <form onSubmit={handleAddPermission} style={{ ...cardStyle, 'margin-top': '12px' }}>
                  <div style={{ 'font-size': '12px', 'font-weight': '600', color: '#e5e7eb' }}>
                    Add / update rule
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      'grid-template-columns': '1fr 1fr 110px auto',
                      gap: '8px',
                      'align-items': 'end',
                    }}
                  >
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label style={labelStyle} for="perm-tool">
                        Tool
                      </label>
                      <input
                        id="perm-tool"
                        value={permTool()}
                        onInput={(e) => setPermTool(e.currentTarget.value)}
                        placeholder="bash or read"
                        spellcheck={false}
                        autocomplete="off"
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label style={labelStyle} for="perm-pattern">
                        Pattern (optional)
                      </label>
                      <input
                        id="perm-pattern"
                        value={permPattern()}
                        onInput={(e) => setPermPattern(e.currentTarget.value)}
                        placeholder="rm -rf * or *.ts"
                        spellcheck={false}
                        autocomplete="off"
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label style={labelStyle} for="perm-action">
                        Action
                      </label>
                      <select
                        id="perm-action"
                        value={permAction()}
                        onChange={(e) =>
                          setPermAction(e.currentTarget.value as 'allow' | 'deny' | 'ask')
                        }
                        style={inputStyle}
                      >
                        <option value="allow">allow</option>
                        <option value="deny">deny</option>
                        <option value="ask">ask</option>
                      </select>
                    </div>
                    <button
                      type="submit"
                      disabled={!permTool().trim()}
                      style={{
                        padding: '7px 12px',
                        'border-radius': '6px',
                        border: '1px solid rgba(99,102,241,0.5)',
                        background: !permTool().trim()
                          ? 'rgba(255,255,255,0.06)'
                          : 'rgba(99,102,241,0.85)',
                        color: !permTool().trim() ? 'rgba(255,255,255,0.35)' : 'white',
                        cursor: !permTool().trim() ? 'not-allowed' : 'pointer',
                        'font-size': '12px',
                        height: '34px',
                      }}
                    >
                      Add
                    </button>
                  </div>
                </form>

                <div
                  style={{
                    ...cardStyle,
                    background: 'rgba(0,0,0,0.18)',
                    border: '1px dashed rgba(255,255,255,0.12)',
                    'margin-top': '12px',
                  }}
                >
                  <div
                    style={{
                      'font-size': '11px',
                      'font-weight': '700',
                      color: '#9ca3af',
                      'letter-spacing': '0.04em',
                      'text-transform': 'uppercase',
                    }}
                  >
                    Dry-run permission.check — 5 layers
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      'grid-template-columns': '110px 1fr 110px auto',
                      gap: '8px',
                      'align-items': 'end',
                    }}
                  >
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label style={labelStyle} for="perm-test-tool">
                        Tool
                      </label>
                      <select
                        id="perm-test-tool"
                        value={permTestTool()}
                        onChange={(e) => setPermTestTool(e.currentTarget.value)}
                        style={inputStyle}
                      >
                        <option value="bash">bash</option>
                        <option value="read">read</option>
                        <option value="write">write</option>
                        <option value="edit">edit</option>
                        <option value="glob">glob</option>
                        <option value="grep">grep</option>
                        <option value="webfetch">webfetch</option>
                        <option value="task">task</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label style={labelStyle} for="perm-test-args">
                        Args (JSON)
                      </label>
                      <input
                        id="perm-test-args"
                        value={permTestArgs()}
                        onInput={(e) => setPermTestArgs(e.currentTarget.value)}
                        placeholder='{"command":"ls"}'
                        spellcheck={false}
                        autocomplete="off"
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label style={labelStyle} for="perm-test-agent">
                        Agent (lane)
                      </label>
                      <select
                        id="perm-test-agent"
                        value={permTestAgent()}
                        onChange={(e) => setPermTestAgent(e.currentTarget.value)}
                        style={inputStyle}
                      >
                        <option value="">(none)</option>
                        <option value="researcher">researcher</option>
                        <option value="coder">coder</option>
                        <option value="explorer">explorer</option>
                        <option value="reviewer">reviewer</option>
                        <option value="general">general</option>
                      </select>
                    </div>
                    <button
                      type="button"
                      disabled={permTesting()}
                      onClick={() => void handleTestPermission()}
                      style={{
                        padding: '7px 12px',
                        'border-radius': '6px',
                        border: '1px solid rgba(255,255,255,0.12)',
                        background: 'rgba(255,255,255,0.06)',
                        color: '#e5e7eb',
                        cursor: permTesting() ? 'not-allowed' : 'pointer',
                        'font-size': '12px',
                        height: '34px',
                      }}
                    >
                      {permTesting() ? 'Testing…' : 'Test'}
                    </button>
                  </div>
                  <Show when={permTestResult()}>
                    <span
                      style={{
                        'font-size': '11px',
                        color: permTestResult().startsWith('✓')
                          ? '#6ee7b7'
                          : permTestResult().startsWith('✗')
                            ? '#fca5a5'
                            : '#fbbf24',
                        'font-family': 'ui-monospace, monospace',
                        'word-break': 'break-word',
                      }}
                    >
                      {permTestResult()}
                    </span>
                  </Show>
                </div>
              </div>
            </Show>

            {/* ── Connectors ── */}
            <Show when={tab() === 'connectors'}>
              <div
                id="settings-panel-connectors"
                role="tabpanel"
                aria-labelledby="settings-tab-connectors"
              >
                <div
                  style={{
                    'font-size': '13px',
                    'font-weight': '700',
                    color: '#e5e7eb',
                    'margin-bottom': '6px',
                  }}
                >
                  Connectors — MCP
                </div>
                <div style={{ 'font-size': '11px', color: '#6b7280', 'margin-bottom': '12px' }}>
                  Model Context Protocol servers. Toggle, test, or add via PATCH /config / POST
                  /mcp.
                </div>

                <Show when={s().mcp.length === 0 && !s().loading}>
                  <div
                    style={{
                      padding: '14px',
                      border: '1px dashed rgba(255,255,255,0.12)',
                      'border-radius': '8px',
                      'text-align': 'center',
                      color: '#6b7280',
                      'font-size': '12px',
                      'margin-bottom': '12px',
                    }}
                  >
                    No MCP servers connected. Add one below — local (stdio) or remote
                    (StreamableHTTP/SSE).
                  </div>
                </Show>

                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '8px',
                    'margin-bottom': '16px',
                  }}
                >
                  <For each={s().mcp}>
                    {(srv) => (
                      <div
                        style={{
                          padding: '10px 12px',
                          'border-radius': '8px',
                          background: 'rgba(255,255,255,0.03)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          display: 'flex',
                          'justify-content': 'space-between',
                          'align-items': 'center',
                          gap: '10px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            gap: '10px',
                            'align-items': 'center',
                            'min-width': '0',
                            flex: '1',
                          }}
                        >
                          <span
                            style={{
                              width: '8px',
                              height: '8px',
                              'border-radius': '50%',
                              background:
                                srv.status === 'connected'
                                  ? '#34d399'
                                  : srv.status === 'disabled'
                                    ? '#6b7280'
                                    : '#f87171',
                              'box-shadow':
                                srv.status === 'connected'
                                  ? '0 0 8px rgba(52,211,153,0.35)'
                                  : 'none',
                              flex: 'none',
                            }}
                          />
                          <div
                            style={{
                              display: 'flex',
                              'flex-direction': 'column',
                              gap: '2px',
                              'min-width': '0',
                            }}
                          >
                            <span
                              style={{
                                'font-size': '12px',
                                'font-weight': '600',
                                color: '#e5e7eb',
                                'font-family': 'ui-monospace, monospace',
                              }}
                            >
                              {srv.name}
                            </span>
                            <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                              {srv.type} · {srv.toolCount} tools · {srv.status}
                              {srv.error ? ` · ${srv.error}` : ''}
                            </span>
                          </div>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            gap: '6px',
                            'align-items': 'center',
                            'flex-shrink': '0',
                            'flex-wrap': 'wrap',
                            'justify-content': 'flex-end',
                          }}
                        >
                          <label
                            style={{
                              display: 'inline-flex',
                              'align-items': 'center',
                              gap: '6px',
                              'font-size': '11px',
                              color: '#9ca3af',
                              cursor: 'pointer',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={srv.status !== 'disabled'}
                              onChange={(e) =>
                                void handleToggleMcp(srv.name, e.currentTarget.checked)
                              }
                              aria-label={`Enable ${srv.name}`}
                            />
                            enabled
                          </label>
                          <button
                            type="button"
                            disabled={mcpTesting() === srv.name}
                            onClick={() => void handleTestMcp(srv.name)}
                            style={{
                              padding: '5px 10px',
                              'border-radius': '6px',
                              border: '1px solid rgba(255,255,255,0.12)',
                              background: 'rgba(255,255,255,0.06)',
                              color: '#e5e7eb',
                              cursor: mcpTesting() === srv.name ? 'not-allowed' : 'pointer',
                              'font-size': '11px',
                            }}
                          >
                            {mcpTesting() === srv.name ? 'Testing…' : 'Test'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void props.store.removeMcp(srv.name)}
                            title={`Remove ${srv.name}`}
                            style={{
                              padding: '5px 8px',
                              'border-radius': '6px',
                              border: '1px solid rgba(239,68,68,0.25)',
                              background: 'rgba(239,68,68,0.10)',
                              color: '#fca5a5',
                              cursor: 'pointer',
                              'font-size': '11px',
                            }}
                          >
                            Remove
                          </button>
                          <Show when={mcpResult()[srv.name]}>
                            <span
                              style={{
                                'font-size': '11px',
                                color: mcpResult()[srv.name].startsWith('✓')
                                  ? '#6ee7b7'
                                  : '#fca5a5',
                              }}
                            >
                              {mcpResult()[srv.name]}
                            </span>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>

                <form onSubmit={handleAddMcp} style={cardStyle}>
                  <div style={{ 'font-size': '12px', 'font-weight': '600', color: '#e5e7eb' }}>
                    Add MCP server
                  </div>
                  <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="mcp-name" style={labelStyle}>
                        Name
                      </label>
                      <input
                        id="mcp-name"
                        value={mcpName()}
                        onInput={(e) => setMcpName(e.currentTarget.value)}
                        placeholder="my-tools"
                        autocomplete="off"
                        spellcheck={false}
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="mcp-type" style={labelStyle}>
                        Type
                      </label>
                      <select
                        id="mcp-type"
                        value={mcpType()}
                        onChange={(e) => setMcpType(e.currentTarget.value as 'local' | 'remote')}
                        style={inputStyle}
                      >
                        <option value="local">local (stdio)</option>
                        <option value="remote">remote (http/sse)</option>
                      </select>
                    </div>
                  </div>
                  <Show
                    when={mcpType() === 'local'}
                    fallback={
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                        <label for="mcp-url" style={labelStyle}>
                          URL
                        </label>
                        <input
                          id="mcp-url"
                          value={mcpUrl()}
                          onInput={(e) => setMcpUrl(e.currentTarget.value)}
                          placeholder="https://mcp.example.com/mcp"
                          autocomplete="off"
                          spellcheck={false}
                          style={inputStyle}
                        />
                      </div>
                    }
                  >
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="mcp-command" style={labelStyle}>
                        Command
                      </label>
                      <input
                        id="mcp-command"
                        value={mcpCommand()}
                        onInput={(e) => setMcpCommand(e.currentTarget.value)}
                        placeholder="npx -y my-mcp-server"
                        autocomplete="off"
                        spellcheck={false}
                        style={inputStyle}
                      />
                      <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                        Spawned via stdio. Env vars with {'{env:VAR}'} are expanded server-side.
                      </span>
                    </div>
                  </Show>
                  <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '10px' }}>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="mcp-env" style={labelStyle}>
                        Env (mira parity)
                      </label>
                      <input
                        id="mcp-env"
                        value={mcpEnv()}
                        onInput={(e) => setMcpEnv(e.currentTarget.value)}
                        placeholder='{"FOO":"bar"} or FOO=bar,BAZ=qux'
                        autocomplete="off"
                        spellcheck={false}
                        style={inputStyle}
                      />
                      <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                        JSON or KEY=val, comma separated.
                      </span>
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="mcp-headers" style={labelStyle}>
                        Headers (remote)
                      </label>
                      <input
                        id="mcp-headers"
                        value={mcpHeaders()}
                        onInput={(e) => setMcpHeaders(e.currentTarget.value)}
                        placeholder='{"Authorization":"Bearer ..."}'
                        autocomplete="off"
                        spellcheck={false}
                        style={inputStyle}
                      />
                      <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                        For remote StreamableHTTP/SSE.
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
                    <button
                      type="submit"
                      disabled={!mcpName().trim()}
                      style={{
                        padding: '6px 12px',
                        'border-radius': '6px',
                        border: '1px solid rgba(99,102,241,0.5)',
                        background: !mcpName().trim()
                          ? 'rgba(255,255,255,0.06)'
                          : 'rgba(99,102,241,0.85)',
                        color: !mcpName().trim() ? 'rgba(255,255,255,0.35)' : 'white',
                        cursor: !mcpName().trim() ? 'not-allowed' : 'pointer',
                        'font-size': '12px',
                        'font-weight': '600',
                      }}
                    >
                      Add server
                    </button>
                  </div>
                </form>
              </div>
            </Show>

            {/* ── Agents ── */}
            <Show when={tab() === 'agents'}>
              <div id="settings-panel-agents" role="tabpanel" aria-labelledby="settings-tab-agents">
                <div
                  style={{
                    'font-size': '13px',
                    'font-weight': '700',
                    color: '#e5e7eb',
                    'margin-bottom': '6px',
                  }}
                >
                  Agents
                </div>
                <div style={{ 'font-size': '11px', color: '#6b7280', 'margin-bottom': '12px' }}>
                  Lane personas from{' '}
                  <code style={{ 'font-family': 'ui-monospace, monospace' }}>GET /agents</code> —
                  built-in + custom{' '}
                  <code style={{ 'font-family': 'ui-monospace, monospace' }}>
                    mira.json → agents
                  </code>
                  .
                </div>

                <Show when={s().agents.length === 0 && !s().loading}>
                  <div
                    style={{
                      padding: '14px',
                      border: '1px dashed rgba(255,255,255,0.12)',
                      'border-radius': '8px',
                      'text-align': 'center',
                      color: '#6b7280',
                      'font-size': '12px',
                    }}
                  >
                    No agents reported. Is the server running?
                  </div>
                </Show>

                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                  <For each={s().agents}>
                    {(a) => (
                      <div style={{ ...cardStyle, padding: '12px 14px' }}>
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
                              'font-size': '12px',
                              'font-weight': '700',
                              color: '#e5e7eb',
                              'font-family': 'ui-monospace, monospace',
                            }}
                          >
                            {a.name}
                          </span>
                          <span
                            style={{
                              padding: '1px 6px',
                              'border-radius': '999px',
                              'font-size': '10px',
                              'font-weight': '600',
                              background: a.custom
                                ? 'rgba(99,102,241,0.15)'
                                : 'rgba(255,255,255,0.06)',
                              color: a.custom ? '#a5b4fc' : '#9ca3af',
                              border: `1px solid ${a.custom ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.08)'}`,
                            }}
                          >
                            {a.custom ? 'custom' : 'built-in'}
                          </span>
                          <span
                            style={{
                              padding: '1px 6px',
                              'border-radius': '999px',
                              'font-size': '10px',
                              'font-weight': '600',
                              background:
                                a.permissions === 'readonly'
                                  ? 'rgba(52,211,153,0.15)'
                                  : a.permissions === 'elevated'
                                    ? 'rgba(239,68,68,0.15)'
                                    : 'rgba(251,191,36,0.15)',
                              color:
                                a.permissions === 'readonly'
                                  ? '#6ee7b7'
                                  : a.permissions === 'elevated'
                                    ? '#fca5a5'
                                    : '#fbbf24',
                              border: `1px solid ${a.permissions === 'readonly' ? 'rgba(52,211,153,0.25)' : a.permissions === 'elevated' ? 'rgba(239,68,68,0.25)' : 'rgba(251,191,36,0.25)'}`,
                            }}
                          >
                            {a.permissions}
                          </span>
                          <button
                            type="button"
                            disabled={agentPreview() === a.name}
                            onClick={() => void handlePreviewAgent(a.name)}
                            style={{
                              padding: '3px 8px',
                              'border-radius': '6px',
                              border: '1px solid rgba(255,255,255,0.12)',
                              background: 'rgba(255,255,255,0.06)',
                              color: '#e5e7eb',
                              cursor: agentPreview() === a.name ? 'not-allowed' : 'pointer',
                              'font-size': '11px',
                              'margin-left': 'auto',
                            }}
                          >
                            {agentPreview() === a.name ? 'Testing…' : 'Test'}
                          </button>
                        </div>
                        <div
                          style={{
                            'font-size': '12px',
                            color: '#9ca3af',
                            'margin-top': '6px',
                            'line-height': '1.5',
                          }}
                        >
                          {a.description || 'No description'}
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            'flex-wrap': 'wrap',
                            gap: '4px',
                            'margin-top': '8px',
                          }}
                        >
                          <For each={a.tools}>
                            {(tool) => (
                              <span
                                style={{
                                  'font-family': 'ui-monospace, monospace',
                                  'font-size': '10px',
                                  padding: '2px 7px',
                                  'border-radius': '999px',
                                  border: '1px solid rgba(255,255,255,0.08)',
                                  background: 'rgba(0,0,0,0.18)',
                                  color: '#9ca3af',
                                }}
                              >
                                {tool}
                              </span>
                            )}
                          </For>
                        </div>
                        <Show when={agentPreviewResult()[a.name]}>
                          <div
                            style={{
                              'margin-top': '8px',
                              padding: '6px 8px',
                              'border-radius': '6px',
                              background: 'rgba(0,0,0,0.25)',
                              border: '1px solid rgba(255,255,255,0.08)',
                              'font-size': '11px',
                              'font-family': 'ui-monospace, monospace',
                              color: agentPreviewResult()[a.name].startsWith('✓')
                                ? '#6ee7b7'
                                : '#fca5a5',
                              'word-break': 'break-word',
                            }}
                          >
                            {agentPreviewResult()[a.name]}
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* ── Commands ── */}
            <Show when={tab() === 'commands'}>
              <div
                id="settings-panel-commands"
                role="tabpanel"
                aria-labelledby="settings-tab-commands"
              >
                <div
                  style={{
                    'font-size': '13px',
                    'font-weight': '700',
                    color: '#e5e7eb',
                    'margin-bottom': '6px',
                  }}
                >
                  Commands & Skills
                </div>
                <div style={{ 'font-size': '11px', color: '#6b7280', 'margin-bottom': '12px' }}>
                  Slash commands from{' '}
                  <code style={{ 'font-family': 'ui-monospace, monospace' }}>
                    .mira/commands/*.md
                  </code>{' '}
                  via{' '}
                  <code style={{ 'font-family': 'ui-monospace, monospace' }}>GET /commands</code> +
                  skills from{' '}
                  <code style={{ 'font-family': 'ui-monospace, monospace' }}>GET /skills</code>.
                </div>

                <Show when={s().commands.length === 0 && s().skills.length === 0 && !s().loading}>
                  <div
                    style={{
                      padding: '14px',
                      border: '1px dashed rgba(255,255,255,0.12)',
                      'border-radius': '8px',
                      'text-align': 'center',
                      color: '#6b7280',
                      'font-size': '12px',
                    }}
                  >
                    No commands or skills found. Add markdown files to{' '}
                    <code style={{ 'font-family': 'ui-monospace, monospace' }}>
                      .mira/commands/
                    </code>
                    .
                  </div>
                </Show>

                <Show when={s().commands.length > 0}>
                  <div
                    style={{
                      'font-size': '11px',
                      'font-weight': '700',
                      color: '#9ca3af',
                      'letter-spacing': '0.04em',
                      'text-transform': 'uppercase',
                      'margin-bottom': '8px',
                    }}
                  >
                    Slash commands · {s().commands.length}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '6px',
                      'margin-bottom': '16px',
                    }}
                  >
                    <For each={s().commands}>
                      {(c) => (
                        <div
                          style={{
                            ...cardStyle,
                            padding: '10px 12px',
                            display: 'flex',
                            'justify-content': 'space-between',
                            gap: '12px',
                            'align-items': 'center',
                          }}
                        >
                          <div>
                            <div
                              style={{
                                'font-family': 'ui-monospace, monospace',
                                'font-size': '12px',
                                'font-weight': '600',
                                color: '#e5e7eb',
                              }}
                            >
                              {c.name}
                            </div>
                            <div
                              style={{ 'font-size': '11px', color: '#9ca3af', 'margin-top': '2px' }}
                            >
                              {c.description || 'No description'}
                            </div>
                          </div>
                          <span
                            style={{
                              padding: '1px 6px',
                              'border-radius': '999px',
                              'font-size': '10px',
                              background: 'rgba(255,255,255,0.06)',
                              color: '#9ca3af',
                              border: '1px solid rgba(255,255,255,0.08)',
                              'flex-shrink': '0',
                            }}
                          >
                            {c.source}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={s().skills.length > 0}>
                  <div
                    style={{
                      'font-size': '11px',
                      'font-weight': '700',
                      color: '#9ca3af',
                      'letter-spacing': '0.04em',
                      'text-transform': 'uppercase',
                      'margin-bottom': '8px',
                    }}
                  >
                    Skills · {s().skills.length}
                  </div>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                    <For each={s().skills}>
                      {(sk) => (
                        <div style={cardStyle}>
                          <div
                            style={{
                              'font-family': 'ui-monospace, monospace',
                              'font-size': '12px',
                              'font-weight': '600',
                              color: '#e5e7eb',
                            }}
                          >
                            {sk.name}
                          </div>
                          <div
                            style={{
                              'font-size': '11px',
                              color: '#9ca3af',
                              'margin-top': '2px',
                              'line-height': '1.45',
                            }}
                          >
                            {sk.description || 'No description'}
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>

            {/* ── Terminal ── */}
            <Show when={tab() === 'terminal'}>
              <div
                id="settings-panel-terminal"
                role="tabpanel"
                aria-labelledby="settings-tab-terminal"
              >
                <div
                  style={{
                    'font-size': '13px',
                    'font-weight': '700',
                    color: '#e5e7eb',
                    'margin-bottom': '6px',
                  }}
                >
                  Terminal — PTY
                </div>
                <div style={{ 'font-size': '11px', color: '#6b7280', 'margin-bottom': '12px' }}>
                  Interactive shell via{' '}
                  <code style={{ 'font-family': 'ui-monospace, monospace' }}>WS /terminal</code>.
                  Toggle + sandbox allowlist apply live from mira.json.
                </div>
                <form
                  onSubmit={handleSaveTerminal}
                  style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}
                >
                  <div style={cardStyle}>
                    <label
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: '8px',
                        'font-size': '12px',
                        color: '#e5e7eb',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={termEnabled()}
                        onChange={(e) => setTermEnabled(e.currentTarget.checked)}
                      />
                      Enabled
                    </label>
                    <label
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: '8px',
                        'font-size': '12px',
                        color: '#e5e7eb',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={termSandbox()}
                        onChange={(e) => setTermSandbox(e.currentTarget.checked)}
                      />
                      Sandbox (allowlist)
                    </label>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="settings-term-allowed" style={labelStyle}>
                        Allowed commands
                      </label>
                      <input
                        id="settings-term-allowed"
                        value={termAllowed()}
                        onInput={(e) => setTermAllowed(e.currentTarget.value)}
                        placeholder="bash, ls, cat, git, bun, node, tsc, echo, pwd"
                        autocomplete="off"
                        spellcheck={false}
                        style={inputStyle}
                      />
                      <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                        Comma separated. When sandbox on, first token must be in this list.
                      </span>
                    </div>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                      <label for="settings-term-timeout" style={labelStyle}>
                        Timeout ms
                      </label>
                      <input
                        id="settings-term-timeout"
                        type="number"
                        min="1000"
                        value={termTimeout()}
                        onInput={(e) => setTermTimeout(e.currentTarget.value)}
                        placeholder="30000"
                        autocomplete="off"
                        style={inputStyle}
                      />
                      <span style={{ 'font-size': '11px', color: '#6b7280' }}>
                        Kill after this long.
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                      <button
                        type="button"
                        disabled={termTesting()}
                        onClick={() => void handleTestTerminal()}
                        style={{
                          padding: '6px 12px',
                          'border-radius': '6px',
                          border: '1px solid rgba(255,255,255,0.12)',
                          background: 'rgba(255,255,255,0.06)',
                          color: '#e5e7eb',
                          cursor: termTesting() ? 'not-allowed' : 'pointer',
                          'font-size': '12px',
                        }}
                      >
                        {termTesting() ? 'Testing…' : 'Test terminal'}
                      </button>
                      <Show when={termResult()}>
                        <span
                          style={{
                            'font-size': '11px',
                            color: termResult().startsWith('✓') ? '#6ee7b7' : '#fca5a5',
                          }}
                        >
                          {termResult()}
                        </span>
                      </Show>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
                    <button
                      type="submit"
                      disabled={props.store.saving()}
                      style={{
                        padding: '7px 14px',
                        'border-radius': '6px',
                        border: '1px solid rgba(99,102,241,0.5)',
                        background: 'rgba(99,102,241,0.85)',
                        color: 'white',
                        cursor: props.store.saving() ? 'not-allowed' : 'pointer',
                        'font-size': '12px',
                        'font-weight': '700',
                        opacity: props.store.saving() ? '0.6' : '1',
                      }}
                    >
                      {props.store.saving() ? 'Saving…' : 'Save terminal'}
                    </button>
                  </div>
                </form>
              </div>
            </Show>

            {/* ── Autopilot ── */}
            <Show when={tab() === 'autopilot'}>
              <div
                id="settings-panel-autopilot"
                role="tabpanel"
                aria-labelledby="settings-tab-autopilot"
              >
                <div
                  style={{
                    'font-size': '13px',
                    'font-weight': '700',
                    color: '#e5e7eb',
                    'margin-bottom': '6px',
                  }}
                >
                  Autopilot — Scheduler & Patches
                </div>
                <div style={{ 'font-size': '11px', color: '#6b7280', 'margin-bottom': '12px' }}>
                  Learning scheduler status, eval delta, and pending self-improvement patches. Also
                  available via{' '}
                  <code
                    style={{
                      'font-family': 'ui-monospace, monospace',
                      background: 'rgba(255,255,255,0.08)',
                      padding: '1px 4px',
                      'border-radius': '4px',
                    }}
                  >
                    /autopilot
                  </code>
                  .
                </div>
                <AutopilotInline />
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div
            style={{
              padding: '8px 12px',
              'border-top': '1px solid rgba(255,255,255,0.06)',
              'font-size': '11px',
              color: '#6b7280',
              display: 'flex',
              'justify-content': 'space-between',
              'flex-shrink': '0',
            }}
          >
            <span>
              Changes save to{' '}
              <code
                style={{
                  'font-family': 'ui-monospace, monospace',
                  background: 'rgba(255,255,255,0.08)',
                  padding: '1px 4px',
                  'border-radius': '4px',
                }}
              >
                mira.json
              </code>{' '}
              via PATCH /config · 1-7 quick switch · Tab cycles
            </span>
            <span>Esc to close</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
