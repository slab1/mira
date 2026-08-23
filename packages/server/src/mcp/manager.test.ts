import { describe, test, expect } from "bun:test"
import { join } from "node:path"
import { MCPManager } from "./index.js"
import { ToolRegistry } from "../tools/registry.js"

const MOCK = join(import.meta.dir, "mock-mcp-server.ts")

describe("MCPManager end-to-end (stdio)", () => {
  test("connects, discovers real tools, registers callable registry entries", async () => {
    const tools = new ToolRegistry({ db: null as any, bus: null as any, permissions: null as any, gateway: null as any })
    const mgr = new MCPManager({
      bus: null as any,
      tools,
      config: {
        mock: {
          type: "local",
          command: ["bun", "run", MOCK],
          enabled: true,
        },
        off: { type: "local", command: ["whatever"], enabled: false },
      },
    })
    await mgr.connectAll()

    // Discovery surfaced both mock tools under namespaced names
    const servers = mgr.listServers()
    const mock = servers.find(s => s.name === "mock")
    expect(mock?.status).toBe("connected")
    expect(mock?.toolCount).toBe(2)

    // Registry has them; executing proxies a REAL call to the server
    expect(tools.get("mcp__mock__add")).toBeDefined()
    const out = await tools.execute("mcp__mock__add", { a: 20, b: 22 }, { sessionID: "s", messageID: "m" })
    expect((out as any).text).toBe("42")

    // Disabled server registered but inert
    expect(servers.find(s => s.name === "off")?.status).toBe("disabled")
    mgr.disconnectAll()
  }, 30_000)
})
