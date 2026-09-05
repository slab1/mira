/**
 * Mira Eval — Tracing (OpenTelemetry + Langfuse)
 *
 * Wraps OTel + Langfuse so every eval run and prod prompt is observable
 * without hard-depending on either SDK. If deps / env are missing we degrade
 * to in-memory + console, so `bun test` never needs credentials.
 *
 * Env:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  → enables OTel span export
 *   LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_HOST → enables Langfuse
 *   MIRA_TRACE_SAMPLE_RATE  (0..1, default 1 in eval, 0.1 in prod)
 */

import type { Tracer, Span as OTelSpan } from '@opentelemetry/api'

/** Structural shims for the OPTIONAL langfuse SDK (not a hard dependency).
 *  When absent we degrade to the in-memory store; these mirror the SDK surface
 *  actually used here so no `any` is needed at call sites. */
interface LangfuseSpanLike {
  end(input?: {
    output?: Record<string, string | number | boolean | undefined>
    statusMessage?: string
  }): void
  update(input?: Record<string, string | number | boolean | undefined>): void
}
interface LangfuseTraceLike {
  span(input: {
    id: string
    name: string
    input?: Record<string, string | number | boolean | undefined>
  }): LangfuseSpanLike
  update(input?: Record<string, string | number | boolean | undefined>): void
}
interface LangfuseClientLike {
  trace(input: {
    id: string
    name: string
    metadata?: Record<string, string | number | boolean | undefined>
  }): LangfuseTraceLike
  flushAsync?(): Promise<void>
}

/** Attribute values we put on spans (OTel-compatible subset) */
export type SpanAttrValue = string | number | boolean | undefined
export type SpanAttributes = Record<string, SpanAttrValue>

export interface Span {
  name: string
  traceId: string
  spanId: string
  startMs: number
  endMs?: number
  attributes: SpanAttributes
  status: 'ok' | 'error'
  error?: string
  parentId?: string
}

export interface Trace {
  traceId: string
  name: string
  spans: Span[]
  metadata?: SpanAttributes
}

export interface DriftCheckResult {
  metric: string
  window: string
  baseline: number
  current: number
  driftPct?: number
  threshold: number
  alert: boolean
  message: string
}

// ── In-memory store (fallback + test-friendly) ───────────────────────

const traces: Map<string, Trace> = new Map()
const metrics: Map<string, number[]> = new Map() // metric → ring of recent values

