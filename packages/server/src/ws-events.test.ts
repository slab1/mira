/**
 * Tenant-safe WS fan-out tests.
 *
 * These exercise the real production policy in `ws-events.ts`, which `activateSocket`
 * in `index.ts` uses to decide whether an event reaches a given socket.
 */
import { describe, test, expect } from 'bun:test'
import { deliveryModeFor, referencedSessionIds } from './ws-events.js'

describe('ws-events: referencedSessionIds', () => {
  test('prefers event.sessionID', () => {
    expect(referencedSessionIds({ sessionID: 'sess-1', payload: { id: 'other' } })).toEqual([
      'sess-1',
    ])
  })

  test('falls back to payload.sessionID (question.ask)', () => {
    expect(referencedSessionIds({ payload: { sessionID: 'sess-2' } })).toEqual(['sess-2'])
  })

  test('falls back to payload.id (session.created / session.deleted)', () => {
    expect(referencedSessionIds({ type: 'session.created', payload: { id: 'sess-3' } })).toEqual([
      'sess-3',
    ])
  })

  test('falls back to nested payload.session.id', () => {
    expect(referencedSessionIds({ payload: { session: { id: 'sess-4' } } })).toEqual(['sess-4'])
  })

  test('dedupes when several ids agree', () => {
    expect(referencedSessionIds({ payload: { sessionID: 's', id: 's' } })).toEqual(['s'])
  })

  test('returns nothing for an unattributable event', () => {
    expect(referencedSessionIds({ type: 'server.error', payload: { error: 'boom' } })).toEqual([])
    expect(referencedSessionIds({})).toEqual([])
  })

  test('ignores empty and non-string ids', () => {
    expect(referencedSessionIds({ sessionID: '' })).toEqual([])
    expect(referencedSessionIds({ payload: { id: 7 } })).toEqual([])
    expect(referencedSessionIds({ payload: null })).toEqual([])
    expect(referencedSessionIds({ payload: 'nope' })).toEqual([])
  })
})

describe('ws-events: deliveryModeFor', () => {
  test('single-tenant deployments broadcast everything', () => {
    expect(deliveryModeFor({ type: 'server.error', payload: {} }, false)).toBe('broadcast')
    expect(deliveryModeFor({ sessionID: 's1' }, false)).toBe('broadcast')
  })

  test('session-scoped events are scoped under tenancy', () => {
    expect(deliveryModeFor({ type: 'message.created', sessionID: 's1' }, true)).toBe('scoped')
  })

  test('lifecycle events carrying only a payload id are scoped, not broadcast', () => {
    // Regression: these used to be fanned out to every socket because they carry
    // no event.sessionID, leaking full session records across tenants.
    expect(
      deliveryModeFor({ type: 'session.created', payload: { id: 's1', title: 'x' } }, true),
    ).toBe('scoped')
    expect(deliveryModeFor({ type: 'session.deleted', payload: { id: 's1' } }, true)).toBe('scoped')
  })

  test('session-less server.* errors are dropped under tenancy', () => {
    // Regression: `server.*` used to bypass the owner check entirely, leaking MCP
    // server names and internal gateway failures to every tenant.
    expect(
      deliveryModeFor({ type: 'server.error', payload: { server: 'internal-db' } }, true),
    ).toBe('drop')
    expect(deliveryModeFor({ type: 'server.error', payload: { source: 'mcp-health' } }, true)).toBe(
      'drop',
    )
  })

  test('doom-loop errors keep flowing — they are session-scoped', () => {
    expect(
      deliveryModeFor(
        { type: 'server.error', sessionID: 's1', payload: { source: 'doom-loop' } },
        true,
      ),
    ).toBe('scoped')
  })

  test('any other unattributable event is dropped under tenancy', () => {
    expect(deliveryModeFor({ type: 'gateway.fallback', payload: { provider: 'x' } }, true)).toBe(
      'drop',
    )
  })
})
