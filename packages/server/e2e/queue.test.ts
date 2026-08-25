/** E2E: queue-while-streaming — messages queue during a turn, drain as chained turns */
import { describe, test, beforeAll, afterAll, expect } from "bun:test"

const PORT = 4789
const BASE = `http://localhost:${PORT}`
let serverProc: ReturnType<typeof Bun.spawn> | null = null

beforeAll(async () => {
  serverProc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, PORT: String(PORT), MIRA_DB: "/tmp/mira-e2e-queue.db" },
    stdout: "pipe", stderr: "pipe",
  })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/health`)).ok) break } catch {}
    await Bun.sleep(250)
  }
})
afterAll(() => serverProc?.kill())

describe("message queue", () => {
  test("queue → list → clear roundtrip + chained turn drains", async () => {
    const session = await (await fetch(`${BASE}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "queue-test" }),
    })).json()

    // Queue two while idle (valid — they run on next/chain turns)
    const q1 = await (await fetch(`${BASE}/session/${session.id}/queue`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "first queued" }),
    })).json()
    expect(q1.position).toBe(1)
    await fetch(`${BASE}/session/${session.id}/queue`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "second queued" }),
    })
    expect(await (await fetch(`${BASE}/session/${session.id}/queue`)).json())
      .toEqual(["first queued", "second queued"])

    // Start a real turn (stub stream) — at finalize it drains the queue head
    await fetch(`${BASE}/session/${session.id}/prompt`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "kickoff" }),
    }).then(r => r.text())

    // Allow chained turn to start
    await Bun.sleep(1500)
    const remaining = await (await fetch(`${BASE}/session/${session.id}/queue`)).json()
    expect(remaining).toEqual(["second queued"])

    // Clear rest
    const cleared = await (await fetch(`${BASE}/session/${session.id}/queue`, { method: "DELETE" })).json()
    expect(cleared.cleared).toBe(1)

    // Chained turn persisted its own user+assistant messages
    const msgs = await (await fetch(`${BASE}/session/${session.id}/message`)).json() as Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>
    const userTexts = msgs.filter(m => m.role === "user")
      .flatMap(m => (m.parts ?? []).filter(p => p.type === "text").map(p => p.text))
    expect(userTexts).toContain("first queued")
  })
})
