# @mira/server — Agent Engine

> **Mira is better than all** — OpenCode's openness + Claude's reasoning, minus weaknesses, plus memory/eval/guardrails.

## Architecture

```
Clients (TUI/Web/VSCode) ──RPC/WS──► Server :4096
                                ├─ SessionPrompt.loop
                                │   LLM.stream → tool-call → execute → finish-step → doom-loop → compaction
                                ├─ Tool Registry (24 tools, Zod)
                                ├─ Permission (5 layers + BashArity)
                                ├─ GlobalBus → Worker → RPC → TUI  (no polling)
                                ├─ Storage: SQLite WAL + Drizzle
                                ├─ Gateway: Vercel AI SDK v5 → OpenRouter → 25+ providers
                                └─ MCP: StreamableHTTP / SSE / Stdio
```

## Quick Start

```bash
bun install
# Set key for live LLM (or run stub without key)
export OPENROUTER_API_KEY=sk-or-...
bun run dev          # → http://localhost:4096
```

## REST + WS

| Method | Path | Notes |
|--------|------|-------|
| GET | /health | { ok, version, tools } |
| POST | /session | create |
| GET | /session/:id/message | history |
| POST | /session/:id/prompt | **SSE stream** (core loop) |
| GET | /tools | list 24 tools |
| POST | /permission/check | preflight |
| WS | / | BusEvent stream (no polling) |

## Tools (24)

`bash`, `read`, `write`, `edit`, `patch`, `glob`, `grep`, `lsp`, `todowrite`, `task`, `question`, `plan`, `exit_plan`, `skill`, `config`, `diagnose`, `websearch`, `webfetch`, `memory_search`, `memory_write`, `session_list`, `session_fork`, `analyze_image`, `parse_document` + dynamic `mcp__*`

## Permission — 5 Layers

1. Explicit deny → 2. Explicit allow → 3. Pattern (`edit: { "src/secret/*": "deny" }`) → 4. BashArity (rm -rf=2) → 5. Default ask

## Storage

SQLite WAL + Drizzle. Tables: `sessions`, `messages`, `parts`, `todos`. Postgres+pgvector for memory (separate).

## Gateway

Vercel AI SDK v5 thin by default, OpenRouter for 25+ providers. Fallback stub works without keys.

## MCP

Linux Foundation standard, 97M downloads. Stdio (local) + StreamableHTTP/SSE (remote). Tools auto-register as `mcp__<server>__<tool>`.

## Sources

- zengineer.blog (OpenCode deep-dive)
- arXiv:2604.14228 (Claude Code)
- O'Reilly 6-layer 2026 stack
