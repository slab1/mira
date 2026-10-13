/**
 * Governance — canary traffic attribution middleware.
 *
 * Sits on the request path, resolves a lane for each eligible request via the
 * VariantRouter, and records the observed latency against the lane's
 * attribution key. This is what makes candidate-specific evidence possible at
 * all: without it, LatencyTracker's samples carry only HTTP route strings and
 * `stats(windowMs, proposalId)` can never match anything.
 *
 * Opt-in and fail-safe: with no router targets registered it is a single map
 * lookup and a no-op, and it never throws into the request path.
 */

import type { Context, MiddlewareHandler, Next } from 'hono'
import { getVariantRouter, type VariantRouter, type RoutingDecision } from './traffic.js'
import { getVariantScope, type VariantScope } from './variant-scope.js'
import type { LatencyTracker } from '../latency.js'

export interface CanaryAttributionOptions {
  /** Proposal to route; omit to attribute everything to baseline. */
  proposalId?: string
  router?: VariantRouter
  /** Maps the candidate arm to its working root for tools and path policy. */
  scope?: VariantScope
  tracker: LatencyTracker
  /** Restrict attribution to these request paths (prefix match). */
  paths?: string[]
  /** Supply the stickiness key; defaults to the session id then request id. */
  keyOf?: (c: Context) => string
}

export function canaryAttribution(opts: CanaryAttributionOptions): MiddlewareHandler {
  const router = opts.router ?? getVariantRouter()
  const keyOf =
    opts.keyOf ??
    ((c: Context) =>
      // Prefer session so a single user stays on one side of the split.
      (c.get('sessionID' as never) as string | undefined) ??
      c.req.header('x-request-id') ??
      String(Math.random()))

  const eligible = (path: string): boolean => {
    if (!opts.paths || opts.paths.length === 0) return true
    return opts.paths.some((p) => path === p || path.startsWith(p))
  }

  return async (c: Context, next: Next) => {
    if (!router.list().length) return next()
    const scope = opts.scope ?? getVariantScope()

    let decision: RoutingDecision
    try {
      decision = router.resolve({
        ...(opts.proposalId ? { proposalId: opts.proposalId } : {}),
        key: keyOf(c),
        eligible: eligible(c.req.path),
      })
    } catch {
      return next()
    }

    // Hand the decision to downstream handlers (e.g. gateway lane selection)
    // so the whole request uses one lane, not just the recorded metric.
    c.set('miraVariantLane' as never, decision.lane as never)
    if (decision.variant) c.set('miraVariant' as never, decision.variant as never)

    // Bind this request to the candidate root so tools operate on the patched
    // tree instead of production. Keyed by session when available so every turn
    // of a session stays on the same arm.
    const scopeKey = `${opts.proposalId ?? 'none'}:${keyOf(c)}`
    if (decision.lane === 'candidate' && decision.variant) {
      scope.attach(scopeKey, decision.variant)
      c.set('miraVariantScopeKey' as never, scopeKey as never)
    } else if (scope.isCandidate(scopeKey)) {
      // Same key, now on the baseline arm — stop redirecting its tools.
      scope.detach(scopeKey)
    }
    c.set('miraVariantRoot' as never, scope.rootFor(scopeKey) as never)

    const start = Date.now()
    try {
      await next()
    } finally {
      try {
        opts.tracker.record(
          Date.now() - start,
          router.attributionKey(decision),
          c.get('requestId' as never) as string | undefined,
          c.res.status >= 500,
        )
      } catch {
        // Never let telemetry break a request.
      }
    }
  }
}

/** Read the lane chosen by the middleware (undefined outside attribution). */
export function variantLaneOf(c: Context): 'baseline' | 'candidate' | undefined {
  return c.get('miraVariantLane' as never) as 'baseline' | 'candidate' | undefined
}
