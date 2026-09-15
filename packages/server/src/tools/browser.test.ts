import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test"
import { browserTool, closeBrowser } from "./browser.js"

const ctx = { sessionID: "test-browser", messageID: "msg-1" }

// ── Schema validation tests ────────────────────────────────────────

describe("browser schema validation", () => {
  test("navigate requires url", async () => {
    const result = await browserTool.schema.safeParseAsync({ action: "navigate" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes("url"))).toBe(true)
    }
  })

  test("fetch requires url", async () => {
    const result = await browserTool.schema.safeParseAsync({ action: "fetch" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes("url"))).toBe(true)
    }
  })

  test("click requires selector", async () => {
    const result = await browserTool.schema.safeParseAsync({ action: "click", url: "https://example.com" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes("selector"))).toBe(true)
    }
  })

  test("click with url and selector passes", async () => {
    const result = await browserTool.schema.safeParseAsync({ action: "click", url: "https://example.com", selector: "#btn" })
    expect(result.success).toBe(true)
  })

  test("type requires selector and text", async () => {
    const result = await browserTool.schema.safeParseAsync({ action: "type", url: "https://example.com" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes("selector"))).toBe(true)
    }
  })

  test("type with all required fields passes", async () => {
    const result = await browserTool.schema.safeParseAsync({
      action: "type", url: "https://example.com", selector: "#input", text: "hello"
    })
    expect(result.success).toBe(true)
  })

  test("screenshot does not require url (can use active page)", async () => {
    const result = await browserTool.schema.safeParseAsync({ action: "screenshot" })
    expect(result.success).toBe(true)
  })

  test("screenshot with url and selector passes", async () => {
    const result = await browserTool.schema.safeParseAsync({
      action: "screenshot", url: "https://example.com", selector: ".hero"
    })
    expect(result.success).toBe(true)
  })

  test("scroll has default direction and amount", async () => {
    const result = await browserTool.schema.safeParseAsync({ action: "scroll" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.direction).toBe("down")
      expect(result.data.amount).toBe(500)
    }
  })

  test("scroll with all options passes", async () => {
    const result = await browserTool.schema.safeParseAsync({
      action: "scroll", url: "https://example.com", direction: "up", amount: 1000
    })
    expect(result.success).toBe(true)
  })

  test("scroll rejects invalid direction", async () => {
    const result = await browserTool.schema.safeParseAsync({
      action: "scroll", direction: "diagonal"
    })
    expect(result.success).toBe(false)
  })

  test("scroll rejects negative amount", async () => {
    const result = await browserTool.schema.safeParseAsync({
      action: "scroll", amount: -100
    })
    expect(result.success).toBe(false)
  })

  test("invalid action rejected", async () => {
    const result = await browserTool.schema.safeParseAsync({ action: "download" })
    expect(result.success).toBe(false)
  })

  test("url must be valid format", async () => {
    const result = await browserTool.schema.safeParseAsync({
      action: "navigate", url: "not-a-url"
    })
    expect(result.success).toBe(false)
  })

  test("maxChars has bounds", async () => {
    const tooLow = await browserTool.schema.safeParseAsync({
      action: "fetch", url: "https://example.com", maxChars: 50
    })
    expect(tooLow.success).toBe(false)

    const tooHigh = await browserTool.schema.safeParseAsync({
      action: "fetch", url: "https://example.com", maxChars: 200000
    })
    expect(tooHigh.success).toBe(false)

    const valid = await browserTool.schema.safeParseAsync({
      action: "fetch", url: "https://example.com", maxChars: 50000
    })
    expect(valid.success).toBe(true)
  })
})

// ── Tool metadata tests ────────────────────────────────────────────

describe("browser tool metadata", () => {
  test("name is browser", () => {
    expect(browserTool.name).toBe("browser")
  })

  test("category is web", () => {
    expect(browserTool.category).toBe("web")
  })

  test("has description", () => {
    expect(browserTool.description.length).toBeGreaterThan(10)
  })

  test("execute is a function", () => {
    expect(typeof browserTool.execute).toBe("function")
  })
})

// ── Execute tests (Playwright available in this env) ───────────────

const canLaunchBrowser = async (): Promise<boolean> => {
  try {
    const pw = await import("playwright")
    const b = await pw.chromium.launch({ headless: true, args: ["--no-sandbox"] })
    await b.close()
    return true
  } catch {
    return false
  }
}

