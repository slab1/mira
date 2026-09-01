/**
 * Mira Settings Store — SolidJS reactive state for the Settings system.
 *
 * Wires to backend:
 *   GET /config, PATCH /config, GET /config/schema,
 *   GET /providers, GET /mcp, GET /commands, GET /skills,
 *   GET /agents, GET /permission
 *
 * Gracefully handles missing endpoints (404) — every fetch is try/catch
 * with empty fallbacks so the UI never dead-ends when the server is older.
 *
 * Theme: persists `mira_theme` (light/dark/system) in localStorage,
 * applies `data-theme` on <html>, respects prefers-color-scheme for "system".
 */

import { createStore } from "solid-js/store"
import { createSignal, onCleanup } from "solid-js"
import {
  api,
  ApiError,
  type MiraConfig,
  type ConfigSchema,
  type ProviderEntry,
  type ProviderConfig,
  type MCPServerConfig,
  type MCPServerEntry,
  type AgentEntry,
  type CommandEntry,
  type SkillEntry,
  type PermissionMatrix,
  type ThemeChoice,
} from "../api/client"

// ── Theme ──────────────────────────────────────────────────────────

const THEME_KEY = "mira_theme"

function getInitialTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === "light" || v === "dark" || v === "system") return v
  } catch {}
  return "system"
}

function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches) return "light"
  return "dark"
}

