/**
 * Gateway — GatewayRouter
 *
 * Resolves lane precedence and delegates to SubgatewayRegistry.
 * Precedence (highest first):
 *   1. summarize → compaction lane
 *   2. vision → vision lane (image_url content or model contains vision)
 *   3. agent binding (agent:ask → agent:ask lane, etc.)
 *   4. model prefix (deepseek/cheap → cheap lane)
 *   5. cheap tier (autoModel tier cheap)
 *   6. default
 *
 * Also provides delegating Gateway impl (facade).
 */

import type { MiraConfig } from '../types/index.js'
import type { Gateway, GatewayMessage, StreamOptions, GatewayStats } from './types.js'
import type { SubgatewayRegistry } from './registry.js'
import { getAgentTemplates } from '../agents/templates.js'

export interface RouteContext {
  model?: string
  agent?: string | null
  messages?: GatewayMessage[]
  task?: 'summarize' | 'stream' | 'complete' | 'vision'
  cheapTier?: boolean
}

/** Nvidia auto-pick catalog — cheapest/fastest → reasoning → fallback */
export const NVIDIA_AUTO_MODELS = {
  flash: 'nvidia/deepseek-ai/deepseek-v4-flash',
  pro: 'nvidia/deepseek-ai/deepseek-v4-pro',
  llama: 'nvidia/meta/llama-3.3-70b-instruct',
  // Vision stays on openai, anthropic as generic fallback
  vision: 'openai/gpt-4o',
  anthropicFallback: 'anthropic/claude-sonnet-4',
} as const

/**
 * Health-aware auto-pick for nvidia primary.
 * Picks cheapest/fastest healthy nvidia model that satisfies capability.
 * - default/cheap/compaction/local/agent:ask → flash
 * - reasoning (lane or task hint) → pro
 * - if nvidia provider is down/degraded with high failureCount, fall back to llama then anthropic
 */
export function pickNvidiaAutoModel(
  lane: string,
  task: string | undefined,
  registry: { providersHealth?: () => Record<string, { status: string; state: string; failureCount: number; latencyMs: number }> },
  capability: 'reasoning' | 'default' = 'default',
): string {
  // Vision lane never auto-picks nvidia
  if (lane === 'vision' || task === 'vision') return NVIDIA_AUTO_MODELS.vision

  let health: { status: string; state: string; failureCount: number; latencyMs: number } | undefined
  try {
    health = registry.providersHealth?.()?.['nvidia'] ?? registry.providersHealth?.()?.['Nvidia']
  } catch {}
  const degraded = health && (health.status === 'down' || health.state === 'OPEN' || health.failureCount >= 5)

  // Reasoning capability → pro (higher quality, still nvidia)
  if (capability === 'reasoning' || lane.includes('reasoning')) {
    if (!degraded) return NVIDIA_AUTO_MODELS.pro
    // nvidia degraded → try llama as cheaper fallback before leaving nvidia
    return NVIDIA_AUTO_MODELS.llama
  }

  // Default: cheapest/fastest — flash; if degraded, ladder flash → llama → anthropic
  if (!degraded) return NVIDIA_AUTO_MODELS.flash
  // If flash provider degraded, try llama (same provider but may have same circuit — still try)
  // For healthiest pick, compare failureCount/latency across providers: nvidia vs anthropic
  let anthHealth: { failureCount: number; latencyMs: number } | undefined
  try {
    anthHealth = (
      registry.providersHealth?.() as Record<string, { failureCount: number; latencyMs: number }>
    )?.['anthropic']
  } catch {}
  // If anthropic is healthier (lower latency/failures), use it; otherwise stay on llama
  if (anthHealth && health) {
    if (anthHealth.failureCount < health.failureCount && anthHealth.latencyMs < health.latencyMs) {
      return NVIDIA_AUTO_MODELS.anthropicFallback
    }
  }
  return NVIDIA_AUTO_MODELS.llama
}

export class GatewayRouter {
  constructor(
    private registry: SubgatewayRegistry,
    private config: MiraConfig,
  ) {}

  syncConfig(config: MiraConfig): void {
    this.config = config
  }

  resolve(ctx: RouteContext): string {
    // 1. summarize → compaction
    if (ctx.task === 'summarize') return 'compaction'

    // 1b. complete → cheap (autocomplete)
    if (ctx.task === 'complete') return 'cheap'

    // 2. vision → vision
    if (ctx.task === 'vision') return 'vision'
    if (ctx.messages?.some((m) => typeof m.content === 'string' && m.content.includes('image_url')))
      return 'vision'
    // Also check if model contains vision hint
    if (ctx.model && /vision|gpt-4o|claude.*vision|gemini.*vision/i.test(ctx.model)) return 'vision'
    // Check messages for image_url parts (GatewayMessage content may be stringified)
    if (
      ctx.messages?.some((m) => {
        const c: unknown = m.content
        if (typeof c === 'string' && c.includes('image_url')) return true
        if (
          Array.isArray(c) &&
          c.some((p: unknown) => (p as { type?: string })?.type === 'image_url')
        )
          return true
        return false
      })
    )
      return 'vision'

    // 3. agent binding
    if (ctx.agent) {
      const lane = `agent:${ctx.agent}`
      // If registry has this lane, use it; otherwise fallback to default agent handling
      // Check if agent exists in templates or config
      const templates = (() => {
        try {
          return getAgentTemplates()
        } catch {
          return {} as Record<string, unknown>
        }
      })()
      if (lane in templates || this.registry.get(lane)) {
        // Only route to agent lane if it exists or is ask (always exists)
        if (this.registry.lanes().includes(lane)) return lane
        // For known agents, still route to agent:xxx even if not explicitly in registry (registry creates it)
        if (ctx.agent in templates) return lane
      }
      // Fallback: if agent has cheap model, route to cheap
      const tpl = (templates as Record<string, { model?: string }>)[ctx.agent]
      if (tpl?.model && /deepseek|haiku|flash|cheap/i.test(tpl.model)) return 'cheap'
    }

    // 4. model prefix → cheap tier
    if (ctx.model) {
      const m = ctx.model.toLowerCase()
      if (
        m.includes('deepseek') ||
        m.includes('haiku') ||
        m.includes('flash') ||
        m.includes('cheap') ||
        m.includes('mini')
      ) {
        return 'cheap'
      }
      // local models
      if (m.startsWith('local/') || m.includes('ollama') || m.includes('lmstudio')) return 'local'
    }

    // 5. cheap tier via autoModel
    if (ctx.cheapTier) return 'cheap'
    try {
      const cfg = this.config as MiraConfig & { autoModel?: { enabled?: boolean; tier?: string } }
      if (cfg.autoModel?.enabled && cfg.autoModel.tier === 'cheap') return 'cheap'
    } catch {}

    // 6. default
    return 'default'
  }

