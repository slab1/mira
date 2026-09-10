/**
 * Mira Settings Store — TUI port of web/src/stores/settings.ts
 *
 * Wires to backend:
 *   GET /config, PATCH /config, GET /config/schema,
 *   GET /providers, GET /mcp, GET /commands, GET /skills,
 *   GET /agents, GET /permission
 *
 * Gracefully handles missing endpoints (404) — every fetch is try/catch
 * with empty fallbacks so the UI never dead-ends when the server is older.
 */

import { createStore } from 'solid-js/store'
import { createSignal, onCleanup } from 'solid-js'
import {
  rpc,
  ApiError,
  type MiraConfig,
  type ProviderEntry,
  type MCPServerEntry,
  type AgentEntry,
} from '../rpc/client'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type ConfigSchema = {
  properties?: Record<
    string,
    { type: string; description?: string; default?: unknown; enum?: string[] }
  >
  required?: string[]
}
export type CommandEntry = {
  name: string
  description: string
  content?: string
  source: 'command' | 'skill'
}
export type SkillEntry = { name: string; description: string }
export type PermissionMatrix = Record<string, string | Record<string, string>>
export type ProviderConfig = {
  name: string
  options: { baseURL: string; apiKey: string }
  models: Record<string, { name: string; limit: { context: number; output: number } }>
}

// ── Theme ──────────────────────────────────────────────────────────

const THEME_KEY = 'mira_theme'

function getInitialTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v as ThemeChoice
  } catch {}
  return 'system'
}

function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches)
    return 'light'
  return 'dark'
}

