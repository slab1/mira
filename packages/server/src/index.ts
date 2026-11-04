/**
 * Mira Server - Main Entry
 *
 * Thin entry point that delegates to bootstrap modules.
 * 
 * Architecture:
 *   Clients (TUI/Web/VSCode) --RPC/WebSocket--> Server
 *     |-- SessionPrompt.loop -- LLM.stream --> tool-call --> execute --> finish-step --> doom-loop --> compaction
 *     |-- Tool Registry (42+ tools, Zod schemas)
 *     |-- Permission (5 layers + BashArity)
 *     |-- GlobalBus --> Worker --> RPC --> TUI  (event-driven, no polling)
 *     |-- Storage: SQLite + Drizzle (WAL mode, sessions/messages/parts/todos)
 *     |-- Model Gateway: Vercel AI SDK v5 --> OpenRouter --> 25+ providers
 *     |-- MCP: StreamableHTTP / SSE / Stdio
 *
 * Runtime: Bun (native SQLite, fast startup, ~3x Node for this workload)
 * Monorepo: Turborepo - packages/server, packages/tui, packages/web, packages/shared
 *
 * Usage:
 *   bun src/index.ts              # start server on :4096
 *   bun src/index.ts --port 3000  # custom port
 */

import { main, sandbox } from './bootstrap/main.js'

// Start the server
main().catch((e) => {
  console.error('Fatal error:', e)
  process.exit(1)
})

// Export for testing and programmatic use
export * from './bootstrap/main.js'
export * from './session/prompt.js'
export * from './tools/registry.js'
export * from './bus/index.js'
export * from './storage/db.js'
export * from './gateway/index.js'
export * from './permission/index.js'
export * from './config/index.js'
export * from './mcp/index.js'
export * from './learning/index.js'
export * from './guardrails/index.js'

// Re-export sandbox
export { sandbox }
