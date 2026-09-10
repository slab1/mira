/**
 * Mira TUI — SolidJS + @opentui/solid terminal UI (keyboard-first rebuild)
 *
 * Architecture:
 *   TUI (SolidJS)  ⇄  WebSocket RPC (GlobalBus)  ⇄  Mira Server (Hono + SessionPrompt.loop)
 *   - Event-driven, no polling: WS streams BusEvent → store updates → reactive render
 *   - Prompt via SSE: POST /session/:id/prompt streams text_delta/tool_call/tool_result
 *   - Permission HITL: server emits permission.ask → PermissionView → permission.reply via WS
 *
 * Focus topology (2026 TUI Standard):
 *   sidebar (TabGroup) → messages (TabGroup) → input (TabStop) → inspector (TabGroup)
 *   Tab / Shift+Tab cycles groups; j/k or arrows navigate within group; Enter selects.
 *
 * Global keybindings:
 *   Tab / Shift+Tab  cycle focus groups
 *   j / k / ↑ / ↓    list navigation (when sidebar/messages focused)
 *   Enter            select / send
 *   n                new session
 *   d                delete session (with confirm)
 *   /                search (focus search input)
 *   ?                help overlay
 *   :                command palette
 *   q                quit (when no modal)
 *   Esc              cancel / close modal / stop streaming
 */

import { Show, For, createEffect, createSignal, createMemo, onMount, onCleanup } from 'solid-js'
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
import { Header, Shell, Banner } from './components/Layout'
import { createFocusManager } from './lib/focus'
import { getColorMode } from './lib/a11y'
import { getToken, validateToken } from './rpc/client'

