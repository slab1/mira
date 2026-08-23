/**
 * Mock MCP stdio server — speaks REAL MCP JSON-RPC (newline-delimited).
 * Validates McpStdioClient against the actual protocol.
 */
import { exit } from "node:process"

const decoder = new TextDecoder()
let buf = ""

function send(obj: object): void {
  process.stdout.write(JSON.stringify(obj) + "\n")
}

for await (const chunk of process.stdin) {
  buf += decoder.decode(chunk as Uint8Array, { stream: true })
  let nl: number
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg: any
    try { msg = JSON.parse(line) } catch { continue }
    const { id, method, params } = msg
    switch (method) {
      case "initialize":
        send({ jsonrpc: "2.0", id, result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-mcp", version: "1.0.0" },
        } })
        break
      case "tools/list":
        send({ jsonrpc: "2.0", id, result: { tools: [
          { name: "echo", description: "Echo back input", inputSchema: { type: "object" } },
          { name: "add", description: "Add two numbers", inputSchema: { type: "object" } },
        ] } })
        break
      case "tools/call": {
        if (params.name === "echo") {
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${JSON.stringify(params.arguments)}` }] } })
        } else if (params.name === "add") {
          const a = Number(params.arguments?.a ?? 0), b = Number(params.arguments?.b ?? 0)
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(a + b) }] } })
        } else {
          send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params.name}` } })
        }
        break
      }
      default:
        if (id !== undefined && method !== "notifications/initialized") {
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
        }
    }
  }
}
exit(0)
