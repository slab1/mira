/**
 * Provider System — Pricing & Usage Tracking
 * Re-exports from gateway/pricing.ts (single source)
 */
export {
  priceFor,
  createUsageStats,
  record,
  statsSnapshot,
  PRICING_TABLE,
  GatewayStatsStore,
} from '../gateway/pricing.js'
export type { UsageStats } from '../gateway/pricing.js'

import { priceFor as _priceFor, PRICING_TABLE as _PRICING_TABLE } from '../gateway/pricing.js'

/**
 * Returns the cost in USD for a given model and token counts.
 */
export function costForModel(modelID: string, inputTokens: number, outputTokens: number): number {
  const [pin, pout] = _priceFor(modelID)
  return (inputTokens * pin + outputTokens * pout) / 1_000_000
}

/**
 * Returns provider-specific pricing per 1k tokens.
 */
export function pricingForProvider(providerKey: string): { inputPer1k: number; outputPer1k: number } {
  const defaultPricing = { inputPer1k: 0.001, outputPer1k: 0.002 }

  const providerModelMap: Record<string, string[]> = {
    openrouter: ['claude-opus', 'claude-sonnet', 'deepseek', 'llama', 'mistral'],
    anthropic: ['claude-opus', 'claude-sonnet', 'claude-haiku'],
    openai: ['gpt-4o', 'gpt-4'],
    google: ['gemini'],
    deepseek: ['deepseek'],
    nvidia: ['llama', 'mistral'],
  }

  const models = providerModelMap[providerKey] ?? []
  if (models.length === 0) return defaultPricing

  for (const model of models) {
    for (const entry of _PRICING_TABLE) {
      if (entry.match(model)) {
        return {
          inputPer1k: entry.input / 1000,
          outputPer1k: entry.output / 1000,
        }
      }
    }
  }

  return defaultPricing
}

/**
 * Checks if adding this request would exceed the cost cap.
 */
export function costCapCheck(
  stats: UsageStats,
  capUSD: number,
  inputTokens: number,
  outputTokens: number,
  modelID: string,
): { allowed: boolean; remainingUSD: number } {
  const cost = costForModel(modelID, inputTokens, outputTokens)
  const projectedTotal = stats.costUSD + cost
  const allowed = projectedTotal <= capUSD
  return {
    allowed,
    remainingUSD: Math.max(0, capUSD - projectedTotal),
  }
}

/**
 * Pre-call cost estimation for a model and estimated token counts.
 */
export function estimateCost(modelID: string, estimatedInputTokens: number, estimatedOutputTokens: number): number {
  return costForModel(modelID, estimatedInputTokens, estimatedOutputTokens)
}
