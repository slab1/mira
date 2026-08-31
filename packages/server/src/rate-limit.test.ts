import { describe, expect, test } from "bun:test"
import {
  RATE_LIMIT_CAPACITY,
  RATE_LIMIT_SSE_CAPACITY,
  choosePeerIP,
  isSSERoute,
} from "./rate-limit.js"

describe("choosePeerIP", () => {
  test("non-proxy mode uses the real socket peer, ignoring forged headers", () => {
    const peer = choosePeerIP({
      trustProxy: false,
      xForwardedFor: "1.2.3.4",
      xRealIp: "5.6.7.8",
      socketPeer: "::ffff:127.0.0.1",
    })
    expect(peer).toBe("::ffff:127.0.0.1")
  })

  test("non-proxy mode does NOT create a per-header bucket (security: anti-bypass)", () => {
    // A different forged header value must NOT yield a different key in default mode.
    const a = choosePeerIP({
      trustProxy: false,
      xForwardedFor: "10.0.0.1",
      xRealIp: "10.0.0.1",
      socketPeer: "127.0.0.1",
    })
    const b = choosePeerIP({
      trustProxy: false,
      xForwardedFor: "10.0.0.2",
      xRealIp: "10.0.0.2",
      socketPeer: "127.0.0.1",
    })
    expect(a).toBe(b) // same bucket, forged headers gave no fresh key
  })

  test("falls back to unknown (never a forged value) when no socket peer available", () => {
    const peer = choosePeerIP({
      trustProxy: false,
      xForwardedFor: "203.0.113.9",
      xRealIp: "203.0.113.9",
      socketPeer: null,
    })
    expect(peer).toBe("unknown")
  })

  test("proxy mode honors the left-most x-forwarded-for entry", () => {
    const peer = choosePeerIP({
      trustProxy: true,
      xForwardedFor: "198.51.100.7, 10.0.0.1",
      xRealIp: "10.0.0.1",
      socketPeer: "127.0.0.1",
    })
    expect(peer).toBe("198.51.100.7")
  })

  test("proxy mode falls back to x-real-ip when no x-forwarded-for", () => {
    const peer = choosePeerIP({
      trustProxy: true,
      xForwardedFor: undefined,
      xRealIp: "203.0.113.5",
      socketPeer: "127.0.0.1",
    })
    expect(peer).toBe("203.0.113.5")
  })
})

describe("isSSERoute", () => {
  test("matches POST /session/:id/prompt", () => {
    expect(isSSERoute("POST", "/session/abc123/prompt")).toBe(true)
  })

  test("matches POST /session/:id/queue", () => {
    expect(isSSERoute("POST", "/session/abc123/queue")).toBe(true)
  })

  test("does not match non-POST requests", () => {
    expect(isSSERoute("GET", "/session/abc123/prompt")).toBe(false)
  })

  test("does not match unrelated POST routes", () => {
    expect(isSSERoute("POST", "/session/abc123")).toBe(false)
  })
})

describe("capacities", () => {
  test("SSE bucket is stricter than the default", () => {
    expect(RATE_LIMIT_SSE_CAPACITY).toBeLessThan(RATE_LIMIT_CAPACITY)
  })
})