  /** Resolve model — auto picks nvidia healthiest when model is empty or 'auto' */
  resolveModel(ctx: RouteContext): string {
    const model = ctx.model?.trim() ?? ''
    if (!model || model === 'auto') {
      const lane = this.resolve(ctx)
      // Detect reasoning intent from task/agent (future: capability param)
      const capability = ctx.task === 'vision' ? 'default' : 'default'
      return pickNvidiaAutoModel(lane, ctx.task, this.registry as unknown as { providersHealth: () => Record<string, { status: string; state: string; failureCount: number; latencyMs: number }> }, capability)
    }
    return ctx.model!
  }

  /** Resolve and get Subgateway instance */
  getGateway(ctx: RouteContext): Gateway {
    const lane = this.resolve(ctx)
    return this.registry.getOrDefault(lane)
  }

  /** For compaction: always use compaction lane */
  getCompactionGateway(): Gateway {
    return this.registry.getOrDefault('compaction')
  }

  /** For vision: always use vision lane */
  getVisionGateway(): Gateway {
    return this.registry.getOrDefault('vision')
  }
}

/**
 * Create a delegating Gateway facade that routes via GatewayRouter.
 * Keeps Gateway interface backward compat.
 */
export function createRoutingGateway(
  registry: SubgatewayRegistry,
  router: GatewayRouter,
): Gateway & { registry: SubgatewayRegistry; router: GatewayRouter } {
  const facade: Gateway & { registry: SubgatewayRegistry; router: GatewayRouter } = {
    registry,
    router,
    async stream(opts: StreamOptions): Promise<AsyncIterable<import('./types.js').GatewayChunk>> {
      // Detect vision from messages
      const isVision = opts.messages.some((m) => {
        const c: unknown = m.content
        if (typeof c === 'string' && c.includes('image_url')) return true
        return false
      })
      // Auto-pick nvidia healthiest when model is empty or 'auto'
      const effectiveModel = !opts.model || opts.model === 'auto'
        ? router.resolveModel({ model: opts.model, messages: opts.messages as GatewayMessage[], task: isVision ? 'vision' : 'stream' })
        : opts.model
      const lane = router.resolve({
        model: effectiveModel,
        messages: opts.messages as GatewayMessage[],
        task: isVision ? 'vision' : 'stream',
      })
      const gw = registry.getOrDefault(lane)
      return gw.stream({ ...opts, model: effectiveModel })
    },
    async complete(opts: {
      model: string
      system?: string
      prompt: string | import('./types.js').GatewayContentPart[]
      maxTokens?: number
    }): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
      const isVision =
        Array.isArray(opts.prompt) &&
        opts.prompt.some((p) => (p as { type?: string }).type === 'image_url')
      const effectiveModel = !opts.model || opts.model === 'auto'
        ? router.resolveModel({ model: opts.model, task: isVision ? 'vision' : 'complete' })
        : opts.model
      const lane = router.resolve({
        model: effectiveModel,
        task: isVision ? 'vision' : 'complete',
      })
      const gw = registry.getOrDefault(lane)
      return gw.complete({ ...opts, model: effectiveModel })
    },
    async summarize(messages: GatewayMessage[], smallModel?: string): Promise<string> {
      // summarize always goes to compaction lane
      const gw = registry.getOrDefault('compaction')
      return gw.summarize(messages, smallModel)
    },
    async listModels(): Promise<Array<{ id: string; name: string; context: number }>> {
      const gw = registry.getOrDefault('default')
      return gw.listModels()
    },
    stats(): GatewayStats {
      // Aggregate stats across all lanes for backward compat
      const all = registry.statsAll()
      const agg: GatewayStats = {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
        avgLatencyMs: 0,
        byModel: {},
      }
      let totalLatency = 0
      let totalReq = 0
      for (const s of Object.values(all)) {
        agg.requests += s.requests
        agg.inputTokens += s.inputTokens
        agg.outputTokens += s.outputTokens
        agg.costUSD += s.costUSD
        totalLatency += s.avgLatencyMs * s.requests
        totalReq += s.requests
        for (const [k, v] of Object.entries(s.byModel)) {
          if (!agg.byModel[k])
            agg.byModel[k] = { requests: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 }
          agg.byModel[k].requests += v.requests
          agg.byModel[k].inputTokens += v.inputTokens
          agg.byModel[k].outputTokens += v.outputTokens
          agg.byModel[k].costUSD += v.costUSD
        }
      }
      agg.costUSD = Math.round(agg.costUSD * 1e6) / 1e6
      agg.avgLatencyMs = totalReq ? Math.round(totalLatency / totalReq) : 0
      return agg
    },
  }
  return facade
}
