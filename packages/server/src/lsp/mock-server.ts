/**
 * Mock language server — speaks REAL LSP JSON-RPC (Content-Length framing)
 * over stdio. Used by client.test.ts to validate the protocol implementation
 * without external binaries.
 */
import { exit } from "node:process"

const decoder = new TextDecoder()
let buf = ""

function send(msg: object): void {
  const body = JSON.stringify(msg)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

/** Minimal LSP wire envelope: {jsonrpc, id?, method, params} */
interface LspMsg {
  id?: number | string
  method?: string
  params?: {
    position?: { line: number; character: number }
    textDocument?: { uri: string }
  }
}

function handle(msg: LspMsg): void {
  // Standard LSP wire bodies ARE the jsonrpc envelope: {jsonrpc, id?, method, params}
  const { id, method } = msg
  const position = msg.params?.position ?? { line: 0, character: 0 }
  const uri = msg.params?.textDocument?.uri ?? ""

  switch (method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: { capabilities: { textDocumentSync: 1, hoverProvider: true, definitionProvider: true, referencesProvider: true } } })
      break
    case "shutdown":
      send({ jsonrpc: "2.0", id, result: null })
      break
    case "textDocument/definition": {
      const target = position.character === 0
        ? { uri: "file:///other/def.ts", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } } }
        : null
      send({ jsonrpc: "2.0", id, result: target })
      break
    }
    case "textDocument/references":
      send({ jsonrpc: "2.0", id, result: [
        { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
        { uri: "file:///third/use.ts", range: { start: { line: 9, character: 1 }, end: { line: 9, character: 6 } } },
      ] })
      break
    case "textDocument/hover":
      send({ jsonrpc: "2.0", id, result: { contents: { kind: "markdown", value: `**mock** hover at ${position.line}:${position.character}` } } })
      break
    default:
      if (id !== undefined) {
        if (method === "test/hang") return // never respond — exercises client timeout
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
      }
  }

  // Push diagnostics after first didOpen (tests notification capture)
  if (method === "textDocument/didOpen") {
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {
      uri,
      diagnostics: [{ severity: 1, message: "mock error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    } })
  }
}

// Read loop — parse Content-Length frames from stdin
for await (const chunk of process.stdin) {
  buf += decoder.decode(chunk as Uint8Array, { stream: true })
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n")
    if (headerEnd === -1) break
    const m = buf.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i)
    const len = m ? parseInt(m[1], 10) : 0
    const start = headerEnd + 4
    if (buf.length < start + len) break
    try { handle(JSON.parse(buf.slice(start, start + len)) as LspMsg) } catch {}
    buf = buf.slice(start + len)
  }
}
exit(0)