function applyTheme(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(choice)
  document.documentElement.setAttribute('data-theme', resolved)
  try {
    localStorage.setItem(THEME_KEY, choice)
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────────

function maskKey(key: string): string {
  if (!key) return '— not set —'
  if (key.length <= 8) return '••••' + key.slice(-2)
  return key.slice(0, 3) + '••••' + key.slice(-4)
}

function normalizeProviders(
  raw: ProviderEntry[] | Record<string, ProviderConfig> | null,
): ProviderEntry[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  return Object.entries(raw).map(([id, cfg]) => ({
    id,
    name: cfg.name || id,
    maskedKey: cfg.options?.apiKey ? maskKey(cfg.options.apiKey) : '— not set —',
    baseURL: cfg.options?.baseURL,
    status: cfg.options?.apiKey ? 'ok' : 'unknown',
    models: Object.keys(cfg.models ?? {}),
  }))
}

function normalizeCommands(raw: CommandEntry[] | string[] | null): CommandEntry[] {
  if (!raw || !Array.isArray(raw)) return []
  if (raw.length === 0) return []
  if (typeof raw[0] === 'string') {
    return (raw as string[]).map((name) => ({
      name: name.startsWith('/') ? name : `/${name}`,
      description: '',
      source: 'command' as const,
    }))
  }
  return raw as CommandEntry[]
}

function normalizeSkills(raw: SkillEntry[] | string[] | null): SkillEntry[] {
  if (!raw || !Array.isArray(raw)) return []
  if (raw.length === 0) return []
  if (typeof raw[0] === 'string') {
    return (raw as string[]).map((name) => ({ name, description: '' }))
  }
  return raw as SkillEntry[]
}

// ── State ──────────────────────────────────────────────────────────

export type SettingsState = {
  config: MiraConfig | null
  schema: ConfigSchema | null
  providers: ProviderEntry[]
  mcp: MCPServerEntry[]
  agents: AgentEntry[]
  commands: CommandEntry[]
  skills: SkillEntry[]
  permission: PermissionMatrix | null
  loading: boolean
  error: string | null
  theme: ThemeChoice
  resolvedTheme: 'light' | 'dark'
}

export function createSettingsStore() {
  const [state, setState] = createStore<SettingsState>({
    config: null,
    schema: null,
    providers: [],
    mcp: [],
    agents: [],
    commands: [],
    skills: [],
    permission: null,
    loading: false,
    error: null,
    theme: getInitialTheme(),
    resolvedTheme: resolveTheme(getInitialTheme()),
  })

  const [saving, setSaving] = createSignal(false)

  if (typeof window !== 'undefined') {
    applyTheme(state.theme)
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => {
      if (state.theme === 'system') {
        const r = resolveTheme('system')
        document.documentElement.setAttribute('data-theme', r)
        setState('resolvedTheme', r)
      }
    }
    try {
      mq.addEventListener('change', onChange)
      onCleanup(() => mq.removeEventListener('change', onChange))
    } catch {
      const legacy = mq as unknown as {
        addListener: (cb: () => void) => void
        removeListener: (cb: () => void) => void
      }
      legacy.addListener(onChange)
      onCleanup(() => legacy.removeListener(onChange))
    }
  }

  function setTheme(choice: ThemeChoice): void {
    setState({ theme: choice, resolvedTheme: resolveTheme(choice) })
    applyTheme(choice)
  }

  async function loadConfig(cwd?: string): Promise<void> {
    try {
      const cfg = await rpc.getConfig(cwd)
      setState('config', cfg)
    } catch (e) {
      const msg = String((e as Error).message)
      if (e instanceof ApiError && e.status === 401) return
      if (msg.includes('401') || msg.includes('unauthorized')) return
      if (!msg.includes('404')) setState('error', (e as Error).message)
    }
  }

  async function loadWorkspaceTree(cwd?: string): Promise<string[]> {
    try {
      return await rpc.getWorkspaceTree(cwd)
    } catch {
      return []
    }
  }

  async function loadSchema(): Promise<void> {
    try {
      const s = await rpc.getConfigSchema()
      setState('schema', s as ConfigSchema)
    } catch {
      // optional
    }
  }

  async function loadProviders(): Promise<void> {
    try {
      const raw = await rpc.listProviders()
      setState(
        'providers',
        normalizeProviders(raw as ProviderEntry[] | Record<string, ProviderConfig>),
      )
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return
      if (String((e as Error).message).includes('401')) return
      if (state.config?.provider) {
        setState(
          'providers',
          normalizeProviders(state.config.provider as unknown as Record<string, ProviderConfig>),
        )
      }
    }
  }

  async function loadMcp(): Promise<void> {
    try {
      const list = await rpc.listMcp()
      setState('mcp', list)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setState('mcp', [])
        return
      }
      if (String((e as Error).message).includes('401')) {
        setState('mcp', [])
        return
      }
      if (!String((e as Error).message).includes('404')) setState('error', (e as Error).message)
      setState('mcp', [])
    }
  }

  async function loadAgents(): Promise<void> {
    try {
      const list = await rpc.listAgents()
      setState('agents', list)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setState('agents', [])
        return
      }
      setState('agents', [])
    }
  }

  async function loadCommands(): Promise<void> {
    try {
      const raw = await rpc.listCommands()
      setState('commands', normalizeCommands(raw as unknown as CommandEntry[] | string[]))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setState('commands', [])
        return
      }
      setState('commands', [])
    }
  }

  async function loadSkills(): Promise<void> {
    try {
      const raw = await rpc.listSkills()
      setState('skills', normalizeSkills(raw as unknown as SkillEntry[] | string[]))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setState('skills', [])
        return
      }
      setState('skills', [])
    }
  }

  async function loadPermission(cwd?: string): Promise<void> {
    try {
      const perm = await rpc.getPermission(cwd)
      setState('permission', perm as PermissionMatrix)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return
      if (String((e as Error).message).includes('401')) return
      if (state.config?.permission)
        setState('permission', state.config.permission as PermissionMatrix)
      else setState('permission', null)
    }
  }

  async function loadAll(cwd?: string): Promise<void> {
    setState({ loading: true, error: null })
    await Promise.all([
      loadConfig(cwd),
      loadSchema(),
      loadMcp(),
      loadAgents(),
      loadCommands(),
      loadSkills(),
    ])
    await Promise.all([loadProviders(), loadPermission(cwd)])
    if (cwd) await loadWorkspaceTree(cwd)
    setState('loading', false)
  }

  async function saveConfig(
    patch: Partial<MiraConfig>,
    cwd?: string,
  ): Promise<MiraConfig | null> {
    setSaving(true)
    setState('error', null)
    try {
      const updated = await rpc.patchConfig(patch, cwd)
      setState('config', updated)
      return updated
    } catch (e) {
      setState('error', (e as Error).message)
      return null
    } finally {
      setSaving(false)
    }
  }

  async function patchConfigField(
    key: string,
    value: string | number | boolean | null,
  ): Promise<MiraConfig | null> {
    if (!key.includes('.')) return saveConfig({ [key]: value } as Partial<MiraConfig>)
    const parts = key.split('.')
    const top = parts[0]
    if (parts.length === 2) {
      const sub = parts[1]
      const current =
        (state.config?.[top as keyof MiraConfig] as Record<string, string | number | boolean>) ?? {}
      return saveConfig({ [top]: { ...current, [sub]: value } } as Partial<MiraConfig>)
    }
    if (parts.length === 3 && top === 'mcp') {
      const server = parts[1]
      const field = parts[2]
      const mcp: Record<string, Record<string, unknown>> = {
        ...(state.config?.mcp ?? {}),
      } as Record<string, Record<string, unknown>>
      const srv: Record<string, unknown> = {
        ...(mcp[server] ?? { type: 'local' as const, enabled: true }),
      }
      srv[field] = value as string | number | boolean
      mcp[server] = srv as unknown as MiraConfig['mcp'][string]
      return saveConfig({ mcp: mcp as unknown as MiraConfig['mcp'] } as Partial<MiraConfig>)
    }
    return saveConfig({ [key]: value } as Partial<MiraConfig>)
  }

  async function testProvider(
    id: string,
  ): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    try {
      return await rpc.testProvider(id)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  async function removeProvider(id: string): Promise<boolean> {
    try {
      await rpc.removeProvider(id)
      setState('providers', (prev) => prev.filter((p) => p.id !== id))
      if (state.config?.provider?.[id]) {
        const next = { ...state.config.provider }
        delete next[id]
        setState('config', (prev) => (prev ? { ...prev, provider: next } : prev))
      }
      return true
    } catch (e) {
      setState('error', (e as Error).message)
      return false
    }
  }

  async function addMcp(body: {
    name: string
    type: 'local' | 'remote'
    command?: string[]
    url?: string
    enabled?: boolean
    env?: Record<string, string>
    headers?: Record<string, string>
  }): Promise<MCPServerEntry | null> {
    try {
      const created = await rpc.addMcp(body)
      await loadMcp()
      return created
    } catch (e) {
      setState('error', (e as Error).message)
      return null
    }
  }

  async function toggleMcp(name: string, enabled: boolean): Promise<MCPServerEntry | null> {
    try {
      const updated = await rpc.toggleMcp(name, enabled)
      setState('mcp', (prev) =>
        prev.map((s) =>
          s.name === name
            ? {
                ...s,
                status: enabled ? 'connected' : 'disabled',
                config: { ...(s.config ?? { type: 'local' as const, enabled }), enabled },
              }
            : s,
        ),
      )
      return updated
    } catch (e) {
      setState('error', (e as Error).message)
      return null
    }
  }

  async function testMcp(
    name: string,
  ): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    try {
      return await rpc.testMcp(name)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  async function removeMcp(name: string): Promise<boolean> {
    try {
      await rpc.removeMcp(name)
      setState('mcp', (prev) => prev.filter((s) => s.name !== name))
      return true
    } catch (e) {
      setState('error', (e as Error).message)
      return false
    }
  }

  const allCommands = (): CommandEntry[] => {
    const cmds = state.commands
    const skillCmds: CommandEntry[] = state.skills.map((s) => ({
      name: s.name.startsWith('/') ? s.name : `/${s.name}`,
      description: s.description || `Skill: ${s.name}`,
      source: 'skill' as const,
    }))
    const seen = new Set<string>()
    const merged: CommandEntry[] = []
    for (const c of [...cmds, ...skillCmds]) {
      if (!seen.has(c.name)) {
        seen.add(c.name)
        merged.push(c)
      }
    }
    return merged
  }

  return {
    state,
    saving,
    setTheme,
    loadAll,
    loadConfig,
    loadProviders,
    loadMcp,
    loadAgents,
    loadCommands,
    loadSkills,
    loadPermission,
    saveConfig,
    patchConfigField,
    testProvider,
    removeProvider,
    addMcp,
    toggleMcp,
    testMcp,
    removeMcp,
    allCommands,
  }
}

export type SettingsStore = ReturnType<typeof createSettingsStore>
