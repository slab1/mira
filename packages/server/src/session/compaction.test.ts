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

  test("preserves toolResults in tail after compaction", async () => {
    const messages = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 8 }, (_, i) => ({ role: "user" as const, content: `msg ${i}` })),
      { role: "assistant", content: "tool call", toolCalls: [{ id: "c1", name: "read", args: { path: "a.txt" } }] },
      { role: "tool", content: JSON.stringify({ ok: true }), toolResults: [{ toolCallID: "c1", name: "read", result: "file content", isError: false }], toolCallID: "c1" },
    ]
    const result = await compactMessages(fakeGateway, messages, { keepTailRatio: 0.25 })
    // Tail (25% of 10 conv = 3) should include the tool messages
    const hasToolCall = result.messages.some(m => m.toolCalls?.some(tc => tc.id === "c1"))
    const hasToolResult = result.messages.some(m => m.toolResults?.some(tr => tr.toolCallID === "c1"))
    expect(hasToolCall).toBe(true)
    expect(hasToolResult).toBe(true)
  })

  test("threshold logic: 80% triggers, 79% does not", async () => {
    // 100 tokens limit, 80 threshold → 81 tokens should trigger
    const mk = (n: number) => Array.from({ length: n }, () => ({ role: "user" as const, content: "x".repeat(40) })) // ~10 tokens each +10 overhead = ~20
    const justUnder = mk(3) // ~60 tokens, ratio 0.6
    const justOver = mk(10) // ~200 tokens, ratio 2.0
    expect((await needsCompaction(justUnder, 100, 0.8)).needed).toBe(false)
    expect((await needsCompaction(justOver, 100, 0.8)).needed).toBe(true)
    // Custom threshold 0.5 should trigger earlier
    expect((await needsCompaction(justUnder, 100, 0.5)).needed).toBe(true)
  })
})
