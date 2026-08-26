# @mira/server — Agent Engine

> **Mira** — hierarchical memory, eval-first observability, tool-layer guardrails, file snapshots with undo.

## Architecture

```
Clients (TUI/Web) ──REST/SSE/WS──► Server :4096 (127.0.0.1 default)
  ├─ SessionPrompt.loop
  │    context = system prompt + skills + memory retrieval + history
  │    LLM.stream → tool-call → permission → guardrails → snapshot → execute
  │    → doom-loop detection → compaction → usage learning → SSE events
  ├─ Tool Registry (24 native + dynamic mcp__* — Zod validated)
  ├─ Permission (5 layers + BashArity)
  ├─ File Snapshots (undo/rewind) · Durable Message Queue
  ├─ GlobalBus → WS fan-out (no polling)
  ├─ Storage: SQLite WAL + Drizzle
  ├─ Gateway: OpenRouter + NVIDIA NIM — cost-tracked, prompt-cached (Claude)
  ├─ LSP: real JSON-RPC servers (gopls) + heuristic fallback
  ├─ MCP: real stdio protocol client
  └─ Learning: online learner · usage analysis · knowledge graph
```

## Quick Start

```bash
bun install
# .env works (gitignored): NVIDIA_API_KEY / OPENROUTER_API_KEY / MIRA_TOKEN …
bun run dev          # → http://127.0.0.1:4096
bun test             # unit + E2E (live tests auto-skip without keys/binaries)
```

## REST + WS

| Method | Path | Notes |
|--------|------|-------|
| GET | /health | ok, version, tools, uptime |
| GET | /dev/health | + bus, learning scheduler, **gateway cost stats** |
| GET | /skills | loaded skill packs |
| POST/GET | /session | create / list (`agent: researcher\|coder\|reviewer` supported) |
| GET/DELETE | /session/:id | fetch / delete |
| POST | /session/:id/prompt | **SSE stream** — the core loop |
| GET | /session/:id/message | history with parts |
| GET | /session/:id/export?format=md\|json | shareable transcript |
| GET/POST | /session/:id/todo | todos |
| POST/GET/DELETE | /session/:id/queue | queue while streaming; durable; drains as chained turns |
| GET | /session/:id/snapshots | file mutation audit trail |
| POST | /session/:id/revert | undo last mutation, or `{messageID}` to rewind |
| GET | /tools | list tools incl. `mcp__*` |
| GET | /mcp | MCP server discovery (sanitized) |
| GET | /learning/status · /learning/insights · POST /learning/trigger | learning system |
| POST | /permission/check | preflight |
| WS | / | BusEvent stream (+ question.reply / permission.reply uplink) |

## Tools (24 native)

`bash` `read` `write` `edit`(9-layer fallback) `patch` `glob` `grep` `lsp`(real LSP→heuristic fallback) `todowrite` `task`(real subagents → persistent child sessions) `question`(HITL pause/resume over WS) `plan` `exit_plan` `skill` `config` `diagnose`(runs tsc/test/build for real) `websearch`(Firecrawl→Tavily→DuckDuckGo) `webfetch` `memory_search` `memory_write`(wired to KnowledgeBase) `session_list` `session_fork`(real history copy) `analyze_image`(provider vision) `parse_document` + dynamic `mcp__<server>__<tool>`

## Security

- Binds **127.0.0.1** by default; `HOST=0.0.0.0` to expose deliberately
- `MIRA_TOKEN` enables bearer auth on HTTP + WS (`Authorization: Bearer …` or `?token=`)
- Mutating tools (edit/write/patch) auto-snapshot targets — every change reversible
- Guardrails check + audit-log every tool call

## Gateway

OpenAI-compatible wire. Providers: OpenRouter, NVIDIA NIM (auto-enabled when key present). Claude models get `cache_control: ephemeral` prompt caching via OpenRouter. Every request records tokens/cost/latency into `/dev/health` stats and per-session columns.

## LSP

Real Language Server Protocol 3.17 client (`src/lsp/client.ts`) — Content-Length framing, initialize handshake, hover/definition/references, publishDiagnostics capture, timeout guards. Auto-detects `gopls` for Go; extend via `MIRA_LSP_<LANG>_CMD`. Falls back to the heuristic SymbolIndex when no server exists.

## MCP

Real stdio protocol (`src/mcp/stdio-client.ts`) — newline-delimited JSON-RPC, initialize handshake, tools/list discovery, live tools/call proxying. Configure in `mira.json`: `{ "type": "local", "command": [...], "enabled": true }`.

## Testing

- `bun test` — 54 unit + protocol-mock suites (LSP mock server, MCP mock server)
- `e2e/` — boots the real server: SSE flow, persistence, export, fork, undo, queue
- Live gates (auto-skip): real LLM roundtrip, vision, gopls
- Eval: `bun src/eval/index.ts --tier pr` runs inside CI

## Sources

- zengineer.blog (Mira deep-dive) · arXiv:2604.14228 (Claude Code) · O'Reilly 6-layer 2026 stack
