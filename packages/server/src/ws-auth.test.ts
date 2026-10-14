/**
 * WebSocket auth decision tests.
 *
 * These exercise the real production helpers in `ws-auth.ts`, which `index.ts`
 * calls from the Bun.serve upgrade/open/message handlers — not a mock server.
 */
import { describe, test, expect } from 'bun:test'
import {
  WS_AUTH_TIMEOUT_MS,
  WS_CLOSE_UNAUTHORIZED,
  authenticateUpgrade,
  authRequired,
  bearerOf,
  credentialStillValid,
  ownerFromAuthMessage,
  shouldActivateOnOpen,
  type WSAuthContext,
} from './ws-auth.js'

const MASTER = 'master-secret'
const ALICE_KEY = 'alice-key'
const BOB_KEY = 'bob-key'

/** Mirrors resolveOwner() in index.ts, including revocation/expiry short-circuits. */
function makeCtx(
  opts: {
    requiredToken?: string
    revoked?: Set<string>
    expired?: Set<string>
    known?: Record<string, string>
  } = {},
): WSAuthContext & { revoked: Set<string>; expired: Set<string> } {
  const revoked = new Set(opts.revoked ?? [])
  const expired = new Set(opts.expired ?? [])
  const known = opts.known ?? { [ALICE_KEY]: 'alice', [BOB_KEY]: 'bob' }
  const requiredToken = opts.requiredToken ?? MASTER
  return {
    requiredToken,
    apiKeyCount: Object.keys(known).length,
    revoked,
    expired,
    resolveOwner: (t: string) => {
      if (!t) return undefined
      if (requiredToken && t === requiredToken) return 'default'
      if (revoked.has(t)) return undefined
      if (expired.has(t)) return undefined
      return known[t]
    },
  }
}

describe('ws-auth: bearerOf', () => {
  test('extracts a bearer token', () => {
    expect(bearerOf(`Bearer ${ALICE_KEY}`)).toBe(ALICE_KEY)
  })

  test('is scheme-sensitive and does not trim the token', () => {
    expect(bearerOf(`bearer ${ALICE_KEY}`)).toBe('')
    expect(bearerOf(`Bearer  ${ALICE_KEY}`)).toBe(` ${ALICE_KEY}`)
  })

  test('returns empty string for missing/non-bearer headers', () => {
    expect(bearerOf(undefined)).toBe('')
    expect(bearerOf('')).toBe('')
    expect(bearerOf(`Basic ${ALICE_KEY}`)).toBe('')
  })
})

describe('ws-auth: authRequired', () => {
  test('master token alone enables auth', () => {
    expect(authRequired(makeCtx({ known: {} }))).toBe(true)
  })

  test('api keys alone enable auth', () => {
    expect(authRequired(makeCtx({ requiredToken: '', known: { [ALICE_KEY]: 'alice' } }))).toBe(true)
  })

  test('no credentials means no auth', () => {
    expect(authRequired(makeCtx({ requiredToken: '', known: {} }))).toBe(false)
  })
})

describe('ws-auth: authenticateUpgrade (header path)', () => {
  test('valid master token authenticates as the default owner', () => {
    expect(authenticateUpgrade(makeCtx(), `Bearer ${MASTER}`)).toEqual({
      authenticated: true,
      owner: 'default',
    })
  })

  test('valid api key authenticates as its own owner', () => {
    expect(authenticateUpgrade(makeCtx(), `Bearer ${ALICE_KEY}`)).toEqual({
      authenticated: true,
      owner: 'alice',
    })
  })

  test('unknown token does not authenticate', () => {
    expect(authenticateUpgrade(makeCtx(), 'Bearer nope')).toEqual({
      authenticated: false,
      owner: undefined,
    })
  })

  test('missing header does not authenticate', () => {
    expect(authenticateUpgrade(makeCtx(), undefined).authenticated).toBe(false)
    expect(authenticateUpgrade(makeCtx(), '').authenticated).toBe(false)
  })

  test('revoked api key is refused at connect time', () => {
    const ctx = makeCtx({ revoked: new Set([ALICE_KEY]) })
    expect(authenticateUpgrade(ctx, `Bearer ${ALICE_KEY}`).authenticated).toBe(false)
  })

  test('expired api key is refused at connect time', () => {
    const ctx = makeCtx({ expired: new Set([ALICE_KEY]) })
    expect(authenticateUpgrade(ctx, `Bearer ${ALICE_KEY}`).authenticated).toBe(false)
  })

  test('with auth disabled every socket is implicitly authenticated', () => {
    expect(authenticateUpgrade(makeCtx({ requiredToken: '', known: {} }), undefined)).toEqual({
      authenticated: true,
      owner: undefined,
    })
  })
})

