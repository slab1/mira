import { describe, test, expect } from "bun:test"
import type { Gateway } from "../gateway/index.js"
import { estimateTokens, needsCompaction, compactMessages } from "./compaction.js"

// Minimal gateway whose summarize echoes a marker (verifies wiring)
const fakeGateway: Gateway = {
  stream: async () => { throw new Error("not used") },
  complete: async () => ({ text: "" }),
  summarize: async (messages) => `SUMMARY_OF_${messages.length}`,
  listModels: async () => [],
  stats: () => ({ requests: 0, inputTokens: 0, outputTokens: 0, costUSD: 0, avgLatencyMs: 0, byModel: {} }),
}

describe("estimateTokens", () => {
  test("scales with content length", () => {
    const small = estimateTokens([{ role: "user", content: "hi" }])
    const big = estimateTokens([{ role: "user", content: "x".repeat(800) }])
    expect(big).toBeGreaterThan(small * 5)
  })
})

describe("needsCompaction", () => {
  test("flags when over threshold", async () => {
    const msgs = [{ role: "user", content: "x".repeat(800_000) }]
    const r = await needsCompaction(msgs, 100_000, 0.8)
    expect(r.needed).toBe(true)
    expect(r.ratio).toBeGreaterThan(0.8)
  })

  test("clear when tiny", async () => {
    const r = await needsCompaction([{ role: "user", content: "hi" }], 128_000, 0.8)
    expect(r.needed).toBe(false)
  })
})

describe("compactMessages", () => {
  test("keeps system messages + tail, replaces head with summary block", async () => {
    const messages = [
      { role: "system", content: "sys prompt" },
      ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `msg ${i}` })),
    ]
    const result = await compactMessages(fakeGateway, messages, { keepTailRatio: 0.25 })
    const roles = result.messages.map(m => m.role)
    expect(roles[0]).toBe("system")
    const summaryBlock = result.messages.find(m => m.__meta?.compacted === true)
    expect(summaryBlock).toBeDefined()
    expect(summaryBlock?.content).toContain("SUMMARY_OF_")
    expect(result.originalCount).toBe(11)
    expect(result.compactedCount).toBeLessThan(11)
  })

  test("no-op for very short conversations", async () => {
    const messages = [{ role: "user", content: "hello" }]
    const result = await compactMessages(fakeGateway, messages)
    expect(result.summary).toBe("")
    expect(result.messages).toEqual(messages)
  })
})
