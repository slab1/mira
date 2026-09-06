/**
 * Mira TUI — SolidJS + @opentui/solid terminal UI
 *
 * Architecture:
 *   TUI (SolidJS)  ⇄  WebSocket RPC (GlobalBus)  ⇄  Mira Server (Hono + SessionPrompt.loop)
 *   - Event-driven, no polling: WS streams BusEvent → store updates → reactive render
 *   - Prompt via SSE: POST /session/:id/prompt streams text_delta/tool_call/tool_result
 *   - Permission HITL: server emits permission.ask → PermissionView → permission.reply via WS
 *
 * Layout:
 *   ┌─ Header (Mira, connection, model, health) ─────────────────────┐
 *   │ SessionView (sidebar + messages)                                 │
 *   │ PermissionView (overlay when pending)                            │
 *   │ Input bar + status                                               │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Run: `bun run dev` (Vite on :3001 → proxy to :4096) or `bun src/index.ts` for native TUI via @opentui/solid renderer.
 */

import { Show, createEffect, createSignal, onMount, onCleanup } from 'solid-js'
// @opentui/solid — SolidJS renderer for terminal (Box/Text primitives, Yoga layout)
// Vite preview renders to DOM (#root); native TUI uses renderTui → stdout.
import { render } from '@opentui/solid'
import { createSessionStore } from './stores/session'
import { createSettingsStore } from './stores/settings'
import SessionView from './components/SessionView'
import PermissionView from './components/PermissionView'
import QuestionView from './components/QuestionView'
import CommandPalette, { SlashAutocomplete, filterCommands } from './components/CommandPalette'
import HelpOverlay from './components/HelpOverlay'
import JobsView from './components/JobsView'
import ExportView from './components/ExportView'
import QueueRail from './components/QueueRail'
import Inspector from './components/Inspector'
import AuthGate from './components/AuthGate'
import DoomLoopBanner from './components/DoomLoopBanner'
import SettingsView from './components/SettingsView'
import MemoryGraph from './components/MemoryGraph'
import TraceView from './components/TraceView'
import ModelPicker from './components/ModelPicker'
import AutopilotView from './components/AutopilotView'
import { SkillSelector } from './components/SkillSelector'
import { ToastViewport } from './components/Toast'
import TerminalView from './components/TerminalView'
import { getToken, validateToken } from './rpc/client'