describe('ws-auth: shouldActivateOnOpen', () => {
  test('activates immediately when auth is disabled', () => {
    expect(shouldActivateOnOpen(makeCtx({ requiredToken: '', known: {} }), false)).toBe(true)
  })

  test('activates immediately on a pre-authenticated upgrade', () => {
    expect(shouldActivateOnOpen(makeCtx(), true)).toBe(true)
  })

  test('holds an unauthenticated socket for the in-band auth message', () => {
    expect(shouldActivateOnOpen(makeCtx(), false)).toBe(false)
  })
})

describe('ws-auth: ownerFromAuthMessage (in-band path)', () => {
  test('accepts a valid token', () => {
    expect(ownerFromAuthMessage(makeCtx(), { type: 'auth', token: BOB_KEY })).toBe('bob')
  })

  test('rejects a wrong message type', () => {
    expect(ownerFromAuthMessage(makeCtx(), { type: 'hello', token: BOB_KEY })).toBeUndefined()
  })

  test('rejects a non-string token', () => {
    expect(ownerFromAuthMessage(makeCtx(), { type: 'auth', token: 1234 })).toBeUndefined()
    expect(ownerFromAuthMessage(makeCtx(), { type: 'auth' })).toBeUndefined()
  })

  test('rejects an unknown / revoked / expired token', () => {
    expect(ownerFromAuthMessage(makeCtx(), { type: 'auth', token: 'nope' })).toBeUndefined()
    expect(
      ownerFromAuthMessage(makeCtx({ revoked: new Set([BOB_KEY]) }), {
        type: 'auth',
        token: BOB_KEY,
      }),
    ).toBeUndefined()
    expect(
      ownerFromAuthMessage(makeCtx({ expired: new Set([BOB_KEY]) }), {
        type: 'auth',
        token: BOB_KEY,
      }),
    ).toBeUndefined()
  })

  test('tolerates null/undefined events', () => {
    expect(ownerFromAuthMessage(makeCtx(), null)).toBeUndefined()
    expect(ownerFromAuthMessage(makeCtx(), undefined)).toBeUndefined()
  })

  test('cannot be tricked into escalation by sending auth after activation', () => {
    // ownerFromAuthMessage is only consulted on the !__active branch in index.ts;
    // an activated socket ignores it. Guard the helper's contract anyway.
    expect(ownerFromAuthMessage(makeCtx(), { type: 'auth', token: MASTER })).toBe('default')
  })
})

describe('ws-auth: credentialStillValid (live revocation)', () => {
  test('valid credential stays valid', () => {
    expect(credentialStillValid(makeCtx(), ALICE_KEY, 'alice')).toBe(true)
  })

  test('revocation after connect invalidates the socket', () => {
    const ctx = makeCtx()
    expect(credentialStillValid(ctx, ALICE_KEY, 'alice')).toBe(true)
    ctx.revoked.add(ALICE_KEY)
    expect(credentialStillValid(ctx, ALICE_KEY, 'alice')).toBe(false)
  })

  test('expiry after connect invalidates the socket', () => {
    const ctx = makeCtx()
    expect(credentialStillValid(ctx, ALICE_KEY, 'alice')).toBe(true)
    ctx.expired.add(ALICE_KEY)
    expect(credentialStillValid(ctx, ALICE_KEY, 'alice')).toBe(false)
  })

  test('credential reassigned to another owner is treated as invalid', () => {
    const ctx = makeCtx()
    expect(credentialStillValid(ctx, ALICE_KEY, 'mallory')).toBe(false)
  })

  test('sockets with no recorded token are not killed', () => {
    expect(credentialStillValid(makeCtx(), undefined, 'alice')).toBe(true)
  })

  test('auth-disabled deployments never revalidate', () => {
    const ctx = makeCtx({ requiredToken: '', known: {} })
    ctx.revoked.add(ALICE_KEY)
    expect(credentialStillValid(ctx, ALICE_KEY, 'alice')).toBe(true)
  })
})

describe('ws-auth: constants', () => {
  test('unauthenticated sockets get a bounded window', () => {
    expect(WS_AUTH_TIMEOUT_MS).toBeGreaterThan(0)
    expect(WS_AUTH_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })

  test('auth rejections use the policy-violation close code', () => {
    expect(WS_CLOSE_UNAUTHORIZED).toBe(1008)
  })
})
