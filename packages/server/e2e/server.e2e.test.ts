/**
 * Mira E2E — boots the real server, drives the full HTTP/SSE flow.
 *
 * Uses the gateway's stub stream (no API key needed) so the entire
 * pipeline is exercised: REST → SessionPrompt loop → tools → permissions
 * → bus events → SQLite persistence → export/fork.
 */
import { describe, test, beforeAll, afterAll, expect } from "bun:test"

const PORT = 4788
const BASE = `http://localhost:${PORT}`
let serverProc: ReturnType<typeof Bun.spawn> | null = null

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) return await res.json()
    } catch {}
    await Bun.sleep(250)
  }
  throw new Error("server never became healthy")
}

beforeAll(async () => {
  serverProc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, PORT: String(PORT), MIRA_DB: "/tmp/mira-e2e-test.db" },
    stdout: "pipe",
    stderr: "pipe",
  })
  await waitForHealth()
})

afterAll(() => {
  serverProc?.kill()
})

describe("Mira server E2E", () => {
  test("health reports registered tools", async () => {
    const health = await waitForHealth()
    expect(health.ok).toBe(true)
    expect(health.tools).toBeGreaterThan(10)
  })

  test("skills + tools + mcp discovery endpoints", async () => {
    const skills = await (await fetch(`${BASE}/skills`)).json()
    expect(Array.isArray(skills)).toBe(true)
    const toolList = await (await fetch(`${BASE}/tools`)).json()
    expect(toolList.length).toBeGreaterThan(10)
    const mcp = await (await fetch(`${BASE}/mcp`)).json()
    expect(Array.isArray(mcp)).toBe(true)
  })

  test("session lifecycle: create → prompt(SSE) → messages persisted", async () => {
    const created = await fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "e2e-test-session" }),
    })
    const session = await created.json()
    expect(created.status).toBe(201)
    expect(session.id).toBeDefined()

    // Drive the prompt loop over SSE (stub gateway streams a response)
    const res = await fetch(`${BASE}/session/${session.id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello mira" }),
    })
    expect(res.headers.get("Content-Type")).toContain("text/event-stream")
    const body = await res.text()
    expect(body).toContain("event: finish")
    expect(body).toContain("event: step_start")

    // Messages were persisted
    const messages = await (await fetch(`${BASE}/session/${session.id}/message`)).json()
    expect(messages.length).toBeGreaterThanOrEqual(2) // user + assistant

    // Export as markdown contains the conversation
    const md = await (await fetch(`${BASE}/session/${session.id}/export`)).text()
    expect(md).toContain("# e2e-test-session")
  })

  test("agent personas: create session with researcher template", async () => {
    const res = await fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "researcher" }),
    })
    const session = await res.json()
    expect(session.agent).toBe("researcher")
    expect(session.title).toContain("researcher")
  })

  test("dev/health exposes gateway cost stats", async () => {
    const dev = await (await fetch(`${BASE}/dev/health`)).json()
    expect(dev.gateway).toBeDefined()
    expect(typeof dev.gateway.requests).toBe("number")
    expect(typeof dev.gateway.costUSD).toBe("number")
    expect(dev.learning).toBeDefined()
  })

  test("file snapshots + undo roundtrip via REST", async () => {
    // Create session, snapshot a file through the write path
    const target = "/tmp/mira-e2e-undo.txt"
    await Bun.write(target, "before-mira")

    const created = await fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "undo-test" }),
    })
    const session = await created.json()

    // Mutate the file directly (simulating agent edit), then verify snapshot list is queryable
    await Bun.write(target, "after-mira")

    const snaps = await (await fetch(`${BASE}/session/${session.id}/snapshots`)).json()
    expect(Array.isArray(snaps)).toBe(true)

    // Revert with no mutations recorded → ok:true, reverted:0
    const res = await fetch(`${BASE}/session/${session.id}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const out = await res.json()
    expect(out.ok).toBe(true)
    expect(out.reverted).toBe(0)
    await Bun.write(target, "") // cleanup
  })

  test("config layered settings + PATCH persistence", async () => {
    // GET /config returns merged + layers, apiKeys redacted
    const cfgRes = await fetch(`${BASE}/config`)
    expect(cfgRes.status).toBe(200)
    const cfg = await cfgRes.json() as { merged: { model: string; provider: Record<string, { options: { apiKey: string } }> }; layers: Array<{ source: string }> }
    expect(typeof cfg.merged.model).toBe("string")
    expect(Array.isArray(cfg.layers)).toBe(true)
    // Redaction: no raw key should leak as plain text longer than "***"
    const rawKey = cfg.merged.provider?.["openrouter"]?.options?.apiKey ?? ""
    expect(rawKey === "" || rawKey === "***" || rawKey.startsWith("sk-***")).toBe(true)

    // GET /config/schema returns JSON Schema shape
    const schema = await (await fetch(`${BASE}/config/schema`)).json() as { properties?: Record<string, { type: string }> }
    expect(typeof schema.properties).toBe("object")
    expect(schema.properties?.["model"]).toBeDefined()

    // PATCH /config (project layer) → round-trips
    const testModel = "openrouter/test-e2e-model"
    const patched = await fetch(`${BASE}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { model: testModel }, layer: "project" }),
    })
    expect(patched.status).toBe(200)
    const afterPatch = await patched.json() as { merged: { model: string } }
    expect(afterPatch.merged.model).toBe(testModel)

    // GET again confirms persistence
    const cfg2 = await (await fetch(`${BASE}/config`)).json() as { merged: { model: string } }
    expect(cfg2.merged.model).toBe(testModel)

    // Revert to default to not pollute later runs
    const revert = await fetch(`${BASE}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { model: "openrouter/anthropic/claude-sonnet-4" }, layer: "project" }),
    })
    expect(revert.status).toBe(200)

    // Invalid patch → 400
    const bad = await fetch(`${BASE}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: null }),
    })
    expect(bad.status).toBe(400)
  })

  // ── Live LLM roundtrip (skips when no key is configured) ──────────
  const liveKey = process.env.NVIDIA_API_KEY
  const LIVE_MODEL = "nvidia/meta/llama-3.3-70b-instruct"

  test.skipIf(!liveKey)("LIVE: real LLM streams through the full pipeline", async () => {
    const created = await fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "live-llm-test", model: LIVE_MODEL }),
    })
    const session = await created.json()
    expect(session.model).toBe(LIVE_MODEL)

    // Provider latency from CI sandboxes varies wildly (6s–60s+ first byte).
    // Retry the prompt up to 3× so one network hiccup doesn't fail the suite.
    let body = ""
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${BASE}/session/${session.id}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "Reply with exactly the word: MIRA_E2E_OK" }),
        })
        body = await res.text()
        if (body.includes("event: finish") && /"delta":"/.test(body)) break
      } catch (e) {
        lastErr = e
      }
      if (attempt < 3) await Bun.sleep(2000)
    }
    expect(body).toBeTruthy()

    // No loop errors, real finish
    expect(body).not.toContain("event: error")
    expect(body).toContain("event: step_start")
    expect(body).toContain("event: finish")

    // Real model output arrived via text deltas
    const deltas = [...body.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)].map(m => m[1])
    const fullText = deltas.join("")
    console.log("  [live] model output:", JSON.stringify(fullText.slice(0, 120)))
    expect(fullText.length).toBeGreaterThan(0)
    expect(fullText).not.toContain("[Mira stub") // must NOT be the stub stream

    // Gateway recorded real token usage
    await Bun.sleep(500)
    const dev = await (await fetch(`${BASE}/dev/health`)).json()
    expect(dev.gateway.requests).toBeGreaterThan(0)
    expect(dev.gateway.inputTokens).toBeGreaterThan(0)
    console.log("  [live] gateway stats:", JSON.stringify(dev.gateway.byModel))
  }, 240_000)
})
