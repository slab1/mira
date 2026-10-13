/**
 * Governance — candidate traffic routing.
 *
 * §3.5 of docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md requires that the canary
 * lifecycle "actually route[s] the configured fraction of traffic to the
 * candidate, observe[s] it for the configured duration, and verify[s] that
 * enough candidate requests were sampled."
 *
 * Until now `trafficPct` was validated, stored, and interpolated into a human
 * string — no request was ever routed anywhere. This module is the routing
 * decision itself plus the attribution that makes candidate-only evidence
 * possible.
 *
 * Design notes:
 *  - Deterministic bucketing: a session/request id always lands on the same
 *    side, so a single user cannot flip between baseline and candidate
 *    mid-session and produce a bimodal, uninterpretable measurement.
 *  - 32-bit FNV-1a rather than the 16-bit `& 0xffff` hash in canary/canary.ts:
 *    a 16-bit space collides across few enough sessions to skew the split.
 *  - A variant is only ever selected when one is REGISTERED. With no variant
 *    registered the router returns `baseline` and says so — it never invents a
 *    candidate, because a candidate that is not independently executable
 *    cannot produce evidence.
 */

export type VariantLane = 'baseline' | 'candidate'

export interface VariantTarget {
  /** Proposal under test — also the attribution key on latency samples. */
  proposalId: string
  /** Percentage (0..100) of eligible traffic to send to the candidate. */
  trafficPct: number
  /** Resolves the executable variant for this proposal, if one exists. */
  resolveVariant?: (proposalId: string) => string | null
}

export interface RoutingDecision {
  lane: VariantLane
  proposalId?: string
  variant?: string
  /** 0..99 bucket this id hashed to — useful when debugging a split. */
  bucket: number
  /** Why the decision came out this way. */
  reason:
    | 'no-target'
    | 'not-eligible'
    | 'no-variant-registered'
    | 'routed-candidate'
    | 'held-back-baseline'
}

/** 32-bit FNV-1a → stable bucket in [0,100). */
export function bucketOf(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % 100
}

export class VariantRouter {
  private targets = new Map<string, VariantTarget>()

  register(target: VariantTarget): void {
    if (!Number.isFinite(target.trafficPct) || target.trafficPct <= 0 || target.trafficPct > 100) {
      throw new RangeError(`trafficPct must be within (0,100], got ${String(target.trafficPct)}`)
    }
    this.targets.set(target.proposalId, target)
  }

  unregister(proposalId: string): void {
    this.targets.delete(proposalId)
  }

  get(proposalId: string): VariantTarget | undefined {
    return this.targets.get(proposalId)
  }

  list(): VariantTarget[] {
    return [...this.targets.values()]
  }

  clear(): void {
    this.targets.clear()
  }

  /**
   * Decide the lane for one request.
   *
   * `key` is the stickiness key (session id, falling back to request id).
   * `eligible` lets the caller restrict routing to the paths that actually
   * exercise the candidate — routing health checks or static assets through a
   * patched variant would just add noise.
   */
  resolve(opts: { proposalId?: string; key: string; eligible?: boolean }): RoutingDecision {
    const bucket = bucketOf(opts.key)

    if (!opts.proposalId) {
      return { lane: 'baseline', bucket, reason: 'no-target' }
    }
    const target = this.targets.get(opts.proposalId)
    if (!target) {
      return { lane: 'baseline', bucket, reason: 'no-target' }
    }
    if (opts.eligible === false) {
      return { lane: 'baseline', proposalId: target.proposalId, bucket, reason: 'not-eligible' }
    }
    // No executable variant → the candidate cannot be observed, so every
    // request stays on baseline and the canary will (correctly) block on
    // "insufficient candidate traffic" instead of measuring itself.
    const variant = target.resolveVariant?.(target.proposalId) ?? null
    if (!variant) {
      return {
        lane: 'baseline',
        proposalId: target.proposalId,
        bucket,
        reason: 'no-variant-registered',
      }
    }
    if (bucket < target.trafficPct) {
      return {
        lane: 'candidate',
        proposalId: target.proposalId,
        variant,
        bucket,
        reason: 'routed-candidate',
      }
    }
    return {
      lane: 'baseline',
      proposalId: target.proposalId,
      variant,
      bucket,
      reason: 'held-back-baseline',
    }
  }

  /**
   * The attribution key to record a latency sample under. Candidate samples are
   * tagged with the proposal id so `stats(windowMs, proposalId)` isolates them;
   * baseline samples are tagged 'baseline' so they are equally retrievable.
   */
  attributionKey(decision: RoutingDecision): string {
    return decision.lane === 'candidate' ? (decision.proposalId ?? 'candidate') : 'baseline'
  }
}

/** Process-wide router used by the request path. */
let sharedRouter: VariantRouter | undefined

export function getVariantRouter(): VariantRouter {
  return (sharedRouter ??= new VariantRouter())
}

export function resetVariantRouter(): VariantRouter {
  sharedRouter = new VariantRouter()
  return sharedRouter
}