describe("browser execute", () => {
  let hasBrowser = false
  beforeAll(async () => { hasBrowser = await canLaunchBrowser() })
  afterEach(async () => {
    await closeBrowser()
  })

  test("navigate returns structured JSON with url and content", async () => {
    if (!hasBrowser) return
    const result = await browserTool.execute({
      action: "navigate", url: "https://example.com"
    }, ctx) as Record<string, unknown>

    expect(result).toHaveProperty("url", "https://example.com")
    expect(result).toHaveProperty("content")
    expect(typeof result.content).toBe("string")
    expect(result.via).toBe("playwright")
  })

  test("fetch returns content from a static page", async () => {
    if (!hasBrowser) return
    const result = await browserTool.execute({
      action: "fetch", url: "https://example.com"
    }, ctx) as Record<string, unknown>

    expect(result).toHaveProperty("content")
    expect(typeof result.content).toBe("string")
    expect((result.content as string).length).toBeGreaterThan(0)
  })

  test("click on active page returns success", async () => {
    if (!hasBrowser) return
    const navResult = await browserTool.execute({
      action: "navigate", url: "https://example.com"
    }, ctx) as Record<string, unknown>
    expect(navResult.via).toBe("playwright")

    const result = await browserTool.execute({
      action: "click", url: "https://example.com", selector: "a"
    }, ctx) as Record<string, unknown>

    expect(result).toHaveProperty("via", "playwright")
    expect(result).toHaveProperty("selector", "a")
  })

  test("type on active page returns success", async () => {
    if (!hasBrowser) return
    await browserTool.execute({ action: "navigate", url: "https://example.com" }, ctx)

    const result = await browserTool.execute({
      action: "type", url: "https://example.com", selector: "input[name=q]", text: "test"
    }, ctx) as Record<string, unknown>

    expect(result).toHaveProperty("via", "playwright")
    expect(result).toHaveProperty("selector")
  })

  test("screenshot returns base64 PNG", async () => {
    if (!hasBrowser) return
    const result = await browserTool.execute({
      action: "screenshot", url: "https://example.com"
    }, ctx) as Record<string, unknown>

    expect(result).toHaveProperty("success", true)
    expect(result).toHaveProperty("base64")
    expect(typeof result.base64).toBe("string")
    expect((result.base64 as string).length).toBeGreaterThan(100)
  })

  test("screenshot with invalid selector returns error", async () => {
    if (!hasBrowser) return
    await browserTool.execute({ action: "navigate", url: "https://example.com" }, ctx)

    const result = await browserTool.execute({
      action: "screenshot", url: "https://example.com", selector: "#nonexistent"
    }, ctx) as Record<string, unknown>

    expect(result.error).toContain("not found")
    expect(result.code).toBe("NO_SUCH_ELEMENT")
  })

  test("scroll down on page returns position info", async () => {
    if (!hasBrowser) return
    await browserTool.execute({ action: "navigate", url: "https://example.com" }, ctx)

    const result = await browserTool.execute({
      action: "scroll", url: "https://example.com", direction: "down", amount: 300
    }, ctx) as Record<string, unknown>

    expect(result).toHaveProperty("success", true)
    expect(result).toHaveProperty("direction", "down")
    expect(result).toHaveProperty("scrollY")
    expect(result).toHaveProperty("docHeight")
  })

  test("scroll up on page works", async () => {
    if (!hasBrowser) return
    await browserTool.execute({ action: "navigate", url: "https://example.com" }, ctx)

    await browserTool.execute({
      action: "scroll", url: "https://example.com", direction: "down", amount: 1000
    }, ctx)

    const result = await browserTool.execute({
      action: "scroll", url: "https://example.com", direction: "up", amount: 500
    }, ctx) as Record<string, unknown>

    expect(result).toHaveProperty("success", true)
    expect(result).toHaveProperty("direction", "up")
  })

  test("scroll with selector scrolls that element", async () => {
    if (!hasBrowser) return
    await browserTool.execute({ action: "navigate", url: "https://example.com" }, ctx)

    const result = await browserTool.execute({
      action: "scroll", url: "https://example.com", selector: "body", direction: "down", amount: 200
    }, ctx) as Record<string, unknown>

    expect(result).toHaveProperty("success", true)
    expect(result).toHaveProperty("selector", "body")
  })

  test("unknown action returns error", async () => {
    const result = await browserTool.execute({
      action: "download" as string, url: "https://example.com"
    }, ctx) as Record<string, unknown>

    expect(result.error).toContain("unknown browser action")
  })
})

// ── Edge cases (require real Playwright + chromium) ─────────────────

describe("browser edge cases", () => {
  let hasBrowser = false
  beforeAll(async () => { hasBrowser = await canLaunchBrowser() })
  afterEach(async () => { await closeBrowser() })

  test("navigate handles invalid URL gracefully", async () => {
    if (!hasBrowser) return
    const result = await browserTool.execute({
      action: "navigate", url: "https://this-domain-definitely-does-not-exist-12345.com"
    }, ctx) as Record<string, unknown>

    // Should return an error, not throw
    expect(result).toHaveProperty("error")
    expect(result).toHaveProperty("via", "navigate")
  })

  test("click on nonexistent selector returns structured error", async () => {
    if (!hasBrowser) return
    await browserTool.execute({ action: "navigate", url: "https://example.com" }, ctx)

    const result = await browserTool.execute({
      action: "click", url: "https://example.com", selector: "#does-not-exist"
    }, ctx) as Record<string, unknown>

    expect(result).toHaveProperty("error")
    expect(result).toHaveProperty("code")
  })

  test("consecutive actions on same page", async () => {
    if (!hasBrowser) return
    const nav = await browserTool.execute({
      action: "navigate", url: "https://example.com"
    }, ctx) as Record<string, unknown>
    expect(nav.via).toBe("playwright")

    const ss = await browserTool.execute({
      action: "screenshot", url: "https://example.com"
    }, ctx) as Record<string, unknown>
    expect(ss.success).toBe(true)

    const sc = await browserTool.execute({
      action: "scroll", url: "https://example.com", direction: "down", amount: 100
    }, ctx) as Record<string, unknown>
    expect(sc.success).toBe(true)
  })
})
