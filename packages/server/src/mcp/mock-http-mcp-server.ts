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
 *   MOCK_MCP_LEGACY=1→ serve the legacy HTTP+SSE (2024-11-05) transport:
 *                      GET /mcp streams an `endpoint` event + response messages;
 *                      POST /message returns 202 and pushes the response to the
 *                      open GET stream. Modern POST /mcp returns 405 (fallback cue).
 *   MOCK_MCP_PORT=x  → listen on that port (optional; 0 = random, printed to stdout)
 *   MOCK_MCP_REQUIRE_SESSION=1 → reject non-initialize requests without session id
 */
import { serve } from "bun"

const LEGACY = process.env.MOCK_MCP_LEGACY === "1"
const USE_SSE = process.env.MOCK_MCP_SSE === "1"
const REQUIRE_SESSION = process.env.MOCK_MCP_REQUIRE_SESSION === "1"
const PORT = process.env.MOCK_MCP_PORT ? Number(process.env.MOCK_MCP_PORT) : 0
const SESSION_ID = "mock-session-abc123"
const MESSAGE_PATH = "/mcp/message"

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

/**
 * Compute the JSON-RPC response object for a request (transport-agnostic).
 * The modern transport serializes it as JSON or SSE; the legacy transport
 * pushes it onto the open GET stream as an SSE `message` event.
 */
function computeResponse(msg: RpcMsg, request: Request): object {
  const { id, method, params } = msg

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-http-mcp", version: "1.0.0" },
        },
      }

    case "notifications/initialized":
      // Notification: no response body expected
      return { jsonrpc: "2.0", id, result: {} }

    case "tools/list": {
      // Non-initialize requests must echo the session id
      if (REQUIRE_SESSION && request.headers.get("mcp-session-id") !== SESSION_ID) {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: "Missing Mcp-Session-Id header" } }
      }
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: [
          { name: "remote_echo", description: "Echo back input", inputSchema: { type: "object" } },
          { name: "remote_add", description: "Add two numbers", inputSchema: { type: "object" } },
        ] },
      }
    }

    case "tools/call": {
      if (REQUIRE_SESSION && request.headers.get("mcp-session-id") !== SESSION_ID) {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: "Missing Mcp-Session-Id header" } }
      }
      const name = params?.name
      const args = params?.arguments
      if (name === "remote_echo") {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${JSON.stringify(args)}` }] } }
      }
      if (name === "remote_add") {
        const a = Number(args?.a ?? 0), b = Number(args?.b ?? 0)
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(a + b) }] } }
      }
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } }
    }

    default:
      if (id !== undefined && method !== "notifications/initialized") {
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }
      }
      return { jsonrpc: "2.0", id, result: {} }
  }
}

function handleMessage(msg: RpcMsg, request: Request): Response {
  const response = computeResponse(msg, request)
  const { id, method } = msg
  if (method === "notifications/initialized") {
    return new Response(null, { status: 202 })
  }
  if (LEGACY) {
    void response
    void id
    // The actual response is pushed onto the GET stream by the caller (which
    // has access to the stream sink). Here we only acknowledge with 202.
    return new Response(null, { status: 202 })
  }
  if (USE_SSE) {
    return new Response(sseFrame(response), { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }
  // initialize sets the session id header used by require-session mode
  const extra: Record<string, string> = {}
  if (method === "initialize") extra["Mcp-Session-Id"] = SESSION_ID
  return jsonResponse(JSON.stringify(response), 200, extra)
}

// Legacy HTTP+SSE: the open GET stream sink. POST /message pushes a computed
// response here as an SSE `message` event.
let legacyStreamSink: ((chunk: string) => void) | null = null

const server = serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)
    if (LEGACY) {
      if (req.method === "GET" && url.pathname === "/mcp") {
        // Persistent SSE listen stream. Emit the `endpoint` event (the /message
        // POST url), then stream response `message` events as they are pushed.
        let sink: ((chunk: string) => void) | null = null
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            sink = (chunk) => controller.enqueue(new TextEncoder().encode(chunk))
            controller.enqueue(new TextEncoder().encode(`event: endpoint\ndata: ${url.origin}${MESSAGE_PATH}\n\n`))
            legacyStreamSink = sink
          },
          cancel() {
            legacyStreamSink = null
            sink = null
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      if (req.method === "POST" && url.pathname === MESSAGE_PATH) {
        return req.text().then((body) => {
          let msg: RpcMsg
          try { msg = JSON.parse(body) as RpcMsg } catch { return new Response(null, { status: 400 }) }
          const response = computeResponse(msg, req)
          // Notification/initialize-with-id responses both go on the stream.
          legacyStreamSink?.(sseFrame(response))
          return new Response(null, { status: 202 })
        })
      }
      return new Response("Not Found", { status: 404 })
    }

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