function applyTheme(choice: ThemeChoice): void {
  if (typeof document === "undefined") return
  const resolved = resolveTheme(choice)
  document.documentElement.setAttribute("data-theme", resolved)
  try {
    localStorage.setItem(THEME_KEY, choice)
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────────

function maskKey(key: string): string {
  if (!key) return "— not set —"
  if (key.length <= 8) return "••••" + key.slice(-2)
  return key.slice(0, 3) + "••••" + key.slice(-4)
}

function normalizeProviders(raw: ProviderEntry[] | Record<string, ProviderConfig> | null): ProviderEntry[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  // Record<string, ProviderConfig> → ProviderEntry[]
  return Object.entries(raw).map(([id, cfg]) => ({
    id,
    name: cfg.name || id,
    maskedKey: cfg.options?.apiKey ? maskKey(cfg.options.apiKey) : "— not set —",
    baseURL: cfg.options?.baseURL,
    status: cfg.options?.apiKey ? "unknown" : "unknown",
    models: Object.keys(cfg.models ?? {}),
  }))
}

function normalizeCommands(raw: CommandEntry[] | string[] | null): CommandEntry[] {
  if (!raw || !Array.isArray(raw)) return []
  if (raw.length === 0) return []
  // string[] → CommandEntry[]
  if (typeof raw[0] === "string") {
    return (raw as string[]).map((name) => ({
      name: name.startsWith("/") ? name : `/${name}`,
      description: "",
      source: "command" as const,
    }))
  }
  return raw as CommandEntry[]
}

function normalizeSkills(raw: SkillEntry[] | string[] | null): SkillEntry[] {
  if (!raw || !Array.isArray(raw)) return []
  if (raw.length === 0) return []
  if (typeof raw[0] === "string") {
    return (raw as string[]).map((name) => ({ name, description: "" }))
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
  resolvedTheme: "light" | "dark"
  /** admin capability (curated model catalog etc.) — probe from GET /admin/whoami */
  isAdmin: boolean
  adminMode: "open" | "token"
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
    isAdmin: false,
    adminMode: "open",
  })

  const [saving, setSaving] = createSignal(false)

  // Apply initial theme + listen for system changes when choice is "system"
  if (typeof window !== "undefined") {
    applyTheme(state.theme)
    const mq = window.matchMedia("(prefers-color-scheme: light)")
    const onChange = () => {
      if (state.theme === "system") {
        const r = resolveTheme("system")
        document.documentElement.setAttribute("data-theme", r)
        setState("resolvedTheme", r)
      }
    }
    // Modern browsers: addEventListener, fallback to addListener
    try {
      mq.addEventListener("change", onChange)
      onCleanup(() => mq.removeEventListener("change", onChange))
    } catch {
      // Safari <14 fallback
      const legacy = mq as MediaQueryList & { addListener: (cb: () => void) => void; removeListener: (cb: () => void) => void }
      legacy.addListener(onChange)
      onCleanup(() => legacy.removeListener(onChange))
    }
  }

  function setTheme(choice: ThemeChoice): void {
    setState({ theme: choice, resolvedTheme: resolveTheme(choice) })
    applyTheme(choice)
  }

  async function loadConfig(): Promise<void> {
    try {
      const cfg = await api.getConfig()
      setState("config", cfg)
    } catch (e) {
      // 404 = no config endpoint on older server — keep null, UI shows fallback
      // 401 = token invalid — don't surface as error, auth gate handles it
      const msg = String((e as Error).message)
      if (e instanceof ApiError && e.status === 401) return
      if (msg.includes("401") || msg.includes("unauthorized")) return
      if (!msg.includes("404")) setState("error", (e as Error).message)
    }
  }

  async function loadSchema(): Promise<void> {
    try {
      const s = await api.getConfigSchema()
      setState("schema", s)
    } catch {
      // optional
    }
  }

  async function loadProviders(): Promise<void> {
    try {
      const raw = await api.listProviders()
      setState("providers", normalizeProviders(raw as ProviderEntry[] | Record<string, ProviderConfig>))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return
      if (String((e as Error).message).includes("401")) return
      // fallback: derive from config.provider if /providers missing
      if (state.config?.provider) {
        setState("providers", normalizeProviders(state.config.provider as Record<string, ProviderConfig>))
      }
    }
  }

  async function loadMcp(): Promise<void> {
    try {
      const list = await api.listMcp()
      setState("mcp", list)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setState("mcp", []); return }
      if (String((e as Error).message).includes("401")) { setState("mcp", []); return }
      if (!String((e as Error).message).includes("404")) setState("error", (e as Error).message)
      setState("mcp", [])
    }
  }

  async function loadAgents(): Promise<void> {
    try {
      const list = await api.listAgents()
      setState("agents", list)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setState("agents", []); return }
      setState("agents", [])
    }
  }

  async function loadCommands(): Promise<void> {
    try {
      const raw = await api.listCommands()
      setState("commands", normalizeCommands(raw as CommandEntry[] | string[]))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setState("commands", []); return }
      setState("commands", [])
    }
  }

  async function loadSkills(): Promise<void> {
    try {
      const raw = await api.listSkills()
      setState("skills", normalizeSkills(raw as SkillEntry[] | string[]))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setState("skills", []); return }
      setState("skills", [])
    }
  }

  async function loadPermission(): Promise<void> {
    try {
      const perm = await api.getPermission()
      setState("permission", perm)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return
      if (String((e as Error).message).includes("401")) return
      // fallback to config.permission if endpoint missing
      if (state.config?.permission) setState("permission", state.config.permission as PermissionMatrix)
      else setState("permission", null)
    }
  }

  async function loadAdmin(): Promise<void> {
    try {
      const w = await api.whoami()
      setState({ isAdmin: w.isAdmin, adminMode: w.mode })
    } catch {
      setState({ isAdmin: false, adminMode: "open" })
    }
  }

  async function loadAll(): Promise<void> {
    setState({ loading: true, error: null })
    await Promise.all([loadConfig(), loadSchema(), loadMcp(), loadAgents(), loadCommands(), loadSkills()])
    // providers & permission may depend on config, load after
    await Promise.all([loadProviders(), loadPermission(), loadAdmin()])
    setState("loading", false)
  }

  async function saveConfig(patch: Partial<MiraConfig>): Promise<MiraConfig | null> {
    setSaving(true)
    setState("error", null)
    try {
      const updated = await api.patchConfig(patch)
      setState("config", updated)
      return updated
    } catch (e) {
      setState("error", (e as Error).message)
      return null
    } finally {
      setSaving(false)
    }
  }

  async function patchConfigField(key: string, value: string | number | boolean | null): Promise<MiraConfig | null> {
    // Support dot notation: "model", "smallModel", "permission.bash", "mcp.myserver.enabled"
    if (!key.includes(".")) return saveConfig({ [key]: value } as Partial<MiraConfig>)
    const parts = key.split(".")
    const top = parts[0]
    // Build nested patch for mcp / permission subkeys
    if (parts.length === 2) {
      const sub = parts[1]
      const current = (state.config?.[top as keyof MiraConfig] as Record<string, string | number | boolean>) ?? {}
      return saveConfig({ [top]: { ...current, [sub]: value } } as Partial<MiraConfig>)
    }
    if (parts.length === 3 && top === "mcp") {
      const server = parts[1]
      const field = parts[2]
      const mcp: Record<string, MCPServerConfig> = { ...(state.config?.mcp ?? {}) }
      const srv: Record<string, string | number | boolean | string[] | Record<string, string> | undefined> = { ...(mcp[server] ?? { type: "local" as const, enabled: true }) }
      srv[field] = value as string | number | boolean
      mcp[server] = srv as MCPServerConfig
      return saveConfig({ mcp } as Partial<MiraConfig>)
    }
    return saveConfig({ [key]: value } as Partial<MiraConfig>)
  }

  async function testProvider(id: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    try {
      return await api.testProvider(id)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  async function removeProvider(id: string): Promise<boolean> {
    try {
      await api.removeProvider(id)
      setState("providers", (prev) => prev.filter((p) => p.id !== id))
      // also drop from config if present
      if (state.config?.provider?.[id]) {
        const next = { ...state.config.provider }
        delete next[id]
        setState("config", (prev) => (prev ? { ...prev, provider: next } : prev))
      }
      return true
    } catch (e) {
      setState("error", (e as Error).message)
      return false
    }
  }

  // ── Admin: curated model catalog ──────────────────────────────────

  /** Sync the provider's curated catalog (live auto-fetch when models omitted). */
  async function syncModels(
    providerId: string,
    models?: unknown[],
  ): Promise<{ added?: string[]; updated?: string[]; total?: number; error?: string } | null> {
    try {
      const r = await api.syncProviderModels(providerId, models)
      await loadConfig()
      await loadProviders()
      return r
    } catch (e) {
      setState("error", (e as Error).message)
      return null
    }
  }

  /** Patch one catalog entry's flags/metadata (enabled/deprecated/name/limit/pricing). */
  async function patchModel(
    providerId: string,
    modelId: string,
    patch: Partial<{ name: string; limit: { context: number; output: number }; enabled: boolean; deprecated: boolean; pricing: { prompt: number; completion: number } }>,
  ): Promise<boolean> {
    try {
      await api.patchProviderModel(providerId, modelId, patch)
      await loadConfig()
      return true
    } catch (e) {
      setState("error", (e as Error).message)
      return false
    }
  }

  /** Permanently remove a curated model from the provider's registry. */
  async function deleteModel(providerId: string, modelId: string): Promise<boolean> {
    try {
      await api.deleteProviderModel(providerId, modelId)
      await loadConfig()
      await loadProviders()
      return true
    } catch (e) {
      setState("error", (e as Error).message)
      return false
    }
  }

  async function addMcp(body: { name: string; type: "local" | "remote"; command?: string[]; url?: string; enabled?: boolean; env?: Record<string, string>; headers?: Record<string, string> }): Promise<MCPServerEntry | null> {
    try {
      const created = await api.addMcp(body)
      await loadMcp()
      return created
    } catch (e) {
      setState("error", (e as Error).message)
      return null
    }
  }

  async function toggleMcp(name: string, enabled: boolean): Promise<MCPServerEntry | null> {
    try {
      const updated = await api.toggleMcp(name, enabled)
      // Optimistic update
      setState("mcp", (prev) => prev.map((s) => (s.name === name ? { ...s, status: enabled ? "connected" : "disabled", config: { ...(s.config ?? { type: "local" as const, enabled }), enabled } } : s)))
      return updated
    } catch (e) {
      setState("error", (e as Error).message)
      return null
    }
  }

  async function testMcp(name: string): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    try {
      return await api.testMcp(name)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  async function removeMcp(name: string): Promise<boolean> {
    try {
      await api.removeMcp(name)
      setState("mcp", (prev) => prev.filter((s) => s.name !== name))
      return true
    } catch (e) {
      setState("error", (e as Error).message)
      return false
    }
  }

  // Combined command+skill list for palette (slash commands + skills)
  const allCommands = (): CommandEntry[] => {
    const cmds = state.commands
    const skillCmds: CommandEntry[] = state.skills.map((s) => ({
      name: s.name.startsWith("/") ? s.name : `/${s.name}`,
      description: s.description || `Skill: ${s.name}`,
      source: "skill" as const,
    }))
    // Deduplicate by name
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
    // theme
    setTheme,
    // loaders
    loadAll,
    loadConfig,
    loadProviders,
    loadMcp,
    loadAgents,
    loadCommands,
    loadSkills,
    loadPermission,
    loadAdmin,
    // mutations
    saveConfig,
    patchConfigField,
    testProvider,
    removeProvider,
    // admin catalog
    syncModels,
    patchModel,
    deleteModel,
    addMcp,
    toggleMcp,
    testMcp,
    removeMcp,
    // derived
    allCommands,
  }
}

export type SettingsStore = ReturnType<typeof createSettingsStore>
