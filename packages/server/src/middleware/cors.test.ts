import { describe, expect, test, beforeEach, afterEach } from "bun:test"

/**
 * F5 parity test: isOriginAllowed (WS) vs corsOrigin (HTTP) must mirror.
 * - empty CORS_ORIGIN_LIST → only isLocalDevOrigin + vscode (not any origin)
 * - prod with CORS_ORIGINS set → only allowlisted + localhost if MIRA_ALLOW_LOCALHOST=1, vscode always
 * - isLocalDevOrigin checks localhost, 127.0.0.1, [::1] with http/https/ws/wss
 */

// Replicate the helpers exactly as in middleware/index.ts and index.ts
const isVscodeOrigin = (origin: string): boolean =>
  origin.startsWith("vscode-webview://") ||
  origin.startsWith("vscode-file://") ||
  origin.startsWith("vscode:")

const isLocalDevOrigin = (origin: string): boolean => {
  try {
    const u = new URL(origin)
    const host = u.hostname
    return (
      (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") &&
      (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:")
    )
  } catch {
    return false
  }
}

function makeIsOriginAllowed(corsList: string[]) {
  const normalizedAllowSet = new Set(
    corsList.map((o) => {
      try {
        return new URL(o).origin
      } catch {
        return o
      }
    }),
  )
  return (origin: string | null | undefined): boolean => {
    if (!origin) return true
    if (isVscodeOrigin(origin)) return true
    if (corsList.length === 0) return isLocalDevOrigin(origin)
    try {
      const normalized = new URL(origin).origin
      if (normalizedAllowSet.has(normalized)) return true
    } catch {
      if (corsList.includes(origin)) return true
      return false
    }
    if (process.env.MIRA_ALLOW_LOCALHOST === "1" && isLocalDevOrigin(origin)) return true
    return false
  }
}

function makeCorsOrigin(corsList: string[]) {
  const normalizedAllowSet = new Set(
    corsList.map((o) => {
      try {
        return new URL(o).origin
      } catch {
        return o
      }
    }),
  )
  if (corsList.length > 0) {
    return (origin: string | undefined): string => {
      if (!origin) return ""
      if (isVscodeOrigin(origin)) return origin
      let normalized: string
      try {
        normalized = new URL(origin).origin
      } catch {
        return ""
      }
      if (normalizedAllowSet.has(normalized)) return normalized
      if (isLocalDevOrigin(origin) && process.env.MIRA_ALLOW_LOCALHOST === "1") return normalized
      return ""
    }
  } else {
    return (origin: string | undefined): string => {
      if (!origin) return ""
      if (isVscodeOrigin(origin)) return origin
      if (!isLocalDevOrigin(origin)) return ""
      try {
        return new URL(origin).origin
      } catch {
        return ""
      }
    }
  }
}

describe("F5 isOriginAllowed vs corsOrigin parity", () => {
  const origAllow = process.env.MIRA_ALLOW_LOCALHOST

  afterEach(() => {
    if (origAllow === undefined) delete process.env.MIRA_ALLOW_LOCALHOST
    else process.env.MIRA_ALLOW_LOCALHOST = origAllow
  })

  test("isLocalDevOrigin checks localhost, 127.0.0.1, [::1] with http/https/ws/wss", () => {
    expect(isLocalDevOrigin("http://localhost:3000")).toBe(true)
    expect(isLocalDevOrigin("https://localhost:3000")).toBe(true)
    expect(isLocalDevOrigin("ws://localhost:3000")).toBe(true)
    expect(isLocalDevOrigin("wss://localhost:3000")).toBe(true)
    expect(isLocalDevOrigin("http://127.0.0.1:3000")).toBe(true)
    expect(isLocalDevOrigin("https://127.0.0.1:3000")).toBe(true)
    expect(isLocalDevOrigin("ws://127.0.0.1:3000")).toBe(true)
    expect(isLocalDevOrigin("wss://127.0.0.1:3000")).toBe(true)
    expect(isLocalDevOrigin("http://[::1]:3000")).toBe(true)
    expect(isLocalDevOrigin("https://[::1]:3000")).toBe(true)
    expect(isLocalDevOrigin("ws://[::1]:3000")).toBe(true)
    expect(isLocalDevOrigin("wss://[::1]:3000")).toBe(true)
    // negative
    expect(isLocalDevOrigin("https://evil.com")).toBe(false)
    expect(isLocalDevOrigin("http://example.com")).toBe(false)
    expect(isLocalDevOrigin("ftp://localhost:3000")).toBe(false)
    expect(isLocalDevOrigin("vscode-webview://123")).toBe(false)
  })

  test("vscode-webview:// always allowed", () => {
    const devIsAllowed = makeIsOriginAllowed([])
    const devCors = makeCorsOrigin([])
    expect(devIsAllowed("vscode-webview://123")).toBe(true)
    expect(devCors("vscode-webview://123")).not.toBe("")
    expect(devIsAllowed("vscode-file://abc")).toBe(true)
    expect(devCors("vscode-file://abc")).not.toBe("")
    expect(devIsAllowed("vscode:extension")).toBe(true)
    expect(devCors("vscode:extension")).not.toBe("")

    const prodIsAllowed = makeIsOriginAllowed(["https://slab1.github.io"])
    const prodCors = makeCorsOrigin(["https://slab1.github.io"])
    expect(prodIsAllowed("vscode-webview://123")).toBe(true)
    expect(prodCors("vscode-webview://123")).not.toBe("")
  })

  test("empty list (dev) → only localhost, not any origin", () => {
    delete process.env.MIRA_ALLOW_LOCALHOST
    const isAllowed = makeIsOriginAllowed([])
    const cors = makeCorsOrigin([])

    // localhost allowed
    expect(isAllowed("http://localhost:3000")).toBe(true)
    expect(cors("http://localhost:3000")).toBe("http://localhost:3000")
    expect(isAllowed("https://127.0.0.1:4000")).toBe(true)
    expect(cors("https://127.0.0.1:4000")).toBe("https://127.0.0.1:4000")
    expect(isAllowed("ws://localhost:3000")).toBe(true)
    expect(cors("ws://localhost:3000")).toBe("ws://localhost:3000")
    expect(isAllowed("wss://[::1]:3000")).toBe(true)
    expect(cors("wss://[::1]:3000")).toBe("wss://[::1]:3000")

    // evil blocked
    expect(isAllowed("https://evil.com")).toBe(false)
    expect(cors("https://evil.com")).toBe("")
    expect(isAllowed("https://slab1.github.io")).toBe(false)
    expect(cors("https://slab1.github.io")).toBe("")

    // null/undefined (no Origin header) allowed
    expect(isAllowed(null)).toBe(true)
    expect(isAllowed(undefined)).toBe(true)
    expect(cors(undefined)).toBe("")
    expect(cors("")).toBe("")
  })

  test("prod with CORS_ORIGINS set → only allowlisted + localhost if MIRA_ALLOW_LOCALHOST=1", () => {
    const allowlist = ["https://slab1.github.io", "https://mira.example.com"]
    delete process.env.MIRA_ALLOW_LOCALHOST
    const isAllowedNoGate = makeIsOriginAllowed(allowlist)
    const corsNoGate = makeCorsOrigin(allowlist)

    // allowlisted allowed
    expect(isAllowedNoGate("https://slab1.github.io")).toBe(true)
    expect(corsNoGate("https://slab1.github.io")).toBe("https://slab1.github.io")
    expect(isAllowedNoGate("https://mira.example.com")).toBe(true)
    expect(corsNoGate("https://mira.example.com")).toBe("https://mira.example.com")

    // localhost blocked without gate
    expect(isAllowedNoGate("http://localhost:3000")).toBe(false)
    expect(corsNoGate("http://localhost:3000")).toBe("")
    expect(isAllowedNoGate("http://127.0.0.1:3000")).toBe(false)
    expect(corsNoGate("http://127.0.0.1:3000")).toBe("")

    // evil blocked
    expect(isAllowedNoGate("https://evil.com")).toBe(false)
    expect(corsNoGate("https://evil.com")).toBe("")

    // with gate, localhost allowed
    process.env.MIRA_ALLOW_LOCALHOST = "1"
    const isAllowedGate = makeIsOriginAllowed(allowlist)
    const corsGate = makeCorsOrigin(allowlist)
    expect(isAllowedGate("http://localhost:3000")).toBe(true)
    expect(corsGate("http://localhost:3000")).toBe("http://localhost:3000")
    expect(isAllowedGate("https://127.0.0.1:3000")).toBe(true)
    expect(corsGate("https://127.0.0.1:3000")).toBe("https://127.0.0.1:3000")
    expect(isAllowedGate("ws://localhost:3000")).toBe(true)
    expect(corsGate("ws://localhost:3000")).toBe("ws://localhost:3000")
    // still block evil even with gate
    expect(isAllowedGate("https://evil.com")).toBe(false)
    expect(corsGate("https://evil.com")).toBe("")
    // allowlisted still allowed with gate
    expect(isAllowedGate("https://slab1.github.io")).toBe(true)
    expect(corsGate("https://slab1.github.io")).toBe("https://slab1.github.io")
  })

  test("parity: isOriginAllowed true iff corsOrigin returns non-empty (for non-empty origin)", () => {
    const cases: Array<{ list: string[]; gate?: string; origin: string }> = [
      { list: [], origin: "http://localhost:3000" },
      { list: [], origin: "https://evil.com" },
      { list: [], origin: "vscode-webview://abc" },
      { list: ["https://slab1.github.io"], origin: "https://slab1.github.io" },
      { list: ["https://slab1.github.io"], origin: "https://evil.com" },
      { list: ["https://slab1.github.io"], origin: "http://localhost:3000" },
      { list: ["https://slab1.github.io"], gate: "1", origin: "http://localhost:3000" },
      { list: ["https://slab1.github.io"], gate: "1", origin: "https://evil.com" },
      { list: ["https://slab1.github.io"], origin: "vscode-webview://x" },
    ]
    for (const c of cases) {
      if (c.gate) process.env.MIRA_ALLOW_LOCALHOST = c.gate
      else delete process.env.MIRA_ALLOW_LOCALHOST
      const isAllowed = makeIsOriginAllowed(c.list)(c.origin)
      const cors = makeCorsOrigin(c.list)(c.origin)
      const corsAllowed = cors !== ""
      expect(isAllowed).toBe(corsAllowed)
    }
  })
})
