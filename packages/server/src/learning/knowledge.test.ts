import { describe, test, expect } from "bun:test"
import { embedKeyword, cosine } from "./knowledge.js"

describe("embedKeyword", () => {
  test("produces unit-length vector", () => {
    const v = embedKeyword("hello world hello")
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1.0, 5)
  })

  test("is deterministic", () => {
    expect(embedKeyword("agent memory retrieval")).toEqual(embedKeyword("agent memory retrieval"))
  })

  test("similar texts score higher than dissimilar", () => {
    const a = embedKeyword("agent tool execution permission guardrail")
    const similar = embedKeyword("tool permission agent guardrail execution")
    const different = embedKeyword("cooking recipe pasta tomato basil")
    expect(cosine(a, similar)).toBeGreaterThan(cosine(a, different))
  })

  test("empty text yields zero vector", () => {
    const v = embedKeyword("")
    expect(v.every((x) => x === 0)).toBe(true)
  })
})

describe("cosine", () => {
  test("identical vectors → ~1", () => {
    const v = embedKeyword("mira agent platform")
    expect(cosine(v, v)).toBeCloseTo(1.0, 5)
  })

  test("orthogonal-ish vectors → low score", () => {
    const a = embedKeyword("alpha beta gamma delta")
    const b = embedKeyword("epsilon zeta eta theta")
    expect(cosine(a, b)).toBeLessThan(0.5)
  })
})
