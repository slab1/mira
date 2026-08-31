import type { Hono } from "hono"
import type { MiraConfig, JsonValue } from "../types/index.js"
import type { Bus } from "../bus/index.js"
import { DURATION_BUCKETS_SECONDS } from "../metrics.js"

export function mountHealthRoutes(app: Hono<{ Variables: { requestId: string } }>, deps: {
  GIT_SHA: string; STARTED_AT: string; tools: { count(): number }; mcp: { count(): number };
  config: MiraConfig; bus: Bus; learning: { scheduler: { status(): JsonValue } };
  gateway: { stats(): Record<string, JsonValue> };   metrics: { httpRequestsTotal: Map<string, number>; durationsByRoute: Map<string, number[]>; durationSumByRoute: Map<string, number>; httpRequestDurationSecondsSum: number; httpRequestDurationSecondsCount: number; activeSessions: number };
  TERMINAL_ENABLED: boolean; TERMINAL_SANDBOX: boolean; REQUIRED_TOKEN: string; API_KEY_OWNERS: Map<string, string>; CORS_ORIGIN_LIST: string[]
}) {
  const { GIT_SHA, STARTED_AT } = deps
  app.get("/healthz", c => c.json({ ok: true, version: "0.1.0", sha: GIT_SHA, startedAt: STARTED_AT, uptime: process.uptime() }))
  app.get("/health", c =>
    c.json({
      ok: true, version: "0.1.0", sha: GIT_SHA, startedAt: STARTED_AT,
      tools: deps.tools.count(), mcp: deps.mcp.count(),
      providers: Object.keys(deps.config.provider).length,
      terminal: { enabled: deps.TERMINAL_ENABLED, sandbox: deps.TERMINAL_SANDBOX },
      ws: { auth: !!(deps.REQUIRED_TOKEN || deps.API_KEY_OWNERS.size), cors: deps.CORS_ORIGIN_LIST.length ? deps.CORS_ORIGIN_LIST : ["*"] },
      uptime: process.uptime(), memory: process.memoryUsage(),
    }),
  )
  app.get("/dev/health", c => c.json({
    ok: true, version: "0.1.0", sha: GIT_SHA, startedAt: STARTED_AT,
    tools: deps.tools.count(), mcp: deps.mcp.count(),
    providers: Object.keys(deps.config.provider).length,
    terminal: { enabled: deps.TERMINAL_ENABLED, sandbox: deps.TERMINAL_SANDBOX },
    busHistory: deps.bus.recent(5).length, learning: deps.learning.scheduler.status(),
    gateway: deps.gateway.stats(), uptime: process.uptime()
  }))
  app.get("/metrics", async c => {
    const gatewayStats = deps.gateway.stats() as { costUSD: number }
    const cost = gatewayStats.costUSD
    const activeSessions = deps.metrics.activeSessions
    let out = ''
    out += '# HELP http_requests_total Total HTTP requests\n# TYPE http_requests_total counter\n'
    for (const [key, val] of deps.metrics.httpRequestsTotal) {
      const parts = key.split(' ')
      const method = parts[0]; const status = parts[parts.length - 1]; const route = parts.slice(1, -1).join(' ')
      out += `http_requests_total{method="${method}",route="${route}",status="${status}"} ${val}\n`
    }
    out += '# HELP http_request_duration_seconds HTTP request duration seconds\n# TYPE http_request_duration_seconds histogram\n'
    // Real per-route histogram: cumulative bucket counts reflect the actual latency
    // distribution (not a degenerate flat line). +Inf bucket is implicit; emitted
    // explicitly as `sum`-independent count for Prometheus correctness.
    for (const [routeKey, buckets] of deps.metrics.durationsByRoute) {
      const parts = routeKey.split(' ')
      const method = parts[0]; const route = parts.slice(1).join(' ')
      let cumulative = 0
      for (let i = 0; i < DURATION_BUCKETS_SECONDS.length; i++) {
        cumulative += buckets[i] ?? 0
        out += `http_request_duration_seconds_bucket{method="${method}",route="${route}",le="${DURATION_BUCKETS_SECONDS[i]}"} ${cumulative}\n`
      }
      cumulative += buckets[DURATION_BUCKETS_SECONDS.length] ?? 0
      out += `http_request_duration_seconds_bucket{method="${method}",route="${route}",le="+Inf"} ${cumulative}\n`
      const routeSum = deps.metrics.durationSumByRoute.get(routeKey) ?? 0
      out += `http_request_duration_seconds_sum{method="${method}",route="${route}"} ${routeSum}\n`
      out += `http_request_duration_seconds_count{method="${method}",route="${route}"} ${cumulative}\n`
    }
    out += `http_request_duration_seconds_sum ${deps.metrics.httpRequestDurationSecondsSum}\n`
    out += `http_request_duration_seconds_count ${deps.metrics.httpRequestDurationSecondsCount}\n`
    out += '# HELP active_sessions Number of active sessions\n# TYPE active_sessions gauge\n'
    out += `active_sessions ${activeSessions}\n`
    out += '# HELP gateway_cost_total Total gateway cost USD\n# TYPE gateway_cost_total counter\n'
    out += `gateway_cost_total ${cost}\n`
    return c.text(out, 200, { 'Content-Type': 'text/plain; version=0.0.4' })
  })
}
