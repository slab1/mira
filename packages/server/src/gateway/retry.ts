/**
 * Gateway — Retry helpers.
 *
 * Only the two primitive helpers below are used in production (both by
 * Subgateway's request loop). `withRetry` / `withFallbackChain` and their
 * supporting machinery were removed 2026-10-12: they had no production callers
 * and duplicated the retry + candidate-fallback loop that Subgateway implements
 * directly (it needs the bus `gateway.fallback` events and per-candidate key
 * rotation, which these generic helpers cannot express).
 */
export function backoffWithJitter(attempt: number, baseMs = 500, maxMs = 10_000): number {
  const exp = baseMs * Math.pow(2, attempt)
  const capped = Math.min(exp, maxMs)
  // Full jitter: random in [0, capped)
  // Use decorrelated jitter variant: random in [capped/2, capped)
  const jitter = capped / 2 + Math.random() * (capped / 2)
  return Math.round(jitter)
}

export function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null
  const trimmed = header.trim()
  // Numeric seconds
  const secs = Number(trimmed)
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.round(secs * 1000)
  }
  // HTTP date
  const date = Date.parse(trimmed)
  if (Number.isFinite(date)) {
    const diff = date - Date.now()
    if (diff > 0) return diff
    return 0
  }
  return null
}
