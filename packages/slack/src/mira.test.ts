import { describe, test, expect } from "bun:test"
import { truncateForSlack, parseSseFrames, extractTextDelta } from "./mira.js"

describe("truncateForSlack", () => {
  test("passes through short text", () => {
    expect(truncateForSlack("hello", 10)).toBe("hello")
  })
  test("truncates long text with head + tail", () => {
    const long = "a".repeat(5000)
    const out = truncateForSlack(long, 2900)
    expect(out.length).toBeLessThan(5000)
    expect(out).toContain("truncated")
    expect(out.slice(0, 100)).toBe("a".repeat(100))
  })
  test("exact max is not truncated", () => {
    const s = "x".repeat(2900)
    expect(truncateForSlack(s, 2900)).toBe(s)
  })
})

describe("parseSseFrames", () => {
  test("splits SSE double-newline frames", () => {
    const raw = `data: {"type":"text-delta","textDelta":"hi"}\n\ndata: {"type":"finish"}\n\n`
    const frames = parseSseFrames(raw)
    expect(frames.length).toBe(2)
    expect(frames[0]!.data).toContain("text-delta")
    expect(frames[1]!.data).toContain("finish")
  })
  test("skips [DONE] sentinel", () => {
    const raw = `data: [DONE]\n\ndata: {"type":"text-delta","textDelta":"x"}\n\n`
    const frames = parseSseFrames(raw)
    expect(frames.length).toBe(1)
  })
  test("captures event: line", () => {
    const raw = `event: text-delta\ndata: {"textDelta":"yo"}\n\n`
    const frames = parseSseFrames(raw)
    expect(frames[0]!.eventType).toBe("text-delta")
  })
  test("empty yields 0", () => {
    expect(parseSseFrames("")).toEqual([])
  })
})

describe("extractTextDelta", () => {
  test("text-delta type", () => {
    expect(extractTextDelta({ type: "text-delta", textDelta: "hello" }, "")).toBe("hello")
  })
  test("text fallback", () => {
    expect(extractTextDelta({ text: "hi" }, "")).toBe("hi")
  })
  test("content fallback", () => {
    expect(extractTextDelta({ content: "c" }, "")).toBe("c")
  })
  test("non-text payload returns null", () => {
    expect(extractTextDelta({ type: "tool-call", toolName: "read" }, "")).toBeNull()
  })
  test("eventType fallback", () => {
    expect(extractTextDelta({ textDelta: "via-event" }, "text-delta")).toBe("via-event")
  })
})
