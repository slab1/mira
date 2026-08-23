# Mira — AI Agent Platform Better Than All

> **OpenCode's openness + Claude's reasoning + Cursor's polish + Windsurf's autonomy + Cline's transparency, minus weaknesses, plus memory/eval/guardrails as first-class.**

Mira is a next-gen AI agent platform: **hierarchical memory, eval-first observability, tool-layer guardrails, file snapshots with undo, real LSP + MCP integration, HITL questions, and a cost-tracking model gateway — all verified by a 60+ test suite including live-provider E2E gates.**

## Why Mira?

| Feature | OpenCode | Claude Code | Cursor | Windsurf | Cline | **Mira** |
|---------|----------|-------------|--------|----------|-------|------------|
| Provider-agnostic | ✅ 25+ | ❌ Claude-only | ⚠️ Limited | ⚠️ Limited | ✅ BYO-key | ✅ **Gateway: OpenRouter + NVIDIA NIM** |
| Real LSP servers | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ **JSON-RPC 3.17 (gopls today) + 9-layer edit fallback** |
| Hierarchical Memory | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **Episodic/Semantic/Procedural, auto-injected per turn** |
| Eval-first | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ✅ **3-tier eval gating CI** |
| Tool-layer Guardrails | ❌ | ⚠️ | ❌ | ❌ | ❌ | ✅ **Enforced + audit log** |
| File snapshots + undo | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ **Auto-snapshot before every mutation, rewind to any message** |
| Message queue while streaming | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ **Durable (SQLite), chained-turn drain** |
| Inspectable subagents | ❌ (ephemeral) | ❌ | ❌ | ❌ | ❌ | ✅ **Persistent child sessions with full transcripts** |
| Self-improvement | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **Pain-point detection → verified patches → autopilot PRs** |
| Cost Control | ✅ Free | $20-200 | $20-200 | $15-35 | Free | ✅ **Free + local, live spend display, prompt caching** |

## Architecture

```
[Clients] TUI (SolidJS) | Web (SolidJS/Vite) | VS Code
         ↕ REST / SSE / WebSocket (+ optional MIRA_TOKEN auth)
[Server :4096 — binds 127.0.0.1 by default]
   SessionPrompt.loop
     context = system + skills + memory-retrieval + history
     LLM.stream → tool-call → permission → guardrail snapshot → execute
     → doom-loop detect → compaction → usage learning → SSE events
   ├─ Tool Registry (24 native tools + dynamic mcp__* — Zod validated)
   ├─ Permission (5 layers + BashArity)
   ├─ File Snapshots (undo/rewind) + Message Queue (durable)
   ├─ GlobalBus → WS fan-out (no polling)
   ├─ Storage: SQLite WAL (sessions/messages/parts/todos/snapshots/queue/knowledge)
   ├─ Gateway: OpenRouter + NVIDIA NIM (+25 providers) — cost-tracked
   ├─ LSP: gopls & friends (JSON-RPC stdio) with heuristic fallback
   ├─ MCP: real stdio protocol (initialize/tools/list/tools/call)
   └─ Learning: online learner + usage analysis + knowledge graph
```

## Stack

- **Runtime:** Bun (native SQLite, WAL)
- **Monorepo:** Turborepo — `packages/{server,web,tui,shared}`, `vscode-mira`
- **UI:** SolidJS (Web + TUI)
- **LLM:** Model Gateway (OpenRouter, NVIDIA NIM) — OpenAI-compatible wire
- **Protocols:** MCP stdio, LSP 3.17
- **Memory:** SQLite-backed KnowledgeBase with hybrid retrieval (cosine + tag boost + graph expansion)
- **Instructions:** AGENTS.md + Skills injection
- **Eval:** 3 tiers (PR → nightly → prod); PR tier blocks CI
- **Testing:** Bun test — unit + protocol mocks + E2E (boots the real server; live-LLM/vision/gopls tests gated on keys/binaries)

## Security Defaults

- Server binds **127.0.0.1** — set `HOST=0.0.0.0` explicitly for remote access
- Optional bearer auth: set `MIRA_TOKEN`; clients pass `Authorization: Bearer …` or `?token=…`
- Every mutating tool call is snapshotted; permission layer gates bash/edit/write/MCP

## Quick Start

```bash
bun install

# Optional keys (.env in packages/server works — gitignored)
export OPENROUTER_API_KEY=sk-or-...   # or NVIDIA_API_KEY=nvapi-...

bun run dev            # server :4096 · web :3000 · tui :3001
curl localhost:4096/health
```

Without keys the gateway serves a stub stream — the whole pipeline (tools, permissions, SSE, persistence) still runs.

## Environment Reference

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | Primary provider |
| `NVIDIA_API_KEY` | NVIDIA NIM provider + enables vision model default |
| `FIRECRAWL_API_KEY` / `TAVILY_API_KEY` | websearch quality tiers (DuckDuckGo fallback needs none) |
| `MIRA_VISION_MODEL` | Vision model override (default `nvidia/meta/llama-3.2-90b-vision-instruct`) |
| `MIRA_LSP_GO_CMD` | Custom Go LSP command (default `gopls`) |
| `MIRA_AUTOPILOT=1` | Open PRs for verified self-patches |
| `MIRA_TOKEN` | Require bearer auth |
| `HOST` | Bind address (default `127.0.0.1`) |

See [ARCHITECTURE.md](./ARCHITECTURE.md) and [packages/server/README.md](./packages/server/README.md).

## License

MIT — Open source, provider-agnostic, community-driven.
