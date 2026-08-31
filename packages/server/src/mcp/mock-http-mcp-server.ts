/**
 * Mock MCP Streamable HTTP server — speaks REAL MCP Streamable HTTP transport.
 * Validates McpHttpClient against the actual protocol (session id capture,
 * JSON vs SSE framing, tools/list, tools/call).
 *
 * Server schedule:
 *   - POST /mcp
 *     - initialize        → 200 JSON result + `Mcp-Session-Id` header
 *     - notifications/initialized → 202 empty (no body)
 *     - tools/list, tools/call  → requires Mcp-Session-Id echo; returns
 *                                 either single JSON (default) or SSE stream
 *   - GET  /mcp (SSE listen)     → optional; streams nothing currently
 *
 * Behavior driven by:
 *   MOCK_MCP_SSE=1   → respond with SSE framing instead of JSON
 *   MOCK_MCP_PORT=x  → listen on that port (optional; 0 = random, printed to stdout)
 *   MOCK_MCP_REQUIRE_SESSION=1 → reject non-initialize requests without session id
 */
import { serve } from "bun"

const USE_SSE = process.env.MOCK_MCP_SSE === "1"
const REQUIRE_SESSION = process.env.MOCK_MCP_REQUIRE_SESSION === "1"
const PORT = process.env.MOCK_MCP_PORT ? Number(process.env.MOCK_MCP_PORT) : 0
const SESSION_ID = "mock-session-abc123"

interface RpcMsg {
  id?: number
  method?: string
  params?: { name?: string; arguments?: Record<string, number | string>; protocolVersion?: string }
}

function jsonResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  })
}

function sseFrame(msg: object): string {
  return `event: message\ndata: ${JSON.stringify(msg)}\n\n`
}

function handleMessage(msg: RpcMsg, request: Request): Response {
  const { id, method, params } = msg

  switch (method) {
    case "initialize":
      return jsonResponse(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-http-mcp", version: "1.0.0" },
        },
      }), 200, { "Mcp-Session-Id": SESSION_ID })

    case "notifications/initialized":
      // Notification: no response body expected
      return new Response(null, { status: 202 })

    case "tools/list": {
      // Non-initialize requests must echo the session id
      if (REQUIRE_SESSION && request.headers.get("mcp-session-id") !== SESSION_ID) {
        return jsonResponse(JSON.stringify({
          jsonrpc: "2.0", id,
          error: { code: -32000, message: "Missing Mcp-Session-Id header" },
        }), 400)
      }
      const result = {
        jsonrpc: "2.0",
        id,
        result: { tools: [
          { name: "remote_echo", description: "Echo back input", inputSchema: { type: "object" } },
          { name: "remote_add", description: "Add two numbers", inputSchema: { type: "object" } },
        ] },
      }
      if (USE_SSE) {
        return new Response(sseFrame(result), { status: 200, headers: { "Content-Type": "text/event-stream" } })
      }
      return jsonResponse(JSON.stringify(result))
    }

    case "tools/call": {
      if (REQUIRE_SESSION && request.headers.get("mcp-session-id") !== SESSION_ID) {
        return jsonResponse(JSON.stringify({
          jsonrpc: "2.0", id,
          error: { code: -32000, message: "Missing Mcp-Session-Id header" },
        }), 400)
      }
      const name = params?.name
      const args = params?.arguments
      let result: object
      if (name === "remote_echo") {
        result = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${JSON.stringify(args)}` }] } }
      } else if (name === "remote_add") {
        const a = Number(args?.a ?? 0), b = Number(args?.b ?? 0)
        result = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(a + b) }] } }
      } else {
        result = { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } }
      }
      if (USE_SSE) {
        return new Response(sseFrame(result), { status: 200, headers: { "Content-Type": "text/event-stream" } })
      }
      return jsonResponse(JSON.stringify(result))
    }

    default:
      if (id !== undefined && method !== "notifications/initialized") {
        return jsonResponse(JSON.stringify({
          jsonrpc: "2.0", id,
          error: { code: -32601, message: `Method not found: ${method}` },
        }))
      }
      return new Response(null, { status: 202 })
  }
}

const server = serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 })
    }
    if (req.method === "GET") {
      // Optional SSE listen stream — no server-initiated messages
      return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } })
    }
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 })
    }
    return req.text().then((body) => {
      let msg: RpcMsg
      try { msg = JSON.parse(body) as RpcMsg } catch { return jsonResponse("{}", 400) }
      return handleMessage(msg, req)
    })
  },
})

// Signal readiness with the actual port
console.log(JSON.stringify({ ready: true, port: server.port }))
