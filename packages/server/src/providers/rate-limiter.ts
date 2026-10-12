/**
 * Provider System — Rate Limiter
 *
 * Token bucket algorithm for per-identity rate limiting.
 * Supports standard and premium tier limits.
 */

export interface TokenBucketConfig {
  capacity: number
  refillRate: number // tokens per second
  identity: string
}

export interface TokenBucket {
  consume(tokens: number): boolean
  /** Would `consume` succeed right now? Refills first, but charges nothing. */
  peek(tokens: number): boolean
  getTokensRemaining(): number
  getNextRefillMs(): number
  getIdentity(): string
}

class TokenBucketImpl implements TokenBucket {
  private capacity: number
  private refillRate: number
  private tokens: number
  private lastRefillTime: number
  private readonly identity: string

  constructor(config: TokenBucketConfig) {
    this.capacity = config.capacity
    this.refillRate = config.refillRate
    this.identity = config.identity
    this.tokens = config.capacity // start full
    this.lastRefillTime = Date.now()
  }

  /** Refill tokens based on elapsed time since last refill */
  private refill(): void {
    const now = Date.now()
    const elapsedSec = (now - this.lastRefillTime) / 1000
    const newTokens = elapsedSec * this.refillRate
    this.tokens = Math.min(this.capacity, this.tokens + newTokens)
    this.lastRefillTime = now
  }

  /** Attempt to consume tokens. Returns true if allowed, false if rate limited. */
  consume(tokens: number): boolean {
    this.refill()
    if (this.tokens >= tokens) {
      this.tokens -= tokens
      return true
    }
    return false
  }

  /**
   * Would `consume(tokens)` succeed right now? Refills (time passed) but
   * charges nothing — so a caller can ask "is there capacity?" during routing
   * without spending a token it may never use.
   */
  peek(tokens: number): boolean {
    this.refill()
    return this.tokens >= tokens
  }

  /** Get current tokens remaining (fractional) */
  getTokensRemaining(): number {
    this.refill()
    return this.tokens
  }

  /** Get milliseconds until the next token is available */
  getNextRefillMs(): number {
    this.refill()
    if (this.tokens >= 1) return 0
    const tokensNeeded = 1 - this.tokens
    const msUntilNext = (tokensNeeded / this.refillRate) * 1000
    return Math.ceil(msUntilNext)
  }

  getIdentity(): string {
    return this.identity
  }
}

interface RateLimitTier {
  capacity: number
  refillRate: number
}

const STANDARD_TIER: RateLimitTier = { capacity: 20, refillRate: 100 / 60 } // 100 req/min, burst 20
const PREMIUM_TIER: RateLimitTier = { capacity: 200, refillRate: 1000 / 60 } // 1000 req/min, burst 200

export class RateLimiter {
  private buckets = new Map<string, TokenBucketImpl>()
  private tierMap = new Map<string, 'standard' | 'premium'>()
  private standard: RateLimitTier

  /**
   * @param standard Override the default (standard-tier) bucket. Wire this from
   *   `routing.providerRateLimit` in mira.json; omit for the built-in
   *   100 req/min, burst 20.
   */
  constructor(standard?: Partial<RateLimitTier>) {
    this.standard = { ...STANDARD_TIER, ...(standard ?? {}) }
  }

  /** Set the tier for an identity prefix (e.g., "user:premium:*") */
  setTier(identityPrefix: string, tier: 'standard' | 'premium'): void {
    this.tierMap.set(identityPrefix, tier)
  }

  /** Determine the tier for a given identity */
  private getTier(identity: string): RateLimitTier {
    for (const [prefix, tier] of this.tierMap) {
      if (identity.startsWith(prefix)) {
        return tier === 'premium' ? PREMIUM_TIER : this.standard
      }
    }
    return this.standard
  }

  /** Get (or lazily create) the bucket for an identity. */
  private bucketFor(identity: string): TokenBucketImpl {
    let bucket = this.buckets.get(identity)
    if (!bucket) {
      const tier = this.getTier(identity)
      bucket = new TokenBucketImpl({
        capacity: tier.capacity,
        refillRate: tier.refillRate,
        identity,
      })
      this.buckets.set(identity, bucket)
    }
    return bucket
  }

  /**
   * Check if an identity is allowed to consume tokens. Returns allowed status and retry-after if limited.
   *
   * CONSUMES a token. For a non-charging capacity check use `peek`.
   */
  check(identity: string, tokens: number = 1): { allowed: boolean; retryAfterMs?: number } {
    const bucket = this.bucketFor(identity)
    const allowed = bucket.consume(tokens)

    if (!allowed) {
      return { allowed: false, retryAfterMs: bucket.getNextRefillMs() }
    }

    return { allowed: true }
  }

  /**
   * Non-consuming capacity check.
   *
   * Model resolution calls `resolve()` several times per request (per candidate,
   * plus a re-resolve of each fallback). Charging in `resolve()` would bill one
   * user request several tokens and make a low-rps provider throttle itself, so
   * routing only PEEKS here and the token is charged once at dispatch.
   */
  peek(identity: string, tokens: number = 1): { allowed: boolean; retryAfterMs?: number } {
    const bucket = this.bucketFor(identity)
    if (bucket.peek(tokens)) return { allowed: true }
    return { allowed: false, retryAfterMs: bucket.getNextRefillMs() }
  }

  /** Get tokens remaining for an identity */
  getTokensRemaining(identity: string): number {
    const tier = this.getTier(identity)
    if (!this.buckets.has(identity)) {
      this.buckets.set(
        identity,
        new TokenBucketImpl({
          capacity: tier.capacity,
          refillRate: tier.refillRate,
          identity,
        }),
      )
    }
    return this.buckets.get(identity)!.getTokensRemaining()
  }

  /** Get all tracked identities */
  getIdentities(): string[] {
    return [...this.buckets.keys()]
  }

  /** Reset bucket for an identity */
  reset(identity: string): void {
    this.buckets.delete(identity)
  }
}

/** Singleton rate limiter instance */
let defaultRateLimiter: RateLimiter | null = null

/**
 * Factory: get or create the default RateLimiter instance.
 * Pre-configured with standard and premium tiers.
 */
export function createRateLimiter(): RateLimiter {
  if (!defaultRateLimiter) {
    defaultRateLimiter = new RateLimiter()
    // Register tier prefixes
    defaultRateLimiter.setTier('user:premium:', 'premium')
  }
  return defaultRateLimiter
}

/** Reset the default rate limiter (useful for testing) */
export function resetRateLimiter(): void {
  defaultRateLimiter = null
}
