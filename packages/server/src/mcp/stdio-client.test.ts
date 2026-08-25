import { describe, test, expect, afterAll } from "bun:test"
import { join } from "node:path"
import { McpStdioClient } from "./stdio-client.js"

const MOCK = join(import.meta.dir, "mock-mcp-server.ts")
const clients: McpStdioClient[] = []
afterAll(async () => { await Promise.allSettled(clients.map(c => c.shutdown())) })

describe("McpStdioClient (real newline-delimited JSON-RPC)", () => {
  test("initialize handshake captures serverInfo", async () => {
    const c = await McpStdioClient.spawn(["bun", "run", MOCK])
    clients.push(c)
    expect(c.alive).toBe(true)
    expect(c.serverInfo.name).toBe("mock-mcp")
  }, 20_000)

  test("tools/list discovers real tools", async () => {
    const c = await McpStdioClient.spawn(["bun", "run", MOCK]); clients.push(c)
    const tools = await c.listTools()
    expect(tools.map(t => t.name)).toEqual(["echo", "add"])
    expect(tools[0].description).toContain("Echo")
  }, 20_000)

  test("tools/call executes with arguments (add: 2+3=5)", async () => {
    const c = await McpStdioClient.spawn(["bun", "run", MOCK]); clients.push(c)
    const r = await c.callTool("add", { a: 2, b: 3 })
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text).toBe("5")
  }, 20_000)

  test("unknown tool surfaces server error", async () => {
    const c = await McpStdioClient.spawn(["bun", "run", MOCK]); clients.push(c)
    let err: Error | null = null
    try { await c.callTool("nope", {}) } catch (e) { err = e as Error }
    expect(err?.message).toContain("Unknown tool")
  }, 20_000)
})
