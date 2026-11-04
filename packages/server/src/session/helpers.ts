/**
 * Mira Session Helpers
 * 
 * Helper functions for session and prompt management.
 */

import type { LoopMessage } from './types.js'
import type { Gateway } from '../gateway/index.js'
import type { GatewayRouter } from '../gateway/router.js'
import type { SubgatewayRegistry } from '../gateway/registry.js'
import { getConfig } from '../config/index.js'

/**
 * Prune reasoning from messages to reduce context size.
 * Removes internal reasoning content while preserving tool calls and results.
 */
export function pruneReasoning(messages: LoopMessage[]): LoopMessage[] {
  return messages.map((m) => {
    // Keep tool calls and results
    if (m.toolCalls || m.toolResults) {
      return m
    }
    // For assistant messages, try to keep only the final answer
    if (m.role === 'assistant' && m.content) {
      // Simple heuristic: keep content after last newline or 'Final answer:'
      const content = m.content
      const finalAnswerIdx = content.lastIndexOf('\n')
      if (finalAnswerIdx > 0) {
        return { ...m, content: content.slice(finalAnswerIdx + 1) }
      }
    }
    return m
  })
}

/**
 * Summarize tool traces to reduce context size.
 * Aggregates multiple tool calls into summary messages.
 */
export function summarizeToolTraces(messages: LoopMessage[], stepCount: number): LoopMessage[] {
  if (stepCount < 3) return messages

  const summarized: LoopMessage[] = []
  let toolCallBuffer: LoopMessage[] = []

  for (const msg of messages) {
    if (msg.toolCalls?.length || msg.toolResults?.length) {
      toolCallBuffer.push(msg)
    } else {
      if (toolCallBuffer.length > 0) {
        // Summarize buffered tool calls
        const toolNames = toolCallBuffer
          .flatMap((m) => m.toolCalls?.map((tc) => tc.name) ?? [])
          .join(', ')
        const results = toolCallBuffer
          .flatMap((m) => m.toolResults?.map((tr) => `${tr.name}: ${JSON.stringify(tr.result).slice(0, 100)}`) ?? [])
          .join('; ')
        summarized.push({
          role: 'assistant',
          content: `[Tool Execution Summary: ${toolNames}] Results: ${results}`,
        })
        toolCallBuffer = []
      }
      summarized.push(msg)
    }
  }

  // Flush any remaining buffered tool calls
  if (toolCallBuffer.length > 0) {
    const toolNames = toolCallBuffer
      .flatMap((m) => m.toolCalls?.map((tc) => tc.name) ?? [])
      .join(', ')
    summarized.push({
      role: 'assistant',
      content: `[Tool Execution Summary: ${toolNames}]`,
    })
  }

  return summarized
}

/**
 * Get the gateway router from gateway if available.
 */
export function getRouter(gateway: Gateway): GatewayRouter | null {
  return (gateway as unknown as { router?: GatewayRouter }).router ?? null
}

/**
 * Get the subgateway registry from gateway if available.
 */
export function getRegistry(gateway: Gateway): SubgatewayRegistry | null {
  return (gateway as unknown as { registry?: SubgatewayRegistry }).registry ?? null
}

/**
 * Type guard for GatewayRouter
 */
export function isGatewayRouter(value: unknown): value is GatewayRouter {
  return typeof value === 'object' && value !== null && 'route' in value
}

/**
 * Type guard for SubgatewayRegistry
 */
export function isSubgatewayRegistry(value: unknown): value is SubgatewayRegistry {
  return typeof value === 'object' && value !== null && 'get' in value
}

/**
 * Resolve the lane for a session based on model and configuration.
 */
export function resolveLane(
  modelID: string,
  configOverrides?: Partial<{ lane: string }>,
): string {
  const cfg = getConfig()
  const routing = cfg.routing as Record<string, unknown> | undefined
  const laneMapping = routing?.laneModel as Record<string, string> | undefined

  // Check overrides first
  if (configOverrides?.lane) {
    return configOverrides.lane
  }

  // Check lane mapping
  if (laneMapping?.[modelID]) {
    return laneMapping[modelID]
  }

  // Default lane
  return (routing?.defaultLane as string) ?? 'default'
}

