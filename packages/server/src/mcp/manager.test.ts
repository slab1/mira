import { describe, test, expect } from "bun:test"
import { join } from "node:path"
import { MCPManager } from "./index.js"
import { ToolRegistry } from "../tools/registry.js"
import { createDatabase } from "../storage/db.js"
import { PermissionManager } from "../permission/index.js"
import { Bus } from "../bus/index.js"
import type { Gateway } from "../gateway/index.js"
import type { JsonValue } from "../types/index.js"

const MOCK = join(import.meta.dir, "mock-mcp-server.ts")

// Inert typed gateway stub — MCP registration never streams
const stubGateway: Gateway = {
  stream: () => Promise.resolve((async function* () {})()),
  complete: async () => ({ text: "" }),
  summarize: async () => "",
  listModels: async () => [],
  stats: () => ({ requests: 0, inputTokens: 0, outputTokens: 0, costUSD: 0, avgLatencyMs: 0, byModel: {} }),
}

describe("MCPManager end-to-end (stdio)", () => {
  test("connects, discovers real tools, registers callable registry entries", async () => {
    const tools = new ToolRegistry({
      db: createDatabase(":memory:"),
      bus: new Bus(),
      permissions: new PermissionManager({}),
      gateway: stubGateway,
    })
    const mgr = new MCPManager({
      bus: new Bus(),
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
    const text = (out as { text?: JsonValue }).text
    expect(text).toBe("42")

    // Disabled server registered but inert
    expect(servers.find(s => s.name === "off")?.status).toBe("disabled")
    mgr.disconnectAll()
  }, 30_000)
})
