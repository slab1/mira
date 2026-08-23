import { describe, test, expect, afterAll } from "bun:test"
import { join } from "node:path"
import { LSPClient } from "./client.js"

const MOCK = join(import.meta.dir, "mock-server.ts")
let client: LSPClient | null = null

afterAll(async () => {
  await client?.shutdown()
})

describe("LSPClient (real JSON-RPC framing against mock server)", () => {
  test("initialize handshake returns capabilities", async () => {
    client = await LSPClient.spawn(["bun"], ["run", MOCK], import.meta.dir, "mock-lsp")
    expect(client.alive).toBe(true)
    expect(client.capabilities.hoverProvider).toBe(true)
    expect(client.capabilities.definitionProvider).toBe(true)
  }, 20_000)

  test("didOpen + publishDiagnostics notification captured", async () => {
    const uri = "file:///test/doc.ts"
    await client!.didOpen(uri, "const x = 1\n", "typescript")
    // mock pushes diagnostics on didOpen — allow the notification to arrive
    await Bun.sleep(200)
    const diags = client!.diagnostics.get(uri)
    expect(diags).toBeDefined()
    expect(diags![0].message).toBe("mock error")
    expect(diags![0].severity).toBe(1)
  }, 20_000)

  test("definition resolves location (or null)", async () => {
    const uri = "file:///test/doc.ts"
    const atZero = await client!.definition(uri, { line: 0, character: 0 })
    expect(atZero).toHaveLength(1)
    expect(atZero![0].uri).toBe("file:///other/def.ts")
    expect(atZero![0].range.start.line).toBe(4)

    const elsewhere = await client!.definition(uri, { line: 2, character: 3 })
    expect(elsewhere).toBeNull()
  }, 20_000)

  test("references returns multiple locations", async () => {
    const refs = await client!.references("file:///test/doc.ts", { line: 1, character: 1 })
    expect(refs).toHaveLength(2)
    expect(refs[1].uri).toBe("file:///third/use.ts")
  }, 20_000)

  test("hover returns formatted contents", async () => {
    const h = await client!.hover("file:///test/doc.ts", { line: 3, character: 7 })
    expect(h.contents.value).toContain("**mock** hover at 3:7")
  }, 20_000)

  test("request timeout rejects cleanly", async () => {
    // "test/hang" never responds — client must reject via its timeout guard
    let err: Error | null = null
    try {
      await client!.request("test/hang", {}, 500)
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toContain("timed out")
  }, 10_000)

  test("server error responses reject with message (MethodNotFound)", async () => {
    let err: Error | null = null
    try {
      await client!.request("no/such/method", {})
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toContain("Method not found")
  }, 10_000)

  test("server-exited rejects pending requests", async () => {
    const dying = await LSPClient.spawn(["bun"], ["run", MOCK], import.meta.dir, "dying-lsp")
    // Kill the process, then any request should reject with exit error
    dying.shutdown().catch(() => {})
    let err: Error | null = null
    try {
      await dying.request("textDocument/hover", {}, 5_000)
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
  }, 15_000)
})
