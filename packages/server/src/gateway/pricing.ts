/**
 * Gateway — Pricing & Usage Tracking
 *
 * Single source for cost calculation (per-request + cumulative).
 * Extracted from providers/pricing.ts to be gateway-owned.
 */

export const PRICING_TABLE: Array<{
  match: (m: string) => boolean
  input: number
  output: number
}> = [
  { match: (m) => m.includes('claude-opus'), input: 15, output: 75 },
  { match: (m) => m.includes('claude-sonnet'), input: 3, output: 15 },
  { match: (m) => m.includes('claude-haiku'), input: 0.8, output: 4 },
  { match: (m) => m.includes('gpt-4o'), input: 2.5, output: 10 },
  { match: (m) => m.includes('gpt-4'), input: 10, output: 30 },
  { match: (m) => m.includes('deepseek'), input: 0.27, output: 1.1 },
  { match: (m) => m.includes('gemini'), input: 1.25, output: 5 },
  { match: (m) => m.includes('llama') || m.includes('mistral'), input: 0.5, output: 0.8 },
]

export function priceFor(modelID: string): [number, number] {
  const m = modelID.toLowerCase()
  for (const entry of PRICING_TABLE) {
    if (entry.match(m)) return [entry.input, entry.output]
  }
  return [1, 2]
}

export interface UsageStats {
  requests: number
  inputTokens: number
  outputTokens: number
  costUSD: number
  totalLatencyMs: number
  byModel: Map<
    string,
    { requests: number; inputTokens: number; outputTokens: number; costUSD: number }
  >
}

export function createUsageStats(): UsageStats {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    totalLatencyMs: 0,
    byModel: new Map(),
  }
}

export function record(
  stats: UsageStats,
  modelID: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
): void {
  const [pin, pout] = priceFor(modelID)
  const cost = (inputTokens * pin + outputTokens * pout) / 1_000_000
  stats.requests++
  stats.inputTokens += inputTokens
  stats.outputTokens += outputTokens
  stats.costUSD += cost
  stats.totalLatencyMs += latencyMs
  const cur = stats.byModel.get(modelID) ?? {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
  }
  cur.requests++
  cur.inputTokens += inputTokens
  cur.outputTokens += outputTokens
  cur.costUSD += cost
  stats.byModel.set(modelID, cur)
}

export function statsSnapshot(stats: UsageStats): {
  requests: number
  inputTokens: number
  outputTokens: number
  costUSD: number
  avgLatencyMs: number
  byModel: Record<
    string,
    { requests: number; inputTokens: number; outputTokens: number; costUSD: number }
  >
} {
  const byModel: Record<
    string,
    { requests: number; inputTokens: number; outputTokens: number; costUSD: number }
  > = {}
  for (const [k, v] of stats.byModel) byModel[k] = { ...v }
  return {
    requests: stats.requests,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    costUSD: Math.round(stats.costUSD * 1e6) / 1e6,
    avgLatencyMs: stats.requests ? Math.round(stats.totalLatencyMs / stats.requests) : 0,
    byModel,
  }
}

/**
 * GatewayStatsStore — class wrapper for ergonomic use in gateway/index.ts
 */
export class GatewayStatsStore {
  private stats = createUsageStats()

  record(modelID: string, inputTokens: number, outputTokens: number, latencyMs: number): void {
    record(this.stats, modelID, inputTokens, outputTokens, latencyMs)
  }

  snapshot() {
    return statsSnapshot(this.stats)
  }

  get raw(): UsageStats {
    return this.stats
  }
}
