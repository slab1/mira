import type { Hono } from 'hono'
import type { MiraConfig, JsonValue } from '../types/index.js'
import type { Bus } from '../bus/index.js'
import { DURATION_BUCKETS_SECONDS } from '../metrics.js'
import type { GatewayStats } from '../gateway/types.js'

export function mountHealthRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    GIT_SHA: string
    STARTED_AT: string
    tools: { count(): number }
    mcp: { count(): number }
    config: MiraConfig
    bus: Bus
    learning: { scheduler: { status(): JsonValue } }
    gateway: { stats(): GatewayStats }
    metrics: {
      httpRequestsTotal: Map<string, number>
      durationsByRoute: Map<string, number[]>
      durationSumByRoute: Map<string, number>
      httpRequestDurationSecondsSum: number
      httpRequestDurationSecondsCount: number
      activeSessions: number
    }
    TERMINAL_ENABLED: boolean
    TERMINAL_SANDBOX: boolean
    REQUIRED_TOKEN: string
    API_KEY_OWNERS: Map<string, string>
    CORS_ORIGIN_LIST: string[]
  },
) {
  const { GIT_SHA, STARTED_AT } = deps
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      version: '0.1.0',
      sha: GIT_SHA,
      startedAt: STARTED_AT,
      uptime: process.uptime(),
    }),
  )
  // Non-blocking colibri probe for /health (800ms cap, never fails health)
  async function colibriStatus(): Promise<{ ok: boolean; baseURL: string; latencyMs?: number; error?: string }> {
    try {
      const raw =
        (deps.config as unknown as { provider?: Record<string, { options?: { baseURL?: string } }> }).provider
          ?.colibri?.options?.baseURL ?? 'http://127.0.0.1:8000/v1'
      const base = String(raw).replace(/\/$/, '').replace(/\/v1$/, '')
      const url = `${base}/v1/models`
      const t0 = Date.now()
      const ctl = new AbortController()
      const to = setTimeout(() => ctl.abort(), 800)
      try {
        const r = await fetch(url, { signal: ctl.signal })
        clearTimeout(to)
        return { ok: r.ok, baseURL: `${base}/v1`, latencyMs: Date.now() - t0, ...(r.ok ? {} : { error: `${r.status}` }) }
      } catch (e) {
        clearTimeout(to)
        const msg = e instanceof Error ? e.message : String(e)
        const isAbort = msg.includes('abort')
        return { ok: false, baseURL: `${base}/v1`, error: isAbort ? 'timeout' : 'unreachable' }
      }
    } catch {
      return { ok: false, baseURL: 'http://127.0.0.1:8000/v1', error: 'unreachable' }
    }
  }

  app.get('/health', async (c) => {
    const colibri = await colibriStatus()
    return c.json({
      ok: true,
      version: '0.1.0',
      sha: GIT_SHA,
      startedAt: STARTED_AT,
      tools: deps.tools.count(),
      mcp: deps.mcp.count(),
      providers: Object.keys(deps.config.provider).length,
      colibri,
      terminal: { enabled: deps.TERMINAL_ENABLED, sandbox: deps.TERMINAL_SANDBOX },
      ws: {
        auth: !!(deps.REQUIRED_TOKEN || deps.API_KEY_OWNERS.size),
        cors: deps.CORS_ORIGIN_LIST.length ? deps.CORS_ORIGIN_LIST : ['*'],
      },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    })
  })
  // Helpers: extract lane/provider health if gateway is a routing gateway (has registry)
  function gatewayHealthSnapshot(): {
    lanes?: Record<string, unknown>
    providers?: Record<string, unknown>
    stats?: Record<string, unknown>
    costCap?: unknown
  } | null {
    try {
      const gwAny = deps.gateway as unknown as {
        registry?: {
          healthSnapshot?: () => {
            lanes: Record<string, unknown>
            providers: Record<string, unknown>
            stats: Record<string, unknown>
            costCap?: unknown
          }
          health?: () => Record<string, unknown>
          providersHealth?: () => Record<string, unknown>
          statsAll?: () => Record<string, unknown>
        }
      }
      if (gwAny.registry?.healthSnapshot) return gwAny.registry.healthSnapshot()
      if (gwAny.registry?.health) {
        return {
          lanes: gwAny.registry.health(),
          providers: (gwAny.registry.providersHealth?.() ?? {}) as Record<string, unknown>,
          stats: (gwAny.registry.statsAll?.() ?? {}) as Record<string, unknown>,
        }
      }
    } catch {}
    return null
  }

  app.get('/dev/health', (c) => {
    const snap = gatewayHealthSnapshot()
    return c.json({
      ok: true,
      version: '0.1.0',
      sha: GIT_SHA,
      startedAt: STARTED_AT,
      tools: deps.tools.count(),
      mcp: deps.mcp.count(),
      providers: Object.keys(deps.config.provider).length,
      terminal: { enabled: deps.TERMINAL_ENABLED, sandbox: deps.TERMINAL_SANDBOX },
      busHistory: deps.bus.recent(5).length,
      learning: deps.learning.scheduler.status(),
      gateway: deps.gateway.stats(),
      // Lane-aware gateway health (per-lane circuit, latency, failureCount, cooldownUntil, rateLimit, costCap)
      ...(snap
        ? {
            lanes: snap.lanes,
            providersHealth: snap.providers,
            laneStats: snap.stats,
            costCap: snap.costCap ?? (deps.config as unknown as { costCap?: unknown }).costCap,
          }
        : {}),
      uptime: process.uptime(),
    })
  })

  // Production standout: health per lane + per provider (circuit, latency, failureCount, cooldown, rateLimit)
  function gatewayHealthResponse() {
    const snap = gatewayHealthSnapshot()
    const stats = deps.gateway.stats()
    const costCap = (deps.config as unknown as { costCap?: unknown }).costCap
    if (!snap) {
      return {
        ok: true,
        gateway: stats,
        costCap,
        lanes: {} as Record<string, unknown>,
        providers: {} as Record<string, unknown>,
        timestamp: Date.now(),
      }
    }
    return {
      ok: true,
      gateway: stats,
      costCap: snap.costCap ?? costCap,
      lanes: snap.lanes,
      providers: snap.providers,
      laneStats: snap.stats,
      timestamp: Date.now(),
    }
  }

  // Canonical: GET /gateway/health  — lane + provider health with circuit/rateLimit/costCap
  app.get('/gateway/health', (c) => c.json(gatewayHealthResponse()))
  // Aliases required by spec: GET /provider/health and GET /providers/health
  app.get('/provider/health', (c) => c.json(gatewayHealthResponse()))
  app.get('/providers/health', (c) => c.json(gatewayHealthResponse()))
  // Back-compat singular alias for /provider/health when plural is expected
  app.get('/provider', (c) => c.json(gatewayHealthResponse()))
  app.get('/dev/cost', (c) => {
    const stats = deps.gateway.stats()
    const costCap = (deps.config as any).costCap
    return c.json({
      ok: true,
      gateway: {
        costUSD: stats.costUSD,
        requests: stats.requests,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        byModel: stats.byModel,
      },
      costCap,
      activeSessions: deps.metrics.activeSessions,
      timestamp: Date.now(),
    })
  })
  app.get('/metrics', async (c) => {
    const gatewayStats = deps.gateway.stats() as { costUSD: number }
    const cost = gatewayStats.costUSD
    const activeSessions = deps.metrics.activeSessions
    let out = ''
    out += '# HELP http_requests_total Total HTTP requests\n# TYPE http_requests_total counter\n'
    for (const [key, val] of deps.metrics.httpRequestsTotal) {
      const parts = key.split(' ')
      const method = parts[0]
      const status = parts[parts.length - 1]
      const route = parts.slice(1, -1).join(' ')
      out += `http_requests_total{method="${method}",route="${route}",status="${status}"} ${val}\n`
    }
    out +=
      '# HELP http_request_duration_seconds HTTP request duration seconds\n# TYPE http_request_duration_seconds histogram\n'
    // Real per-route histogram: cumulative bucket counts reflect the actual latency
    // distribution (not a degenerate flat line). +Inf bucket is implicit; emitted
    // explicitly as `sum`-independent count for Prometheus correctness.
    for (const [routeKey, buckets] of deps.metrics.durationsByRoute) {
      const parts = routeKey.split(' ')
      const method = parts[0]
      const route = parts.slice(1).join(' ')
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
