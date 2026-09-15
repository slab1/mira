import type { MiraConfig } from '../types/index.js'
import type { PartialMiraConfig } from './types.js'
import { DEFAULT_CONFIG } from './defaults.js'
import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import { warn, log } from '../util/logger.js'

const configCache = new Map<string, MiraConfig>()
let cached: MiraConfig | null = null

// ── Config validation helpers ────────────────────────────────────────

/** Known top-level keys in mira.json — flag unknowns as typos. */
const KNOWN_TOP_KEYS = new Set([
  'model',
  'smallModel',
  'loop',
  'permission',
  'guardrails',
  'mcp',
  'provider',
  'routing',
  'subgateways',
  'agents',
  'autoModel',
  'costCap',
  'features',
  'tools',
  'theme',
  'debug',
])

function validateConfig(raw: Record<string, unknown>, source: string): void {
  const issues: string[] = []

  // Unknown top-level keys (likely typos)
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_KEYS.has(key)) {
      issues.push(`unknown key "${key}" — did you mean one of: ${[...KNOWN_TOP_KEYS].join(', ')}?`)
    }
  }

  // Model validation
  if (raw.model !== undefined && typeof raw.model !== 'string') {
    issues.push(`model: expected string, got ${typeof raw.model}`)
  }
  if (raw.smallModel !== undefined && typeof raw.smallModel !== 'string') {
    issues.push(`smallModel: expected string, got ${typeof raw.smallModel}`)
  }

  // Loop validation
  if (raw.loop && typeof raw.loop === 'object' && !Array.isArray(raw.loop)) {
    const loop = raw.loop as Record<string, unknown>
    if (loop.maxSteps !== undefined && (typeof loop.maxSteps !== 'number' || loop.maxSteps < 1)) {
      issues.push(`loop.maxSteps: expected positive integer, got ${JSON.stringify(loop.maxSteps)}`)
    }
    if (
      loop.contextLimit !== undefined &&
      (typeof loop.contextLimit !== 'number' || loop.contextLimit < 1)
    ) {
      issues.push(
        `loop.contextLimit: expected positive integer, got ${JSON.stringify(loop.contextLimit)}`,
      )
    }
    if (
      loop.compactionThreshold !== undefined &&
      (typeof loop.compactionThreshold !== 'number' ||
        loop.compactionThreshold < 0 ||
        loop.compactionThreshold > 1)
    ) {
      issues.push(
        `loop.compactionThreshold: expected 0-1, got ${JSON.stringify(loop.compactionThreshold)}`,
      )
    }
  }

  // MCP validation
  if (raw.mcp && typeof raw.mcp === 'object' && !Array.isArray(raw.mcp)) {
    for (const [name, srv] of Object.entries(raw.mcp as Record<string, unknown>)) {
      if (!srv || typeof srv !== 'object' || Array.isArray(srv)) {
        issues.push(
          `mcp.${name}: expected object, got ${Array.isArray(srv) ? 'array' : typeof srv}`,
        )
        continue
      }
      const cfg = srv as Record<string, unknown>
      if (!cfg.type) {
        issues.push(`mcp.${name}: missing "type" (expected "local" or "remote")`)
      } else if (
        cfg.type === 'local' &&
        (!cfg.command || !Array.isArray(cfg.command) || cfg.command.length === 0)
      ) {
        issues.push(`mcp.${name}: type "local" requires "command" array`)
      } else if (cfg.type === 'remote' && !cfg.url) {
        issues.push(`mcp.${name}: type "remote" requires "url"`)
      }
      if (cfg.type && !['local', 'remote'].includes(String(cfg.type))) {
        issues.push(`mcp.${name}.type: invalid "${cfg.type}" — expected "local" or "remote"`)
      }
    }
  }

  // Provider validation
  if (raw.provider && typeof raw.provider === 'object' && !Array.isArray(raw.provider)) {
    for (const [name, prov] of Object.entries(raw.provider as Record<string, unknown>)) {
      if (!prov || typeof prov !== 'object' || Array.isArray(prov)) {
        issues.push(`provider.${name}: expected object`)
        continue
      }
      const p = prov as Record<string, unknown>
      if (p.npm !== undefined && typeof p.npm !== 'string') {
        issues.push(`provider.${name}.npm: expected string, got ${typeof p.npm}`)
      }
      if (p.options && typeof p.options === 'object') {
        const opts = p.options as Record<string, unknown>
        if (opts.baseURL !== undefined && typeof opts.baseURL !== 'string') {
          issues.push(
            `provider.${name}.options.baseURL: expected string, got ${typeof opts.baseURL}`,
          )
        }
        if (
          opts.apiKey !== undefined &&
          typeof opts.apiKey !== 'string' &&
          !Array.isArray(opts.apiKey)
        ) {
          issues.push(
            `provider.${name}.options.apiKey: expected string or array, got ${typeof opts.apiKey}`,
          )
        }
        if (opts.timeout !== undefined && (typeof opts.timeout !== 'number' || opts.timeout < 1)) {
          issues.push(
            `provider.${name}.options.timeout: expected positive integer, got ${JSON.stringify(opts.timeout)}`,
          )
        }
      }
      if (p.models && typeof p.models === 'object' && !Array.isArray(p.models)) {
        for (const [mName, mDef] of Object.entries(p.models as Record<string, unknown>)) {
          if (!mDef || typeof mDef !== 'object') {
            issues.push(`provider.${name}.models.${mName}: expected object`)
            continue
          }
          const m = mDef as Record<string, unknown>
          if (!m.name) issues.push(`provider.${name}.models.${mName}: missing "name"`)
          if (!m.limit || typeof m.limit !== 'object') {
            issues.push(`provider.${name}.models.${mName}: missing "limit" object`)
          } else {
            const lim = m.limit as Record<string, unknown>
            if (lim.context === undefined)
              issues.push(`provider.${name}.models.${mName}.limit: missing "context"`)
            if (lim.output === undefined)
              issues.push(`provider.${name}.models.${mName}.limit: missing "output"`)
          }
        }
      }
    }
  }

  // Agent validation
  if (raw.agents && typeof raw.agents === 'object' && !Array.isArray(raw.agents)) {
    for (const [name, agent] of Object.entries(raw.agents as Record<string, unknown>)) {
      if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
        issues.push(`agents.${name}: expected object`)
        continue
      }
      const a = agent as Record<string, unknown>
      if (!a.system || typeof a.system !== 'string') {
        issues.push(`agents.${name}: missing or invalid "system" prompt (expected string)`)
      }
      if (
        a.permissions !== undefined &&
        !['readonly', 'standard', 'elevated'].includes(String(a.permissions))
      ) {
        issues.push(
          `agents.${name}.permissions: invalid "${a.permissions}" — expected "readonly", "standard", or "elevated"`,
        )
      }
    }
  }

  // Routing validation
  if (raw.routing && typeof raw.routing === 'object' && !Array.isArray(raw.routing)) {
    const r = raw.routing as Record<string, unknown>
    if (r.defaultProvider !== undefined && typeof r.defaultProvider !== 'string') {
      issues.push(`routing.defaultProvider: expected string, got ${typeof r.defaultProvider}`)
    }
    if (r.fallbacks !== undefined && !Array.isArray(r.fallbacks)) {
      issues.push(`routing.fallbacks: expected array, got ${typeof r.fallbacks}`)
    }
  }

  // Feature flags validation
  if (raw.features && typeof raw.features === 'object' && !Array.isArray(raw.features)) {
    for (const [key, val] of Object.entries(raw.features as Record<string, unknown>)) {
      if (typeof val !== 'boolean') {
        issues.push(`features.${key}: expected boolean, got ${typeof val}`)
      }
    }
  }

  // Theme validation
  if (raw.theme !== undefined && !['dark', 'light', 'system'].includes(String(raw.theme))) {
    issues.push(`theme: invalid "${raw.theme}" — expected "dark", "light", or "system"`)
  }

  if (issues.length > 0) {
    warn(`⚠ ${source}: ${issues.length} config issue(s):`)
    for (const issue of issues) {
      warn(`  • ${issue}`)
    }
  }
}

