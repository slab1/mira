// @ts-nocheck
import { createSignal, createMemo, onMount, onCleanup, Show, For } from 'solid-js'
import type { AppStore } from '../stores/app'
import type { SettingsStore } from '../stores/settings'
import {
  req,
  api,
  resolveServerHost,
  type AgentEntry,
  type ToolInfo,
  type PatchProposal,
  type AuditEntry,
  type MeProfile,
} from '../api/client'
import { type WorkspaceId } from './TopNav'
import { WorkspaceRouter } from './WorkspaceRouter'
import { HeaderModelSelector } from './HeaderSelectors'
import { TerminalView } from './TerminalView'
import { ChatView } from './ChatView'
import { SessionList } from './SessionList'
import { ActivityPanel } from './ActivityPanel'
import { initialsForName, displayNameForMe } from './Me'
import { toast } from './Toast'
import BrioPage from '../pages/Brio'

type WorkSubTabId = 'chat' | 'brio' | 'terminal' | 'agents' | 'tools' | 'files'

function NavIcon(props: { name: string; size?: number }) {
  const s = () => props.size ?? 16
  switch (props.name) {
    case 'work':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      )
    case 'missions':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
        </svg>
      )
    case 'intelligence':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="5" r="2.5" />
          <circle cx="5" cy="18" r="2.5" />
          <circle cx="19" cy="18" r="2.5" />
          <path d="M10.5 7 6.5 15.8M13.5 7l4 8.8M7.5 18h9" />
        </svg>
      )
    case 'changes':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M6 9v12M13 6h3a2 2 0 0 1 2 2v7" />
        </svg>
      )
    case 'evolution':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z" />
        </svg>
      )
    case 'system':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      )
    case 'dashboard':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 3v18h18" />
          <path d="M7 15v-3M12 15V8M17 15v-5" />
        </svg>
      )
    case 'brio':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="12 2 22 12 12 22 2 12 12 2" />
        </svg>
      )
    case 'terminal':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" x2="20" y1="19" y2="19" />
        </svg>
      )
    case 'agents':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M9 9h6v6H9z" />
        </svg>
      )
    case 'tools':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      )
    case 'files':
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
      )
    default:
      return (
        <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="4" x2="20" y1="6" y2="6" />
          <line x1="4" x2="20" y1="12" y2="12" />
          <line x1="4" x2="20" y1="18" y2="18" />
        </svg>
      )
  }
}

