/**
 * Shared undici Agent for gateway fetch calls.
 *
 * Reuses TCP/TLS connections to LLM providers across requests, reducing
 * latency from repeated connection establishment. Without this, each
 * `fetch()` may create a new connection (review #20).
 *
 * Uses setGlobalDispatcher so all fetch calls in the process share the
 * connection pool — no per-request dispatcher option needed.
 */
import { Agent, setGlobalDispatcher } from 'undici'

const gatewayAgent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connections: 10,
  pipelining: 1,
})

setGlobalDispatcher(gatewayAgent)

export { gatewayAgent }
