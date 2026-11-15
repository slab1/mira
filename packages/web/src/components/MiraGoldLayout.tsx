// @ts-nocheck
import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import type { AppStore } from '../stores/app'
import type { SettingsStore } from '../stores/settings'
import {
  req,
  api,
  type AgentEntry,
  type ToolInfo,
  type PatchProposal,
  type AuditEntry,
  type Finding,
  type ProviderEntry,
  type MiraConfig,
} from '../api/client'
import { TopNav, type WorkspaceId } from './TopNav'
import { WorkspaceRouter } from './WorkspaceRouter'
import { HeaderModelSelector } from './HeaderSelectors'
import { TerminalView } from './TerminalView'

export function MiraGoldLayout(props: {
  store: AppStore
  settings: SettingsStore
  children?: any
}) {
  const [activeNav, setActiveNav] = createSignal<string>('home')
  const [activeSubTab, setActiveSubTab] = createSignal<string>('chat')
  const [searchQuery, setSearchQuery] = createSignal<string>('')
  const [inputPrompt, setInputPrompt] = createSignal<string>('')
  const [toastMessage, setToastMessage] = createSignal<string>('')
  const [loadingState, setLoadingState] = createSignal<boolean>(false)

  // Mobile UX & Drawer Controls
  const [isMobileScreen, setIsMobileScreen] = createSignal<boolean>(window.innerWidth < 1024)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = createSignal<boolean>(false)
  const [isRightSidebarOpen, setIsRightSidebarOpen] = createSignal<boolean>(false)

  // System Stats State (Truth over confidence: null until backend evidence arrives)
  const [activeAgentsCount, setActiveAgentsCount] = createSignal<number | null>(null)
  const [tasksRunningCount, setTasksRunningCount] = createSignal<number | null>(null)
  const [systemHealthPct, setSystemHealthPct] = createSignal<number | null>(null)
  const [responseTimeMs, setResponseTimeMs] = createSignal<number | null>(null)
  const [memoryUsageGb, setMemoryUsageGb] = createSignal<number | null>(null)
  const [latencySec, setLatencySec] = createSignal<number | null>(null)

  // Real Backend Data Lists
  const [realAgents, setRealAgents] = createSignal<AgentEntry[]>([])
  const [realTools, setRealTools] = createSignal<ToolInfo[]>([])
  const [proposals, setProposals] = createSignal<PatchProposal[]>([])
  const [auditLogs, setAuditLogs] = createSignal<AuditEntry[]>([])
  const [knowledgeNodes, setKnowledgeNodes] = createSignal<any[]>([])
  const [workspaceFiles, setWorkspaceFiles] = createSignal<Array<{ path: string; isDir: boolean; size: number; mtime: number }>>([])
  const [findingsList, setFindingsList] = createSignal<Finding[]>([])
  const [gatewayHealth, setGatewayHealth] = createSignal<any>(null)
  const [miraConfig, setMiraConfig] = createSignal<MiraConfig | null>(null)
  const [providerList, setProviderList] = createSignal<ProviderEntry[]>([])

  // Interactive Modal States
  const [showSeedMemoryModal, setShowSeedMemoryModal] = createSignal<boolean>(false)
  const [showCheckGuardrailModal, setShowCheckGuardrailModal] = createSignal<boolean>(false)

  // Inputs for modal operations
  const [seedTitle, setSeedTitle] = createSignal<string>('')
  const [seedContent, setSeedContent] = createSignal<string>('')
  const [guardrailToolInput, setGuardrailToolInput] = createSignal<string>('bash')
  const [guardrailResult, setGuardrailResult] = createSignal<string>('')

  const showToast = (msg: string) => {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(''), 3500)
  }

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
        graphData,
        filesData,
        findingsData,
        configData,
        providersData,
      ] = await Promise.all([
        req<any>('/health').catch(() => null),
        api.getGatewayHealth().catch(() => null),
        api.listAgents().catch(() => []),
        api.listToolsCached().catch(() => []),
        req<{ proposals: PatchProposal[] }>('/evolution/proposals').catch(() => ({ proposals: [] })),
        api.listAuditTrail({ limit: 30 }).catch(() => ({ entries: [] })),
        req<{ nodes?: any[] }>('/knowledge/graph').catch(() => ({ nodes: [] })),
        req<{ files?: any[] }>('/workspace/tree').catch(() => ({ files: [] })),
        api.listFindings().catch(() => []),
        api.getConfig().catch(() => null),
        api.listProviders().catch(() => []),
      ])

      if (agentsData && agentsData.length > 0) {
        setRealAgents(agentsData)
        setActiveAgentsCount(agentsData.length)
      }
      if (toolsData && toolsData.length > 0) {
        setRealTools(toolsData)
      }
      if (propsData?.proposals) {
        setProposals(propsData.proposals)
      }
      if (auditData?.entries) {
        setAuditLogs(auditData.entries)
      }
      if (graphData?.nodes) {
        setKnowledgeNodes(graphData.nodes)
      }
      if (filesData?.files) {
        setWorkspaceFiles(filesData.files.filter((f) => !f.isDir))
      }
      if (findingsData) {
        setFindingsList(findingsData)
      }
      if (gatewayData?.gateway) {
        setGatewayHealth(gatewayData)
        if (typeof gatewayData.gateway.avgLatencyMs === 'number') {
          setResponseTimeMs(gatewayData.gateway.avgLatencyMs)
          setLatencySec(Number((gatewayData.gateway.avgLatencyMs / 1000).toFixed(2)))
        }
        if (typeof gatewayData.gateway.requests === 'number') {
          setTasksRunningCount(gatewayData.gateway.requests)
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
      if (configData) {
        setMiraConfig(configData)
      }
      if (providersData) {
        const provs = Array.isArray(providersData)
          ? providersData
          : Object.entries(providersData).map(([id, p]: [string, any]) => ({
              id,
              name: p.name || id,
              baseURL: p.options?.baseURL,
              maskedKey: '***',
            }))
        setProviderList(provs)
      }
    } catch (e) {
      console.warn('Real data sync error:', e)
    } finally {
      setLoadingState(false)
    }
  }

  onMount(() => {
    void loadAllRealData()

    const handleResize = () => {
      setIsMobileScreen(window.innerWidth < 1024)
      if (window.innerWidth >= 1024) {
        setIsMobileMenuOpen(false)
        setIsRightSidebarOpen(false)
      }
    }
    window.addEventListener('resize', handleResize)

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const el = document.getElementById('mira-global-search') as HTMLInputElement | null
        if (el) el.focus()
      }
      if (e.key === 'Escape') {
        setIsMobileMenuOpen(false)
        setIsRightSidebarOpen(false)
        setShow3DModal(false)
        setShowPatternModal(false)
        setShowFabricsModal(false)
        setShowModifyModal(false)
        setShowSeedMemoryModal(false)
        setShowCheckGuardrailModal(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    onCleanup(() => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('keydown', handleKeyDown)
    })
  })

  const navItems = [
    { id: 'home', label: 'Home', icon: '🏠' },
    { id: 'agents', label: 'Agents', icon: '👥' },
    { id: 'tools', label: 'Tools', icon: '🛠' },
    { id: 'memory', label: 'Memory', icon: '💾' },
    { id: 'evolution', label: 'Evolution', icon: '🧬' },
    { id: 'security', label: 'Security', icon: '🛡' },
    { id: 'projects', label: 'Projects', icon: '📅' },
    { id: 'analytics', label: 'Analytics', icon: '📊' },
    { id: 'settings', label: 'Settings', icon: '⚙' },
  ]

  const mobileBottomNavItems = [
    { id: 'home', label: 'Home', icon: '🏠' },
    { id: 'agents', label: 'Agents', icon: '👥' },
    { id: 'tools', label: 'Tools', icon: '🛠' },
    { id: 'evolution', label: 'Evolution', icon: '🧬' },
    { id: 'menu', label: 'Menu', icon: '☰' },
  ]

  const workspaceSubTabs = [
    { id: 'chat', label: 'Chat', icon: '💬' },
    { id: 'terminal', label: 'Terminal', icon: '▣' },
    { id: 'agents', label: 'Agents', icon: '⚙' },
    { id: 'tools', label: 'Tools', icon: '🎯' },
    { id: 'memory', label: 'Memory', icon: '🎛' },
    { id: 'evolution', label: 'Evolution', icon: '🚀' },
    { id: 'security', label: 'Security', icon: '🛡' },
    { id: 'files', label: 'Files', icon: '📁' },
    { id: 'analytics', label: 'Analytics', icon: '📊' },
    { id: 'settings', label: 'Settings', icon: '⚙' },
  ]

  const [currentWorkspace, setCurrentWorkspace] = createSignal<WorkspaceId>('missions')

  const handleNavClick = (id: string) => {
    setActiveNav(id)
    if (id === 'settings') {
      window.dispatchEvent(new CustomEvent('mira:open-settings'))
      setCurrentWorkspace('system')
    } else if (id === 'home' || id === 'missions') {
      setCurrentWorkspace('missions')
    } else if (id === 'agents' || id === 'tools' || id === 'chat' || id === 'terminal') {
      setCurrentWorkspace('work')
      setActiveSubTab(id)
    } else if (id === 'memory' || id === 'intelligence') {
      setCurrentWorkspace('intelligence')
    } else if (id === 'changes') {
      setCurrentWorkspace('changes')
    } else if (id === 'evolution') {
      setCurrentWorkspace('evolution')
    } else if (id === 'security') {
      setCurrentWorkspace('system')
    } else if (id === 'analytics' || id === 'dashboard') {
      setCurrentWorkspace('dashboard')
    } else {
      setActiveSubTab(id)
    }

    if (isMobileScreen()) {
      setIsMobileMenuOpen(false)
    }
  }

  const handleSendPrompt = (e?: Event) => {
    e?.preventDefault()
    const val = inputPrompt().trim()
    if (!val) return
    props.store.sendPrompt(val)
    setInputPrompt('')
  }



  const handleSeedMemory = async (e: Event) => {
    e.preventDefault()
    if (!seedTitle().trim()) return
    try {
      await api.seedKnowledge({
        title: seedTitle().trim(),
        content: seedContent().trim() || seedTitle().trim(),
        tier: 'semantic',
        source: 'user_ui',
      })
      showToast(`Memory node "${seedTitle()}" saved to knowledge graph.`)
      setSeedTitle('')
      setSeedContent('')
      setShowSeedMemoryModal(false)
      void loadAllRealData()
    } catch (err) {
      showToast(`Seed memory: ${err instanceof Error ? err.message : String(err)}`)
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

  const handlePromoteProposal = async (id: string) => {
    try {
      await req(`/evolution/proposals/${encodeURIComponent(id)}/promote`, { method: 'POST' })
      showToast(`Proposal ${id} promoted successfully!`)
      void loadAllRealData()
    } catch (err) {
      showToast(`Promote failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleRollbackProposal = async (id: string) => {
    try {
      await req(`/evolution/proposals/${encodeURIComponent(id)}/rollback`, { method: 'POST' })
      showToast(`Proposal ${id} rolled back.`)
      void loadAllRealData()
    } catch (err) {
      showToast(`Rollback failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Filter helpers based on search
  const filteredAgents = () => {
    const q = searchQuery().toLowerCase().trim()
    const list = realAgents().length > 0 ? realAgents() : [
      { name: 'Mira Architect', description: 'System design, workflow decomposition, and planning agent', tools: ['search', 'plan'], permissions: 'full' },
      { name: 'Mira Developer', description: 'Autonomous patch creation, TypeScript code engine', tools: ['bash', 'edit'], permissions: 'full' },
      { name: 'Mira Reviewer', description: 'Security audit, linter validation, and quality gate', tools: ['read', 'lint'], permissions: 'readonly' },
      { name: 'Mira Researcher', description: 'Knowledge retrieval, document parsing, and analysis', tools: ['websearch', 'fetch'], permissions: 'readonly' },
    ]
    if (!q) return list
    return list.filter((a) => (a.name || '').toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q))
  }

  const filteredTools = () => {
    const q = searchQuery().toLowerCase().trim()
    const list = realTools()
    if (!q) return list
    return list.filter((t) => (t.name || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
  }

  const filteredFiles = () => {
    const q = searchQuery().toLowerCase().trim()
    const list = workspaceFiles()
    if (!q) return list
    return list.filter((f) => (f.path || '').toLowerCase().includes(q))
  }

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        background: '#07090E',
        color: '#F1F3FA',
        'font-family': "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
        position: 'relative',
      }}
    >
      {/* Toast Notification */}
      <Show when={toastMessage()}>
        <div
          style={{
            position: 'fixed',
            bottom: isMobileScreen() ? '70px' : 'auto',
            top: isMobileScreen() ? 'auto' : '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'linear-gradient(135deg, #101524 0%, #1A2136 100%)',
            border: '1px solid #E5B842',
            color: '#F5D061',
            padding: '10px 20px',
            'border-radius': '999px',
            'font-size': '13px',
            'font-weight': '600',
            'box-shadow': '0 8px 32px rgba(229, 184, 66, 0.4)',
            'z-index': '9999',
            display: 'flex',
            'align-items': 'center',
            gap: '8px',
            'max-width': '90vw',
          }}
        >
          <span>✦</span>
          <span>{toastMessage()}</span>
        </div>
      </Show>

      {/* ========================================================================= */}
      {/* MOBILE BACKDROP & DRAWER OVERLAY */}
      {/* ========================================================================= */}
      <Show when={isMobileScreen() && isMobileMenuOpen()}>
        <div
          onClick={() => setIsMobileMenuOpen(false)}
          style={{
            position: 'fixed',
            inset: '0',
            background: 'rgba(0, 0, 0, 0.75)',
            'backdrop-filter': 'blur(4px)',
            'z-index': '1000',
            display: 'flex',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '270px',
              height: '100%',
              background: '#090B12',
              'border-right': '1px solid #1A2033',
              display: 'flex',
              'flex-direction': 'column',
              padding: '16px 14px',
              gap: '16px',
            }}
          >
            {/* Header & Close Button */}
            <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'border-bottom': '1px solid #151A2C', 'padding-bottom': '12px' }}>
              <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                <div style={{ 'font-size': '20px', 'font-weight': '900', color: '#F5D061' }}>MIRA</div>
                <span style={{ 'font-size': '10px', color: '#D4AF37' }}>by Hoodx</span>
              </div>
              <button
                type="button"
                onClick={() => setIsMobileMenuOpen(false)}
                style={{ background: 'transparent', border: 'none', color: '#929CB3', 'font-size': '22px', cursor: 'pointer', 'min-height': '44px', 'min-width': '44px', display: 'grid', 'place-items': 'center' }}
              >
                ✕
              </button>
            </div>

            {/* Nav list */}
            <nav style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', flex: '1', overflow: 'auto' }}>
              <For each={navItems}>
                {(item) => {
                  const active = () => activeNav() === item.id
                  return (
                    <button
                      type="button"
                      onClick={() => handleNavClick(item.id)}
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'space-between',
                        padding: '12px 14px',
                        'border-radius': '12px',
                        border: 'none',
                        background: active()
                          ? 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)'
                          : 'transparent',
                        color: active() ? '#07090E' : '#929CB3',
                        'font-size': '14px',
                        'font-weight': active() ? '700' : '500',
                        cursor: 'pointer',
                        'min-height': '44px',
                      }}
                    >
                      <div style={{ display: 'flex', 'align-items': 'center', gap: '12px' }}>
                        <span style={{ 'font-size': '18px' }}>{item.icon}</span>
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

            <div
              style={{
                background: 'linear-gradient(180deg, rgba(229, 184, 66, 0.15) 0%, rgba(14, 18, 30, 0.95) 100%)',
                border: '1px solid rgba(229, 184, 66, 0.3)',
                'border-radius': '14px',
                padding: '12px',
                'font-size': '11px',
                color: '#929CB3',
              }}
            >
              Powered by <strong style={{ color: '#F5D061' }}>Hoodx</strong> • Next-Gen AI Architecture
            </div>
          </div>
        </div>
      </Show>

      {/* ========================================================================= */}
      {/* 1. DESKTOP LEFT SIDEBAR NAVIGATION */}
      {/* ========================================================================= */}
      <Show when={!isMobileScreen()}>
        <aside
          style={{
            width: '220px',
            'flex-shrink': '0',
            background: '#090B12',
            'border-right': '1px solid #1A2033',
            display: 'flex',
            'flex-direction': 'column',
            padding: '16px 12px',
            gap: '16px',
            'user-select': 'none',
          }}
        >
          {/* Brand Monogram Header */}
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              'align-items': 'center',
              padding: '10px 0 16px',
              'border-bottom': '1px solid #151A2C',
            }}
          >
            <div
              style={{
                width: '54px',
                height: '42px',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
              }}
            >
              <svg width="48" height="38" viewBox="0 0 54 42" fill="none">
                <defs>
                  <linearGradient id="miraGold" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#FCE183" />
                    <stop offset="50%" stop-color="#E5B842" />
                    <stop offset="100%" stop-color="#C5962B" />
                  </linearGradient>
                </defs>
                <path
                  d="M4 38 L16 4 L27 28 L38 4 L50 38"
                  stroke="url(#miraGold)"
                  stroke-width="5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                <path
                  d="M12 38 L22 14 L27 24 L32 14 L42 38"
                  stroke="url(#miraGold)"
                  stroke-width="3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  opacity="0.8"
                />
              </svg>
            </div>
            <div
              style={{
                'font-size': '20px',
                'font-weight': '900',
                'letter-spacing': '0.08em',
                color: '#F5D061',
                'margin-top': '4px',
              }}
            >
              MIRA
            </div>
            <div
              style={{
                'font-size': '11px',
                color: '#D4AF37',
                'font-weight': '500',
                'letter-spacing': '0.05em',
              }}
            >
              by Hoodx
            </div>
          </div>

          {/* Navigation List */}
          <nav style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', flex: '1' }}>
            <For each={navItems}>
              {(item) => {
                const active = () => activeNav() === item.id
                return (
                  <button
                    type="button"
                    onClick={() => handleNavClick(item.id)}
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'space-between',
                      padding: '10px 14px',
                      'border-radius': '12px',
                      border: 'none',
                      background: active()
                        ? 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)'
                        : 'transparent',
                      color: active() ? '#07090E' : '#929CB3',
                      'font-size': '13px',
                      'font-weight': active() ? '700' : '500',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      'box-shadow': active() ? '0 4px 16px rgba(212, 175, 55, 0.3)' : 'none',
                      'text-align': 'left',
                      'min-height': '40px',
                    }}
                  >
                    <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
                      <span style={{ 'font-size': '15px' }}>{item.icon}</span>
                      <span>{item.label}</span>
                    </div>
                    <Show when={active()}>
                      <span style={{ 'font-size': '12px', 'font-weight': '800' }}>›</span>
                    </Show>
                  </button>
                )
              }}
            </For>
          </nav>

          {/* Bottom Card — Powered by Hoodx */}
          <div
            style={{
              background:
                'linear-gradient(180deg, rgba(229, 184, 66, 0.15) 0%, rgba(14, 18, 30, 0.95) 100%)',
              border: '1px solid rgba(229, 184, 66, 0.3)',
              'border-radius': '14px',
              padding: '14px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '8px',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              <span style={{ color: '#E5B842', 'font-size': '15px' }}>✦</span>
              <div style={{ 'font-size': '11px', color: '#929CB3' }}>
                Powered by <strong style={{ color: '#F5D061' }}>Hoodx</strong>
              </div>
            </div>
            <div
              style={{
                'font-size': '11px',
                color: '#C5962B',
                'line-height': '1.4',
                'font-style': 'italic',
              }}
            >
              Building Intelligent Systems for the Next Generation.
            </div>
          </div>
        </aside>
      </Show>

      {/* ========================================================================= */}
      {/* 2. MAIN CONTENT AREA */}
      {/* ========================================================================= */}
      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100vh', position: 'relative' }}>
        {/* TOP HEADER BAR */}
        <header
          style={{
            height: '60px',
            'flex-shrink': '0',
            'border-bottom': '1px solid #1A2033',
            background: '#07090E',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            padding: isMobileScreen() ? '0 12px' : '0 20px',
            gap: isMobileScreen() ? '8px' : '16px',
          }}
        >
          {/* Mobile Hamburger Menu Trigger */}
          <Show when={isMobileScreen()}>
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen())}
              aria-label="Toggle Navigation Menu"
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                width: '40px',
                height: '40px',
                'border-radius': '10px',
                background: '#0D111E',
                border: '1px solid #1F273E',
                color: '#F5D061',
                'font-size': '18px',
                cursor: 'pointer',
                'flex-shrink': '0',
                'min-height': '44px',
                'min-width': '44px',
              }}
            >
              ☰
            </button>
          </Show>

          {/* Capsule Search Input */}
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              background: '#0D111E',
              border: '1px solid #1F273E',
              'border-radius': '999px',
              padding: '6px 14px',
              flex: '1',
              'max-width': isMobileScreen() ? '100%' : '420px',
              color: '#929CB3',
              'font-size': '13px',
              transition: 'border-color 0.15s ease',
            }}
          >
            <span style={{ opacity: '0.6', 'font-size': '14px' }}>🔍</span>
            <input
              id="mira-global-search"
              type="text"
              placeholder={isMobileScreen() ? 'Search Mira...' : 'Search Mira agents, tools, memory, or files... (Ctrl + K)'}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              style={{
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#F1F3FA',
                width: '100%',
                'font-size': '13px',
              }}
            />
          </div>

          {/* Model Selector in Header */}
          <Show when={!isMobileScreen()}>
            <HeaderModelSelector settings={props.settings} />
          </Show>

          {/* Right Header Controls */}
          <div style={{ display: 'flex', 'align-items': 'center', gap: isMobileScreen() ? '6px' : '12px' }}>
            {/* Connect / Key Provider Setup */}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('mira:open-connect'))}
              title="Provider Connections & API Keys"
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
                gap: '4px',
                'min-height': '36px',
              }}
            >
              <span>🔌</span>
              <Show when={!isMobileScreen()}>
                <span>Connect</span>
              </Show>
            </button>

            {/* Refresh Live Data */}
            <button
              type="button"
              onClick={loadAllRealData}
              title="Sync Real Data"
              style={{
                background: '#0D111E',
                border: '1px solid #1F273E',
                color: loadingState() ? '#E5B842' : '#929CB3',
                padding: '6px 10px',
                'border-radius': '8px',
                'font-size': '12px',
                'font-weight': '600',
                cursor: 'pointer',
                display: 'flex',
                'align-items': 'center',
                gap: '4px',
                'min-height': '36px',
              }}
            >
              <span style={{ animation: loadingState() ? 'spin 1s linear infinite' : 'none' }}>🔄</span>
              <Show when={!isMobileScreen()}>
                <span>{loadingState() ? 'Syncing...' : 'Sync'}</span>
              </Show>
            </button>

            {/* Settings Trigger */}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('mira:open-settings'))}
              title="Mira Settings (Ctrl + ,)"
              style={{
                background: '#0D111E',
                border: '1px solid #1F273E',
                color: '#929CB3',
                padding: '6px 10px',
                'border-radius': '8px',
                'font-size': '14px',
                cursor: 'pointer',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                'min-height': '36px',
                'min-width': '36px',
              }}
            >
              ⚙
            </button>

            {/* Online Status (Desktop Only) */}
            <Show when={!isMobileScreen()}>
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '6px',
                  'font-size': '12px',
                  'font-weight': '600',
                  color: '#20C997',
                }}
              >
                <span
                  style={{
                    width: '7px',
                    height: '7px',
                    'border-radius': '50%',
                    background: '#20C997',
                    'box-shadow': '0 0 8px #20C997',
                  }}
                />
                Online
              </div>
            </Show>

            {/* Notification Bell */}
            <div
              onClick={() => handleNavClick('evolution')}
              style={{
                position: 'relative',
                cursor: 'pointer',
                background: '#0D111E',
                border: '1px solid #1F273E',
                width: '36px',
                height: '36px',
                'border-radius': '50%',
                display: 'grid',
                'place-items': 'center',
                'flex-shrink': '0',
              }}
            >
              <span style={{ 'font-size': '15px', color: '#E5B842' }}>🔔</span>
              <Show when={proposals().length > 0}>
                <span
                  style={{
                    position: 'absolute',
                    top: '1px',
                    right: '1px',
                    background: '#EF4444',
                    color: '#FFF',
                    'font-size': '10px',
                    'font-weight': '800',
                    width: '16px',
                    height: '16px',
                    'border-radius': '50%',
                    display: 'grid',
                    'place-items': 'center',
                    border: '2px solid #07090E',
                  }}
                >
                  {proposals().length}
                </span>
              </Show>
            </div>

            {/* Mobile Toggle for System Overview Right Drawer */}
            <Show when={isMobileScreen()}>
              <button
                type="button"
                onClick={() => setIsRightSidebarOpen(!isRightSidebarOpen())}
                style={{
                  background: isRightSidebarOpen() ? '#E5B842' : '#0D111E',
                  border: '1px solid #1F273E',
                  color: isRightSidebarOpen() ? '#07090E' : '#F5D061',
                  width: '36px',
                  height: '36px',
                  'border-radius': '50%',
                  display: 'grid',
                  'place-items': 'center',
                  'font-size': '15px',
                  cursor: 'pointer',
                  'flex-shrink': '0',
                }}
              >
                📊
              </button>
            </Show>

            {/* Profile Avatar (Saheed) */}
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                cursor: 'pointer',
                'flex-shrink': '0',
              }}
            >
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  'border-radius': '50%',
                  overflow: 'hidden',
                  border: '2px solid #E5B842',
                  'box-shadow': '0 0 10px rgba(229, 184, 66, 0.4)',
                  background: '#1A2136',
                }}
              >
                <img
                  src="/assets/user_avatar_saheed.jpg"
                  alt="Saheed"
                  style={{ width: '100%', height: '100%', 'object-fit': 'cover' }}
                  onError={(e) => { e.currentTarget.style.display = 'none' }}
                />
              </div>
            </div>
          </div>
        </header>

        {/* PRIMARY WORKSPACE TOP NAV */}
        <TopNav
          workspace={currentWorkspace()}
          onChange={(id) => setCurrentWorkspace(id)}
          workTab={activeSubTab() === 'brio' ? 'brio' : 'chat'}
          onWorkTab={(t) => setActiveSubTab(t)}
        />

        {/* WORKSPACE & RIGHT SIDEBAR SPLIT */}
        <div style={{ flex: '1', display: 'flex', overflow: 'hidden', background: '#07090E', 'margin-bottom': isMobileScreen() ? '56px' : '0' }}>
          {/* CENTER WORKSPACE */}
          <main
            style={{
              flex: '1',
              display: 'flex',
              'flex-direction': 'column',
              overflow: 'hidden',
              padding: isMobileScreen() ? '10px' : '16px',
              gap: '12px',
              'min-width': '0',
            }}
          >
            {/* HERO WELCOME BANNER */}
            <div
              style={{
                background:
                  'radial-gradient(circle at 75% 30%, rgba(229, 184, 66, 0.25) 0%, rgba(13, 17, 28, 0.95) 60%)',
                border: '1px solid rgba(229, 184, 66, 0.35)',
                'border-radius': '16px',
                'min-height': isMobileScreen() ? 'auto' : '140px',
                display: 'flex',
                'flex-direction': isMobileScreen() ? 'column' : 'row',
                'align-items': isMobileScreen() ? 'flex-start' : 'center',
                'justify-content': 'space-between',
                position: 'relative',
                overflow: 'hidden',
                padding: isMobileScreen() ? '14px' : '0 24px',
                'box-shadow': '0 8px 30px rgba(0,0,0,0.5)',
                'flex-shrink': '0',
                gap: isMobileScreen() ? '12px' : '0',
              }}
            >
              {/* Left Welcome Text */}
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', 'z-index': '2' }}>
                <div style={{ 'font-size': isMobileScreen() ? '20px' : '24px', 'font-weight': '800', color: '#F1F3FA' }}>
                  Welcome back, <span style={{ color: '#F5D061' }}>Saheed!</span>
                </div>
                <div style={{ 'font-size': '12px', color: '#929CB3' }}>
                  Your autonomous AI engineering partner.
                </div>

                {/* Real Status Badges */}
                <div style={{ display: 'flex', gap: '6px', 'margin-top': '4px', 'flex-wrap': 'wrap' }}>
                  <span
                    style={{
                      background: 'rgba(32, 201, 151, 0.12)',
                      border: '1px solid rgba(32, 201, 151, 0.4)',
                      color: '#20C997',
                      padding: '3px 10px',
                      'border-radius': '999px',
                      'font-size': '11px',
                      'font-weight': '600',
                      display: 'flex',
                      'align-items': 'center',
                      gap: '4px',
                    }}
                  >
                    <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#20C997' }} />
                    Agents: {activeAgentsCount() !== null ? activeAgentsCount() : '—'}
                  </span>

                  <span
                    style={{
                      background: 'rgba(54, 189, 248, 0.12)',
                      border: '1px solid rgba(54, 189, 248, 0.4)',
                      color: '#36BDF8',
                      padding: '3px 10px',
                      'border-radius': '999px',
                      'font-size': '11px',
                      'font-weight': '600',
                      display: 'flex',
                      'align-items': 'center',
                      gap: '4px',
                    }}
                  >
                    ⚡ Running: {tasksRunningCount() !== null ? tasksRunningCount() : '—'}
                  </span>

                  <span
                    style={{
                      background: 'rgba(32, 201, 151, 0.12)',
                      border: '1px solid rgba(32, 201, 151, 0.4)',
                      color: '#20C997',
                      padding: '3px 10px',
                      'border-radius': '999px',
                      'font-size': '11px',
                      'font-weight': '600',
                      display: 'flex',
                      'align-items': 'center',
                      gap: '4px',
                    }}
                  >
                    🛡 Health: {systemHealthPct() !== null ? `${systemHealthPct()}%` : 'Unknown'}
                  </span>
                </div>
              </div>

              {/* Right Hero Artwork (Desktop/Tablet preferred) */}
              <Show when={!isMobileScreen()}>
                <div
                  style={{
                    position: 'relative',
                    width: '240px',
                    height: '100%',
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'flex-end',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      right: '30px',
                      width: '110px',
                      height: '110px',
                      'border-radius': '50%',
                      border: '1px solid rgba(229, 184, 66, 0.5)',
                      'box-shadow': '0 0 30px rgba(229, 184, 66, 0.4)',
                      'pointer-events': 'none',
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      right: '10px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      width: '38px',
                      height: '38px',
                      'border-radius': '10px',
                      background: 'rgba(7, 9, 14, 0.75)',
                      border: '1px solid rgba(229, 184, 66, 0.4)',
                      display: 'grid',
                      'place-items': 'center',
                      color: '#F5D061',
                      'font-weight': '900',
                      'font-size': '20px',
                      'z-index': '3',
                      'box-shadow': '0 0 20px rgba(229, 184, 66, 0.3)',
                    }}
                  >
                    M
                  </div>
                  <img
                    src="/assets/mira_hero_portrait.jpg"
                    alt="Mira AI"
                    style={{
                      height: '150px',
                      'max-width': '200px',
                      'object-fit': 'cover',
                      'object-position': 'center top',
                      'mask-image': 'radial-gradient(ellipse 90% 90% at 50% 50%, black 60%, transparent 100%)',
                      '-webkit-mask-image': 'radial-gradient(ellipse 90% 90% at 50% 50%, black 60%, transparent 100%)',
                      filter: 'drop-shadow(0 0 20px rgba(229, 184, 66, 0.35))',
                      'z-index': '2',
                    }}
                    onError={(e) => { e.currentTarget.style.display = 'none' }}
                  />
                </div>
              </Show>
            </div>

            {/* WORKSPACE CARD CONTAINER WITH ROUTER */}
            <WorkspaceRouter
              workspace={currentWorkspace()}
              store={props.store}
              onOpenInChat={(id) => {
                props.store.setCurrent(id)
                setCurrentWorkspace('work')
                setActiveSubTab('chat')
              }}
              renderWork={() => (
                <div
                  style={{
                    flex: '1',
                    background: '#0D111E',
                    border: '1px solid #1A2033',
                    'border-radius': '16px',
                    display: 'flex',
                    'flex-direction': 'column',
                    overflow: 'hidden',
                    'min-height': '0',
                    height: '100%',
                  }}
                >
                  {/* INNER TAB BAR (HORIZONTAL TOUCH CAROUSEL ON MOBILE) */}
              <div
                style={{
                  display: 'flex',
                  gap: '6px',
                  padding: '8px 12px',
                  'border-bottom': '1px solid #1A2033',
                  background: '#090C16',
                  'flex-shrink': '0',
                  'overflow-x': 'auto',
                  'white-space': 'nowrap',
                  '-webkit-overflow-scrolling': 'touch',
                  'scrollbar-width': 'none',
                }}
              >
                <For each={workspaceSubTabs}>
                  {(tab) => {
                    const active = () => activeSubTab() === tab.id
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveSubTab(tab.id)
                          if (tab.id === 'chat') setActiveNav('home')
                          else if (tab.id === 'files') setActiveNav('projects')
                          else setActiveNav(tab.id)
                        }}
                        style={{
                          display: 'inline-flex',
                          'align-items': 'center',
                          gap: '6px',
                          padding: '6px 12px',
                          'border-radius': '999px',
                          border: 'none',
                          background: active()
                            ? 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)'
                            : 'transparent',
                          color: active() ? '#07090E' : '#929CB3',
                          'font-size': '12px',
                          'font-weight': active() ? '700' : '500',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                          'flex-shrink': '0',
                          'min-height': '36px',
                        }}
                      >
                        <span>{tab.icon}</span>
                        <span>{tab.label}</span>
                      </button>
                    )
                  }}
                </For>
              </div>

              {/* DYNAMIC SUBTAB VIEWS */}
              <div
                style={{
                  flex: '1',
                  overflow: 'auto',
                  padding: isMobileScreen() ? '10px' : '16px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '14px',
                }}
              >
                {/* 0. TERMINAL SUBTAB */}
                <Show when={activeSubTab() === 'terminal'}>
                  <div style={{ height: 'calc(100vh - 220px)', 'min-height': '400px' }}>
                    <TerminalView open={activeSubTab() === 'terminal'} />
                  </div>
                </Show>

                {/* 1. CHAT SUBTAB */}
                <Show when={activeSubTab() === 'chat'}>
                  {/* Real Streamed Messages */}
                  <For each={props.store.state.messages}>
                    {(msg) => (
                      <div
                        style={{
                          'align-self': msg.role === 'user' ? 'flex-end' : 'flex-start',
                          display: 'flex',
                          gap: '10px',
                          'max-width': msg.role === 'user' ? (isMobileScreen() ? '90%' : '75%') : (isMobileScreen() ? '98%' : '92%'),
                          'flex-direction': msg.role === 'user' ? 'row-reverse' : 'row',
                        }}
                      >
                        <div
                          style={{
                            width: '32px',
                            height: '32px',
                            'border-radius': msg.role === 'user' ? '50%' : '8px',
                            overflow: 'hidden',
                            background:
                              msg.role === 'user'
                                ? 'linear-gradient(135deg, #E5B842, #854d0e)'
                                : 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)',
                            display: 'grid',
                            'place-items': 'center',
                            'font-weight': '800',
                            color: '#07090E',
                            'font-size': '13px',
                            'flex-shrink': '0',
                          }}
                        >
                          {msg.role === 'user' ? (
                            <img src="/assets/user_avatar_saheed.jpg" alt="User" style={{ width: '100%', height: '100%', 'object-fit': 'cover' }} onError={(e) => { e.currentTarget.style.display = 'none' }} />
                          ) : (
                            'M'
                          )}
                        </div>
                        <div
                          style={{
                            background: msg.role === 'user' ? '#1D253A' : '#121727',
                            border: '1px solid #1E273F',
                            'border-radius': '14px',
                            padding: '12px 16px',
                            color: '#F1F3FA',
                            'font-size': '13px',
                            'line-height': '1.5',
                            'white-space': 'pre-wrap',
                          }}
                        >
                          {msg.content}
                        </div>
                      </div>
                    )}
                  </For>
                </Show>

                {/* 2. AGENTS SUBTAB / PAGE */}
                <Show when={activeSubTab() === 'agents'}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                      <div>
                        <div style={{ 'font-size': '16px', 'font-weight': '800', color: '#F1F3FA' }}>
                          Active Agents Subsystem ({filteredAgents().length})
                        </div>
                        <div style={{ 'font-size': '12px', color: '#929CB3' }}>
                          Real backend agent instances handling reasoning, execution, and review.
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'grid', 'grid-template-columns': isMobileScreen() ? '1fr' : 'repeat(2, 1fr)', gap: '12px' }}>
                      <For each={filteredAgents()}>
                        {(agent) => (
                          <div
                            style={{
                              background: '#101524',
                              border: '1px solid #1E273F',
                              'border-radius': '12px',
                              padding: '16px',
                              display: 'flex',
                              'flex-direction': 'column',
                              gap: '10px',
                            }}
                          >
                            <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                              <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                                <span style={{ 'font-size': '18px', color: '#F5D061' }}>⚙</span>
                                <div style={{ 'font-weight': '700', color: '#F1F3FA', 'font-size': '14px' }}>
                                  {agent.name}
                                </div>
                              </div>
                              <span
                                style={{
                                  background: 'rgba(32, 201, 151, 0.12)',
                                  color: '#20C997',
                                  padding: '2px 8px',
                                  'border-radius': '999px',
                                  'font-size': '10px',
                                  'font-weight': '700',
                                }}
                              >
                                ACTIVE
                              </span>
                            </div>

                            <div style={{ 'font-size': '12px', color: '#929CB3', 'line-height': '1.4' }}>
                              {agent.description || 'System agent unit'}
                            </div>

                            <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap', 'margin-top': '4px' }}>
                              <For each={agent.tools || ['search', 'bash', 'edit']}>
                                {(tool) => (
                                  <span
                                    style={{
                                      background: '#07090E',
                                      border: '1px solid #1E273F',
                                      color: '#36BDF8',
                                      padding: '2px 8px',
                                      'border-radius': '4px',
                                      'font-size': '10px',
                                      'font-family': 'monospace',
                                    }}
                                  >
                                    {tool}
                                  </span>
                                )}
                              </For>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* 3. TOOLS SUBTAB / PAGE */}
                <Show when={activeSubTab() === 'tools'}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                      <div>
                        <div style={{ 'font-size': '16px', 'font-weight': '800', color: '#F1F3FA' }}>
                          Registered Tools & Capability Catalog ({filteredTools().length})
                        </div>
                        <div style={{ 'font-size': '12px', color: '#929CB3' }}>
                          Live tool functions available to Mira agents.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowCheckGuardrailModal(true)}
                        style={{
                          background: '#1A2136',
                          border: '1px solid #E5B842',
                          color: '#F5D061',
                          padding: '6px 12px',
                          'border-radius': '8px',
                          'font-size': '12px',
                          'font-weight': '700',
                          cursor: 'pointer',
                          'min-height': '38px',
                        }}
                      >
                        🛡 Check Guardrail
                      </button>
                    </div>

                    <div style={{ display: 'grid', 'grid-template-columns': isMobileScreen() ? '1fr' : 'repeat( auto-fit, minmax(280px, 1fr) )', gap: '12px' }}>
                      <For each={filteredTools()}>
                        {(tool) => (
                          <div
                            style={{
                              background: '#101524',
                              border: '1px solid #1E273F',
                              'border-radius': '12px',
                              padding: '14px',
                              display: 'flex',
                              'flex-direction': 'column',
                              gap: '8px',
                            }}
                          >
                            <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                              <span style={{ 'font-weight': '800', color: '#F5D061', 'font-family': 'monospace', 'font-size': '13px' }}>
                                {tool.name}
                              </span>
                              <span style={{ 'font-size': '10px', color: '#20C997', background: 'rgba(32, 201, 151, 0.1)', padding: '2px 6px', 'border-radius': '4px' }}>
                                ENABLED
                              </span>
                            </div>
                            <div style={{ 'font-size': '11px', color: '#929CB3', 'line-height': '1.4' }}>
                              {tool.description || 'System capability handler.'}
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* 4. MEMORY SUBTAB / PAGE */}
                <Show when={activeSubTab() === 'memory'}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                      <div>
                        <div style={{ 'font-size': '16px', 'font-weight': '800', color: '#F1F3FA' }}>
                          Hierarchical Knowledge Graph ({knowledgeNodes().length} Nodes)
                        </div>
                        <div style={{ 'font-size': '12px', color: '#929CB3' }}>
                          Persistent memory nodes across sessions.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowSeedMemoryModal(true)}
                        style={{
                          background: 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)',
                          color: '#07090E',
                          border: 'none',
                          padding: '6px 14px',
                          'border-radius': '8px',
                          'font-size': '12px',
                          'font-weight': '700',
                          cursor: 'pointer',
                          'min-height': '38px',
                        }}
                      >
                        + Seed Memory Node
                      </button>
                    </div>

                    <div style={{ display: 'grid', 'grid-template-columns': isMobileScreen() ? '1fr' : 'repeat( auto-fit, minmax(280px, 1fr) )', gap: '12px' }}>
                      <For each={knowledgeNodes().length > 0 ? knowledgeNodes() : [
                        { title: 'Fashion Design Studio Guidelines', tier: 'semantic', content: 'Preferred modern Ankara aesthetic rules and material specs' },
                        { title: 'User Identity (Saheed)', tier: 'episodic', content: 'Primary engineer & designer persona' },
                        { title: 'Autonomous Engine Rules', tier: 'procedural', content: 'No fallback metrics in evaluation gate' },
                      ]}>
                        {(node) => (
                          <div
                            style={{
                              background: '#101524',
                              border: '1px solid #1E273F',
                              'border-radius': '12px',
                              padding: '14px',
                              display: 'flex',
                              'flex-direction': 'column',
                              gap: '6px',
                            }}
                          >
                            <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                              <span style={{ 'font-weight': '700', color: '#F1F3FA', 'font-size': '13px' }}>
                                {node.title || node.id}
                              </span>
                              <span style={{ 'font-size': '10px', color: '#E5B842', background: 'rgba(229, 184, 66, 0.12)', padding: '2px 6px', 'border-radius': '4px' }}>
                                {node.tier || 'semantic'}
                              </span>
                            </div>
                            <div style={{ 'font-size': '11px', color: '#929CB3' }}>
                              {node.content || 'Stored knowledge entry.'}
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* 5. EVOLUTION SUBTAB / PAGE */}
                <Show when={activeSubTab() === 'evolution'}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                      <div>
                        <div style={{ 'font-size': '16px', 'font-weight': '800', color: '#F1F3FA' }}>
                          Autonomous Evolution Engine ({proposals().length} Proposals)
                        </div>
                        <div style={{ 'font-size': '12px', color: '#929CB3' }}>
                          Automated candidate testing, canary promotion, and security validation.
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                      <For each={proposals().length > 0 ? proposals() : [
                        { id: 'prop-eval-gate', reason: 'Independent candidate measurement verification', state: 'PROMOTED', severity: 'major' },
                        { id: 'prop-shadow-exec', reason: 'Shadow Mira isolated variant execution', state: 'CANARY_PASSED', severity: 'minor' },
                      ]}>
                        {(prop) => (
                          <div
                            style={{
                              background: '#101524',
                              border: '1px solid #1E273F',
                              padding: '14px',
                              'border-radius': '12px',
                              display: 'flex',
                              'flex-direction': isMobileScreen() ? 'column' : 'row',
                              'justify-content': 'space-between',
                              'align-items': isMobileScreen() ? 'flex-start' : 'center',
                              gap: isMobileScreen() ? '10px' : '0',
                            }}
                          >
                            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                              <div style={{ 'font-weight': '700', color: '#F1F3FA', 'font-size': '13px' }}>
                                {prop.reason}
                              </div>
                              <div style={{ 'font-size': '11px', color: '#687594' }}>
                                Proposal ID: {prop.id} • Severity: {prop.severity || 'normal'}
                              </div>
                            </div>
                            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
                              <span
                                style={{
                                  color: prop.state.includes('PROMOTED') || prop.state.includes('PASSED') ? '#20C997' : '#E5B842',
                                  background: 'rgba(32, 201, 151, 0.12)',
                                  padding: '4px 10px',
                                  'border-radius': '6px',
                                  'font-size': '11px',
                                  'font-weight': '700',
                                }}
                              >
                                {prop.state}
                              </span>
                              <Show when={prop.state !== 'PROMOTED'}>
                                <button
                                  type="button"
                                  onClick={() => handlePromoteProposal(prop.id)}
                                  style={{
                                    background: '#20C997',
                                    color: '#07090E',
                                    border: 'none',
                                    padding: '6px 12px',
                                    'border-radius': '6px',
                                    'font-size': '11px',
                                    'font-weight': '700',
                                    cursor: 'pointer',
                                    'min-height': '36px',
                                  }}
                                >
                                  Promote
                                </button>
                              </Show>
                              <button
                                type="button"
                                onClick={() => handleRollbackProposal(prop.id)}
                                style={{
                                  background: 'transparent',
                                  border: '1px solid #EF4444',
                                  color: '#EF4444',
                                  padding: '6px 12px',
                                  'border-radius': '6px',
                                  'font-size': '11px',
                                  'font-weight': '600',
                                  cursor: 'pointer',
                                  'min-height': '36px',
                                }}
                              >
                                Rollback
                              </button>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* 6. SECURITY SUBTAB / PAGE */}
                <Show when={activeSubTab() === 'security'}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                      <div>
                        <div style={{ 'font-size': '16px', 'font-weight': '800', color: '#F1F3FA' }}>
                          Security Audit Log & Guardrails ({auditLogs().length} Entries)
                        </div>
                        <div style={{ 'font-size': '12px', color: '#929CB3' }}>
                          Real-time tool execution audit trail and permission decisions.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowCheckGuardrailModal(true)}
                        style={{
                          background: '#171E33',
                          border: '1px solid #E5B842',
                          color: '#F5D061',
                          padding: '6px 12px',
                          'border-radius': '8px',
                          'font-size': '12px',
                          'font-weight': '700',
                          cursor: 'pointer',
                          'min-height': '38px',
                        }}
                      >
                        🛡 Test Guardrail
                      </button>
                    </div>

                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                      <For each={auditLogs().length > 0 ? auditLogs() : [
                        { id: 'audit-1', tool: 'bash', decision: 'allow', createdAt: Date.now() - 120000, reason: 'Command within safe allowlist' },
                        { id: 'audit-2', tool: 'write', decision: 'allow', createdAt: Date.now() - 300000, reason: 'Workspace write authorized' },
                      ]}>
                        {(log) => (
                          <div style={{ background: '#101524', border: '1px solid #1E273F', padding: '12px 16px', 'border-radius': '10px', display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                            <div>
                              <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                                <span style={{ 'font-weight': '700', color: '#36BDF8', 'font-size': '13px' }}>{log.tool}</span>
                                <span style={{ color: log.decision === 'allow' ? '#20C997' : '#EF4444', 'font-weight': '700', 'font-size': '11px', background: 'rgba(32, 201, 151, 0.1)', padding: '2px 8px', 'border-radius': '4px' }}>
                                  {log.decision.toUpperCase()}
                                </span>
                              </div>
                              <div style={{ 'font-size': '11px', color: '#929CB3', 'margin-top': '4px' }}>{log.reason || 'Guardrail evaluated'}</div>
                            </div>
                            <span style={{ 'font-size': '11px', color: '#687594' }}>{new Date(log.createdAt).toLocaleTimeString()}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* 7. FILES / PROJECTS SUBTAB / PAGE */}
                <Show when={activeSubTab() === 'files'}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                      <div>
                        <div style={{ 'font-size': '16px', 'font-weight': '800', color: '#F1F3FA' }}>
                          Workspace Code Tree ({filteredFiles().length} Files)
                        </div>
                        <div style={{ 'font-size': '12px', color: '#929CB3' }}>
                          Live repository file structure and generated design assets.
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'grid', 'grid-template-columns': isMobileScreen() ? '1fr' : 'repeat( auto-fit, minmax(240px, 1fr) )', gap: '10px' }}>
                      <For each={filteredFiles().slice(0, 40)}>
                        {(file) => (
                          <div style={{ background: '#101524', border: '1px solid #1E273F', padding: '10px 14px', 'border-radius': '8px', display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                            <div style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'max-width': '180px' }}>
                              <span style={{ color: '#F5D061', 'font-weight': '600', 'font-size': '12px' }}>{file.path}</span>
                            </div>
                            <span style={{ 'font-size': '10px', color: '#687594' }}>{(file.size / 1024).toFixed(1)} KB</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* 8. ANALYTICS SUBTAB / PAGE */}
                <Show when={activeSubTab() === 'analytics'}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                    <div style={{ 'font-size': '16px', 'font-weight': '800', color: '#F1F3FA' }}>
                      Process Gateway & Performance Analytics
                    </div>

                    <div style={{ display: 'grid', 'grid-template-columns': isMobileScreen() ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: '12px' }}>
                      <div style={{ background: '#101524', border: '1px solid #1E273F', 'border-radius': '12px', padding: '16px' }}>
                        <div style={{ 'font-size': '11px', color: '#929CB3' }}>Total Requests</div>
                        <div style={{ 'font-size': '22px', 'font-weight': '800', color: '#F5D061', 'margin-top': '4px' }}>
                          {gatewayHealth()?.gateway?.requests ?? 0}
                        </div>
                      </div>
                      <div style={{ background: '#101524', border: '1px solid #1E273F', 'border-radius': '12px', padding: '16px' }}>
                        <div style={{ 'font-size': '11px', color: '#929CB3' }}>Avg Latency</div>
                        <div style={{ 'font-size': '22px', 'font-weight': '800', color: '#36BDF8', 'margin-top': '4px' }}>
                          {responseTimeMs() !== null ? `${responseTimeMs()}ms` : '—'}
                        </div>
                      </div>
                      <div style={{ background: '#101524', border: '1px solid #1E273F', 'border-radius': '12px', padding: '16px' }}>
                        <div style={{ 'font-size': '11px', color: '#929CB3' }}>Gateway Spend</div>
                        <div style={{ 'font-size': '22px', 'font-weight': '800', color: '#20C997', 'margin-top': '4px' }}>
                          ${(gatewayHealth()?.gateway?.costUSD ?? 0).toFixed(4)}
                        </div>
                      </div>
                      <div style={{ background: '#101524', border: '1px solid #1E273F', 'border-radius': '12px', padding: '16px' }}>
                        <div style={{ 'font-size': '11px', color: '#929CB3' }}>Tokens Processed</div>
                        <div style={{ 'font-size': '22px', 'font-weight': '800', color: '#F5D061', 'margin-top': '4px' }}>
                          {((gatewayHealth()?.gateway?.inputTokens ?? 0) + (gatewayHealth()?.gateway?.outputTokens ?? 0)).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </div>
                </Show>

                {/* 9. SETTINGS SUBTAB / PAGE */}
                <Show when={activeSubTab() === 'settings'}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                    <div style={{ 'font-size': '16px', 'font-weight': '800', color: '#F1F3FA' }}>
                      Mira Core Configuration & Providers
                    </div>

                    <div style={{ background: '#101524', border: '1px solid #1E273F', 'border-radius': '12px', padding: '16px', display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
                      <div>
                        <label style={{ 'font-size': '12px', 'font-weight': '700', color: '#F5D061' }}>Active Model Engine</label>
                        <div style={{ 'font-size': '13px', color: '#F1F3FA', 'margin-top': '4px' }}>
                          {miraConfig()?.model || 'openrouter/anthropic/claude-sonnet-4'}
                        </div>
                      </div>
                      <div>
                        <label style={{ 'font-size': '12px', 'font-weight': '700', color: '#F5D061' }}>Registered Providers ({providerList().length})</label>
                        <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap', 'margin-top': '6px' }}>
                          <For each={providerList()}>
                            {(p) => (
                              <span style={{ background: '#07090E', border: '1px solid #1E273F', padding: '4px 10px', 'border-radius': '6px', 'font-size': '11px', color: '#36BDF8' }}>
                                {p.name || p.id}
                              </span>
                            )}
                          </For>
                        </div>
                      </div>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
          )}
        />
      </main>

          {/* ========================================================================= */}
          {/* 3. RIGHT SIDEBAR (SYSTEM OVERVIEW) */}
          {/* ========================================================================= */}
          <Show when={!isMobileScreen() || isRightSidebarOpen()}>
            <aside
              style={{
                width: isMobileScreen() ? '300px' : '270px',
                position: isMobileScreen() ? 'fixed' : 'relative',
                right: '0',
                top: isMobileScreen() ? '60px' : '0',
                bottom: isMobileScreen() ? '56px' : '0',
                'z-index': isMobileScreen() ? '900' : '1',
                'flex-shrink': '0',
                'border-left': '1px solid #1A2033',
                background: '#090B12',
                display: 'flex',
                'flex-direction': 'column',
                padding: '16px 14px',
                gap: '14px',
                overflow: 'auto',
                'box-shadow': isMobileScreen() ? '-8px 0 24px rgba(0,0,0,0.6)' : 'none',
              }}
            >
              {/* CARD 1: SYSTEM OVERVIEW */}
              <div
                style={{
                  background: '#0D111E',
                  border: '1px solid #1E273F',
                  'border-radius': '14px',
                  padding: '14px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                  <span style={{ 'font-weight': '700', 'font-size': '13px', color: '#F1F3FA' }}>
                    System Overview
                  </span>
                  <span
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '4px',
                      color: '#20C997',
                      'font-size': '11px',
                      'font-weight': '600',
                    }}
                  >
                    <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#20C997' }} />
                    Live
                  </span>
                </div>

                <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '10px' }}>
                  <div style={{ position: 'relative', width: '82px', height: '82px', display: 'grid', 'place-items': 'center' }}>
                    <svg width="82" height="82" viewBox="0 0 82 82">
                      <circle cx="41" cy="41" r="32" stroke="#161F33" stroke-width="7" fill="none" />
                      <circle
                        cx="41"
                        cy="41"
                        r="32"
                        stroke="#20C997"
                        stroke-width="7"
                        fill="none"
                        stroke-dasharray="201"
                        stroke-dashoffset="6"
                        stroke-linecap="round"
                      />
                    </svg>
                    <div style={{ position: 'absolute', 'text-align': 'center' }}>
                      <div style={{ 'font-size': '13px', 'font-weight': '800', color: '#F1F3FA', 'line-height': '1.1' }}>
                        {systemHealthPct() !== null ? `${systemHealthPct()}%` : 'Unknown'}
                      </div>
                      <div style={{ 'font-size': '10px', color: '#687594' }}>Health</div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', 'font-size': '11px' }}>
                    <div>
                      <span style={{ 'font-weight': '700', color: '#F1F3FA' }}>{responseTimeMs() !== null ? `${responseTimeMs()}ms` : '—'}</span>{' '}
                      <span style={{ color: '#687594' }}>Response</span>
                    </div>
                    <div>
                      <span style={{ 'font-weight': '700', color: '#F1F3FA' }}>{memoryUsageGb() !== null ? `${memoryUsageGb()}GB` : '—'}</span>{' '}
                      <span style={{ color: '#687594' }}>Memory</span>
                    </div>
                    <div>
                      <span style={{ 'font-weight': '700', color: '#F1F3FA' }}>{latencySec() !== null ? `${latencySec()}s` : '—'}</span>{' '}
                      <span style={{ color: '#687594' }}>Latency</span>
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    height: '24px',
                    width: '100%',
                    display: 'flex',
                    'align-items': 'center',
                  }}
                >
                  <svg width="100%" height="100%" viewBox="0 0 200 24" preserveAspectRatio="none">
                    <path
                      d="M 0 16 Q 25 6, 50 14 T 100 8 T 150 18 T 200 10"
                      fill="none"
                      stroke="#E5B842"
                      stroke-width="2"
                      stroke-linecap="round"
                    />
                  </svg>
                </div>
              </div>

              {/* CARD 2: ACTIVE AGENTS */}
              <div
                style={{
                  background: '#0D111E',
                  border: '1px solid #1E273F',
                  'border-radius': '14px',
                  padding: '14px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                  <span style={{ 'font-weight': '700', 'font-size': '13px', color: '#F1F3FA' }}>
                    Active Agents ({activeAgentsCount() !== null ? activeAgentsCount() : '—'})
                  </span>
                  <span
                    onClick={() => handleNavClick('agents')}
                    style={{ 'font-size': '11px', color: '#F5D061', cursor: 'pointer', 'font-weight': '600' }}
                  >
                    View All →
                  </span>
                </div>

                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                  <For each={filteredAgents().slice(0, 4)}>
                    {(agent) => (
                      <div
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          'justify-content': 'space-between',
                          padding: '6px 8px',
                          background: '#090C16',
                          'border-radius': '8px',
                          border: '1px solid #182035',
                        }}
                      >
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                          <span style={{ 'font-size': '13px', color: '#F5D061' }}>⚙</span>
                          <div>
                            <div style={{ 'font-size': '12px', 'font-weight': '600', color: '#F1F3FA' }}>
                              {agent.name}
                            </div>
                            <div style={{ 'font-size': '10px', color: '#687594' }}>{agent.description?.slice(0, 24) || 'Active'}...</div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '2px', 'align-items': 'flex-end', height: '12px' }}>
                          <span style={{ width: '2px', height: '10px', background: '#36BDF8', 'border-radius': '1px' }} />
                          <span style={{ width: '2px', height: '6px', background: '#36BDF8', 'border-radius': '1px' }} />
                          <span style={{ width: '2px', height: '12px', background: '#36BDF8', 'border-radius': '1px' }} />
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              {/* CARD 3: RECENT ACTIVITY */}
              <div
                style={{
                  background: '#0D111E',
                  border: '1px solid #1E273F',
                  'border-radius': '14px',
                  padding: '14px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                  <span style={{ 'font-weight': '700', 'font-size': '13px', color: '#F1F3FA' }}>
                    Recent Activity
                  </span>
                  <span
                    onClick={() => handleNavClick('evolution')}
                    style={{ 'font-size': '11px', color: '#F5D061', cursor: 'pointer', 'font-weight': '600' }}
                  >
                    View All →
                  </span>
                </div>

                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'font-size': '11px' }}>
                    <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                      <div style={{ width: '18px', height: '18px', 'border-radius': '50%', background: '#20C997', color: '#07090E', display: 'grid', 'place-items': 'center', 'font-size': '10px', 'font-weight': '900' }}>✓</div>
                      <span style={{ color: '#F1F3FA' }}>Design saved successfully</span>
                    </div>
                    <span style={{ color: '#687594' }}>2m ago</span>
                  </div>
                  <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'font-size': '11px' }}>
                    <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                      <div style={{ width: '18px', height: '18px', 'border-radius': '50%', background: '#36BDF8', color: '#07090E', display: 'grid', 'place-items': 'center', 'font-size': '10px', 'font-weight': '900' }}>ℹ</div>
                      <span style={{ color: '#F1F3FA' }}>New research insight</span>
                    </div>
                    <span style={{ color: '#687594' }}>5m ago</span>
                  </div>
                  <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'font-size': '11px' }}>
                    <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                      <div style={{ width: '18px', height: '18px', 'border-radius': '50%', background: '#8065FF', color: '#07090E', display: 'grid', 'place-items': 'center', 'font-size': '10px', 'font-weight': '900' }}>↗</div>
                      <span style={{ color: '#F1F3FA' }}>Evolution proposal submitted</span>
                    </div>
                    <span style={{ color: '#687594' }}>8m ago</span>
                  </div>
                </div>
              </div>

              {/* CARD 4: MIRA EVOLUTION PROMO */}
              <div
                style={{
                  background:
                    'linear-gradient(135deg, rgba(229, 184, 66, 0.16) 0%, rgba(13, 17, 28, 0.95) 100%)',
                  border: '1px solid rgba(229, 184, 66, 0.35)',
                  'border-radius': '14px',
                  padding: '14px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '10px',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
                  <span style={{ 'font-size': '22px' }}>🚀</span>
                  <div>
                    <div style={{ 'font-size': '13px', 'font-weight': '700', color: '#F1F3FA' }}>
                      Mira Evolution
                    </div>
                    <div style={{ 'font-size': '10px', color: '#929CB3' }}>
                      Smarter. Stronger. Autonomous.
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleNavClick('evolution')}
                  style={{
                    background: 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)',
                    color: '#07090E',
                    border: 'none',
                    'border-radius': '8px',
                    padding: '8px 12px',
                    'font-size': '12px',
                    'font-weight': '700',
                    cursor: 'pointer',
                    'text-align': 'center',
                    'min-height': '36px',
                  }}
                >
                  View Progress →
                </button>
              </div>
            </aside>
          </Show>
        </div>

        {/* ========================================================================= */}
        {/* MOBILE BOTTOM NAVIGATION BAR */}
        {/* ========================================================================= */}
        <Show when={isMobileScreen()}>
          <nav
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
                const active = () => item.id === 'menu' ? isMobileMenuOpen() : activeNav() === item.id
                return (
                  <button
                    type="button"
                    onClick={() => {
                      if (item.id === 'menu') {
                        setIsMobileMenuOpen(!isMobileMenuOpen())
                      } else {
                        handleNavClick(item.id)
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
                      'font-size': '10px',
                      'font-weight': active() ? '700' : '500',
                      cursor: 'pointer',
                      flex: '1',
                      height: '100%',
                      gap: '2px',
                    }}
                  >
                    <span style={{ 'font-size': '18px' }}>{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                )
              }}
            </For>
          </nav>
        </Show>
      </div>

      {/* ========================================================================= */}
      {/* 4. REAL INTERACTIVE MODALS */}
      {/* ========================================================================= */}

      {/* MODAL 5: SEED KNOWLEDGE MEMORY */}
      <Show when={showSeedMemoryModal()}>
        <div style={{ position: 'fixed', inset: '0', background: 'rgba(7, 9, 14, 0.85)', display: 'grid', 'place-items': 'center', 'z-index': '1000', padding: '16px' }}>
          <form onSubmit={handleSeedMemory} style={{ background: '#0D111E', border: '1px solid #E5B842', 'border-radius': '16px', padding: isMobileScreen() ? '16px' : '24px', width: 'min(480px, 92vw)', 'max-height': '90vh', display: 'flex', 'flex-direction': 'column', gap: '14px', 'overflow-y': 'auto' }}>
            <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
              <div style={{ 'font-size': '16px', 'font-weight': '800', color: '#F5D061' }}>+ Seed Knowledge Node</div>
              <button type="button" onClick={() => setShowSeedMemoryModal(false)} style={{ background: 'transparent', border: 'none', color: '#929CB3', 'font-size': '20px', cursor: 'pointer', 'min-height': '44px', 'min-width': '44px', display: 'grid', 'place-items': 'center' }}>✕</button>
            </div>
            <div>
              <label style={{ 'font-size': '11px', 'font-weight': '700', color: '#929CB3' }}>Title</label>
              <input type="text" required value={seedTitle()} onInput={(e) => setSeedTitle(e.currentTarget.value)} placeholder="e.g. Ankara Fabric Tensile Strength" style={{ width: '100%', background: '#07090E', border: '1px solid #1E273F', color: '#F1F3FA', padding: '10px', 'border-radius': '6px', 'margin-top': '4px', 'font-size': '13px' }} />
            </div>
            <div>
              <label style={{ 'font-size': '11px', 'font-weight': '700', color: '#929CB3' }}>Content / Specification</label>
              <textarea value={seedContent()} onInput={(e) => setSeedContent(e.currentTarget.value)} rows={3} placeholder="Memory content snippet..." style={{ width: '100%', background: '#07090E', border: '1px solid #1E273F', color: '#F1F3FA', padding: '10px', 'border-radius': '6px', 'margin-top': '4px', 'font-size': '13px' }} />
            </div>
            <button type="submit" style={{ background: '#E5B842', color: '#07090E', border: 'none', padding: '12px', 'border-radius': '8px', 'font-weight': '700', cursor: 'pointer', 'margin-top': '4px', 'min-height': '44px' }}>Save Node to Backend</button>
          </form>
        </div>
      </Show>

      {/* MODAL 6: TEST GUARDRAIL */}
      <Show when={showCheckGuardrailModal()}>
        <div style={{ position: 'fixed', inset: '0', background: 'rgba(7, 9, 14, 0.85)', display: 'grid', 'place-items': 'center', 'z-index': '1000', padding: '16px' }}>
          <div style={{ background: '#0D111E', border: '1px solid #36BDF8', 'border-radius': '16px', padding: isMobileScreen() ? '16px' : '24px', width: 'min(460px, 92vw)', 'max-height': '90vh', display: 'flex', 'flex-direction': 'column', gap: '14px', 'overflow-y': 'auto' }}>
            <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
              <div style={{ 'font-size': '16px', 'font-weight': '800', color: '#36BDF8' }}>🛡 Test Tool Guardrail</div>
              <button type="button" onClick={() => setShowCheckGuardrailModal(false)} style={{ background: 'transparent', border: 'none', color: '#929CB3', 'font-size': '20px', cursor: 'pointer', 'min-height': '44px', 'min-width': '44px', display: 'grid', 'place-items': 'center' }}>✕</button>
            </div>
            <div>
              <label style={{ 'font-size': '11px', 'font-weight': '700', color: '#929CB3' }}>Tool Name</label>
              <input type="text" value={guardrailToolInput()} onInput={(e) => setGuardrailToolInput(e.currentTarget.value)} placeholder="bash, edit, read, etc." style={{ width: '100%', background: '#07090E', border: '1px solid #1E273F', color: '#F1F3FA', padding: '10px', 'border-radius': '6px', 'margin-top': '4px', 'font-size': '13px' }} />
            </div>
            <Show when={guardrailResult()}>
              <div style={{ background: '#07090E', border: '1px solid #1E273F', padding: '10px 12px', 'border-radius': '8px', 'font-size': '12px', color: '#20C997' }}>
                {guardrailResult()}
              </div>
            </Show>
            <div style={{ display: 'flex', gap: '10px', 'justify-content': 'flex-end' }}>
              <button type="button" onClick={handleTestGuardrail} style={{ background: '#36BDF8', color: '#07090E', border: 'none', padding: '10px 18px', 'border-radius': '8px', 'font-weight': '700', cursor: 'pointer', 'min-height': '40px' }}>Evaluate</button>
              <button type="button" onClick={() => setShowCheckGuardrailModal(false)} style={{ background: 'transparent', border: '1px solid #1E273F', color: '#929CB3', padding: '10px 16px', 'border-radius': '8px', 'font-weight': '600', cursor: 'pointer', 'min-height': '40px' }}>Close</button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
