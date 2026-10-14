/**
 * Tenant-safe WebSocket event delivery policy.
 *
 * Extracted from `activateSocket` in `index.ts` so the fan-out rules are unit
 * testable. The previous implementation broadcast an event to *every* connected
 * socket whenever the event had no `sessionID`, or was any `server.*` type. Both
 * bypasses leak across tenants once API-key tenancy is enabled:
 *
 *   - `session.created` carries the full serialized session (id, title, messages)
 *     in its payload and is published with no `sessionID`.
 *   - `session.deleted` carries the session id with no `sessionID`.
 *   - session-less `server.error` events leak MCP server names and internal
 *     subgateway/gateway failures.
 *
 * The policy below resolves the sessions an event refers to, then lets the caller
 * apply the existing owner/org visibility check. Events that cannot be attributed
 * to any session are dropped while tenancy is on.
 */

export type WSEventLike = {
  type?: string
  sessionID?: string
  payload?: unknown
}

/** How an event should be routed to a single connected socket. */
export type DeliveryMode = 'broadcast' | 'scoped' | 'drop'

/**
 * Session ids this event refers to, in priority order.
 *
 * `event.sessionID` is authoritative when present. Otherwise we fall back to ids
 * embedded in the payload by routes that publish session lifecycle events without
 * setting `sessionID` (`session.created` -> payload.id / payload.session.id,
 * `session.deleted` -> payload.id, `question.ask` -> payload.sessionID).
 */
export function referencedSessionIds(event: WSEventLike): string[] {
  if (typeof event.sessionID === 'string' && event.sessionID.length > 0) return [event.sessionID]
  const p = event.payload
  if (!p || typeof p !== 'object') return []
  const rec = p as Record<string, unknown>
  const ids: string[] = []
  if (typeof rec.sessionID === 'string' && rec.sessionID.length > 0) ids.push(rec.sessionID)
  if (typeof rec.id === 'string' && rec.id.length > 0) ids.push(rec.id)
  const nested = rec.session
  if (nested && typeof nested === 'object') {
    const sid = (nested as Record<string, unknown>).id
    if (typeof sid === 'string' && sid.length > 0) ids.push(sid)
  }
  return [...new Set(ids)]
}

/**
 * Decide how to deliver `event` to a socket owned by `owner`.
 *
 * `tenancyEnabled` mirrors `API_KEY_OWNERS.size > 0`:
 *   - false: single-tenant deployment, every event is broadcast unchanged.
 *   - true:  the event is scoped to the sessions it references; the caller must
 *            verify at least one of them is visible to `owner`. Events with no
 *            referencable session are dropped.
 */
export function deliveryModeFor(event: WSEventLike, tenancyEnabled: boolean): DeliveryMode {
  if (!tenancyEnabled) return 'broadcast'
  return referencedSessionIds(event).length > 0 ? 'scoped' : 'drop'
}