export async function loadConfig(cwd = process.cwd()): Promise<MiraConfig> {
  if (configCache.has(cwd)) return configCache.get(cwd)!
  if (cached && cwd === process.cwd()) return cached

  // Auto-generate mira.json from example on first boot
  const candidates = ['mira.json', 'mira.jsonc', '.mira/config.json']
  const hasConfig = candidates.some((name) => existsSync(`${cwd}/${name}`))
  if (!hasConfig) {
    const examplePath = `${cwd}/mira.json.example`
    try {
      const example = Bun.file(examplePath)
      if (await example.exists()) {
        const { copyFileSync } = await import('node:fs')
        copyFileSync(examplePath, `${cwd}/mira.json`)
        log(`✓ created mira.json from mira.json.example — edit to add your API keys`)
      }
    } catch {}
  }

  // Try mira.json, mira.jsonc, .mira/config.json
  for (const name of candidates) {
    try {
      const file = Bun.file(`${cwd}/${name}`)
      if (await file.exists()) {
        let raw: Partial<MiraConfig>
        try {
          raw = (await file.json()) as Partial<MiraConfig>
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          warn(`⚠ ${name}: invalid JSON — ${msg}`)
          warn(`  → fix the syntax error in ${cwd}/${name} and restart`)
          continue
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          warn(`⚠ ${name}: expected JSON object, got ${Array.isArray(raw) ? 'array' : typeof raw}`)
          continue
        }
        // Validate config structure and report issues
        validateConfig(raw as Record<string, unknown>, name)
        // Deep-merge object sections so a partial mira.json (e.g. {"permission":{"bash":"ask"}})
        // overrides only the keys it names — never wipes sibling defaults.
        function mergeSection<T>(base: T | undefined, override: T | undefined): T | undefined {
          if (override === undefined) return base
          if (base === undefined) return override
          if (typeof override !== 'object' || override === null || Array.isArray(override))
            return override
          if (typeof base !== 'object' || base === null || Array.isArray(base)) return override
          return { ...(base as object), ...(override as object) } as T
        }
        cached = {
          ...DEFAULT_CONFIG,
          ...raw,
          permission:
            mergeSection(DEFAULT_CONFIG.permission, raw.permission) ?? DEFAULT_CONFIG.permission,
          mcp: mergeSection(DEFAULT_CONFIG.mcp, raw.mcp) ?? DEFAULT_CONFIG.mcp,
          provider: mergeSection(DEFAULT_CONFIG.provider, raw.provider) ?? DEFAULT_CONFIG.provider,
          routing: mergeSection(
            DEFAULT_CONFIG.routing,
            (raw as Record<string, unknown>).routing as typeof DEFAULT_CONFIG.routing,
          ),
          subgateways: mergeSection(
            DEFAULT_CONFIG.subgateways,
            (raw as Record<string, unknown>).subgateways as typeof DEFAULT_CONFIG.subgateways,
          ),
          loop: mergeSection(DEFAULT_CONFIG.loop, raw.loop),
          agents: mergeSection(DEFAULT_CONFIG.agents, raw.agents),
          guardrails: mergeSection(DEFAULT_CONFIG.guardrails, raw.guardrails),
          features: mergeSection(DEFAULT_CONFIG.features, raw.features),
          tools: mergeSection(DEFAULT_CONFIG.tools, raw.tools),
        } as MiraConfig
        configCache.set(cwd, cached)
        if (cwd === process.cwd()) cached = configCache.get(cwd)!
        return cached
      }
    } catch (e) {
      warn(`⚠ ${name}: failed to load — ${e instanceof Error ? e.message : String(e)}`)
      warn(`  → check ${cwd}/${name} for structural issues`)
    }
  }
  cached = DEFAULT_CONFIG
  configCache.set(cwd, cached)
  if (cwd === process.cwd()) cached = configCache.get(cwd)!
  return cached
}

