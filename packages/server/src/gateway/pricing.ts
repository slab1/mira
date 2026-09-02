/**
 * Mira Pricing — single source for per-1M-token pricing (input/output USD)
 *
 * Centralizes priceFor() previously duplicated in gateway/index.ts and session/prompt.ts.
 * Rough pricing for known model families; conservative default for unknown models.
 */

export const PRICING: Record<string, [number, number]> = {
  "claude-sonnet": [3, 15],
  "claude-opus": [15, 75],
  "claude-haiku": [0.8, 4],
  "gpt-4o": [2.5, 10],
  "gpt-4": [10, 30],
  deepseek: [0.27, 1.1],
  llama: [0.5, 0.8],
  mistral: [0.5, 0.8],
}

export function priceFor(model: string): [number, number] {
  const m = model.toLowerCase()
  if (m.includes("claude-sonnet")) return PRICING["claude-sonnet"]
  if (m.includes("claude-opus")) return PRICING["claude-opus"]
  if (m.includes("claude-haiku")) return PRICING["claude-haiku"]
  if (m.includes("gpt-4o")) return PRICING["gpt-4o"]
  if (m.includes("gpt-4")) return PRICING["gpt-4"]
  if (m.includes("deepseek")) return PRICING["deepseek"]
  if (m.includes("llama") || m.includes("mistral")) return PRICING["llama"]
  return [1, 2]
}
