/**
 * WebSocket authentication decisions.
 *
 * Extracted from the Bun.serve upgrade/open/message handlers in `index.ts` so the
 * security-critical branches are directly unit-testable (same convention as
 * `ws-backpressure.ts` — production module, no stubs).
 *
 * The invariant enforced here: a socket is only ever activated on behalf of an
 * owner that `resolveOwner` currently accepts, and an already-activated socket
 * stops being accepted as soon as that credential is revoked or expires.
 */

/** Unauthenticated sockets must authenticate within this window or be closed (1008). */
export const WS_AUTH_TIMEOUT_MS = 20_000

/** RFC 6455 policy-violation close code used for every auth rejection. */
export const WS_CLOSE_UNAUTHORIZED = 1008

export interface WSAuthContext {
  /** Master token required for any access — empty string when auth is disabled. */
  requiredToken: string
  /** Number of issued API keys — > 0 means per-key auth is enforced. */
  apiKeyCount: number
  /**
   * Resolves a bearer token to its owner. Must return `undefined` for unknown,
   * revoked and expired credentials (see `resolveOwner` in index.ts).
   */
  resolveOwner: (token: string) => string | undefined
}

/** Extract a bearer token from an Authorization header value. */
export function bearerOf(authHeader: string | undefined): string {
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
}

/** True when the server is configured to require credentials at all. */
export function authRequired(ctx: WSAuthContext): boolean {
  return !!ctx.requiredToken || ctx.apiKeyCount > 0
}

/** Result of authenticating an upgrade request. */
export interface UpgradeAuth {
  authenticated: boolean
  /** Owner to bind the socket to; undefined when the server is unauthenticated. */
  owner: string | undefined
}

/**
 * Authenticate the HTTP upgrade request. A socket can be pre-authenticated here
 * (header path) or left pending for the in-band `{type:"auth",token}` message.
 *
 * When no credentials are configured the socket is implicitly authenticated —
 * this matches the HTTP middleware, where the auth gate is not installed at all.
 */
export function authenticateUpgrade(
  ctx: WSAuthContext,
  authHeader: string | undefined,
): UpgradeAuth {
  if (!authRequired(ctx)) return { authenticated: true, owner: undefined }
  const owner = ctx.resolveOwner(bearerOf(authHeader))
  return { authenticated: owner !== undefined, owner }
}

/**
 * Whether `open` should activate the socket immediately rather than arm the
 * auth timeout. Only an authenticated upgrade or a server without auth qualifies.
 */
export function shouldActivateOnOpen(ctx: WSAuthContext, authenticated: boolean): boolean {
  return !authRequired(ctx) || authenticated
}

/**
 * Owner claimed by an in-band `{type:"auth",token}` message, or undefined when the
 * message does not authenticate (wrong type, non-string token, bad/revoked token).
 */
export function ownerFromAuthMessage(
  ctx: WSAuthContext,
  event: { type?: string; token?: unknown } | null | undefined,
): string | undefined {
  if (event?.type !== 'auth' || typeof event.token !== 'string') return undefined
  return ctx.resolveOwner(event.token)
}

/**
 * Revalidate an already-activated socket's credential.
 *
 * Revoking a key must not leave existing sockets live: a revoked owner could
 * otherwise keep streaming events indefinitely. Returns false when the credential
 * no longer resolves to the same owner, in which case the caller must close the
 * socket with {@link WS_CLOSE_UNAUTHORIZED}.
 *
 * Sockets activated while auth was disabled carry no token and are always valid.
 */
export function credentialStillValid(
  ctx: WSAuthContext,
  token: string | undefined,
  owner: string | null | undefined,
): boolean {
  if (!authRequired(ctx)) return true
  // No token recorded: the socket was activated through the "auth disabled" path,
  // which only happens when `authRequired` is false, or before the credential was
  // tracked. Treat as valid rather than killing traffic we cannot attribute.
  if (!token) return true
  const current = ctx.resolveOwner(token)
  if (current === undefined) return false
  return owner == null || current === owner
}