export default function App() {
  const store = createSessionStore()
  const [health, setHealth] = createSignal<{ ok: boolean; version: string; tools: number } | null>(
    null,
  )
  const [cost, setCost] = createSignal<{
    requests: number
    inputTokens: number
    outputTokens: number
    costUSD: number
  } | null>(null)
  const [commandMode, setCommandMode] = createSignal(false)
  const [helpOpen, setHelpOpen] = createSignal(false)
  const [jobsOpen, setJobsOpen] = createSignal(false)
  const [exportOpen, setExportOpen] = createSignal(false)
  const [queueOpen, setQueueOpen] = createSignal(false)
  const [focusRing, setFocusRing] = createSignal<'sidebar' | 'messages' | 'input'>('input')
  const [authorized, setAuthorized] = createSignal(false)
  const [budgetCapEnabled, setBudgetCapEnabled] = createSignal(false)
  const [budgetCapAmount, setBudgetCapAmount] = createSignal(100)
  const [inspectorCollapsed, setInspectorCollapsed] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [viewMode, setViewMode] = createSignal<'chat' | 'graph'>('chat')
  const [traceOpen, setTraceOpen] = createSignal(false)
  const [miraScore, setMiraScore] = createSignal<{ score: number; costUSD: number } | null>(null)
  const [selectedAgent, setSelectedAgent] = createSignal('')
  const [autopilotOpen, setAutopilotOpen] = createSignal(false)
  const [terminalOpen, setTerminalOpen] = createSignal(false)
  const settingsStore = createSettingsStore()
  let inputRef: HTMLTextAreaElement | undefined

  // ── Slash autocomplete (P1-7) ──────────────────────────────────────
  const slashQuery = () => {
    const v = store.input()
    return v.startsWith('/') ? v : ''
  }
  const slashCommands = () => settingsStore.allCommands()
  const slashFiltered = () => filterCommands(slashQuery(), slashCommands())
  const [slashIndex, setSlashIndex] = createSignal(0)
  const [slashDismissed, setSlashDismissed] = createSignal(false)
  const slashVisible = () =>
    slashQuery().startsWith('/') && slashFiltered().length > 0 && !slashDismissed()
  createEffect(() => {
    void slashQuery()
    setSlashIndex(0)
    setSlashDismissed(false)
  })
  const handleSlashSelect = (name: string) => {
    store.setInput(name + ' ')
    inputRef?.focus()
    // auto-grow if needed
    if (inputRef) {
      inputRef.style.height = 'auto'
      inputRef.style.height = Math.min(inputRef.scrollHeight, 160) + 'px'
    }
  }

  onMount(() => {
    try {
      const e = localStorage.getItem('mira.budgetCap.enabled')
      const a = localStorage.getItem('mira.budgetCap.amount')
      if (e != null) setBudgetCapEnabled(e === 'true')
      if (a != null) setBudgetCapAmount(Number(a) || 100)
    } catch {}
    const probe = async (): Promise<void> => {
      const token = getToken()
      if (!token) {
        setAuthorized(false)
        return
      }
      try {
        const ok = await validateToken()
        if (!ok) {
          setAuthorized(false)
          return
        }
        await store.loadSessions()
        setAuthorized(true)
      } catch (e) {
        const msg = (e as Error).message
        const isUnauthorized = msg === 'unauthorized' || msg.includes('401')
        if (isUnauthorized) setAuthorized(false)
        else {
          console.warn('[mira] probe failed:', msg)
          setAuthorized(false)
        }
      }
    }
    void probe()
    const onAuthInvalid = () => setAuthorized(false)
    window.addEventListener('mira:auth-invalid', onAuthInvalid)
    onCleanup(() => window.removeEventListener('mira:auth-invalid', onAuthInvalid))
    // health
    import('./rpc/client').then(({ rpc }) => {
      rpc
        .health()
        .then(setHealth)
        .catch(() => {})
    })
    // palette open via Ctrl+P dispatch
    const onOpenPalette = () => setCommandMode(true)
    window.addEventListener('mira:open-palette', onOpenPalette as EventListener)
    onCleanup(() => window.removeEventListener('mira:open-palette', onOpenPalette as EventListener))
  })

  // keep local cost in sync with store for header display
  createEffect(() => {
    const c = store.state.cost
    if (c) setCost(c)
  })

  // P1-3: fetch Mira Score for current session (score pill in header)
  createEffect(() => {
    const id = store.state.currentId
    if (!id) {
      setMiraScore(null)
      return
    }
    import('./rpc/client').then(({ rpc }) => {
      rpc
        .getScore(id)
        .then((s) => setMiraScore({ score: s.score, costUSD: s.costUSD ?? s.cost ?? 0 }))
        .catch(() => setMiraScore(null))
    })
  })
  // Refresh score after each turn finishes (streaming → false)
  createEffect(() => {
    const streaming = store.state.streaming
    const id = store.state.currentId
    if (!streaming && id) {
      setTimeout(() => {
        import('./rpc/client').then(({ rpc }) => {
          rpc
            .getScore(id)
            .then((s) => setMiraScore({ score: s.score, costUSD: s.costUSD ?? s.cost ?? 0 }))
            .catch(() => {})
        })
      }, 800)
    }
  })
  // P1-4: keep agent picker in sync with active session's lane
  createEffect(() => {
    const sess = store.state.sessions.find((s) => s.id === store.state.currentId)
    setSelectedAgent(sess?.agent ?? '')
  })

  // Budget cap HITL – trigger warning when cost exceeds cap
  createEffect(() => {
    const c = store.state.cost
    if (!c || !budgetCapEnabled() || !store.state.currentId) return
    if (c.costUSD >= budgetCapAmount()) {
      const key = `mira.budgetCap.warned.${store.state.currentId}`
      try {
        if (localStorage.getItem(key)) return
        localStorage.setItem(key, '1')
      } catch {}
      store.setBudgetWarning(`Budget cap reached: $${c.costUSD.toFixed(4)} ≥ $${budgetCapAmount()}`)
    }
  })

  // Keyboard shortcuts: a = allow, d = deny when permission pending
  const onKeyDown = (e: KeyboardEvent) => {
    if (!store.state.pendingPermission) return
    if (e.key === 'a' || e.key === 'A') store.replyPermission('allow')
    if (e.key === 'd' || e.key === 'D' || e.key === 'Escape') store.replyPermission('deny')
  }

  // Global TUI shortcuts
  const onGlobalKey = (e: KeyboardEvent) => {
    const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase()
    const isTyping =
      targetTag === 'input' ||
      targetTag === 'textarea' ||
      (e.target as HTMLElement)?.isContentEditable
    if (e.key === '?' && !isTyping) {
      e.preventDefault()
      setHelpOpen((v) => !v)
    }
    // Tab focus cycle
    if (e.key === 'Tab' && !isTyping) {
      e.preventDefault()
      setFocusRing((f) => {
        if (f === 'sidebar') return 'messages'
        if (f === 'messages') return 'input'
        return 'sidebar'
      })
    }
    // Session quick pick 1-9
    if (!isTyping && e.key >= '1' && e.key <= '9') {
      const sessions = store.state.sessions
      const idx = Number(e.key) - 1
      const s = sessions?.[idx]
      if (s) store.selectSession(s.id)
    }
    // Esc stops streaming globally
    if (e.key === 'Escape' && store.state.streaming && !store.state.pendingPermission) {
      store.stopStream()
    }
    // i toggles inspector
    if (!isTyping && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault()
      setInspectorCollapsed((v) => !v)
    }
    // G toggles Memory Graph
    if (!isTyping && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'g') {
      e.preventDefault()
      setViewMode((v) => (v === 'chat' ? 'graph' : 'chat'))
    }
  }

  // Attach global key handler when permission is pending
  createEffect(() => {
    if (store.state.pendingPermission) window.addEventListener('keydown', onKeyDown)
    else window.removeEventListener('keydown', onKeyDown)
  })
  onCleanup(() => window.removeEventListener('keydown', onKeyDown))

  // Global shortcuts always on
  onMount(() => {
    window.addEventListener('keydown', onGlobalKey)
    return () => window.removeEventListener('keydown', onGlobalKey)
  })

  const handleSend = () => {
    const raw = store.input().trim()
    // Intercept local slash commands (P1-5 autopilot)
    if (raw === '/autopilot' || raw.startsWith('/autopilot ')) {
      store.setInput('')
      setAutopilotOpen(true)
      return
    }
    void store.sendPrompt()
  }

  const handleInputKeyDown = (e: KeyboardEvent) => {
    // Slash autocomplete navigation (P1-7)
    const q = slashQuery()
    const filtered = slashFiltered()
    const hasSlash = slashVisible()
    if (hasSlash) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => Math.min(i + 1, filtered.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (
        e.key === 'Tab' ||
        (e.key === 'Enter' && !e.shiftKey && q.trim().split(/\s/).length === 1)
      ) {
        const pick = filtered[slashIndex()]
        if (pick && q.trim() !== pick.name) {
          e.preventDefault()
          handleSlashSelect(pick.name)
          return
        }
        if (e.key === 'Tab' && pick) {
          e.preventDefault()
          handleSlashSelect(pick.name)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // If slash autocomplete is visible and Enter would autocomplete, we already handled above.
      // Otherwise send.
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape' && store.state.streaming) {
      store.stopStream()
    }
    // Intercept leading '/' to open command palette (only when input empty)
    if (e.key === '/' && store.input() === '') {
      // Let the character be typed first, then palette will be triggered via slash dropdown.
      // Keep palette shortcut for Ctrl+P; '/' now shows inline autocomplete instead.
      void settingsStore.loadAll()
    }
    // Intercept '?' to toggle help
    if (e.key === '?' && !e.shiftKey && !hasSlash) {
      // avoid conflict with slash nav
      const target = e.target as HTMLTextAreaElement
      if (target.value === '') {
        e.preventDefault()
        setHelpOpen((v) => !v)
      }
    }
  }

  const handleCommand = async (cmd: string) => {
    switch (cmd) {
      case 'cost':
        try {
          const { rpc } = await import('./rpc/client')
          const d = await rpc.devHealth()
          setCost(d.gateway)
        } catch {}
        break
      case 'undo':
        void store.undoLast()
        break
      case 'queue':
        setQueueOpen(true)
        break
      case 'jobs':
        setJobsOpen(true)
        break
      case 'fork':
        if (store.state.currentId) {
          try {
            const { rpc } = await import('./rpc/client')
            const ns = await rpc.createSession({ parentID: store.state.currentId })
            await store.selectSession(ns.id)
          } catch {
            void store.createSession()
          }
        }
        break
      case 'export':
        setExportOpen(true)
        break
      case 'autopilot':
        setAutopilotOpen(true)
        break
      default: {
        // For any other slash command (including skills), insert into input
        store.setInput(`/${cmd} `)
        inputRef?.focus()
        break
      }
    }
  }

  return (
    <Show
      when={authorized()}
      fallback={
        <AuthGate
          onReady={() => {
            setAuthorized(true)
            void store.loadSessions()
          }}
        />
      }
    >
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          height: '100vh',
          'min-height': '420px',
          background: '#0a0a0f',
          color: '#e5e7eb',
          'font-family':
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial',
          'font-size': '13px',
          overflow: 'hidden',
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            padding: '10px 14px',
            border: '1px solid rgba(255,255,255,0.08)',
            'border-radius': '10px',
            margin: '8px 8px 0 8px',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.14), rgba(168,85,247,0.10))',
          }}
        >
          <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
            <span
              style={{
                width: '28px',
                height: '28px',
                display: 'inline-flex',
                'align-items': 'center',
                'justify-content': 'center',
                'border-radius': '8px',
                background: 'rgba(99,102,241,0.9)',
                color: 'white',
                'font-weight': '800',
                'font-size': '14px',
                'letter-spacing': '-0.02em',
              }}
            >
              M
            </span>
            <div style={{ display: 'flex', 'flex-direction': 'column' }}>
              <span
                style={{ 'font-weight': '800', 'letter-spacing': '-0.02em', 'font-size': '14px' }}
              >
                Mira
              </span>
              <span style={{ 'font-size': '11px', opacity: '0.6' }}>
                better than all — agent platform
              </span>
            </div>
            <span
              style={{
                margin: '0 8px',
                padding: '3px 8px',
                'border-radius': '999px',
                background: store.state.connected
                  ? 'rgba(16,185,129,0.15)'
                  : 'rgba(239,68,68,0.12)',
                border: store.state.connected
                  ? '1px solid rgba(16,185,129,0.25)'
                  : '1px solid rgba(239,68,68,0.25)',
                color: store.state.connected ? '#6ee7b7' : '#fca5a5',
                'font-size': '11px',
                'font-weight': '600',
              }}
              title={
                store.state.connected
                  ? 'WebSocket connected (GlobalBus)'
                  : 'WebSocket disconnected — reconnecting…'
              }
            >
              {store.state.connected ? '● live' : '○ offline'}
            </span>
          </div>

          <div
            style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'font-size': '11px' }}
          >
            <Show when={store.state.queued.length > 0}>
              <span style={{ color: '#c4b5fd', 'font-weight': '600' }}>
                ⏳ {store.state.queued.length} queued
              </span>
            </Show>
            <Show when={store.state.currentId}>
              <span
                onClick={() => void store.undoLast()}
                title="Undo last file mutation"
                style={{ cursor: 'pointer', color: '#fdba74', 'font-weight': '600' }}
              >
                ↩ undo
              </span>
            </Show>
            <Show when={miraScore()}>
              {(s) => (
                <button
                  type="button"
                  onClick={() => setTraceOpen(true)}
                  title={`Mira Score ${s().score}/100 — click to open trace viewer (cost $${s().costUSD.toFixed(4)})`}
                  style={{
                    padding: '3px 8px',
                    'border-radius': '999px',
                    border: '1px solid rgba(255,255,255,0.12)',
                    background:
                      s().score >= 80
                        ? 'rgba(52,211,153,0.15)'
                        : s().score >= 60
                          ? 'rgba(251,191,36,0.15)'
                          : 'rgba(248,113,113,0.15)',
                    color: s().score >= 80 ? '#6ee7b7' : s().score >= 60 ? '#fbbf24' : '#fca5a5',
                    'font-size': '11px',
                    'font-weight': '700',
                    cursor: 'pointer',
                    'font-family': 'ui-monospace, monospace',
                  }}
                >
                  ◈ {s().score}/100
                </button>
              )}
            </Show>
            <Show when={cost()}>
              {(c) => (
                <span
                  title={`Gateway: ${c().requests} requests · ${c().inputTokens} in / ${c().outputTokens} out`}
                  style={{
                    padding: '3px 8px',
                    'border-radius': '999px',
                    background: 'rgba(59,130,246,0.15)',
                    border: '1px solid rgba(59,130,246,0.25)',
                    color: '#93c5fd',
                    'font-family': 'ui-monospace, monospace',
                    'font-weight': '600',
                  }}
                >
                  ${c().costUSD.toFixed(4)}
                </span>
              )}
            </Show>
            <Show when={health()}>
              {(h) => (
                <span style={{ opacity: '0.7' }}>
                  v{h().version} · {h().tools} tools
                </span>
              )}
            </Show>
            <Show when={store.state.currentId}>
              <span
                style={{
                  opacity: '0.55',
                  'max-width': '220px',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                }}
              >
                {store.state.sessions.find((s) => s.id === store.state.currentId)?.model ?? ''}
              </span>
            </Show>
            <ModelPicker
              value={selectedAgent()}
              onChange={setSelectedAgent}
              onCreateSession={(agent) =>
                void store.createSessionWithAgent({
                  agent: agent || undefined,
                  title: agent ? `${agent} session` : undefined,
                })
              }
            />
            <SkillSelector
              selectedAgent={selectedAgent()}
              onSelectSkill={(skill) =>
                void store.createSessionWithAgent({
                  title: `${skill} session`,
                  agent: selectedAgent() || undefined,
                })
              }
              onSelectAgent={setSelectedAgent}
              onCreateSession={(opts) =>
                void store.createSessionWithAgent({
                  agent: opts.agent || selectedAgent() || undefined,
                  title: opts.skill
                    ? `${opts.skill} session`
                    : opts.agent
                      ? `${opts.agent} session`
                      : undefined,
                })
              }
            />
            <button
              type="button"
              onClick={() => setViewMode((v) => (v === 'chat' ? 'graph' : 'chat'))}
              title="Memory Graph (G) — toggle graph / chat"
              aria-label="Toggle Memory Graph"
              aria-pressed={viewMode() === 'graph' ? 'true' : 'false'}
              style={{
                padding: '4px 8px',
                'border-radius': '6px',
                border: '1px solid rgba(255,255,255,0.10)',
                background:
                  viewMode() === 'graph' ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.06)',
                color: viewMode() === 'graph' ? '#a5b4fc' : '#9ca3af',
                cursor: 'pointer',
                'font-size': '11px',
                'font-weight': '600',
              }}
            >
              ◈ Memory
            </button>
            <button
              type="button"
              onClick={() => setInspectorCollapsed((v) => !v)}
              title={inspectorCollapsed() ? 'Expand inspector (i)' : 'Collapse inspector (i)'}
              aria-expanded={inspectorCollapsed() ? 'false' : 'true'}
              aria-controls="inspector-panel"
              style={{
                padding: '4px 8px',
                'border-radius': '6px',
                border: '1px solid rgba(255,255,255,0.10)',
                background: inspectorCollapsed()
                  ? 'rgba(255,255,255,0.06)'
                  : 'rgba(99,102,241,0.15)',
                color: inspectorCollapsed() ? '#9ca3af' : '#a5b4fc',
                cursor: 'pointer',
                'font-size': '11px',
                'font-weight': '600',
              }}
            >
              {inspectorCollapsed() ? '◧ Inspector' : '◨ Inspector'}
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="Open settings (⚙)"
              aria-label="Open settings"
              aria-haspopup="dialog"
              style={{
                padding: '4px 8px',
                'border-radius': '6px',
                border: '1px solid rgba(255,255,255,0.10)',
                background: settingsOpen() ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.06)',
                color: settingsOpen() ? '#a5b4fc' : '#9ca3af',
                cursor: 'pointer',
                'font-size': '11px',
                'font-weight': '600',
              }}
            >
              ⚙ Settings
            </button>
            <button
              type="button"
              onClick={() => setTerminalOpen(true)}
              title="Open terminal (PTY)"
              aria-label="Open terminal"
              aria-haspopup="dialog"
              style={{
                padding: '4px 8px',
                'border-radius': '6px',
                border: '1px solid rgba(255,255,255,0.10)',
                background: terminalOpen() ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.06)',
                color: terminalOpen() ? '#a5b4fc' : '#9ca3af',
                cursor: 'pointer',
                'font-size': '11px',
                'font-weight': '600',
              }}
            >
              ▣ Terminal
            </button>
            <Show when={store.state.loading}>
              <span style={{ opacity: '0.5' }}>loading…</span>
            </Show>
          </div>
        </div>

        {/* ── Budget warning banner ── */}
        <Show when={store.state.budgetWarning}>
          <div
            style={{
              margin: '8px 8px 0 8px',
              padding: '8px 12px',
              'border-radius': '8px',
              background: 'rgba(251,191,36,0.12)',
              border: '1px solid rgba(251,191,36,0.30)',
              color: '#fde68a',
              'font-size': '12px',
              display: 'flex',
              'justify-content': 'space-between',
              'align-items': 'center',
            }}
          >
            <span>⚠ {store.state.budgetWarning}</span>
            <button
              onClick={() => store.clearBudgetWarning()}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#fde68a',
                cursor: 'pointer',
                'font-size': '12px',
              }}
            >
              ✕
            </button>
          </div>
        </Show>

        <DoomLoopBanner
          doomLoop={store.state.doomLoop}
          onRewind={() => void store.rewindDoomLoop()}
          onDismiss={() => store.clearDoomLoop()}
        />

        {/* ── Error banner ── */}
        <Show when={store.state.error}>
          <div
            style={{
              margin: '8px 8px 0 8px',
              padding: '8px 12px',
              'border-radius': '8px',
              background: 'rgba(239,68,68,0.10)',
              border: '1px solid rgba(239,68,68,0.22)',
              color: '#fecaca',
              'font-size': '12px',
              display: 'flex',
              'justify-content': 'space-between',
              'align-items': 'center',
            }}
          >
            <span>{store.state.error}</span>
            <button
              onClick={() => store.clearError()}
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
        </Show>

        {/* ── Main: SessionView + Inspector / MemoryGraph ── */}
        <Show
          when={viewMode() === 'chat'}
          fallback={
            <div style={{ flex: '1', overflow: 'hidden', display: 'flex', padding: '8px' }}>
              <MemoryGraph
                onOpenInChat={(node) => {
                  setViewMode('chat')
                  store.setInput(`Tell me about: ${node.label}`)
                }}
                onRequestClose={() => setViewMode('chat')}
              />
            </div>
          }
        >
          <div
            style={{
              flex: '1',
              overflow: 'hidden',
              display: 'flex',
              'flex-direction': 'row',
              gap: '8px',
              padding: '8px',
            }}
          >
            <div
              style={{
                flex: '1',
                overflow: 'hidden',
                display: 'flex',
                'flex-direction': 'column',
                gap: '8px',
                'min-width': '0',
              }}
            >
              <SessionView
                sessions={store.state.sessions}
                currentId={store.state.currentId}
                messages={store.state.messages}
                todos={store.state.todos}
                streaming={store.state.streaming}
                streamText={store.state.streamText}
                streamStartAt={store.state.streamStartAt}
                queued={store.state.queued}
                onSelect={(id) => void store.selectSession(id)}
                onCreate={() =>
                  void store.createSessionWithAgent({
                    agent: selectedAgent() || undefined,
                    title: selectedAgent() ? `${selectedAgent()} session` : undefined,
                  })
                }
                onDelete={(id) => void store.deleteSession(id)}
                onRewind={(messageID) => void store.undoLast(messageID)}
              />

              {/* ── Permission overlay ── */}
              <Show when={store.state.pendingPermission}>
                <div style={{ 'margin-top': '4px' }}>
                  <PermissionView
                    request={store.state.pendingPermission}
                    onAllow={() => store.replyPermission('allow')}
                    onDeny={() => store.replyPermission('deny')}
                  />
                </div>
              </Show>

              {/* ── Question (HITL) overlay ── */}
              <Show when={store.state.pendingQuestion}>
                <div style={{ 'margin-top': '4px' }}>
                  <QuestionView
                    request={store.state.pendingQuestion}
                    onSubmit={(answers) => store.answerQuestion(answers)}
                  />
                </div>
              </Show>
            </div>

            {/* ── Inspector (6-tab ToolView) ── */}
            <Inspector
              store={store}
              collapsed={inspectorCollapsed()}
              onCollapsedChange={setInspectorCollapsed}
            />
          </div>
        </Show>

        {/* ── Input bar ── */}
        <div
          style={{
            display: 'flex',
            gap: '8px',
            padding: '10px',
            border: '1px solid rgba(255,255,255,0.08)',
            'border-radius': '10px',
            margin: '0 8px 8px 8px',
            background: 'rgba(255,255,255,0.03)',
            'align-items': 'flex-end',
            position: 'relative',
          }}
        >
          <Show when={slashVisible()}>
            <SlashAutocomplete
              query={slashQuery()}
              commands={slashCommands()}
              selected={slashIndex()}
              onSelect={handleSlashSelect}
              onClose={() => setSlashDismissed(true)}
            />
          </Show>
          <textarea
            ref={inputRef}
            value={store.input()}
            onInput={(e) => {
              store.setInput(e.currentTarget.value)
              if (e.currentTarget.value.startsWith('/')) void settingsStore.loadAll()
              // auto-grow
              e.currentTarget.style.height = 'auto'
              e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 160) + 'px'
            }}
            onKeyDown={handleInputKeyDown}
            placeholder={
              !store.state.currentId
                ? 'Create or select a session to start…'
                : store.state.streaming
                  ? 'Streaming… press Esc to stop'
                  : 'Ask Mira anything — Enter to send, Shift+Enter for newline ( / for commands )'
            }
            disabled={!store.state.currentId || Boolean(store.state.pendingPermission)}
            rows={2}
            style={{
              flex: '1',
              padding: '9px 11px',
              'border-radius': '8px',
              border: '1px solid rgba(255,255,255,0.10)',
              background: 'rgba(0,0,0,0.28)',
              color: '#e5e7eb',
              resize: 'none',
              outline: 'none',
              'font-family': 'inherit',
              'font-size': '13px',
            }}
          />
          <div style={{ display: 'flex', gap: '6px' }}>
            <Show
              when={!store.state.streaming}
              fallback={
                <button
                  onClick={() => store.stopStream()}
                  style={{
                    padding: '9px 14px',
                    'border-radius': '8px',
                    border: '1px solid rgba(239,68,68,0.35)',
                    background: 'rgba(239,68,68,0.14)',
                    color: '#fecaca',
                    cursor: 'pointer',
                    'font-weight': '700',
                    'font-size': '12px',
                  }}
                >
                  Stop
                </button>
              }
            >
              <button
                onClick={handleSend}
                disabled={!store.state.currentId || !store.input().trim()}
                style={{
                  padding: '9px 16px',
                  'border-radius': '8px',
                  border: '1px solid rgba(99,102,241,0.5)',
                  background:
                    !store.state.currentId || !store.input().trim()
                      ? 'rgba(255,255,255,0.06)'
                      : 'rgba(99,102,241,0.9)',
                  color:
                    !store.state.currentId || !store.input().trim()
                      ? 'rgba(255,255,255,0.35)'
                      : 'white',
                  cursor:
                    !store.state.currentId || !store.input().trim() ? 'not-allowed' : 'pointer',
                  'font-weight': '700',
                  'font-size': '12px',
                }}
              >
                Send ↵
              </button>
            </Show>
          </div>
        </div>

        {/* ── Footer ── */}
        <div
          style={{
            display: 'flex',
            'justify-content': 'space-between',
            padding: '0 10px 8px 10px',
            'font-size': '10px',
            opacity: '0.42',
          }}
        >
          <span>
            Mira TUI · SolidJS + @opentui/solid · WS RPC to :4096 · {store.state.sessions.length}{' '}
            sessions
          </span>
          <span>Enter send · Esc stop · a/d on permission · “better than all”</span>
        </div>

        <CommandPalette
          open={commandMode()}
          onClose={() => setCommandMode(false)}
          onExecute={handleCommand}
          settings={settingsStore}
        />
        <HelpOverlay open={helpOpen()} onClose={() => setHelpOpen(false)} />
        <JobsView
          open={jobsOpen()}
          onClose={() => setJobsOpen(false)}
          sessionId={store.state.currentId}
          onSelectSession={(id) => void store.selectSession(id)}
        />
        <ExportView
          open={exportOpen()}
          onClose={() => setExportOpen(false)}
          sessionId={store.state.currentId}
        />
        <QueueRail
          open={queueOpen()}
          onClose={() => setQueueOpen(false)}
          sessionId={store.state.currentId}
        />
        <SettingsView
          open={settingsOpen()}
          onClose={() => setSettingsOpen(false)}
          store={settingsStore}
        />
        <TraceView
          sessionID={store.state.currentId}
          open={traceOpen()}
          onClose={() => setTraceOpen(false)}
        />
        <AutopilotView open={autopilotOpen()} onClose={() => setAutopilotOpen(false)} />
        <TerminalView open={terminalOpen()} onClose={() => setTerminalOpen(false)} />
        <ToastViewport />
      </div>
    </Show>
  )
}
