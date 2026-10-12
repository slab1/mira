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
  { match: (m) => m.includes('haiku'), input: 0.8, output: 4 },
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

// The UsageStats / createUsageStats / record / statsSnapshot / GatewayStatsStore
// half of this file was removed 2026-10-12: all had zero production callers and
// duplicated the live collector in gateway/stats.ts (SubgatewayStatsCollector),
// which is what the Subgateway actually records into. `priceFor` + PRICING_TABLE
// below remain the single pricing source of truth.