export function MiraGoldLayout(props: {
  store: AppStore
  settings: SettingsStore
  children?: any
}) {
  const [currentWorkspace, setCurrentWorkspace] = createSignal<WorkspaceId>('work')
  const [activeSubTab, setActiveSubTab] = createSignal<WorkSubTabId>('chat')
  const [searchQuery, setSearchQuery] = createSignal<string>('')
  const [loadingState, setLoadingState] = createSignal<boolean>(false)
  const [initialLoaded, setInitialLoaded] = createSignal<boolean>(false)

  // Layout & Drawer Controls
  const [isMobileScreen, setIsMobileScreen] = createSignal<boolean>(window.innerWidth < 1024)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = createSignal<boolean>(false)
  const [isRightSidebarOpen, setIsRightSidebarOpen] = createSignal<boolean>(false)
  const [showSessions, setShowSessions] = createSignal<boolean>(window.innerWidth >= 1024)
  const [showActivity, setShowActivity] = createSignal<boolean>(false)
  const [showProfileMenu, setShowProfileMenu] = createSignal<boolean>(false)
  const [meProfile, setMeProfile] = createSignal<MeProfile | null>(null)
  const meDisplayName = () => displayNameForMe(meProfile())
  const meInitials = () => initialsForName(meProfile()?.name)
  const isMeUnnamed = () => {
    const n = meProfile()?.name?.trim().toLowerCase()
    return !n || n === 'user'
  }

  // Live Telemetry State (null until verified from backend)
  const [activeAgentsCount, setActiveAgentsCount] = createSignal<number | null>(null)
  const [systemHealthPct, setSystemHealthPct] = createSignal<number | null>(null)
  const [responseTimeMs, setResponseTimeMs] = createSignal<number | null>(null)
  const [memoryUsageGb, setMemoryUsageGb] = createSignal<number | null>(null)
  const [latencySec, setLatencySec] = createSignal<number | null>(null)

  // Real Backend Data Lists
  const [realAgents, setRealAgents] = createSignal<AgentEntry[]>([])
  const [realTools, setRealTools] = createSignal<ToolInfo[]>([])
  const [proposals, setProposals] = createSignal<PatchProposal[]>([])
  const [auditLogs, setAuditLogs] = createSignal<AuditEntry[]>([])
  const [workspaceFiles, setWorkspaceFiles] = createSignal<Array<{ path: string; isDir: boolean; size: number; mtime: number }>>([])
  const [gatewayHealth, setGatewayHealth] = createSignal<any>(null)

  // Interactive Modal States
  const [showCheckGuardrailModal, setShowCheckGuardrailModal] = createSignal<boolean>(false)
  const [guardrailToolInput, setGuardrailToolInput] = createSignal<string>('bash')
  const [guardrailResult, setGuardrailResult] = createSignal<string>('')

  const loadAllRealData = async () => {
    setLoadingState(true)
    try {
      const [
        healthData,
        gatewayData,
        agentsData,
        toolsData,
        propsData,
        auditData,
        filesData,
        meData,
      ] = await Promise.all([
        req<any>('/health').catch(() => null),
        api.getGatewayHealth().catch(() => null),
        api.listAgents().catch(() => []),
        api.listToolsCached().catch(() => []),
        req<{ proposals: PatchProposal[] }>('/evolution/proposals').catch(() => ({ proposals: [] })),
        api.listAuditTrail({ limit: 30 }).catch(() => ({ entries: [] })),
        req<{ files?: any[] }>('/workspace/tree').catch(() => ({ files: [] })),
        api.getMe().catch(() => null),
      ])

      if (meData) {
        setMeProfile(meData)
      }
      if (Array.isArray(agentsData)) {
        setRealAgents(agentsData)
        setActiveAgentsCount(agentsData.length)
      }
      if (Array.isArray(toolsData)) {
        setRealTools(toolsData)
      }
      if (propsData?.proposals) {
        setProposals(propsData.proposals)
      }
      if (auditData?.entries) {
        setAuditLogs(auditData.entries)
      }
      if (filesData?.files) {
        setWorkspaceFiles(filesData.files.filter((f) => !f.isDir))
      }
      if (gatewayData?.gateway) {
        setGatewayHealth(gatewayData)
        if (typeof gatewayData.gateway.avgLatencyMs === 'number') {
          setResponseTimeMs(gatewayData.gateway.avgLatencyMs)
          setLatencySec(Number((gatewayData.gateway.avgLatencyMs / 1000).toFixed(2)))
        }
      }
      if (healthData?.ok) {
        const score = typeof healthData.healthScore === 'number'
          ? healthData.healthScore
          : (healthData.status === 'healthy' || healthData.ok === true) ? 100 : null
        setSystemHealthPct(score)
        if (healthData?.memoryUsage) {
          setMemoryUsageGb(Number((healthData.memoryUsage / 1024 / 1024 / 1024).toFixed(2)))
        }
      }
    } catch (e) {
      console.warn('Real data sync error:', e)
    } finally {
      setLoadingState(false)
      setInitialLoaded(true)
    }
  }

  onMount(() => {
    void loadAllRealData()

    const handleResize = () => {
      const mobile = window.innerWidth < 1024
      setIsMobileScreen(mobile)
      if (!mobile) {
        setIsMobileMenuOpen(false)
      } else {
        setShowSessions(false)
      }
    }
    window.addEventListener('resize', handleResize)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement | null
        const tag = target?.tagName?.toLowerCase()
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !target?.isContentEditable) {
          e.preventDefault()
          const el = document.getElementById('mira-global-search') as HTMLInputElement | null
          el?.focus()
        }
      }
      if (e.key === 'Escape') {
        setIsMobileMenuOpen(false)
        setIsRightSidebarOpen(false)
        setShowCheckGuardrailModal(false)
        setShowProfileMenu(false)
        if (isMobileScreen()) {
          setShowSessions(false)
          setShowActivity(false)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (showProfileMenu() && !target?.closest('[data-slot="profile-menu-root"]')) {
        setShowProfileMenu(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)

    const onMeUpdated = (e: Event) => {
      const detail = (e as CustomEvent<MeProfile>).detail
      if (detail?.name) {
        setMeProfile(detail)
      } else {
        void api.getMe().then((me) => setMeProfile(me)).catch(() => {})
      }
    }
    window.addEventListener('mira:me-updated', onMeUpdated)

    const unsubMeBus = props.store.subscribeBus((ev) => {
      if (ev.type === 'me.updated') {
        const p = ev.payload as { name?: unknown } | undefined
        if (p && typeof p.name === 'string') {
          setMeProfile((prev) => (prev ? { ...prev, name: p.name as string } : prev))
        }
        void api.getMe().then((me) => setMeProfile(me)).catch(() => {})
      }
    })

    onCleanup(() => {
      unsubMeBus()
      window.removeEventListener('mira:me-updated', onMeUpdated)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleOutsideClick)
    })
  })

  const navItems: Array<{ id: WorkspaceId; label: string; desc: string }> = [
    { id: 'work', label: 'Work', desc: 'Chat, Brio, Terminal & Tools' },
    { id: 'missions', label: 'Missions', desc: 'Autonomous execution cockpit' },
    { id: 'intelligence', label: 'Intelligence', desc: 'Memory & knowledge graph' },
    { id: 'changes', label: 'Changes', desc: 'File diffs & snapshots' },
    { id: 'evolution', label: 'Evolution', desc: 'Proposals & canary gates' },
    { id: 'system', label: 'System', desc: 'Health, security & config' },
    { id: 'dashboard', label: 'Analytics', desc: 'Reliability & token spend' },
  ]

  const mobileBottomNavItems: Array<{ id: WorkspaceId | 'menu'; label: string }> = [
    { id: 'work', label: 'Work' },
    { id: 'missions', label: 'Missions' },
    { id: 'evolution', label: 'Evolution' },
    { id: 'system', label: 'System' },
    { id: 'menu', label: 'More' },
  ]

  const workSubTabs: Array<{ id: WorkSubTabId; label: string }> = [
    { id: 'chat', label: 'Chat' },
    { id: 'brio', label: 'Brio' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'agents', label: 'Agents' },
    { id: 'tools', label: 'Tools' },
    { id: 'files', label: 'Files' },
  ]

  const selectWorkspace = (id: WorkspaceId, subTab?: WorkSubTabId) => {
    setCurrentWorkspace(id)
    if (subTab && id === 'work') {
      setActiveSubTab(subTab)
    }
    if (isMobileScreen()) {
      setIsMobileMenuOpen(false)
    }
  }

  const handleTestGuardrail = async () => {
    setGuardrailResult('Checking guardrail...')
    try {
      const res = await api.checkGuardrails({ tool: guardrailToolInput().trim() })
      setGuardrailResult(`Decision: ${res.decision.toUpperCase()} ${res.reason ? `(${res.reason})` : ''}`)
    } catch (err) {
      setGuardrailResult(`Error checking guardrail: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const filteredAgents = createMemo(() => {
    const q = searchQuery().toLowerCase().trim()
    const list = realAgents()
    if (!q) return list
    return list.filter((a) => (a.name || '').toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q))
  })

  const filteredTools = createMemo(() => {
    const q = searchQuery().toLowerCase().trim()
    const list = realTools()
    if (!q) return list
    return list.filter((t) => (t.name || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
  })

  const filteredFiles = createMemo(() => {
    const q = searchQuery().toLowerCase().trim()
    const list = workspaceFiles()
    if (!q) return list
    return list.filter((f) => (f.path || '').toLowerCase().includes(q))
  })

  // Recent Activity derived exclusively from real backend data (audit logs, proposals, sessions)
  const recentActivityItems = createMemo(() => {
    const items: Array<{ id: string; label: string; kind: 'ok' | 'warn' | 'accent'; time: number }> = []
    for (const log of auditLogs().slice(0, 3)) {
      items.push({
        id: `audit-${log.id}`,
        label: `${log.tool} (${log.decision})`,
        kind: log.decision === 'allow' ? 'ok' : 'warn',
        time: typeof log.createdAt === 'number' ? log.createdAt : Date.now(),
      })
    }
    for (const p of proposals().slice(0, 2)) {
      items.push({
        id: `prop-${p.id}`,
        label: `${p.id}: ${p.state}`,
        kind: p.state.includes('FAILED') ? 'warn' : 'accent',
        time: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
      })
    }
    if (items.length === 0) {
      for (const s of props.store.state.sessions.slice(0, 3)) {
        const ts = typeof s.updatedAt === 'number' ? s.updatedAt : Date.parse(String(s.updatedAt || s.createdAt || ''))
        items.push({
          id: `sess-${s.id}`,
          label: s.title || `Session ${s.id.slice(0, 6)}`,
          kind: 'accent',
          time: Number.isFinite(ts) ? ts : 0,
        })
      }
    }
    return items.slice(0, 5)
  })

  const pendingProposalsCount = createMemo(
    () => proposals().filter((p) => p.state === 'PROPOSED' || p.state.endsWith('_PENDING')).length,
  )

  const ringCircumference = 201.06
  const ringOffset = createMemo(() => {
    const pct = systemHealthPct()
    if (pct === null) return ringCircumference
    const clamped = Math.max(0, Math.min(100, pct))
    return ringCircumference * (1 - clamped / 100)
  })

  const serverLabel = () => resolveServerHost('same-origin')

  return (
    <div
      style={{
        display: 'flex',
        'min-height': '100vh',
        height: '100dvh',
        width: '100vw',
        overflow: 'hidden',
        background: '#07090E',
        color: '#F1F3FA',
        'font-family': "var(--font-sans)",
        position: 'relative',
      }}
    >
      {/* MOBILE DRAWER */}
      <Show when={isMobileScreen() && isMobileMenuOpen()}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          onClick={() => setIsMobileMenuOpen(false)}
          style={{
            position: 'fixed',
            inset: '0',
            background: 'rgba(0, 0, 0, 0.72)',
            'backdrop-filter': 'blur(4px)',
            'z-index': '1000',
            display: 'flex',
          }}
        >
          <div
            role="presentation"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '276px',
              height: '100%',
              background: '#090B12',
              'border-right': '1px solid #1A2033',
              display: 'flex',
              'flex-direction': 'column',
              padding: '16px 14px',
              gap: '14px',
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'border-bottom': '1px solid #151A2C', 'padding-bottom': '12px' }}>
              <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                <div style={{ 'font-size': '19px', 'font-weight': '900', color: '#F5D061', 'letter-spacing': '0.06em' }}>MIRA</div>
                <span style={{ 'font-size': '11px', color: '#A0A9C0' }}>Platform</span>
              </div>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setIsMobileMenuOpen(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#A0A9C0',
                  'font-size': '20px',
                  cursor: 'pointer',
                  'min-height': '44px',
                  'min-width': '44px',
                  display: 'grid',
                  'place-items': 'center',
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ 'padding-bottom': '8px', 'border-bottom': '1px solid #151A2C' }}>
              <HeaderModelSelector settings={props.settings} />
            </div>

            <nav aria-label="Primary workspaces" style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', flex: '1', overflow: 'auto' }}>
              <For each={navItems}>
                {(item) => {
                  const active = () => currentWorkspace() === item.id
                  return (
                    <button
                      type="button"
                      onClick={() => selectWorkspace(item.id)}
                      aria-current={active() ? 'page' : undefined}
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'space-between',
                        padding: '10px 12px',
                        'border-radius': '10px',
                        border: active() ? '1px solid rgba(229, 184, 66, 0.35)' : '1px solid transparent',
                        background: active()
                          ? 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)'
                          : 'transparent',
                        color: active() ? '#07090E' : '#A0A9C0',
                        'font-size': '13.5px',
                        'font-weight': active() ? '700' : '500',
                        cursor: 'pointer',
                        'min-height': '44px',
                        'text-align': 'left',
                      }}
                    >
                      <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
                        <NavIcon name={item.id} size={17} />
                        <span>{item.label}</span>
                      </div>
                      <Show when={active()}>
                        <span style={{ 'font-size': '14px', 'font-weight': '800' }}>›</span>
                      </Show>
                    </button>
                  )
                }}
              </For>
            </nav>

            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', 'padding-top': '8px', 'border-top': '1px solid #151A2C' }}>
              <button
                type="button"
                onClick={() => {
                  setIsMobileMenuOpen(false)
                  window.dispatchEvent(new CustomEvent('mira:open-palette'))
                }}
                style={{
                  background: '#101522',
                  border: '1px solid #1E253A',
                  color: '#F1F3FA',
                  padding: '10px 12px',
                  'border-radius': '10px',
                  'font-size': '12.5px',
                  'font-weight': '600',
                  cursor: 'pointer',
                  'text-align': 'left',
                }}
              >
                Command Palette (⌘K)
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsMobileMenuOpen(false)
                  window.dispatchEvent(new CustomEvent('mira:open-connect'))
                }}
                style={{
                  background: '#101522',
                  border: '1px solid #1E253A',
                  color: '#E5B842',
                  padding: '10px 12px',
                  'border-radius': '10px',
                  'font-size': '12.5px',
                  'font-weight': '600',
                  cursor: 'pointer',
                  'text-align': 'left',
                }}
              >
                Provider Connections
              </button>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  onClick={() => {
                    setIsMobileMenuOpen(false)
                    void loadAllRealData()
                  }}
                  style={{
                    flex: '1',
                    background: '#101522',
                    border: '1px solid #1E253A',
                    color: '#A0A9C0',
                    padding: '9px 10px',
                    'border-radius': '10px',
                    'font-size': '12px',
                    'font-weight': '600',
                    cursor: 'pointer',
                  }}
                >
                  ↻ Sync
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsMobileMenuOpen(false)
                    window.dispatchEvent(new CustomEvent('mira:open-settings'))
                  }}
                  style={{
                    flex: '1',
                    background: '#101522',
                    border: '1px solid #1E253A',
                    color: '#A0A9C0',
                    padding: '9px 10px',
                    'border-radius': '10px',
                    'font-size': '12px',
                    'font-weight': '600',
                    cursor: 'pointer',
                  }}
                >
                  Settings
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* 1. DESKTOP LEFT SIDEBAR NAVIGATION */}
      <Show when={!isMobileScreen()}>
        <aside
          aria-label="Primary navigation"
          style={{
            width: '216px',
            'flex-shrink': '0',
            background: '#090B12',
            'border-right': '1px solid #1A2033',
            display: 'flex',
            'flex-direction': 'column',
            padding: '14px 12px',
            gap: '14px',
            'user-select': 'none',
          }}
        >
          {/* Brand Monogram Header */}
          <button
            type="button"
            onClick={() => selectWorkspace('work', 'chat')}
            title="Go to Mira Chat"
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
              padding: '6px 8px 14px',
              'border-bottom': '1px solid #151A2C',
              background: 'transparent',
              borderTop: 'none',
              borderLeft: 'none',
              borderRight: 'none',
              cursor: 'pointer',
              'text-align': 'left',
            }}
          >
            <svg width="34" height="28" viewBox="0 0 54 42" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="miraGold" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#FCE183" />
                  <stop offset="50%" stop-color="#E5B842" />
                  <stop offset="100%" stop-color="#C5962B" />
                </linearGradient>
              </defs>
              <path d="M4 38 L16 4 L27 28 L38 4 L50 38" stroke="url(#miraGold)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M12 38 L22 14 L27 24 L32 14 L42 38" stroke="url(#miraGold)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.8" />
            </svg>
            <div>
              <div style={{ 'font-size': '17px', 'font-weight': '900', 'letter-spacing': '0.08em', color: '#F5D061', 'line-height': '1.1' }}>
                MIRA
              </div>
              <div style={{ 'font-size': '10.5px', color: '#7A859E', 'font-weight': '500' }}>
                Autonomous AI
              </div>
            </div>
          </button>

          {/* Navigation List */}
          <nav aria-label="Workspaces" style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', flex: '1', overflow: 'auto' }}>
            <For each={navItems}>
              {(item) => {
                const active = () => currentWorkspace() === item.id
                return (
                  <button
                    type="button"
                    onClick={() => selectWorkspace(item.id)}
                    aria-current={active() ? 'page' : undefined}
                    title={item.desc}
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'space-between',
                      padding: '9px 12px',
                      'border-radius': '10px',
                      border: 'none',
                      background: active()
                        ? 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)'
                        : 'transparent',
                      color: active() ? '#07090E' : '#A0A9C0',
                      'font-size': '13px',
                      'font-weight': active() ? '700' : '500',
                      cursor: 'pointer',
                      transition: 'all 0.14s ease',
                      'box-shadow': active() ? '0 4px 14px rgba(212, 175, 55, 0.25)' : 'none',
                      'text-align': 'left',
                      'min-height': '38px',
                    }}
                  >
                    <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
                      <NavIcon name={item.id} size={16} />
                      <span>{item.label}</span>
                    </div>
                    <Show when={item.id === 'evolution' && pendingProposalsCount() > 0 && !active()}>
                      <span
                        class="tabular-nums"
                        style={{
                          background: 'rgba(229, 184, 66, 0.18)',
                          color: '#F5D061',
                          'font-size': '10px',
                          'font-weight': '700',
                          padding: '1px 6px',
                          'border-radius': '6px',
                        }}
                      >
                        {pendingProposalsCount()}
                      </span>
                    </Show>
                  </button>
                )
              }}
            </For>
          </nav>

          {/* Bottom Quick Utilities */}
          <div
            style={{
              background: '#0D111E',
              border: '1px solid #1A2033',
              'border-radius': '12px',
              padding: '10px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '6px',
            }}
          >
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('mira:open-palette'))}
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'space-between',
                background: '#090B12',
                border: '1px solid #1E253A',
                color: '#A0A9C0',
                padding: '7px 10px',
                'border-radius': '8px',
                'font-size': '11.5px',
                cursor: 'pointer',
              }}
            >
              <span>Command Palette</span>
              <span class="kbd">⌘K</span>
            </button>
            <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', padding: '2px 4px', 'font-size': '11px', color: '#7A859E' }}>
              <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                <span
                  style={{
                    width: '7px',
                    height: '7px',
                    'border-radius': '50%',
                    background: props.store.state.connected ? '#34d399' : '#f87171',
                  }}
                />
                {props.store.state.connected ? 'Gateway online' : 'Reconnecting'}
              </span>
              <span class="tabular-nums" style={{ 'font-family': 'var(--font-mono)', 'font-size': '10px' }}>
                {activeAgentsCount() !== null ? `${activeAgentsCount()} agents` : '—'}
              </span>
            </div>
          </div>
        </aside>
      </Show>

      {/* 2. MAIN CONTENT AREA */}
      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100%', position: 'relative' }}>
        {/* TOP HEADER BAR */}
        <header
          class="mira-gold-header"
          style={{
            height: '54px',
            'flex-shrink': '0',
            'border-bottom': '1px solid #1A2033',
            background: '#07090E',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            padding: isMobileScreen() ? '0 10px' : '0 18px',
            gap: isMobileScreen() ? '8px' : '12px',
          }}
        >
          {/* Mobile Menu Trigger */}
          <Show when={isMobileScreen()}>
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen())}
              aria-label="Open navigation menu"
              aria-expanded={isMobileMenuOpen() ? 'true' : 'false'}
              style={{
                display: 'grid',
                'place-items': 'center',
                width: '40px',
                height: '40px',
                'border-radius': '10px',
                background: '#0D111E',
                border: '1px solid #1F273E',
                color: '#F5D061',
                cursor: 'pointer',
                'flex-shrink': '0',
              }}
            >
              <NavIcon name="menu" size={18} />
            </button>
          </Show>

          {/* Search Input */}
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              background: '#0D111E',
              border: '1px solid #1F273E',
              'border-radius': '10px',
              padding: '5px 10px',
              flex: '1',
              'min-width': '0',
              'max-width': isMobileScreen() ? '100%' : '380px',
              color: '#A0A9C0',
              'min-height': '36px',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={{ 'flex-shrink': '0', opacity: '0.65' }}>
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              id="mira-global-search"
              type="search"
              aria-label="Filter agents, tools, and workspace files"
              placeholder={isMobileScreen() ? 'Filter agents, tools, files…' : 'Filter agents, tools, files… ( / )'}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              style={{
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#F1F3FA',
                width: '100%',
                'font-size': '12.5px',
              }}
            />
          </div>

          {/* Model Selector in Header */}
          <Show when={!isMobileScreen()}>
            <HeaderModelSelector settings={props.settings} />
          </Show>

          {/* Right Header Controls */}
          <div style={{ display: 'flex', 'align-items': 'center', gap: isMobileScreen() ? '6px' : '8px', 'flex-shrink': '0' }}>
            <Show when={!isMobileScreen()}>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('mira:open-connect'))}
                title="Provider connections & API keys"
                style={{
                  background: '#0D111E',
                  border: '1px solid #1F273E',
                  color: '#F5D061',
                  padding: '6px 10px',
                  'border-radius': '8px',
                  'font-size': '12px',
                  'font-weight': '600',
                  cursor: 'pointer',
                  display: 'flex',
                  'align-items': 'center',
                  gap: '6px',
                  'min-height': '34px',
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 22v-5" />
                  <path d="M9 8V2" />
                  <path d="M15 8V2" />
                  <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
                </svg>
                <span>Connect</span>
              </button>
            </Show>

            {/* Sync Real Data (Desktop) */}
            <Show when={!isMobileScreen()}>
              <button
                type="button"
                onClick={loadAllRealData}
                disabled={loadingState()}
                aria-label="Sync system telemetry"
                title="Sync live backend data"
                style={{
                  background: '#0D111E',
                  border: '1px solid #1F273E',
                  color: loadingState() ? '#E5B842' : '#A0A9C0',
                  padding: '6px 10px',
                  height: '34px',
                  'border-radius': '8px',
                  'font-size': '12px',
                  'font-weight': '600',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                  gap: '5px',
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                  style={{ animation: loadingState() ? 'spin 1s linear infinite' : 'none' }}
                >
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                  <path d="M16 16h5v5" />
                </svg>
                <span>{loadingState() ? 'Syncing…' : 'Sync'}</span>
              </button>

              {/* Settings Trigger */}
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('mira:open-settings'))}
                aria-label="Open Settings"
                title="Mira Settings (⌘,)"
                style={{
                  background: '#0D111E',
                  border: '1px solid #1F273E',
                  color: '#A0A9C0',
                  width: '34px',
                  height: '34px',
                  'border-radius': '8px',
                  cursor: 'pointer',
                  display: 'grid',
                  'place-items': 'center',
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </Show>

            {/* Evolution Proposals Bell */}
            <button
              type="button"
              onClick={() => selectWorkspace('evolution')}
              aria-label={`View evolution proposals (${pendingProposalsCount()} pending)`}
              title="Evolution proposals & approvals"
              style={{
                position: 'relative',
                cursor: 'pointer',
                background: currentWorkspace() === 'evolution' ? 'rgba(229, 184, 66, 0.16)' : '#0D111E',
                border: currentWorkspace() === 'evolution' ? '1px solid rgba(229, 184, 66, 0.45)' : '1px solid #1F273E',
                color: '#E5B842',
                width: isMobileScreen() ? '38px' : '34px',
                height: isMobileScreen() ? '38px' : '34px',
                'border-radius': '8px',
                display: 'grid',
                'place-items': 'center',
                'flex-shrink': '0',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
              <Show when={pendingProposalsCount() > 0}>
                <span
                  class="tabular-nums"
                  style={{
                    position: 'absolute',
                    top: '-4px',
                    right: '-4px',
                    background: '#f87171',
                    color: '#07090E',
                    'font-size': '10px',
                    'font-weight': '800',
                    'min-width': '16px',
                    height: '16px',
                    padding: '0 4px',
                    'border-radius': '999px',
                    display: 'grid',
                    'place-items': 'center',
                    border: '2px solid #07090E',
                  }}
                >
                  {pendingProposalsCount()}
                </span>
              </Show>
            </button>

            {/* System Overview Drawer Toggle (Desktop & Mobile) */}
            <button
              type="button"
              onClick={() => setIsRightSidebarOpen((v) => !v)}
              aria-label="Toggle System Overview panel"
              aria-expanded={isRightSidebarOpen() ? 'true' : 'false'}
              title="System Overview & Activity"
              style={{
                background: isRightSidebarOpen() ? '#E5B842' : '#0D111E',
                border: '1px solid #1F273E',
                color: isRightSidebarOpen() ? '#07090E' : '#F5D061',
                width: isMobileScreen() ? '38px' : '34px',
                height: isMobileScreen() ? '38px' : '34px',
                'border-radius': '8px',
                display: 'grid',
                'place-items': 'center',
                cursor: 'pointer',
                'flex-shrink': '0',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M15 3v18" />
              </svg>
            </button>

            {/* Account & Gateway Profile Menu */}
            <div data-slot="profile-menu-root" style={{ position: 'relative', 'flex-shrink': '0' }}>
              <button
                type="button"
                onClick={() => setShowProfileMenu((v) => !v)}
                aria-label={`Account menu (${meDisplayName()})`}
                aria-expanded={showProfileMenu() ? 'true' : 'false'}
                title={isMeUnnamed() ? 'Set your name (/me)' : `Signed in as ${meDisplayName()}`}
                style={{
                  width: isMobileScreen() ? '38px' : '34px',
                  height: isMobileScreen() ? '38px' : '34px',
                  'border-radius': '50%',
                  overflow: 'hidden',
                  border: '2px solid #E5B842',
                  background: 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)',
                  color: '#07090E',
                  'font-weight': '800',
                  'font-size': '13px',
                  display: 'grid',
                  'place-items': 'center',
                  cursor: 'pointer',
                  padding: '0',
                }}
              >
                <span>{meInitials()}</span>
              </button>

              <Show when={showProfileMenu()}>
                <div
                  role="menu"
                  aria-label="Account menu"
                  style={{
                    position: 'absolute',
                    right: '0',
                    top: 'calc(100% + 8px)',
                    width: '248px',
                    background: '#0D111E',
                    border: '1px solid #2B3552',
                    'border-radius': '12px',
                    'box-shadow': '0 16px 40px rgba(0, 0, 0, 0.65)',
                    padding: '8px',
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '4px',
                    'z-index': '1100',
                  }}
                >
                  <div style={{ padding: '8px 10px', 'border-bottom': '1px solid #1E253A', 'margin-bottom': '4px' }}>
                    <div style={{ 'font-size': '13px', 'font-weight': '700', color: '#F1F3FA' }}>
                      {isMeUnnamed() ? 'User (unnamed)' : meDisplayName()}
                    </div>
                    <div style={{ 'font-size': '11px', color: '#7A859E', 'font-family': 'var(--font-mono)', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                      {serverLabel()}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowProfileMenu(false)
                      window.dispatchEvent(new CustomEvent('mira:open-me'))
                    }}
                    class="btn btn-ghost"
                    style={{
                      'justify-content': 'space-between',
                      padding: '8px 10px',
                      'font-size': '12.5px',
                      'border-radius': '8px',
                      color: isMeUnnamed() ? '#F5D061' : undefined,
                    }}
                  >
                    <span>My Profile (/me)</span>
                    <Show when={isMeUnnamed()}>
                      <span style={{ 'font-size': '11px', 'font-weight': '700' }}>Set name</span>
                    </Show>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowProfileMenu(false)
                      window.dispatchEvent(new CustomEvent('mira:open-connect'))
                    }}
                    class="btn btn-ghost"
                    style={{ 'justify-content': 'flex-start', padding: '8px 10px', 'font-size': '12.5px', 'border-radius': '8px' }}
                  >
                    Provider Connections
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowProfileMenu(false)
                      window.dispatchEvent(new CustomEvent('mira:open-settings'))
                    }}
                    class="btn btn-ghost"
                    style={{ 'justify-content': 'flex-start', padding: '8px 10px', 'font-size': '12.5px', 'border-radius': '8px' }}
                  >
                    Settings & Config
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowProfileMenu(false)
                      window.dispatchEvent(new CustomEvent('mira:open-trace'))
                    }}
                    class="btn btn-ghost"
                    style={{ 'justify-content': 'flex-start', padding: '8px 10px', 'font-size': '12.5px', 'border-radius': '8px' }}
                  >
                    Trace Viewer
                  </button>
                  <div style={{ height: '1px', background: '#1E253A', margin: '4px 0' }} />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowProfileMenu(false)
                      toast.info('Disconnected session token')
                      window.dispatchEvent(new CustomEvent('mira:sign-out'))
                    }}
                    class="btn btn-ghost"
                    style={{ 'justify-content': 'flex-start', padding: '8px 10px', 'font-size': '12.5px', color: '#f87171', 'border-radius': '8px' }}
                  >
                    Disconnect Server
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </header>

        {/* WORKSPACE & OPTIONAL RIGHT OVERVIEW DRAWER */}
        <div style={{ flex: '1', display: 'flex', overflow: 'hidden', background: '#07090E', 'margin-bottom': isMobileScreen() ? '56px' : '0', 'min-height': '0' }}>
          {/* CENTER WORKSPACE */}
          <main
            style={{
              flex: '1',
              display: 'flex',
              'flex-direction': 'column',
              overflow: 'hidden',
              'min-width': '0',
              'min-height': '0',
            }}
          >
            <WorkspaceRouter
              workspace={currentWorkspace()}
              store={props.store}
              onOpenInChat={(id) => {
                void props.store.selectSession(id)
                setCurrentWorkspace('work')
                setActiveSubTab('chat')
              }}
              renderWork={() => (
                <div
                  style={{
                    flex: '1',
                    background: '#0B0E17',
                    display: 'flex',
                    'flex-direction': 'column',
                    overflow: 'hidden',
                    'min-height': '0',
                    height: '100%',
                  }}
                >
                  {/* UNDERLINE SEGMENTED SUBTAB BAR (Zero Pill Clutter) */}
                  <div
                    role="tablist"
                    aria-label="Work workspace tools"
                    style={{
                      display: 'flex',
                      gap: '4px',
                      padding: '0 12px',
                      'border-bottom': '1px solid #1A2033',
                      background: '#090C15',
                      'flex-shrink': '0',
                      'overflow-x': 'auto',
                      'white-space': 'nowrap',
                      'scrollbar-width': 'none',
                    }}
                  >
                    <For each={workSubTabs}>
                      {(tab) => {
                        const active = () => activeSubTab() === tab.id
                        return (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={active() ? 'true' : 'false'}
                            onClick={() => setActiveSubTab(tab.id)}
                            style={{
                              display: 'inline-flex',
                              'align-items': 'center',
                              gap: '6px',
                              padding: '10px 12px',
                              border: 'none',
                              'border-bottom': active() ? '2px solid #E5B842' : '2px solid transparent',
                              background: 'transparent',
                              color: active() ? '#F5D061' : '#7A859E',
                              'font-size': '12.5px',
                              'font-weight': active() ? '700' : '500',
                              cursor: 'pointer',
                              transition: 'color 0.14s ease, border-color 0.14s ease',
                              'flex-shrink': '0',
                            }}
                          >
                            <NavIcon name={tab.id} size={14} />
                            <span>{tab.label}</span>
                          </button>
                        )
                      }}
                    </For>
                  </div>

                  {/* SUBTAB CONTENT */}
                  <div
                    style={{
                      flex: '1',
                      overflow: 'hidden',
                      display: 'flex',
                      'flex-direction': 'column',
                      'min-height': '0',
                    }}
                  >
                    {/* 1. CHAT WORKBENCH (Sessions + ChatView + ActivityPanel) */}
                    <Show when={activeSubTab() === 'chat'}>
                      <div style={{ flex: '1', display: 'flex', overflow: 'hidden', 'min-height': '0', position: 'relative' }}>
                        {/* Desktop Session Sidebar */}
                        <Show when={showSessions() && !isMobileScreen()}>
                          <SessionList store={props.store} open={true} width={264} />
                        </Show>

                        {/* Mobile Session Drawer */}
                        <Show when={showSessions() && isMobileScreen()}>
                          <div
                            role="presentation"
                            class="mira-gold-drawer-sessions"
                            onClick={() => setShowSessions(false)}
                            style={{
                              position: 'fixed',
                              inset: '0',
                              background: 'rgba(0, 0, 0, 0.7)',
                              'z-index': '980',
                              display: 'flex',
                            }}
                          >
                            <div
                              role="presentation"
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                height: '100%',
                                display: 'flex',
                                'flex-direction': 'column',
                                background: 'var(--bg-app)',
                                'border-right': '1px solid var(--border)',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  'align-items': 'center',
                                  'justify-content': 'space-between',
                                  padding: '8px 12px',
                                  'border-bottom': '1px solid var(--border)',
                                  background: '#090B12',
                                }}
                              >
                                <span style={{ 'font-size': '12px', 'font-weight': '700', color: '#F5D061' }}>
                                  Sessions
                                </span>
                                <button
                                  type="button"
                                  aria-label="Close sessions drawer"
                                  onClick={() => setShowSessions(false)}
                                  style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: '#A0A9C0',
                                    cursor: 'pointer',
                                    width: '32px',
                                    height: '32px',
                                    display: 'grid',
                                    'place-items': 'center',
                                    'font-size': '16px',
                                  }}
                                >
                                  ✕
                                </button>
                              </div>
                              <div style={{ flex: '1', 'min-height': '0', display: 'flex' }}>
                                <SessionList
                                  store={props.store}
                                  open={true}
                                  width={280}
                                  onAfterSelect={() => setShowSessions(false)}
                                />
                              </div>
                            </div>
                          </div>
                        </Show>

                        {/* Full Featured ChatView */}
                        <ChatView
                          store={props.store}
                          settings={props.settings}
                          onPaletteOpen={() => window.dispatchEvent(new CustomEvent('mira:open-palette'))}
                          sessionsOpen={showSessions()}
                          onToggleSessions={() => setShowSessions((v) => !v)}
                          activityOpen={showActivity()}
                          onToggleActivity={() => setShowActivity((v) => !v)}
                        />

                        {/* Activity & Governance Panel */}
                        <Show when={showActivity()}>
                          <Show
                            when={!isMobileScreen()}
                            fallback={
                              <div
                                role="presentation"
                                onClick={() => setShowActivity(false)}
                                style={{
                                  position: 'fixed',
                                  inset: '0',
                                  background: 'rgba(0, 0, 0, 0.7)',
                                  'z-index': '980',
                                  display: 'flex',
                                  'justify-content': 'flex-end',
                                }}
                              >
                                <div role="presentation" onClick={(e) => e.stopPropagation()} style={{ height: '100%', display: 'flex' }}>
                                  <ActivityPanel
                                    store={props.store}
                                    collapsed={false}
                                    onToggle={() => setShowActivity(false)}
                                    width={300}
                                  />
                                </div>
                              </div>
                            }
                          >
                            <ActivityPanel
                              store={props.store}
                              collapsed={false}
                              onToggle={() => setShowActivity(false)}
                              width={320}
                            />
                          </Show>
                        </Show>
                      </div>
                    </Show>

                    {/* 2. BRIO SCORING */}
                    <Show when={activeSubTab() === 'brio'}>
                      <div style={{ flex: '1', overflow: 'auto', display: 'flex', 'flex-direction': 'column' }}>
                        <BrioPage />
                      </div>
                    </Show>

                    {/* 3. TERMINAL */}
                    <Show when={activeSubTab() === 'terminal'}>
                      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', padding: isMobileScreen() ? '8px' : '14px', 'min-height': '0' }}>
                        <TerminalView open={activeSubTab() === 'terminal'} />
                      </div>
                    </Show>

                    {/* 4. AGENTS */}
                    <Show when={activeSubTab() === 'agents'}>
                      <div style={{ flex: '1', overflow: 'auto', padding: isMobileScreen() ? '12px' : '20px', display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                        <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'flex-wrap': 'wrap', gap: '8px' }}>
                          <div>
                            <div style={{ 'font-size': '16px', 'font-weight': '700', color: '#F1F3FA' }}>
                              Registered Agents (<span class="tabular-nums">{filteredAgents().length}</span>)
                            </div>
                            <div style={{ 'font-size': '12px', color: '#7A859E' }}>
                              Live backend agent definitions and tool capabilities.
                            </div>
                          </div>
                        </div>

                        <Show when={!initialLoaded() && loadingState()}>
                          <div style={{ display: 'grid', 'grid-template-columns': isMobileScreen() ? '1fr' : 'repeat(2, 1fr)', gap: '12px' }}>
                            <div class="skeleton" style={{ height: '110px' }} />
                            <div class="skeleton" style={{ height: '110px' }} />
                          </div>
                        </Show>

                        <Show when={initialLoaded() && filteredAgents().length === 0}>
                          <div class="card" style={{ padding: '24px', 'text-align': 'center', color: '#A0A9C0', 'font-size': '13px' }}>
                            {searchQuery().trim()
                              ? `No agents match "${searchQuery().trim()}".`
                              : 'No backend agents reported. Click Sync in the header to retry.'}
                          </div>
                        </Show>

                        <div style={{ display: 'grid', 'grid-template-columns': isMobileScreen() ? '1fr' : 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
                          <For each={filteredAgents()}>
                            {(agent) => (
                              <div
                                style={{
                                  background: '#101522',
                                  border: '1px solid #1E253A',
                                  'border-radius': '10px',
                                  padding: '14px',
                                  display: 'flex',
                                  'flex-direction': 'column',
                                  gap: '8px',
                                }}
                              >
                                <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '8px' }}>
                                  <div style={{ 'font-weight': '700', color: '#F5D061', 'font-size': '14px' }}>
                                    {agent.name}
                                  </div>
                                  <Show when={agent.permissions}>
                                    <span style={{ 'font-family': 'var(--font-mono)', 'font-size': '10.5px', color: '#A0A9C0', background: '#07090E', border: '1px solid #1E253A', padding: '2px 6px', 'border-radius': '4px' }}>
                                      {agent.permissions}
                                    </span>
                                  </Show>
                                </div>
                                <div style={{ 'font-size': '12px', color: '#A0A9C0', 'line-height': '1.45' }}>
                                  {agent.description || 'Agent persona configured on server.'}
                                </div>
                                <Show when={Array.isArray(agent.tools) && agent.tools.length > 0}>
                                  <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap', 'margin-top': '2px' }}>
                                    <For each={agent.tools}>
                                      {(tool) => (
                                        <span style={{ background: '#07090E', border: '1px solid #1E253A', color: '#38bdf8', padding: '2px 6px', 'border-radius': '4px', 'font-size': '10.5px', 'font-family': 'var(--font-mono)' }}>
                                          {tool}
                                        </span>
                                      )}
                                    </For>
                                  </div>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    {/* 5. TOOLS */}
                    <Show when={activeSubTab() === 'tools'}>
                      <div style={{ flex: '1', overflow: 'auto', padding: isMobileScreen() ? '12px' : '20px', display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                        <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'flex-wrap': 'wrap', gap: '8px' }}>
                          <div>
                            <div style={{ 'font-size': '16px', 'font-weight': '700', color: '#F1F3FA' }}>
                              Registered Tools (<span class="tabular-nums">{filteredTools().length}</span>)
                            </div>
                            <div style={{ 'font-size': '12px', color: '#7A859E' }}>
                              Live server capabilities available to agents.
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowCheckGuardrailModal(true)}
                            style={{
                              background: '#161D2F',
                              border: '1px solid rgba(229, 184, 66, 0.45)',
                              color: '#F5D061',
                              padding: '7px 12px',
                              'border-radius': '8px',
                              'font-size': '12px',
                              'font-weight': '600',
                              cursor: 'pointer',
                              'min-height': '36px',
                            }}
                          >
                            Test Guardrail
                          </button>
                        </div>

                        <Show when={initialLoaded() && filteredTools().length === 0}>
                          <div class="card" style={{ padding: '24px', 'text-align': 'center', color: '#A0A9C0', 'font-size': '13px' }}>
                            {searchQuery().trim()
                              ? `No tools match "${searchQuery().trim()}".`
                              : 'No tools reported by server.'}
                          </div>
                        </Show>

                        <div style={{ display: 'grid', 'grid-template-columns': isMobileScreen() ? '1fr' : 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' }}>
                          <For each={filteredTools()}>
                            {(tool) => (
                              <div
                                style={{
                                  background: '#101522',
                                  border: '1px solid #1E253A',
                                  'border-radius': '10px',
                                  padding: '13px',
                                  display: 'flex',
                                  'flex-direction': 'column',
                                  gap: '6px',
                                }}
                              >
                                <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                                  <span style={{ 'font-weight': '700', color: '#F5D061', 'font-family': 'var(--font-mono)', 'font-size': '12.5px' }}>
                                    {tool.name}
                                  </span>
                                  <span style={{ 'font-size': '10px', color: '#34d399', background: 'rgba(52, 211, 153, 0.1)', padding: '2px 6px', 'border-radius': '4px', 'font-weight': '600' }}>
                                    ENABLED
                                  </span>
                                </div>
                                <div style={{ 'font-size': '11.5px', color: '#A0A9C0', 'line-height': '1.45' }}>
                                  {tool.description || 'Server capability handler.'}
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    {/* 6. FILES */}
                    <Show when={activeSubTab() === 'files'}>
                      <div style={{ flex: '1', overflow: 'auto', padding: isMobileScreen() ? '12px' : '20px', display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                        <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'flex-wrap': 'wrap', gap: '8px' }}>
                          <div>
                            <div style={{ 'font-size': '16px', 'font-weight': '700', color: '#F1F3FA' }}>
                              Workspace Files (<span class="tabular-nums">{filteredFiles().length}</span>)
                            </div>
                            <div style={{ 'font-size': '12px', color: '#7A859E' }}>
                              Live files indexed in the active project workspace.
                            </div>
                          </div>
                        </div>

                        <Show when={initialLoaded() && filteredFiles().length === 0}>
                          <div class="card" style={{ padding: '24px', 'text-align': 'center', color: '#A0A9C0', 'font-size': '13px' }}>
                            {searchQuery().trim()
                              ? `No workspace files match "${searchQuery().trim()}".`
                              : 'No workspace files returned by server.'}
                          </div>
                        </Show>

                        <div style={{ display: 'grid', 'grid-template-columns': isMobileScreen() ? '1fr' : 'repeat(auto-fit, minmax(240px, 1fr))', gap: '8px' }}>
                          <For each={filteredFiles().slice(0, 80)}>
                            {(file) => (
                              <div
                                style={{
                                  background: '#101522',
                                  border: '1px solid #1E253A',
                                  padding: '10px 12px',
                                  'border-radius': '8px',
                                  display: 'flex',
                                  'justify-content': 'space-between',
                                  'align-items': 'center',
                                  gap: '8px',
                                }}
                              >
                                <span
                                  title={file.path}
                                  style={{
                                    color: '#F5D061',
                                    'font-weight': '500',
                                    'font-size': '12px',
                                    'font-family': 'var(--font-mono)',
                                    overflow: 'hidden',
                                    'text-overflow': 'ellipsis',
                                    'white-space': 'nowrap',
                                  }}
                                >
                                  {file.path}
                                </span>
                                <span class="tabular-nums" style={{ 'font-size': '10.5px', color: '#7A859E', 'font-family': 'var(--font-mono)', 'flex-shrink': '0' }}>
                                  {(file.size / 1024).toFixed(1)} KB
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            />
          </main>

          {/* 3. ON-DEMAND RIGHT SIDEBAR (SYSTEM OVERVIEW) */}
          <Show when={isRightSidebarOpen()}>
            <Show when={isMobileScreen()}>
              <div
                role="presentation"
                onClick={() => setIsRightSidebarOpen(false)}
                style={{
                  position: 'fixed',
                  inset: '0',
                  background: 'rgba(0, 0, 0, 0.65)',
                  'z-index': '890',
                }}
              />
            </Show>
            <aside
              aria-label="System overview"
              style={{
                width: isMobileScreen() ? '300px' : '280px',
                position: isMobileScreen() ? 'fixed' : 'relative',
                right: '0',
                top: isMobileScreen() ? '54px' : '0',
                bottom: isMobileScreen() ? '56px' : '0',
                'z-index': isMobileScreen() ? '900' : '1',
                'flex-shrink': '0',
                'border-left': '1px solid #1A2033',
                background: '#090B12',
                display: 'flex',
                'flex-direction': 'column',
                padding: '14px',
                gap: '12px',
                overflow: 'auto',
                'box-shadow': isMobileScreen() ? '-8px 0 24px rgba(0,0,0,0.6)' : 'none',
              }}
            >
              <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                <span style={{ 'font-weight': '700', 'font-size': '13px', color: '#F1F3FA' }}>System Overview</span>
                <button
                  type="button"
                  onClick={() => setIsRightSidebarOpen(false)}
                  aria-label="Close System Overview"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#7A859E',
                    cursor: 'pointer',
                    width: '28px',
                    height: '28px',
                    display: 'grid',
                    'place-items': 'center',
                    'border-radius': '6px',
                  }}
                >
                  ✕
                </button>
              </div>

              {/* CARD 1: HEALTH & GATEWAY */}
              <div
                style={{
                  background: '#0D111E',
                  border: '1px solid #1E253A',
                  'border-radius': '12px',
                  padding: '14px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                  <span style={{ 'font-weight': '700', 'font-size': '12px', color: '#A0A9C0', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' }}>
                    Runtime Health
                  </span>
                  <span
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '5px',
                      color: systemHealthPct() !== null ? '#34d399' : '#7A859E',
                      'font-size': '11px',
                      'font-weight': '600',
                    }}
                  >
                    <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: systemHealthPct() !== null ? '#34d399' : '#7A859E' }} />
                    {systemHealthPct() !== null ? 'Live' : 'Pending'}
                  </span>
                </div>

                <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '10px' }}>
                  <div style={{ position: 'relative', width: '78px', height: '78px', display: 'grid', 'place-items': 'center', 'flex-shrink': '0' }}>
                    <svg width="78" height="78" viewBox="0 0 82 82" style={{ transform: 'rotate(-90deg)' }}>
                      <circle cx="41" cy="41" r="32" stroke="#161D2F" stroke-width="7" fill="none" />
                      <circle
                        cx="41"
                        cy="41"
                        r="32"
                        stroke={systemHealthPct() !== null ? (systemHealthPct()! >= 80 ? '#34d399' : '#fbbf24') : '#2B3552'}
                        stroke-width="7"
                        fill="none"
                        stroke-dasharray="201.06"
                        stroke-dashoffset={String(ringOffset())}
                        stroke-linecap="round"
                      />
                    </svg>
                    <div style={{ position: 'absolute', 'text-align': 'center' }}>
                      <div class="tabular-nums" style={{ 'font-size': '12.5px', 'font-weight': '800', color: '#F1F3FA', 'line-height': '1.1' }}>
                        {systemHealthPct() !== null ? `${systemHealthPct()}%` : 'Unknown'}
                      </div>
                      <div style={{ 'font-size': '9.5px', color: '#7A859E' }}>Health</div>
                    </div>
                  </div>

                  <div class="tabular-nums" style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', 'font-size': '11.5px', flex: '1' }}>
                    <div style={{ display: 'flex', 'justify-content': 'space-between' }}>
                      <span style={{ color: '#7A859E' }}>Latency</span>
                      <span style={{ 'font-weight': '700', color: '#F1F3FA', 'font-family': 'var(--font-mono)' }}>
                        {responseTimeMs() !== null ? `${responseTimeMs()}ms` : latencySec() !== null ? `${latencySec()}s` : '—'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', 'justify-content': 'space-between' }}>
                      <span style={{ color: '#7A859E' }}>Memory</span>
                      <span style={{ 'font-weight': '700', color: '#F1F3FA', 'font-family': 'var(--font-mono)' }}>
                        {memoryUsageGb() !== null ? `${memoryUsageGb()} GB` : '—'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', 'justify-content': 'space-between' }}>
                      <span style={{ color: '#7A859E' }}>Requests</span>
                      <span style={{ 'font-weight': '700', color: '#F1F3FA', 'font-family': 'var(--font-mono)' }}>
                        {gatewayHealth()?.gateway?.requests ?? '—'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* CARD 2: ACTIVE AGENTS */}
              <div
                style={{
                  background: '#0D111E',
                  border: '1px solid #1E253A',
                  'border-radius': '12px',
                  padding: '14px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                  <span style={{ 'font-weight': '700', 'font-size': '12.5px', color: '#F1F3FA' }}>
                    Agents (<span class="tabular-nums">{activeAgentsCount() !== null ? activeAgentsCount() : '—'}</span>)
                  </span>
                  <button
                    type="button"
                    onClick={() => selectWorkspace('work', 'agents')}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: '0',
                      'font-size': '11px',
                      color: '#F5D061',
                      cursor: 'pointer',
                      'font-weight': '600',
                    }}
                  >
                    View All →
                  </button>
                </div>

                <Show
                  when={realAgents().length > 0}
                  fallback={
                    <div style={{ 'font-size': '11.5px', color: '#7A859E', padding: '4px 0' }}>
                      No active backend agents loaded.
                    </div>
                  }
                >
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                    <For each={realAgents().slice(0, 4)}>
                      {(agent) => (
                        <div
                          style={{
                            padding: '6px 8px',
                            background: '#090C16',
                            'border-radius': '8px',
                            border: '1px solid #182035',
                          }}
                        >
                          <div style={{ 'font-size': '12px', 'font-weight': '600', color: '#F5D061' }}>{agent.name}</div>
                          <div style={{ 'font-size': '10.5px', color: '#7A859E', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>
                            {agent.description || 'Configured persona'}
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              {/* CARD 3: RECENT ACTIVITY (100% Real Data) */}
              <div
                style={{
                  background: '#0D111E',
                  border: '1px solid #1E253A',
                  'border-radius': '12px',
                  padding: '14px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                  <span style={{ 'font-weight': '700', 'font-size': '12.5px', color: '#F1F3FA' }}>Recent Activity</span>
                  <button
                    type="button"
                    onClick={() => selectWorkspace('evolution')}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: '0',
                      'font-size': '11px',
                      color: '#F5D061',
                      cursor: 'pointer',
                      'font-weight': '600',
                    }}
                  >
                    Evolution →
                  </button>
                </div>

                <Show
                  when={recentActivityItems().length > 0}
                  fallback={
                    <div style={{ 'font-size': '11.5px', color: '#7A859E', padding: '4px 0' }}>
                      No recent audit, proposal, or session events recorded yet.
                    </div>
                  }
                >
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                    <For each={recentActivityItems()}>
                      {(item) => (
                        <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '8px', 'font-size': '11px' }}>
                          <div style={{ display: 'flex', 'align-items': 'center', gap: '7px', 'min-width': '0' }}>
                            <span
                              style={{
                                width: '7px',
                                height: '7px',
                                'border-radius': '50%',
                                background: item.kind === 'ok' ? '#34d399' : item.kind === 'warn' ? '#fbbf24' : '#E5B842',
                                'flex-shrink': '0',
                              }}
                            />
                            <span style={{ color: '#F1F3FA', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>
                              {item.label}
                            </span>
                          </div>
                          <span class="tabular-nums" style={{ color: '#7A859E', 'flex-shrink': '0', 'font-family': 'var(--font-mono)', 'font-size': '10px' }}>
                            {item.time ? new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </aside>
          </Show>
        </div>

        {/* MOBILE BOTTOM NAVIGATION BAR */}
        <Show when={isMobileScreen()}>
          <nav
            aria-label="Mobile navigation"
            style={{
              position: 'fixed',
              bottom: '0',
              left: '0',
              right: '0',
              height: '56px',
              background: 'rgba(9, 11, 18, 0.96)',
              'backdrop-filter': 'blur(10px)',
              'border-top': '1px solid #1A2033',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-around',
              'z-index': '950',
              padding: '0 4px',
            }}
          >
            <For each={mobileBottomNavItems}>
              {(item) => {
                const active = () => item.id === 'menu' ? isMobileMenuOpen() : currentWorkspace() === item.id
                return (
                  <button
                    type="button"
                    aria-current={active() && item.id !== 'menu' ? 'page' : undefined}
                    onClick={() => {
                      if (item.id === 'menu') {
                        setIsMobileMenuOpen(!isMobileMenuOpen())
                      } else {
                        selectWorkspace(item.id)
                      }
                    }}
                    style={{
                      display: 'flex',
                      'flex-direction': 'column',
                      'align-items': 'center',
                      'justify-content': 'center',
                      background: 'transparent',
                      border: 'none',
                      color: active() ? '#F5D061' : '#7A859E',
                      'font-size': '10.5px',
                      'font-weight': active() ? '700' : '500',
                      cursor: 'pointer',
                      flex: '1',
                      height: '100%',
                      gap: '3px',
                    }}
                  >
                    <NavIcon name={item.id} size={18} />
                    <span>{item.label}</span>
                  </button>
                )
              }}
            </For>
          </nav>
        </Show>
      </div>

      {/* GUARDRAIL TEST MODAL */}
      <Show when={showCheckGuardrailModal()}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="guardrail-modal-title"
          onClick={() => setShowCheckGuardrailModal(false)}
          style={{
            position: 'fixed',
            inset: '0',
            background: 'rgba(7, 9, 14, 0.85)',
            display: 'grid',
            'place-items': 'center',
            'z-index': '1000',
            padding: '16px',
          }}
        >
          <div
            role="presentation"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#0D111E',
              border: '1px solid rgba(229, 184, 66, 0.45)',
              'border-radius': '14px',
              padding: isMobileScreen() ? '16px' : '22px',
              width: 'min(460px, calc(100vw - 32px))',
              'max-height': '90dvh',
              display: 'flex',
              'flex-direction': 'column',
              gap: '14px',
              'overflow-y': 'auto',
            }}
          >
            <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
              <div id="guardrail-modal-title" style={{ 'font-size': '15px', 'font-weight': '800', color: '#F5D061' }}>
                Test Tool Guardrail
              </div>
              <button
                type="button"
                aria-label="Close guardrail dialog"
                onClick={() => setShowCheckGuardrailModal(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#A0A9C0',
                  'font-size': '18px',
                  cursor: 'pointer',
                  'min-height': '36px',
                  'min-width': '36px',
                  display: 'grid',
                  'place-items': 'center',
                }}
              >
                ✕
              </button>
            </div>
            <div>
              <label for="guardrail-tool-input" style={{ 'font-size': '11px', 'font-weight': '700', color: '#A0A9C0' }}>
                Tool Name
              </label>
              <input
                id="guardrail-tool-input"
                type="text"
                value={guardrailToolInput()}
                onInput={(e) => setGuardrailToolInput(e.currentTarget.value)}
                placeholder="bash, edit, read, etc."
                style={{
                  width: '100%',
                  background: '#07090E',
                  border: '1px solid #1E253A',
                  color: '#F1F3FA',
                  padding: '9px 10px',
                  'border-radius': '8px',
                  'margin-top': '6px',
                  'font-size': '13px',
                  'font-family': 'var(--font-mono)',
                }}
              />
            </div>
            <Show when={guardrailResult()}>
              <div style={{ background: '#07090E', border: '1px solid #1E253A', padding: '10px 12px', 'border-radius': '8px', 'font-size': '12px', color: '#34d399', 'font-family': 'var(--font-mono)' }}>
                {guardrailResult()}
              </div>
            </Show>
            <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
              <button
                type="button"
                onClick={() => setShowCheckGuardrailModal(false)}
                style={{
                  background: 'transparent',
                  border: '1px solid #1E253A',
                  color: '#A0A9C0',
                  padding: '8px 14px',
                  'border-radius': '8px',
                  'font-weight': '600',
                  cursor: 'pointer',
                  'min-height': '36px',
                }}
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleTestGuardrail}
                style={{
                  background: 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)',
                  color: '#07090E',
                  border: 'none',
                  padding: '8px 16px',
                  'border-radius': '8px',
                  'font-weight': '700',
                  cursor: 'pointer',
                  'min-height': '36px',
                }}
              >
                Evaluate
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
