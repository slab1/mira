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

    // 2. vision → vision
    if (ctx.task === 'vision') return 'vision'
    if (ctx.messages?.some((m) => typeof m.content === 'string' && m.content.includes('image_url')))
      return 'vision'
    // Also check if model contains vision hint
    if (ctx.model && /vision|gpt-4o|claude.*vision|gemini.*vision/i.test(ctx.model)) return 'vision'
    // Check messages for image_url parts (GatewayMessage content may be stringified)
    if (
      ctx.messages?.some((m) => {
        const c = m.content as unknown
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
        const c = m.content as unknown
        if (typeof c === 'string' && c.includes('image_url')) return true
        return false
      })
      const lane = router.resolve({
        model: opts.model,
        messages: opts.messages as GatewayMessage[],
        task: isVision ? 'vision' : 'stream',
      })
      const gw = registry.getOrDefault(lane)
      return gw.stream(opts)
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
      const lane = router.resolve({
        model: opts.model,
        task: isVision ? 'vision' : 'complete',
      })
      const gw = registry.getOrDefault(lane)
      return gw.complete(opts)
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
