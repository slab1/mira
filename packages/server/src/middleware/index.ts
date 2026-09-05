import type { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import type { JsonValue } from '../types/index.js'
import { MetricsCollector } from '../metrics.js'
import {
  RATE_LIMIT_CAPACITY,
  RATE_LIMIT_SSE_CAPACITY,
  choosePeerIP,
  isSSERoute,
} from '../rate-limit.js'

export interface MiddlewareDeps {
  CORS_ORIGIN_LIST: string[]
  REQUIRED_TOKEN: string
  API_KEY_OWNERS: Map<string, string>
  resolveOwner: (t: string) => string | undefined
  bearerOf: (h?: string) => string
  /** Mutable ref — set by Bun.serve fetch handler */
  getBunServer: () => ReturnType<typeof Bun.serve> | null
}

export function mountMiddleware(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: MiddlewareDeps,
) {
  const { CORS_ORIGIN_LIST, REQUIRED_TOKEN, API_KEY_OWNERS, resolveOwner, bearerOf, getBunServer } =
    deps

  // Metrics collector — bounded cardinality (LRU-evicted) + real per-route histograms.
  const metrics = new MetricsCollector()

  // Security: CORS origin allowlist
  app.use('*', cors(CORS_ORIGIN_LIST.length > 0 ? { origin: CORS_ORIGIN_LIST } : {}))

  // Assign a stable request id once per request
  app.use('*', (c: Context, next: () => Promise<void>) => {
    const requestId = c.get('requestId') ?? crypto.randomUUID()
    c.set('requestId', requestId)
    c.header('X-Request-Id', requestId)
    return next()
  })

  // OpenTelemetry tracer middleware
  let cachedTracer: {
    startSpan: (
      name: string,
      opts?: JsonValue,
    ) => { setAttribute: (k: string, v: JsonValue) => void; end: () => void }
  } | null = null
  let otelFailed = false
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    import('@opentelemetry/api')
      .then(({ trace }) => {
        cachedTracer = trace.getTracer('mira-server') as typeof cachedTracer
      })
      .catch(() => {
        otelFailed = true
      })
  }
  app.use('*', async (c: Context, next: () => Promise<void>) => {
    if (!cachedTracer || otelFailed) return await next()
    const tracer = cachedTracer
    const span = tracer.startSpan('http.request', {
      attributes: {
        'http.method': c.req.method,
        'http.route': c.req.path,
        request_id: c.get('requestId'),
      },
    })
    try {
      await next()
      span.setAttribute('http.status_code', c.res.status)
    } finally {
      span.end()
    }
  })

  // Security: optional bearer-token gate
  const PUBLIC_PATHS = new Set(['/healthz', '/metrics'])
  const isPublicUiPath = (p: string) =>
    p === '/' ||
    p.startsWith('/assets/') ||
    p === '/favicon.ico' ||
    p === '/robots.txt' ||
    p === '/vite.svg'
  if (REQUIRED_TOKEN || API_KEY_OWNERS.size > 0) {
    app.use('*', async (c: Context, next: () => Promise<void>) => {
      if (PUBLIC_PATHS.has(c.req.path) || isPublicUiPath(c.req.path)) return await next()
      if (!resolveOwner(bearerOf(c.req.header('Authorization'))))
        return c.json({ error: 'unauthorized' }, 401)
      await next()
    })
  }

  // Body-size limit
  const MAX_BODY_BYTES = Number(process.env.MIRA_MAX_BODY_BYTES ?? 5 * 1024 * 1024)
  const bodyExceedsLimit = async (
    body: ReadableStream<Uint8Array> | null,
    limit: number,
  ): Promise<boolean> => {
    if (!body) return false
    const reader = body.getReader()
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return false
        total += value.byteLength
        if (total > limit) return true
      }
    } catch {
      return false
    } finally {
      try {
        await reader.cancel()
      } catch {}
    }
  }
  app.use('*', async (c: Context, next: () => Promise<void>) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return await next()
    const cl = c.req.header('content-length')
    if (cl && Number(cl) > MAX_BODY_BYTES) {
      return c.json({ error: 'payload too large', limit: MAX_BODY_BYTES }, 413)
    }
    if (!cl) {
      const url = new URL(c.req.url)
      const path = url.pathname
      if (path.startsWith('/health') || path === '/metrics') return await next()
      const body = c.req.raw.body
      if (body && (await bodyExceedsLimit(body, MAX_BODY_BYTES))) {
        return c.json({ error: 'payload too large', limit: MAX_BODY_BYTES }, 413)
      }
    }
    await next()
  })

  // Rate limiting — token bucket per IP, 100 req/min
  const RATE_LIMIT_WINDOW_MS = 60_000
  const RATE_LIMIT_SKIP = new Set(['/health', '/dev/health', '/healthz', '/metrics'])
  const rateLimitBuckets = new Map<string, { tokens: number; last: number }>()
  const RATE_LIMIT_BUCKET_TTL_MS = 10 * 60_000
  const rateLimitCleanup = setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_BUCKET_TTL_MS
    for (const [ip, bucket] of rateLimitBuckets) {
      if (bucket.last < cutoff) rateLimitBuckets.delete(ip)
    }
  }, 60_000)
  rateLimitCleanup.unref?.()
  const TRUST_PROXY = process.env.MIRA_TRUST_PROXY === '1'
  function peerAddress(c: Context): string {
    return choosePeerIP({
      trustProxy: TRUST_PROXY,
      xForwardedFor: c.req.header('x-forwarded-for'),
      xRealIp: c.req.header('x-real-ip'),
      socketPeer: (() => {
        try {
          const ip = getBunServer()?.requestIP?.(c.req.raw as Request)
          return ip?.address ?? null
        } catch {
          return null
        }
      })(),
    })
  }
  function sseRoute(c: Context): boolean {
    return isSSERoute(c.req.method, c.req.path)
  }
  app.use('*', async (c: Context, next: () => Promise<void>) => {
    const path = new URL(c.req.url).pathname
    if (RATE_LIMIT_SKIP.has(path)) return await next()
    const sse = sseRoute(c)
    const key = (sse ? 'sse:' : '') + peerAddress(c)
    const capacity = sse ? RATE_LIMIT_SSE_CAPACITY : RATE_LIMIT_CAPACITY
    const now = Date.now()
    let bucket = rateLimitBuckets.get(key)
    if (!bucket) {
      bucket = { tokens: capacity, last: now }
      rateLimitBuckets.set(key, bucket)
    }
    const elapsed = now - bucket.last
    if (elapsed > 0) {
      const refill = (elapsed / RATE_LIMIT_WINDOW_MS) * capacity
      bucket.tokens = Math.min(capacity, bucket.tokens + refill)
      bucket.last = now
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      await next()
      c.res.headers.set('X-RateLimit-Limit', String(capacity))
      c.res.headers.set('X-RateLimit-Remaining', String(Math.floor(bucket.tokens)))
    } else {
      const refillPerMs = capacity / RATE_LIMIT_WINDOW_MS
      const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000))
      const res = c.json({ error: 'Too Many Requests' }, 429)
      res.headers.set('Retry-After', String(retryAfterSec))
      res.headers.set('X-RateLimit-Limit', String(capacity))
      res.headers.set('X-RateLimit-Remaining', '0')
      return res
    }
  })

  // Metrics middleware
  const metricPath = (p: string): string =>
    p
      .split('/')
      .map((seg) =>
        seg.length > 16 || /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(seg) ? ':id' : seg,
      )
      .join('/')
  app.use('*', async (c: Context, next: () => Promise<void>) => {
    const start = Date.now()
    await next()
    const durationSec = (Date.now() - start) / 1000
    const method = c.req.method
    const path = metricPath(c.req.path)
    const status = c.res.status
    metrics.record(method, path, status, durationSec)
    if (method === 'POST' && path === '/session' && status === 201) metrics.activeSessions += 1
    if (method === 'DELETE' && path.startsWith('/session/') && status === 200)
      metrics.activeSessions = Math.max(0, metrics.activeSessions - 1)
  })

  // Error handler
  app.onError((err: Error, c: Context) => {
    if (c.get('requestId')) c.header('X-Request-Id', c.get('requestId'))
    console.error(`[mira] ${c.req.method} ${c.req.path} error:`, err)
    return c.json({ error: 'internal error' }, 500)
  })

  return { metrics, rateLimitCleanup }
}
