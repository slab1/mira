/**
 * Mira WebSocket fan-out backpressure / resilience.
 *
 * Bun server WS sockets expose getBufferedAmount() = bytes queued by send()
 * but not yet transmitted. A slow consumer (e.g. a phone on a flaky tunnel)
 * behind a fast producer can accumulate unbounded buffered bytes and OOM the
 * shared process, so we bound what a single socket may queue and let callers
 * evict any socket that falls too far behind. Mirrors the 1MB inbound frame cap.
 */

/** Largest single outbound frame we'll hand to a WS socket (matches 1MB inbound cap). */
export const WS_SEND_MAX_MESSAGE = 1_000_000

/** A socket whose unsent backlog exceeds this is judged too slow and evicted. */
export const WS_SEND_MAX_BUFFERED = 8_000_000

/** RFC 6455 application close code 1013 "try again later". */
export const WS_CLOSE_TOO_SLOW = 1013

/** Minimal structural view of a server-side WebSocket this module depends on. */
export interface BoundedSink {
  __active: boolean
  getBufferedAmount?(): number
  send(data: string): void
}

/**
 * Bounded send: returns false (instead of queueing unboundedly) when the
 * message is oversized OR the socket is too far behind. Call sites use a false
 * return as the signal to stop publishing to (and eventually evict) this socket.
 */
export function boundSend(ws: BoundedSink, data: string): boolean {
  if (!ws.__active) return false
  if (data.length > WS_SEND_MAX_MESSAGE) return false
  const buffered = ws.getBufferedAmount ? ws.getBufferedAmount() : 0
  if (buffered > WS_SEND_MAX_BUFFERED) return false
  try {
    ws.send(data)
    return true
  } catch {
    return false
  }
}
