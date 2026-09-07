import type { MiraConfig } from '../types/index.js'
import type { PartialMiraConfig } from './types.js'
import { DEFAULT_CONFIG } from './defaults.js'
import { z } from 'zod'

let cached: MiraConfig | null = null

export async function loadConfig(cwd = process.cwd()): Promise<MiraConfig> {
  if (cached) return cached
  // Try mira.json, mira.jsonc, .mira/config.json
  const candidates = ['mira.json', 'mira.jsonc', '.mira/config.json']
  for (const name of candidates) {
    try {
      const file = Bun.file(`${cwd}/${name}`)
      if (await file.exists()) {
        const raw = (await file.json()) as Partial<MiraConfig>
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
        return cached
      }
    } catch {}
  }
  cached = DEFAULT_CONFIG
  return cached
}

export function getConfig(): MiraConfig {
  return cached ?? DEFAULT_CONFIG
}

/** Reset the cached config (used by tests and hot-reload). */
export function resetConfigCache(): void {
  cached = null
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