function rid(prefix = 'tr'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`
}

function nowMs() {
  return Date.now()
}

// ── OTel + Langfuse lazy clients ─────────────────────────────────────

/**
 * Structural shim for the optional Langfuse SDK (not a hard dependency —
 * installed separately; when absent we degrade to the in-memory store).
 */

/**
 * Structural shim for the optional auto-instrumentations package (not a hard
 * dependency). Return type mirrors NodeSDKConfiguration["instrumentations"].
 */

let otelInited = false
let otelTracer: Tracer | null = null
let langfuseClient: LangfuseClientLike | null = null

async function initOtel(): Promise<void> {
  if (otelInited) return
  otelInited = true
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) return
  try {
    // Optional deps — don't crash if not installed
    const { NodeSDK } = await import('@opentelemetry/sdk-node')
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
    // Optional package: imported non-literally; only shape used is the
    // instrumentation array NodeSDK already expects.
    type Instrumentations = NonNullable<
      import('@opentelemetry/sdk-node').NodeSDKConfiguration['instrumentations']
    >
    const autoInstr = (await import('@opentelemetry/auto-instrumentations-node' as string).catch(
      () => null,
    )) as { getNodeAutoInstrumentations?: () => Instrumentations } | null
    if (!autoInstr?.getNodeAutoInstrumentations)
      throw new Error('auto-instrumentations not installed')
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
      instrumentations: autoInstr.getNodeAutoInstrumentations(),
    })
    await sdk.start()
    // get tracer
    const { trace } = await import('@opentelemetry/api')
    otelTracer = trace.getTracer('mira-eval', '0.1.0')
    console.log(`[tracing] OTel enabled → ${endpoint}`)
  } catch (e) {
    console.warn('[tracing] OTel init failed (optional):', (e as Error).message)
  }
}

async function initLangfuse(): Promise<void> {
  if (langfuseClient) return
  const pub = process.env.LANGFUSE_PUBLIC_KEY
  const sec = process.env.LANGFUSE_SECRET_KEY
  if (!pub || !sec) return
  try {
    const mod = (await import('langfuse' as string).catch(() => null)) as {
      Langfuse?: new (opts: {
        publicKey: string
        secretKey: string
        baseUrl?: string
      }) => LangfuseClientLike
    } | null
    if (!mod?.Langfuse) throw new Error('langfuse not installed')
    const { Langfuse } = mod
    langfuseClient = new Langfuse({
      publicKey: pub,
      secretKey: sec,
      baseUrl: process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com',
    })
    console.log('[tracing] Langfuse enabled')
  } catch (e) {
    console.warn('[tracing] Langfuse init failed (optional):', (e as Error).message)
  }
}

// Fire-and-forget init (don't block import)
initOtel().catch(() => {})
initLangfuse().catch(() => {})

// ── Public API ────────────────────────────────────────────────────────

// Live SDK objects associated with our plain-data Trace/Span records
// (WeakMap instead of expando properties — keeps the exported shapes pure).
const lfTraceByTrace = new WeakMap<Trace, LangfuseTraceLike>()
const otelSpanBySpan = new WeakMap<Span, OTelSpan>()
const lfSpanBySpan = new WeakMap<Span, LangfuseSpanLike>()

export function createTrace(name: string, metadata?: SpanAttributes): Trace {
  const trace: Trace = { traceId: rid('trace'), name, spans: [], metadata }
  traces.set(trace.traceId, trace)
  // Also start a Langfuse trace if available
  if (langfuseClient) {
    try {
      const lfTrace = langfuseClient.trace({ id: trace.traceId, name, metadata })
      lfTraceByTrace.set(trace, lfTrace)
    } catch {}
  }
  return trace
}

export function startSpan(
  trace: Trace,
  name: string,
  attrs: SpanAttributes = {},
  parentId?: string,
): Span {
  const span: Span = {
    name,
    traceId: trace.traceId,
    spanId: rid('span'),
    startMs: nowMs(),
    attributes: { ...attrs },
    status: 'ok',
    parentId,
  }
  trace.spans.push(span)
  // OTel live span
  if (otelTracer) {
    try {
      const ctxSpan = otelTracer.startSpan(name, { attributes: attrs })
      otelSpanBySpan.set(span, ctxSpan)
    } catch {}
  }
  // Langfuse generation/span
  const lfTrace = lfTraceByTrace.get(trace)
  if (lfTrace) {
    try {
      const lfSpan = lfTrace.span({ id: span.spanId, name, input: attrs })
      lfSpanBySpan.set(span, lfSpan)
    } catch {}
  }
  return span
}

export function endSpan(span: Span, attrs: SpanAttributes = {}, isError = false): void {
  span.endMs = nowMs()
  Object.assign(span.attributes, attrs)
  span.status = isError ? 'error' : 'ok'
  if (isError && typeof attrs.error === 'string') span.error = attrs.error
  const otelSpan = otelSpanBySpan.get(span)
  if (otelSpan) {
    try {
      if (isError) otelSpan.setStatus({ code: 2, message: span.error })
      for (const [k, v] of Object.entries(attrs)) otelSpan.setAttribute(k, String(v))
      otelSpan.end()
    } catch {}
  }
  const lfSpan = lfSpanBySpan.get(span)
  if (lfSpan) {
    try {
      lfSpan.end({ output: attrs, statusMessage: isError ? span.error : undefined })
    } catch {}
  }
  // Record metric if span carries a numeric score/latency
  if (typeof attrs.score === 'number') recordMetric('judge_score', attrs.score as number)
  if (typeof attrs.latencyMs === 'number') recordMetric('latency_p50', attrs.latencyMs as number)
}

export async function flush(): Promise<void> {
  if (langfuseClient) {
    try {
      await langfuseClient.flushAsync?.()
    } catch {}
  }
  // OTel flush is via SDK shutdown; no-op here
}

export function getTrace(traceId: string): Trace | undefined {
  return traces.get(traceId)
}

export function listTraces(): Trace[] {
  return [...traces.values()]
}

export function clearTraces(): void {
  traces.clear()
}

// ── Metrics + drift detection (prod tier) ───────────────────────────

export function recordMetric(name: string, value: number): void {
  if (!metrics.has(name)) metrics.set(name, [])
  const arr = metrics.get(name)!
  arr.push(value)
  if (arr.length > 1000) arr.shift()
  // also push to OTel gauge if available
}

export function getMetricWindow(name: string, window: string): number[] {
  // window "1h" / "24h" — stub maps to last N points
  const arr = metrics.get(name) ?? []
  const n = window === '1h' ? 20 : window === '24h' ? 100 : arr.length
  return arr.slice(-n)
}

/**
 * Simple drift check: compare recent window vs older baseline.
 * alert if |current-baseline|/baseline > threshold.
 * Reports "insufficient data" honestly instead of fabricating a stable baseline.
 */
export async function checkDrift(
  metric: string,
  opts: { window: string; threshold: number },
): Promise<DriftCheckResult> {
  const arr = getMetricWindow(metric, opts.window)
  if (arr.length < 5) {
    return {
      metric,
      window: opts.window,
      baseline: 0,
      current: 0,
      driftPct: undefined,
      threshold: opts.threshold,
      alert: false,
      message: `${metric}: insufficient data (${arr.length} points) — drift not measured`,
    }
  }
  const mid = Math.floor(arr.length / 2)
  const baselineSlice = arr.slice(0, mid)
  const currentSlice = arr.slice(mid)
  const baseline = baselineSlice.reduce((a, b) => a + b, 0) / (baselineSlice.length || 1)
  const current = currentSlice.reduce((a, b) => a + b, 0) / (currentSlice.length || 1)
  const driftPct = baseline !== 0 ? (current - baseline) / baseline : 0
  const alert = Math.abs(driftPct) > opts.threshold
  return {
    metric,
    window: opts.window,
    baseline,
    current,
    driftPct,
    threshold: opts.threshold,
    alert,
    message: alert
      ? `ALERT ${metric} drift ${(driftPct * 100).toFixed(1)}% > ${(opts.threshold * 100).toFixed(0)}% (${baseline.toFixed(2)} → ${current.toFixed(2)})`
      : `${metric} stable drift ${(driftPct * 100).toFixed(1)}%`,
  }
}

// ── Helpers for eval runner ─────────────────────────────────────────

export function withTracing<T>(traceName: string, fn: (trace: Trace) => Promise<T>): Promise<T> {
  const trace = createTrace(traceName)
  const span = startSpan(trace, traceName)
  return fn(trace)
    .then((v) => {
      endSpan(span, { ok: true })
      return v
    })
    .catch((e) => {
      endSpan(span, { error: String(e) }, true)
      throw e
    })
    .finally(() => {
      flush().catch(() => {})
    })
}

export interface ExportedTraceSpan {
  spanId: string
  name: string
  startMs: number
  endMs?: number
  durationMs?: number
  status: 'ok' | 'error'
  attributes: SpanAttributes
}

export interface ExportedTrace {
  traceId: string
  name: string
  spans: ExportedTraceSpan[]
}

export interface ExportedTraces {
  resource: { service: string; version: string }
  traces: ExportedTrace[]
}

/** Export traces in OTel-ish JSON (for Langfuse/Braintrust upload or local debug) */
export function exportTraces(): ExportedTraces {
  return {
    resource: { service: 'mira-eval', version: '0.1.0' },
    traces: [...traces.values()].map((t) => ({
      traceId: t.traceId,
      name: t.name,
      spans: t.spans.map((s) => ({
        spanId: s.spanId,
        name: s.name,
        startMs: s.startMs,
        endMs: s.endMs,
        durationMs: s.endMs ? s.endMs - s.startMs : undefined,
        status: s.status,
        attributes: s.attributes,
      })),
    })),
  }
}