export default function App() {
  const store = createSessionStore()
  const settingsStore = createSettingsStore()
  const focusMgr = createFocusManager('input')
  const colorMode = getColorMode()

  // ── UI state ──────────────────────────────────────────────────
  const [health, setHealth] = createSignal<{ ok: boolean; version: string; tools: number } | null>(null)
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
  let inputRef: HTMLTextAreaElement | undefined

  // ── Slash autocomplete ────────────────────────────────────────
  const slashQuery = () => {
    const v = store.input()
    return v.startsWith('/') ? v : ''
  }
  const slashCommands = () => settingsStore.allCommands()
  const slashFiltered = () => filterCommands(slashQuery(), slashCommands())
  const [slashIndex, setSlashIndex] = createSignal(0)
  const [slashDismissed, setSlashDismissed] = createSignal(false)
  const slashVisible = () =>
    slashQuery().startsWith('/') &&
    !slashDismissed() &&
    (slashFiltered().length > 0 || settingsStore.state.loading)
  createEffect(() => {
    void slashQuery()
    void slashCommands().length
    setSlashIndex(0)
    setSlashDismissed(false)
  })
  // Preload slash commands/skills as soon as we're authorized — ensures first "/" shows palette
  createEffect(() => {
    if (authorized()) void settingsStore.loadAll()
  })
  const handleSlashSelect = (name: string) => {
    store.setInput(name + ' ')
    inputRef?.focus()
    if (inputRef) {
      inputRef.style.height = 'auto'
      inputRef.style.height = Math.min(inputRef.scrollHeight, 160) + 'px'
    }
  }

  // ── Workspace @ mention ───────────────────────────────────────
  const MOCK_FILES = [
    'src/App.tsx',
    'src/components/ChatView.tsx',
    'src/components/SessionList.tsx',
    'src/components/ActivityPanel.tsx',
    'src/components/ToolView.tsx',
    'src/stores/app.ts',
    'src/stores/settings.ts',
    'src/api/client.ts',
    'src/index.css',
    'package.json',
    'README.md',
    'vite.config.ts',
    'tsconfig.json',
  ]
  function filterFiles(query: string, files: string[]): string[] {
    const q = query.toLowerCase().trim()
    if (!q) return files.slice(0, 8)
    return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8)
  }
  const [workspaceFiles, setWorkspaceFiles] = createSignal<string[]>(MOCK_FILES)
  const [atQuery, setAtQuery] = createSignal('')
  const [atIndex, setAtIndex] = createSignal(0)
  const [atVisible, setAtVisible] = createSignal(false)
  const [atDismissed, setAtDismissed] = createSignal(false)
  let workspaceFetched = false
  let workspaceFetching: Promise<void> | null = null
  const fetchWorkspaceFiles = () => {
    if (workspaceFetched || workspaceFetching) return workspaceFetching ?? Promise.resolve()
    workspaceFetching = import('./rpc/client')
      .then(({ rpc }) => rpc.getWorkspaceTree())
      .then((files) => {
        if (files.length > 0) setWorkspaceFiles(files)
        workspaceFetched = true
      })
      .catch(() => {
        workspaceFetched = true
      })
      .finally(() => {
        workspaceFetching = null
      })
    return workspaceFetching
  }
  onMount(() => {
    void fetchWorkspaceFiles()
  })
  createEffect(() => {
    if (atVisible()) void fetchWorkspaceFiles()
  })
  createEffect(() => {
    const v = store.input()
    if (!v.includes('@')) setAtDismissed(false)
  })
  const atFiltered = createMemo(() => filterFiles(atQuery(), workspaceFiles()))
  const detectAtMention = (text: string, cursorPos: number): string | null => {
    const before = text.slice(0, cursorPos)
    const atIdx = before.lastIndexOf('@')
    if (atIdx === -1) return null
    if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) return null
    const after = before.slice(atIdx + 1)
    if (after.includes(' ') || after.includes('\n')) return null
    return after
  }
  const handleAtSelect = (path: string) => {
    const val = store.input()
    const cursor = inputRef?.selectionStart ?? val.length
    const before = val.slice(0, cursor)
    const atIdx = before.lastIndexOf('@')
    if (atIdx !== -1) {
      const after = val.slice(cursor)
      const next = before.slice(0, atIdx) + `@${path} ` + after
      store.setInput(next)
    }
    setAtVisible(false)
    setAtDismissed(false)
    inputRef?.focus()
    queueMicrotask(() => {
      if (inputRef) {
        inputRef.style.height = 'auto'
        inputRef.style.height = Math.min(inputRef.scrollHeight, 160) + 'px'
      }
    })
  }
  function AtMentionAutocomplete(props: {
    query: string
    files: string[]
    selected: number
    onSelect: (path: string) => void
    onClose: () => void
  }) {
    const filtered = createMemo(() => filterFiles(props.query, props.files))
    return (
      <Show when={filtered().length > 0}>
        <div
          role="listbox"
          aria-label="File suggestions"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '0',
            right: '0',
            'margin-bottom': '8px',
            background: '#0f1117',
            border: '1px solid rgba(255,255,255,0.12)',
            'border-radius': '10px',
            'box-shadow': '0 12px 32px rgba(0,0,0,0.45)',
            overflow: 'hidden',
            'z-index': '20',
            'max-height': '200px',
            display: 'flex',
            'flex-direction': 'column',
          }}
        >
          <div
            style={{
              padding: '6px 10px',
              'font-size': '10px',
              color: 'rgba(229,231,235,0.5)',
              'font-weight': '600',
              'letter-spacing': '0.04em',
              'text-transform': 'uppercase',
              'border-bottom': '1px solid rgba(255,255,255,0.06)',
            }}
          >
            Files · @{props.query || '…'}
          </div>
          <div style={{ overflow: 'auto', padding: '4px', display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
            <For each={filtered()}>
              {(file, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={props.selected === i() ? 'true' : 'false'}
                  onClick={() => props.onSelect(file)}
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '8px',
                    padding: '6px 9px',
                    'border-radius': '8px',
                    border: props.selected === i() ? '1px solid rgba(99,102,241,0.35)' : '1px solid transparent',
                    background: props.selected === i() ? 'rgba(99,102,241,0.18)' : 'transparent',
                    color: '#e5e7eb',
                    'font-size': '12px',
                    'font-family': 'ui-monospace, monospace',
                    cursor: 'pointer',
                    width: '100%',
                    'text-align': 'left',
                  }}
                >
                  <span style={{ 'font-size': '11px', opacity: '0.5' }}>📄</span>
                  <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{file}</span>
                </button>
              )}
            </For>
          </div>
          <div style={{ padding: '6px 10px', 'border-top': '1px solid rgba(255,255,255,0.06)', 'font-size': '10px', color: 'rgba(229,231,235,0.45)', display: 'flex', gap: '6px' }}>
            <span>↑↓ nav</span>
            <span>·</span>
            <span>Tab select</span>
            <span>·</span>
            <span>Esc close</span>
          </div>
        </div>
      </Show>
    )
  }

  // ── Mount: auth probe + health + palette listener ─────────────
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

    import('./rpc/client').then(({ rpc }) => {
      rpc.health().then(setHealth).catch(() => {})
    })
    const onOpenPalette = () => setCommandMode(true)
    window.addEventListener('mira:open-palette', onOpenPalette as EventListener)
    onCleanup(() => window.removeEventListener('mira:open-palette', onOpenPalette as EventListener))
  })

  // ── Cost + score sync ─────────────────────────────────────────
  createEffect(() => {
    const c = store.state.cost
    if (c) setCost(c)
  })
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
  createEffect(() => {
    const sess = store.state.sessions.find((s) => s.id === store.state.currentId)
    setSelectedAgent(sess?.agent ?? '')
  })
  createEffect(() => {
    const sess = store.state.sessions.find((s) => s.id === store.state.currentId)
    const cap = store.state.costCap?.perSession ?? (budgetCapEnabled() ? budgetCapAmount() : undefined)
    const cost = sess?.costUsd ?? store.state.cost?.costUSD
    if (cost == null || cap == null || !store.state.currentId) return
    if (cost >= cap) {
      const key = `mira.budgetCap.warned.${store.state.currentId}`
      try {
        if (localStorage.getItem(key)) return
        localStorage.setItem(key, '1')
      } catch {}
      store.setBudgetWarning(`Budget cap reached: $${cost.toFixed(4)} ≥ $${cap} (per-session)`)
    }
  })

  // ── Helpers ───────────────────────────────────────────────────
  const isModalOpen = () =>
    commandMode() ||
    helpOpen() ||
    jobsOpen() ||
    exportOpen() ||
    queueOpen() ||
    settingsOpen() ||
    traceOpen() ||
    autopilotOpen() ||
    terminalOpen() ||
    Boolean(store.state.pendingPermission) ||
    Boolean(store.state.pendingQuestion)

  const closeAllModals = () => {
    setCommandMode(false)
    setHelpOpen(false)
    setJobsOpen(false)
    setExportOpen(false)
    setQueueOpen(false)
    setSettingsOpen(false)
    setTraceOpen(false)
    setAutopilotOpen(false)
    setTerminalOpen(false)
  }

  // ── Global keyboard handler (keyboard-first, focus-aware) ─────
  const onGlobalKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    const tag = target?.tagName?.toLowerCase()
    const isTyping =
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      (target?.isContentEditable ?? false)

    // ── Modal / permission / question take priority ─────────────
    if (store.state.pendingPermission) {
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        store.replyPermission('allow')
        return
      }
      if (e.key === 'd' || e.key === 'D' || e.key === 'Escape') {
        e.preventDefault()
        store.replyPermission('deny')
        return
      }
      // Don't handle other keys when permission pending
      return
    }

    // When any modal is open, Esc closes it; other keys handled by modal
    if (isModalOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault()
        // Close topmost modal first
        if (commandMode()) setCommandMode(false)
        else if (helpOpen()) setHelpOpen(false)
        else if (settingsOpen()) setSettingsOpen(false)
        else if (traceOpen()) setTraceOpen(false)
        else if (autopilotOpen()) setAutopilotOpen(false)
        else if (terminalOpen()) setTerminalOpen(false)
        else if (jobsOpen()) setJobsOpen(false)
        else if (exportOpen()) setExportOpen(false)
        else if (queueOpen()) setQueueOpen(false)
        else closeAllModals()
        return
      }
      // Let modals handle their own keys
      return
    }

    // ── Streaming: Esc stops ────────────────────────────────────
    if (e.key === 'Escape' && store.state.streaming) {
      e.preventDefault()
      store.stopStream()
      return
    }

    // ── When typing in input, only handle specific global keys ─
    if (isTyping) {
      // Ctrl+P / Cmd+P → palette even when typing
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setCommandMode(true)
        return
      }
      // Esc when typing but not streaming → blur or clear
      if (e.key === 'Escape' && !store.state.streaming) {
        // Let input handle it (slash dismiss etc.)
        return
      }
      return
    }

    // ── Global shortcuts (not typing, no modal) ─────────────────
    switch (e.key) {
      case '?': {
        e.preventDefault()
        setHelpOpen((v) => !v)
        break
      }
      case ':': {
        e.preventDefault()
        setCommandMode(true)
        break
      }
      case 'Tab': {
        e.preventDefault()
        if (e.shiftKey) focusMgr.cycle(-1)
        else focusMgr.cycle(1)
        // Focus the newly active group's container
        queueMicrotask(() => {
          const active = focusMgr.active()
          if (active === 'input') inputRef?.focus()
          else if (active === 'sidebar') {
            const el = document.querySelector<HTMLElement>('[data-tab-group="sidebar"] [role="listbox"]')
            el?.focus()
          } else if (active === 'messages') {
            const el = document.querySelector<HTMLElement>('[data-tab-group="main"]')
            // Focus messages container for scroll nav
            ;(el as HTMLElement)?.focus?.()
          } else if (active === 'inspector') {
            const el = document.getElementById('inspector-panel')
            el?.focus()
          }
        })
        break
      }
      case 'n':
      case 'N': {
        e.preventDefault()
        void store.createSessionWithAgent({
          agent: selectedAgent() || undefined,
          title: selectedAgent() ? `${selectedAgent()} session` : undefined,
        })
        break
      }
      case 'd':
      case 'D': {
        // Delete current session (with confirm via SessionView)
        if (store.state.currentId) {
          e.preventDefault()
          // Dispatch event for SessionView to show confirm
          window.dispatchEvent(new CustomEvent('mira:delete-session', { detail: { id: store.state.currentId } }))
        }
        break
      }
      case '/': {
        e.preventDefault()
        // Focus search in sidebar or messages depending on active group
        const active = focusMgr.active()
        if (active === 'sidebar') {
          const el = document.querySelector<HTMLInputElement>('[data-tab-group="sidebar"] input[type="text"]')
          el?.focus()
          el?.select()
        } else if (active === 'messages') {
          window.dispatchEvent(new CustomEvent('mira:search-messages'))
        } else {
          // Default: focus sidebar search
          const el = document.querySelector<HTMLInputElement>('[data-tab-group="sidebar"] input[type="text"]')
          if (el) {
            focusMgr.setActive('sidebar')
            el.focus()
            el.select()
          } else {
            inputRef?.focus()
          }
        }
        break
      }
      case 'q':
      case 'Q': {
        // Quit: only when no modal and not typing — dispatch quit event
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('mira:quit'))
        break
      }
      case 'i':
      case 'I': {
        e.preventDefault()
        setInspectorCollapsed((v) => !v)
        break
      }
      case 'g':
      case 'G': {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault()
          setViewMode((v) => (v === 'chat' ? 'graph' : 'chat'))
        }
        break
      }
      default: {
        // Session quick pick 1-9
        if (e.key >= '1' && e.key <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const sessions = store.state.sessions
          const idx = Number(e.key) - 1
          const s = sessions?.[idx]
          if (s) {
            e.preventDefault()
            void store.selectSession(s.id)
          }
        }
        break
      }
    }
  }

  // ── Attach global key handler ─────────────────────────────────
  onMount(() => {
    window.addEventListener('keydown', onGlobalKey)
    onCleanup(() => window.removeEventListener('keydown', onGlobalKey))
  })

  // ── Permission a/d handler (separate, always active when pending) ──
  createEffect(() => {
    if (store.state.pendingPermission) {
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'a' || e.key === 'A') {
          e.preventDefault()
          store.replyPermission('allow')
        } else if (e.key === 'd' || e.key === 'D' || e.key === 'Escape') {
          e.preventDefault()
          store.replyPermission('deny')
        }
      }
      window.addEventListener('keydown', handler)
      onCleanup(() => window.removeEventListener('keydown', handler))
    }
  })

  // ── Send / input handlers ─────────────────────────────────────
  const handleSend = () => {
    const raw = store.input().trim()
    if (raw === '/autopilot' || raw.startsWith('/autopilot ')) {
      store.setInput('')
      setAutopilotOpen(true)
      return
    }
    void store.sendPrompt()
  }

  const handleInputKeyDown = (e: KeyboardEvent) => {
    if (atVisible() && atFiltered().length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtIndex((i) => Math.min(i + 1, atFiltered().length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const pick = atFiltered()[atIndex()]
        if (pick) {
          e.preventDefault()
          handleAtSelect(pick)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtVisible(false)
        setAtDismissed(true)
        return
      }
    }
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
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape' && store.state.streaming) {
      e.preventDefault()
      store.stopStream()
    }
    if (e.key === '/' && store.input() === '') {
      void settingsStore.loadAll()
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
        store.setInput(`/${cmd} `)
        inputRef?.focus()
        break
      }
    }
  }

  // ── Derived ───────────────────────────────────────────────────
  const currentModel = () =>
    store.state.sessions.find((s) => s.id === store.state.currentId)?.model ?? ''

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
      <Shell narrow={false}>
        {/* ── Header (Layout.Header) ── */}
        <Header
          connected={store.state.connected}
          model={currentModel()}
          version={health()?.version}
          tools={health()?.tools}
          costUSD={store.state.sessions.find((s) => s.id === store.state.currentId)?.costUsd ?? cost()?.costUSD}
          costCap={store.state.costCap?.perSession ?? (budgetCapEnabled() ? budgetCapAmount() : undefined)}
          tokensIn={store.state.sessions.find((s) => s.id === store.state.currentId)?.tokensIn}
          tokensOut={store.state.sessions.find((s) => s.id === store.state.currentId)?.tokensOut}
          score={miraScore()?.score ?? null}
          queued={store.state.queued.length}
          hasSession={Boolean(store.state.currentId)}
          onUndo={() => void store.undoLast()}
        >
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
            <span style={{ opacity: '0.5', 'font-size': '11px' }}>loading…</span>
          </Show>
        </Header>

        {/* ── Banners ── */}
        <Show when={store.state.budgetWarning}>
          <Banner kind="warn" message={store.state.budgetWarning!} onDismiss={() => store.clearBudgetWarning()} />
        </Show>
        <DoomLoopBanner
          doomLoop={store.state.doomLoop}
          onRewind={() => void store.rewindDoomLoop()}
          onDismiss={() => store.clearDoomLoop()}
        />
        <Show when={store.state.error}>
          <Banner kind="error" message={store.state.error!} onDismiss={() => store.clearError()} />
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
                focusGroup={focusMgr.active()}
                onFocusGroupChange={focusMgr.setActive}
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

        {/* ── Input bar (TabStop) ── */}
        <div
          data-tab-stop="input"
          data-focused={focusMgr.active() === 'input' ? 'true' : 'false'}
          style={{
            display: 'flex',
            gap: '8px',
            padding: '10px',
            border:
              focusMgr.active() === 'input'
                ? '1px solid rgba(99,102,241,0.45)'
                : '1px solid rgba(255,255,255,0.08)',
            'border-radius': '10px',
            margin: '0 8px 8px 8px',
            background:
              focusMgr.active() === 'input' ? 'rgba(99,102,241,0.06)' : 'rgba(255,255,255,0.03)',
            'align-items': 'flex-end',
            position: 'relative',
            'box-shadow':
              focusMgr.active() === 'input' ? '0 0 0 1px rgba(99,102,241,0.15)' : 'none',
            transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s',
          }}
          role="group"
          aria-label="Prompt input"
          onClick={() => focusMgr.setActive('input')}
        >
          <Show when={slashVisible()}>
            <SlashAutocomplete
              query={slashQuery()}
              commands={slashCommands()}
              selected={slashIndex()}
              onSelect={handleSlashSelect}
              onClose={() => setSlashDismissed(true)}
              loading={settingsStore.state.loading}
            />
          </Show>
          <Show when={atVisible() && atFiltered().length > 0 && !atDismissed()}>
            <AtMentionAutocomplete
              query={atQuery()}
              files={workspaceFiles()}
              selected={atIndex()}
              onSelect={handleAtSelect}
              onClose={() => {
                setAtVisible(false)
                setAtDismissed(true)
              }}
            />
          </Show>
          <textarea
            ref={inputRef}
            value={store.input()}
            onInput={(e) => {
              const val = e.currentTarget.value
              store.setInput(val)
              if (val.startsWith('/')) void settingsStore.loadAll()
              const cursor = e.currentTarget.selectionStart ?? val.length
              const at = detectAtMention(val, cursor)
              if (at !== null && !atDismissed()) {
                setAtQuery(at)
                setAtVisible(true)
                setAtIndex(0)
              } else {
                setAtVisible(false)
              }
              e.currentTarget.style.height = 'auto'
              e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 160) + 'px'
            }}
            onKeyDown={handleInputKeyDown}
            onFocus={() => {
              focusMgr.setActive('input')
              void fetchWorkspaceFiles()
            }}
            placeholder={
              !store.state.currentId
                ? 'Create or select a session to start…'
                : store.state.streaming
                  ? 'Streaming… press Esc to stop'
                  : 'Ask Mira anything — Enter to send, Shift+Enter for newline ( / for commands )'
            }
            disabled={!store.state.currentId || Boolean(store.state.pendingPermission)}
            rows={2}
            aria-label="Prompt input"
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
                  type="button"
                  onClick={() => store.stopStream()}
                  aria-label="Stop streaming"
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
                type="button"
                onClick={handleSend}
                disabled={!store.state.currentId || !store.input().trim()}
                aria-label="Send prompt"
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
          role="contentinfo"
        >
          <span>
            Mira TUI · SolidJS + @opentui/solid · WS RPC to :4096 · {store.state.sessions.length}{' '}
            sessions
            <Show when={colorMode !== 'full'}>
              <span> · {colorMode} mode</span>
            </Show>
          </span>
          <span>Tab switch · ? help · : palette · n new · / search · q quit · Enter send · Esc stop</span>
        </div>

        {/* ── Overlays ── */}
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
        {/* a11y announcer */}
        <div id="a11y-announcer" aria-live="polite" aria-atomic="true" style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', 'white-space': 'nowrap' }} />
      </Shell>
    </Show>
  )
}
