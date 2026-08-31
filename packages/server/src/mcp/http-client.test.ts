import { describe, test, expect, afterAll } from "bun:test"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { McpHttpClient } from "./http-client.js"

const MOCK = join(import.meta.dir, "mock-http-mcp-server.ts")
const clients: McpHttpClient[] = []
const procs: Subprocess[] = []

afterAll(async () => {
  await Promise.allSettled(clients.map(c => c.shutdown()))
  for (const p of procs) { try { p.kill() } catch {} }
})

/** Spawn the mock HTTP server and return { url, stop } once ready */
async function startMock(opts: { sse?: boolean; requireSession?: boolean } = {}): Promise<{ url: string; stop: () => void }> {
  const env: Record<string, string> = {
    // Preserve PATH so the spawned `bun` binary resolves under the child env
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  }
  if (opts.sse) env.MOCK_MCP_SSE = "1"
  if (opts.requireSession) env.MOCK_MCP_REQUIRE_SESSION = "1"
  const proc = Bun.spawn(["bun", "run", MOCK], { env, stdout: "pipe", stderr: "pipe" })
  procs.push(proc)

  const url = await new Promise<string>((resolve, reject) => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const timeout = setTimeout(() => reject(new Error("mock server did not start")), 10_000)
    ;(async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const text = decoder.decode(value, { stream: true })
          try {
            const parsed = JSON.parse(text.trim())
            if (parsed.ready && typeof parsed.port === "number") {
              clearTimeout(timeout)
              resolve(`http://127.0.0.1:${parsed.port}/mcp`)
              return
            }
          } catch { /* keep reading */ }
        }
        clearTimeout(timeout)
        reject(new Error("mock server exited before ready"))
      } catch (e) {
        clearTimeout(timeout)
        reject(e as Error)
      }
    })()
  })

  return { url, stop: () => { try { proc.kill() } catch {} } }
}

describe("McpHttpClient (real Streamable HTTP JSON-RPC)", () => {
  test("initialize handshake captures serverInfo + session id", async () => {
    const { url, stop } = await startMock()
    try {
      const c = await McpHttpClient.connect("mock-http", { url })
      clients.push(c)
      expect(c.alive).toBe(true)
      expect(c.serverInfo.name).toBe("mock-http-mcp")
    } finally { stop() }
  }, 20_000)

  test("tools/list discovers real tools (single JSON)", async () => {
    const { url, stop } = await startMock()
    try {
      const c = await McpHttpClient.connect("mock-http", { url }); clients.push(c)
      const tools = await c.listTools()
      expect(tools.map(t => t.name)).toEqual(["remote_echo", "remote_add"])
      expect(tools[0].description).toContain("Echo")
    } finally { stop() }
  }, 20_000)

  test("tools/list discovers real tools (SSE framing)", async () => {
    const { url, stop } = await startMock({ sse: true })
    try {
      const c = await McpHttpClient.connect("mock-http", { url }); clients.push(c)
      const tools = await c.listTools()
      expect(tools.map(t => t.name)).toEqual(["remote_echo", "remote_add"])
    } finally { stop() }
  }, 20_000)

  test("tools/call executes with arguments (remote_add: 2+3=5)", async () => {
    const { url, stop } = await startMock()
    try {
      const c = await McpHttpClient.connect("mock-http", { url }); clients.push(c)
      const r = await c.callTool("remote_add", { a: 2, b: 3 })
      expect(r.isError).toBeFalsy()
      expect(r.content[0].text).toBe("5")
    } finally { stop() }
  }, 20_000)

  test("session id is echoed on subsequent requests (require-session mode)", async () => {
    const { url, stop } = await startMock({ requireSession: true })
    try {
      const c = await McpHttpClient.connect("mock-http", { url }); clients.push(c)
      const tools = await c.listTools()
      expect(tools.length).toBe(2) // would 400 without session echo
    } finally { stop() }
  }, 20_000)

  test("unknown tool surfaces server error", async () => {
    const { url, stop } = await startMock()
    try {
      const c = await McpHttpClient.connect("mock-http", { url }); clients.push(c)
      let err: Error | null = null
      try { await c.callTool("nope", {}) } catch (e) { err = e as Error }
      expect(err?.message).toContain("Unknown tool")
    } finally { stop() }
  }, 20_000)

  test("aborted signal rejects promptly", async () => {
    const { url, stop } = await startMock()
    try {
      const c = await McpHttpClient.connect("mock-http", { url }); clients.push(c)
      const ac = new AbortController()
      ac.abort() // pre-aborted
      let err: Error | null = null
      try { await c.callTool("remote_echo", {}, 60_000, ac.signal) } catch (e) { err = e as Error }
      expect(err?.message).toContain("aborted")
    } finally { stop() }
  }, 20_000)
})
