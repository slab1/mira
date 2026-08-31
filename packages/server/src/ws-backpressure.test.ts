import { describe, test, expect } from "bun:test"
import { boundSend, WS_SEND_MAX_MESSAGE, WS_SEND_MAX_BUFFERED } from "./ws-backpressure.js"

function fakeSink(overrides: Partial<{
  __active: boolean
  buffered: number
  getBufferedAmount: () => number
  sendThrows: boolean
}> = {}) {
  const sent: string[] = []
  let throwOnSend = overrides.sendThrows ?? false
  const sink = {
    __active: overrides.__active ?? true,
    sent,
    setSendThrows: (v: boolean) => { throwOnSend = v },
    getBufferedAmount: overrides.getBufferedAmount ?? (() => overrides.buffered ?? 0),
    send(data: string) {
      if (throwOnSend) throw new Error("socket closed")
      sent.push(data)
    },
  }
  return sink
}

describe("boundSend (WS fan-out backpressure)", () => {
  test("active socket under threshold sends and returns true", () => {
    const s = fakeSink({ buffered: 0 })
    expect(boundSend(s, "hello")).toBe(true)
    expect(s.sent).toEqual(["hello"])
  })

  test("sends when backlog is at (not above) the capped threshold", () => {
    const s = fakeSink({ buffered: WS_SEND_MAX_BUFFERED })
    expect(boundSend(s, "x".repeat(100))).toBe(true)
    expect(s.sent.length).toBe(1)
  })

  test("inactive socket is refused without sending", () => {
    const s = fakeSink({ __active: false, buffered: 0 })
    expect(boundSend(s, "hello")).toBe(false)
    expect(s.sent.length).toBe(0)
  })

  test("oversized message (>1MB) is refused without sending", () => {
    const s = fakeSink({ buffered: 0 })
    const big = "x".repeat(WS_SEND_MAX_MESSAGE + 1)
    expect(boundSend(s, big)).toBe(false)
    expect(s.sent.length).toBe(0)
  })

  test("socket too far behind (>8MB backlog) is refused without sending", () => {
    const s = fakeSink({ buffered: WS_SEND_MAX_BUFFERED + 1 })
    expect(boundSend(s, "hello")).toBe(false)
    expect(s.sent.length).toBe(0)
  })

  test("socket without getBufferedAmount is never refused on backlog (legacy compat)", () => {
    const s = fakeSink()
    delete (s as { getBufferedAmount?: unknown }).getBufferedAmount
    expect(boundSend(s, "hello")).toBe(true)
    expect(s.sent).toEqual(["hello"])
  })

  test("send() throwing (dead socket) returns false and is treated as eviction signal", () => {
    const s = fakeSink({ buffered: 0 })
    s.setSendThrows(true)
    expect(boundSend(s, "hello")).toBe(false)
  })
})