/**
 * Get the cost cap for a lane.
 */
export function laneCostCap(lane: string): number {
  const cfg = getConfig()
  const routing = cfg.routing as Record<string, unknown> | undefined
  const caps = routing?.laneCostCaps as Record<string, number> | undefined
  return caps?.[lane] ?? Infinity
}

/**
 * Get the model for a tier.
 */
export function tierModel(tier: string | undefined, fallbackSmall?: string): string {
  const cfg = getConfig()
  const tierModels = (cfg as unknown as Record<string, unknown>).tierModels as Record<string, string> | undefined
  if (tier && tierModels?.[tier]) {
    return tierModels[tier]
  }
  return fallbackSmall ?? cfg.smallModel ?? cfg.model
}

/**
 * Get the price for a model.
 */
export function priceForModel(modelID: string): [number, number] {
  const cfg = getConfig()
  const pricing = (cfg as unknown as Record<string, unknown>).modelPricing as Record<string, [number, number]> | undefined
  return pricing?.[modelID] ?? [0, 0]
}

/**
 * Estimate the cost in USD for a model call.
 */
export function estimateCostUSD(
  modelID: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const [inputPrice, outputPrice] = priceForModel(modelID)
  return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000
}

/**
 * Get the set of retired models.
 */
export function getRetiredModels(): Set<string> {
  const cfg = getConfig()
  const routing = cfg.routing as Record<string, unknown> | undefined
  const retired = routing?.retiredModels as string[] | undefined
  return new Set(retired?.map((m) => m.toLowerCase()) ?? [])
}

/**
 * Check if a model is retired.
 */
export function isRetired(modelID: string): boolean {
  const lower = modelID.toLowerCase()
  const retired = getRetiredModels()
  if (retired.has(lower)) return true
  for (const r of retired) {
    if (lower.includes(r) || r.includes(lower)) return true
  }
  return false
}

import { getAgentTemplates } from '../agents/templates.js'
import { buildRegistry } from '../gateway/provider.js'

/**
 * Resolve the effective model to use.
 */
export function resolveEffectiveModel(input: {
  model?: string
  explicitModel?: string
  sessionModel?: string
  smallModel?: string
  agent?: string | null
  task?: string
}): string {
  const cfg = getConfig()

  // 1. Explicit model
  let candidate: string | undefined = input.explicitModel ?? input.model

  // 2. Agent template model
  if (!candidate && input.agent) {
    try {
      const templates = getAgentTemplates()
      const tmpl = templates[input.agent as keyof typeof templates]
      if (tmpl?.model) {
        candidate = tmpl.model
      }
    } catch {}
  }

  // 3. Session model
  if (!candidate && input.sessionModel) {
    candidate = input.sessionModel
  }

  // 4. Config default
  if (!candidate) {
    candidate = cfg.model
  }

  // If candidate is retired, fall back to configured fallbacks
  if (isRetired(candidate)) {
    const fallbacks = (cfg.routing?.fallbacks as string[] | undefined) ?? []
    let resolvedFallback: string | null = null
    try {
      const reg = buildRegistry(cfg)
      for (const fb of fallbacks) {
        if (isRetired(fb)) continue
        try {
          const r = reg.resolve(fb)
          resolvedFallback = `${r.providerKey}/${r.modelID}`
          break
        } catch {
          continue
        }
      }
    } catch {}
    candidate = resolvedFallback ?? fallbacks.find((fb) => !isRetired(fb)) ?? cfg.model
  }

  return resolveModelViaGateway(candidate)
}

/**
 * Resolve model via gateway.
 */
export function resolveModelViaGateway(candidate: string): string {
  const cfg = getConfig()
  const routing = cfg.routing as Record<string, unknown> | undefined
  const aliases = routing?.aliases as Record<string, string> | undefined

  let model = candidate
  if (aliases?.[model]) {
    model = aliases[model]
  }

  try {
    const reg = buildRegistry(cfg)
    const resolved = reg.resolve(model)
    return `${resolved.providerKey}/${resolved.modelID}`
  } catch {
    return model
  }
}