export function getConfig(cwd?: string): MiraConfig {
  if (cwd) {
    if (configCache.has(cwd)) return configCache.get(cwd)!
    // Sync fallback: try to load config for cwd synchronously (for workspace tree)
    try {
      const candidates = ['mira.json', 'mira.jsonc', '.mira/config.json']
      for (const name of candidates) {
        const p = `${cwd}/${name}`
        if (existsSync(p)) {
          let raw: PartialMiraConfig
          try {
            raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<MiraConfig>
          } catch (e) {
            warn(`⚠ ${name}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
            continue
          }
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            warn(
              `⚠ ${name}: expected JSON object, got ${Array.isArray(raw) ? 'array' : typeof raw}`,
            )
            continue
          }
          validateConfig(raw as Record<string, unknown>, name)
          function mergeSection<T>(base: T | undefined, override: T | undefined): T | undefined {
            if (override === undefined) return base
            if (base === undefined) return override
            if (typeof override !== 'object' || override === null || Array.isArray(override))
              return override
            if (typeof base !== 'object' || base === null || Array.isArray(base)) return override
            return { ...(base as object), ...(override as object) } as T
          }
          const merged = {
            ...DEFAULT_CONFIG,
            ...raw,
            permission:
              mergeSection(DEFAULT_CONFIG.permission, raw.permission) ?? DEFAULT_CONFIG.permission,
            mcp: mergeSection(DEFAULT_CONFIG.mcp, raw.mcp) ?? DEFAULT_CONFIG.mcp,
            provider:
              mergeSection(DEFAULT_CONFIG.provider, raw.provider) ?? DEFAULT_CONFIG.provider,
            routing: mergeSection(
              DEFAULT_CONFIG.routing,
              (raw as Record<string, unknown>).routing as typeof DEFAULT_CONFIG.routing,
            ),
            subgateways: mergeSection(
              DEFAULT_CONFIG.subgateways,
              (raw as Record<string, unknown>).subgateways as typeof DEFAULT_CONFIG.subgateways,
            ),
            loop: mergeSection(DEFAULT_CONFIG.loop, raw.loop),
            agents: mergeSection(DEFAULT_CONFIG.agents, raw.agents),
            guardrails: mergeSection(DEFAULT_CONFIG.guardrails, raw.guardrails),
            features: mergeSection(DEFAULT_CONFIG.features, raw.features),
            tools: mergeSection(DEFAULT_CONFIG.tools, raw.tools),
          } as MiraConfig
          configCache.set(cwd, merged)
          return merged
        }
      }
    } catch (e) {
      warn(`⚠ config: failed to load — ${e instanceof Error ? e.message : String(e)}`)
    }
    return cached ?? DEFAULT_CONFIG
  }
  return cached ?? DEFAULT_CONFIG
}

/** Reset the cached config (used by tests and hot-reload). */
export function resetConfigCache(): void {
  cached = null
  configCache.clear()
}

// ── Layer helpers ────────────────────────────────────────────────────
function isPlainObject(
  v: PartialMiraConfig | MiraConfig | string | number | boolean | null,
): v is PartialMiraConfig {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function mergePartialMiraConfig(
  base: PartialMiraConfig,
  patch: PartialMiraConfig,
): PartialMiraConfig {
  const out: PartialMiraConfig = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const prev = out[k as keyof PartialMiraConfig]
    if (isPlainObject(prev as PartialMiraConfig) && isPlainObject(v as PartialMiraConfig)) {
      out[k as keyof PartialMiraConfig] = mergePartialMiraConfig(
        prev as PartialMiraConfig,
        v as PartialMiraConfig,
      ) as never
    } else {
      // Redaction sentinel: the web/TUI clients round-trip masked keys as
      // "***". Never let that clobber a real key (or {env:VAR} reference)
      // already stored — keep the existing value instead.
      if (k === 'apiKey' && v === '***' && prev !== undefined && prev !== '') {
        continue
      }
      out[k as keyof PartialMiraConfig] = v as never
    }
  }
  return out
}

// Zod schema for patch validation (mirrors shared/schemas/config.ts)
const miraConfigPatchSchema = z
  .object({
    model: z.string().min(1).optional(),
    smallModel: z.string().optional(),
    loop: z
      .object({
        maxSteps: z.number().int().positive().optional(),
        contextLimit: z.number().int().positive().optional(),
        compactionThreshold: z.number().min(0).max(1).optional(),
        smallModel: z.string().optional(),
      })
      .optional(),
    permission: z
      .record(
        z.string(),
        z.union([
          z.enum(['allow', 'deny', 'ask']),
          z.record(z.string(), z.enum(['allow', 'deny', 'ask'])),
        ]),
      )
      .optional(),
    guardrails: z
      .object({
        enforce: z.boolean().optional(),
        allowedRoots: z.array(z.string()).optional(),
        blockedPaths: z.array(z.string()).optional(),
        blockedCommands: z.array(z.string()).optional(),
        allowedCommands: z.array(z.string()).optional(),
        maxOutputBytes: z.number().int().positive().optional(),
        auditLogPath: z.string().optional(),
      })
      .optional(),
    mcp: z
      .record(
        z.string(),
        z.object({
          type: z.enum(['local', 'remote']),
          command: z.array(z.string()).optional(),
          args: z.array(z.string()).optional(),
          url: z.string().optional(),
          enabled: z.boolean().optional(),
          env: z.record(z.string(), z.string()).optional(),
          headers: z.record(z.string(), z.string()).optional(),
          timeoutMs: z.number().int().positive().optional(),
          reconnect: z
            .object({
              enabled: z.boolean().optional(),
              maxRetries: z.number().int().min(0).optional(),
              baseDelayMs: z.number().int().positive().optional(),
              maxDelayMs: z.number().int().positive().optional(),
            })
            .optional(),
        }),
      )
      .optional(),
    provider: z
      .record(
        z.string(),
        z.object({
          npm: z.string().optional(),
          name: z.string().optional(),
          options: z
            .object({
              baseURL: z.string().optional(),
              apiKey: z.union([z.string(), z.array(z.string())]).optional(),
              headers: z.record(z.string(), z.string()).optional(),
              timeout: z.number().int().positive().optional(),
              kind: z.string().optional(),
            })
            .optional(),
          models: z
            .record(
              z.string(),
              z.object({
                name: z.string(),
                limit: z.object({ context: z.number(), output: z.number() }),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
    routing: z
      .object({
        aliases: z.record(z.string(), z.string()).optional(),
        fallbacks: z.array(z.string()).optional(),
        defaultProvider: z.string().optional(),
        lanes: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    subgateways: z
      .record(
        z.string(),
        z.object({
          provider: z.string().optional(),
          model: z.string().optional(),
          fallback: z.array(z.string()).optional(),
          rateLimit: z
            .object({
              rps: z.number().positive().optional(),
              burst: z.number().int().positive().optional(),
            })
            .optional(),
          costCap: z
            .object({
              perTask: z.number().positive().optional(),
              perSession: z.number().positive().optional(),
            })
            .optional(),
          retry: z
            .object({
              maxAttempts: z.number().int().positive().optional(),
              baseMs: z.number().int().positive().optional(),
              maxMs: z.number().int().positive().optional(),
            })
            .optional(),
          timeout: z.number().int().positive().optional(),
          circuitBreaker: z
            .object({
              failureThreshold: z.number().int().positive().optional(),
              resetTimeoutMs: z.number().int().positive().optional(),
            })
            .optional(),
          enabled: z.boolean().optional(),
        }),
      )
      .optional(),
    agents: z
      .record(
        z.string(),
        z.object({
          system: z.string(),
          description: z.string().optional(),
          tools: z.array(z.string()).optional(),
          permissions: z.enum(['readonly', 'standard', 'elevated']).optional(),
          model: z.string().min(1).optional(),
        }),
      )
      .optional(),
    autoModel: z
      .object({
        enabled: z.boolean().optional(),
        tier: z.enum(['cheap', 'balanced', 'max']).optional(),
      })
      .optional(),
    costCap: z
      .object({
        perTask: z.number().positive().optional(),
        perSession: z.number().positive().optional(),
      })
      .optional(),
    features: z
      .object({
        injectTodosIntoLoadContext: z.boolean().optional(),
        enforceLaneContracts: z.boolean().optional(),
        perAgentPermissionProfiles: z.boolean().optional(),
      })
      .optional(),
    tools: z
      .object({
        terminal: z
          .object({
            enabled: z.boolean().optional(),
            sandbox: z.boolean().optional(),
            allowedCommands: z.array(z.string()).optional(),
            timeoutMs: z.number().int().positive().optional(),
          })
          .optional(),
      })
      .optional(),
    theme: z.enum(['dark', 'light', 'system']).optional(),
    debug: z.boolean().optional(),
  })
  .passthrough()

/** Write patch to target layer file, deep-merge, invalidate cache. */
export async function saveConfig(
  patch: Partial<MiraConfig>,
  layer: 'project' | 'local' = 'project',
  cwd = process.cwd(),
): Promise<MiraConfig> {
  const parsed = miraConfigPatchSchema.partial().parse(patch) as Partial<MiraConfig>
  const targetPath = layer === 'local' ? `${cwd}/.mira/local.json` : `${cwd}/mira.json`
  // Ensure directory exists
  const dir = targetPath.slice(0, targetPath.lastIndexOf('/'))
  if (dir) {
    try {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(dir, { recursive: true })
    } catch {}
  }
  let existing: PartialMiraConfig = {}
  try {
    const f = Bun.file(targetPath)
    if (await f.exists()) existing = (await f.json()) as PartialMiraConfig
  } catch {}
  const merged = mergePartialMiraConfig(existing, parsed)
  await Bun.write(targetPath, JSON.stringify(merged, null, 2) + '\n')
  cached = null
  configCache.delete(cwd)
  return loadConfig(cwd)
}

/** Remove an MCP server from the project config file (for DELETE /mcp/:name). */
export async function removeMcpFromConfig(name: string, cwd = process.cwd()): Promise<void> {
  const targetPath = `${cwd}/mira.json`
  let existing: PartialMiraConfig = {}
  try {
    const f = Bun.file(targetPath)
    if (await f.exists()) existing = (await f.json()) as PartialMiraConfig
  } catch {}
  if (existing.mcp && existing.mcp[name]) {
    delete existing.mcp[name]
    await Bun.write(targetPath, JSON.stringify(existing, null, 2) + '\n')
    cached = null
    configCache.delete(cwd)
    await loadConfig(cwd)
  }
}

/** Remove a provider from the project config file (for DELETE /provider/:name). */
export async function removeProviderFromConfig(name: string, cwd = process.cwd()): Promise<void> {
  const targetPath = `${cwd}/mira.json`
  let existing: PartialMiraConfig = {}
  try {
    const f = Bun.file(targetPath)
    if (await f.exists()) existing = (await f.json()) as PartialMiraConfig
  } catch {}
  if (existing.provider && existing.provider[name]) {
    delete existing.provider[name]
    await Bun.write(targetPath, JSON.stringify(existing, null, 2) + '\n')
    cached = null
    configCache.delete(cwd)
    await loadConfig(cwd)
  }
}

/** Return merged config + per-layer breakdown for debugging. */
export async function getConfigLayers(cwd = process.cwd()): Promise<{
  merged: MiraConfig
  layers: Array<{ source: string; path: string | null; config: PartialMiraConfig }>
}> {
  const layers: Array<{ source: string; path: string | null; config: Partial<MiraConfig> }> = []
  // defaults
  layers.push({ source: 'defaults', path: null, config: DEFAULT_CONFIG as Partial<MiraConfig> })
  // system
  try {
    const f = Bun.file('/etc/mira/mira.json')
    if (await f.exists())
      layers.push({
        source: 'system',
        path: '/etc/mira/mira.json',
        config: (await f.json()) as Partial<MiraConfig>,
      })
  } catch {}
  // global
  try {
    const home = process.env.HOME ?? ''
    if (home) {
      const p = `${home}/.mira/mira.json`
      const f = Bun.file(p)
      if (await f.exists())
        layers.push({ source: 'global', path: p, config: (await f.json()) as Partial<MiraConfig> })
    }
  } catch {}
  // project candidates
  for (const name of ['mira.json', 'mira.jsonc', '.mira/config.json']) {
    try {
      const p = `${cwd}/${name}`
      const f = Bun.file(p)
      if (await f.exists()) {
        layers.push({ source: 'project', path: p, config: (await f.json()) as Partial<MiraConfig> })
        break
      }
    } catch {}
  }
  // local
  try {
    const p = `${cwd}/.mira/local.json`
    const f = Bun.file(p)
    if (await f.exists())
      layers.push({ source: 'local', path: p, config: (await f.json()) as Partial<MiraConfig> })
  } catch {}
  // env (synthetic)
  const envConfig: PartialMiraConfig = {}
  if (process.env.MIRA_MODEL) envConfig.model = process.env.MIRA_MODEL
  if (process.env.MIRA_SMALL_MODEL) envConfig.smallModel = process.env.MIRA_SMALL_MODEL
  if (Object.keys(envConfig).length) layers.push({ source: 'env', path: null, config: envConfig })
  const merged = await loadConfig(cwd)
  return { merged, layers }
}
