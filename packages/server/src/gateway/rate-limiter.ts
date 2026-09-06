/**
 * Gateway — TokenBucket rate limiter per subgateway
 *
 * Isolated per lane: default, cheap, vision, local, compaction, agent:ask, etc.
 * Each subgateway owns its own bucket; main gateway never shares buckets.
 */

export interface TokenBucketOptions {
  /** tokens added per second (rps) */
  rps: number
  /** max burst capacity */
  burst: number
}

export class TokenBucket {
  private tokens: number
  private lastRefill: number
  private readonly rps: number
  private readonly burst: number

  constructor(opts: TokenBucketOptions) {
    this.rps = opts.rps > 0 ? opts.rps : 10
    this.burst = opts.burst > 0 ? opts.burst : this.rps * 2
    this.tokens = this.burst
    this.lastRefill = Date.now()
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    if (elapsed <= 0) return
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rps)
    this.lastRefill = now
  }

  /** Try to consume n tokens. Returns true if allowed, false if rate-limited. */
  tryConsume(n = 1): boolean {
    this.refill()
    if (this.tokens >= n) {
      this.tokens -= n
      return true
    }
    return false
  }

  /** Consume or throw SubgatewayError-style rate limit. Returns delayMs if limited. */
  consumeOrDelay(n = 1): { allowed: boolean; retryAfterMs?: number } {
    this.refill()
    if (this.tokens >= n) {
      this.tokens -= n
      return { allowed: true }
    }
    const needed = n - this.tokens
    const retryAfterMs = Math.ceil((needed / this.rps) * 1000)
    return { allowed: false, retryAfterMs }
  }

  /** Current available tokens (after refill). */
  get available(): number {
    this.refill()
    return this.tokens
  }

  /** Reset bucket to full. */
  reset(): void {
    this.tokens = this.burst
    this.lastRefill = Date.now()
  }

  /** For testing: set tokens directly */
  _setTokens(n: number): void {
    this.tokens = Math.max(0, Math.min(this.burst, n))
  }

  get config(): TokenBucketOptions {
    return { rps: this.rps, burst: this.burst }
  }
}
