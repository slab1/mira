/**
 * Mira rate-limit key derivation — pure + unit-testable.
 *
 * The critical property this enforces: unless the operator explicitly opts into
 * trusting a reverse proxy (MIRA_TRUST_PROXY=1), the rate-limit key is derived from
 * the REAL socket peer address (Bun server.requestIP), which a client CANNOT forge.
 * `x-forwarded-for` / `x-real-ip` are client-supplied headers — trusting them in the
 * default path would let a caller bypass the limit by sending a fresh header per
 * request (one bucket per forged header) and churn unbounded buckets.
 */

/** Long-lived / expensive SSE streaming routes get a stricter bucket than the rest. */
export const SSE_ROUTE_HINTS = ["/prompt", "/queue"] as const

/** Default per-IP requests/minute. */
export const RATE_LIMIT_CAPACITY = 100
/** Stricter per-IP requests/minute for long-lived SSE streaming routes. */
export const RATE_LIMIT_SSE_CAPACITY = 30

export type PeerInput = {
  /** Operator declared a real reverse proxy is present and sanitizing proxy headers. */
  trustProxy: boolean
  xForwardedFor: string | undefined
  xRealIp: string | undefined
  /** Unspoofable real socket peer address (Bun server.requestIP().address), or null. */
  socketPeer: string | null
}

/**
 * Choose the peer key. With trustProxy we honor the left-most x-forwarded-for entry
 * (the first proxy in the chain set it). Otherwise we trust ONLY the socket peer and
 * ignore spoofable headers — falling back to "unknown" so we never key on a forged value.
 */
export function choosePeerIP(input: PeerInput): string {
  if (input.trustProxy) {
    return input.xForwardedFor?.split(",")[0]?.trim() ?? input.xRealIp ?? "unknown"
  }
  return input.socketPeer ?? "unknown"
}

/** True when this request hits a long-lived SSE streaming route. */
export function isSSERoute(method: string, path: string): boolean {
  if (method !== "POST") return false
  return SSE_ROUTE_HINTS.some(h => path.includes(h))
}
