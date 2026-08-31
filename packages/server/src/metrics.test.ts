import { describe, expect, test } from "bun:test"
import {
  DURATION_BUCKETS_SECONDS,
  MetricsCollector,
  bucketIndex,
} from "./metrics.js"

describe("bucketIndex", () => {
  test("routes durations into the right bucket (last = +Inf)", () => {
    expect(bucketIndex(0.001)).toBe(0)
    expect(bucketIndex(0.05)).toBe(0)
    expect(bucketIndex(0.051)).toBe(1)
    expect(bucketIndex(0.5)).toBe(2)
    expect(bucketIndex(1)).toBe(3)
    expect(bucketIndex(5)).toBe(4)
    expect(bucketIndex(99)).toBe(5) // +Inf
  })
})

describe("MetricsCollector", () => {
  test("counts requests by method/route/status", () => {
    const m = new MetricsCollector()
    m.record("GET", "/health", 200, 0.01)
    m.record("GET", "/health", 200, 0.02)
    m.record("GET", "/health", 500, 0.03)
    expect(m.httpRequestsTotal.get("GET /health 200")).toBe(2)
    expect(m.httpRequestsTotal.get("GET /health 500")).toBe(1)
  })

  test("real histogram: buckets reflect the actual latency distribution", () => {
    const m = new MetricsCollector()
    m.record("POST", "/session/:id/prompt", 200, 0.01) // bucket 0
    m.record("POST", "/session/:id/prompt", 200, 0.09) // bucket 1
    m.record("POST", "/session/:id/prompt", 200, 3.0) // bucket 4
    const buckets = m.durationsByRoute.get("POST /session/:id/prompt")!
    expect(buckets[0]).toBe(1)
    expect(buckets[1]).toBe(1)
    expect(buckets[4]).toBe(1)
    expect(m.httpRequestDurationSecondsCount).toBe(3)
    // Per-route sum reflects actual latency, not the global sum
    expect(m.durationSumByRoute.get("POST /session/:id/prompt")).toBeCloseTo(3.1)
  })

  test("LRU eviction: cardinality stays capped at maxLabels, active labels never dropped", () => {
    const m = new MetricsCollector(3)
    m.record("GET", "/a", 200, 0.01)
    m.record("GET", "/b", 200, 0.01)
    m.record("GET", "/c", 200, 0.01)
    expect(m.httpRequestsTotal.size).toBe(3)
    // Touch /a again (moves it to most-recent), then add /d -> evicts least-recent (/b)
    m.record("GET", "/a", 200, 0.01)
    m.record("GET", "/d", 200, 0.01)
    expect(m.httpRequestsTotal.size).toBe(3) // hard capped
    expect(m.httpRequestsTotal.has("GET /a 200")).toBe(true) // active label survives
    expect(m.httpRequestsTotal.has("GET /b 200")).toBe(false) // least-recent evicted
    expect(m.httpRequestsTotal.get("GET /d 200")).toBe(1) // newcomer recorded (no silent drop)
  })

  test("never silently drops new labels when full", () => {
    const m = new MetricsCollector(2)
    m.record("GET", "/x", 200, 0.001)
    m.record("GET", "/y", 200, 0.001)
    m.record("GET", "/z", 200, 0.001) // must be recorded, evicting one
    expect(m.httpRequestsTotal.get("GET /z 200")).toBe(1)
    expect(m.httpRequestsTotal.size).toBe(2)
  })

  test("histogram maps stay in sync (same keys) under LRU eviction", () => {
    const m = new MetricsCollector(2)
    m.record("GET", "/a", 200, 0.01)
    m.record("GET", "/b", 200, 0.02)
    expect(m.durationsByRoute.size).toBe(2)
    expect(m.durationSumByRoute.size).toBe(2)
    // /c evicts least-recent from BOTH histogram maps together (no key drift)
    m.record("GET", "/c", 200, 0.03)
    expect(m.durationsByRoute.size).toBe(2)
    expect(m.durationSumByRoute.size).toBe(2)
    expect(m.durationsByRoute.has("GET /c")).toBe(true)
    expect(m.durationSumByRoute.has("GET /c")).toBe(true)
    const keys = [...m.durationsByRoute.keys()]
    for (const k of keys) expect(m.durationSumByRoute.has(k)).toBe(true)
  })

  test("activeSessions toggles tracked directly by middleware (documented)", () => {
    const m = new MetricsCollector()
    expect(m.activeSessions).toBe(0)
  })
})
