# Mira — AI Agent Platform Better Than All

> **Openness + Claude's reasoning + Cursor's polish + Windsurf's autonomy + Cline's transparency, minus weaknesses, plus memory/eval/guardrails as first-class.**

Mira is a next-gen AI agent platform: **hierarchical memory, eval-first observability, tool-layer guardrails, file snapshots with undo, real LSP + MCP integration, HITL questions, and a cost-tracking model gateway — all verified by a 119-test suite (0 failing) including live-provider E2E gates and real-wire protocol tests.**

## Why Mira?

| Feature | Legacy | Claude Code | Cursor | Windsurf | Cline | **Mira** |
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
| Cost Control | ✅ Free | $20-200 | $20-200 | $15-35 | Free | ✅ **Free + local, live spend display, prompt caching, cost-cap per-task/session** |
| Kilo Parity (2026-08) | — | — | — | — | — | ✅ **Agents (code/ask/plan, per-agent LLM) · Memory Bank · Orchestrator DAG · MCP Marketplace · Inline Autocomplete · Browser · Sessions Sync · Slack (Socket Mode)** |

## Architecture

```
[Clients] TUI (SolidJS) | Web (SolidJS/Vite + PWA) | VS Code | Slack (Socket Mode) | CLI (`mira-cli-ts` via npx)
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
   ├─ MCP: real stdio + remote HTTP (Streamable HTTP & legacy HTTP+SSE) clients
   ├─ Observability: Prometheus /metrics (bounded-cardinality + real histograms),
   │   OTel spans correlated with HTTP access logs via X-Request-Id
   └─ Learning: online learner + usage analysis + knowledge graph
```

## Stack

- **Runtime:** Bun (native SQLite, WAL)
- **Monorepo:** Turborepo — `packages/{server,web,tui,shared,cli,slack}`, `vscode-mira`
- **UI:** SolidJS (Web + TUI)
- **LLM:** Model Gateway (OpenRouter, NVIDIA NIM) — OpenAI-compatible wire
- **Protocols:** MCP stdio + Streamable HTTP + legacy HTTP+SSE, LSP 3.17
- **Memory:** SQLite-backed KnowledgeBase with hybrid retrieval (cosine + tag boost + graph expansion)
- **Instructions:** AGENTS.md + Skills injection
- **Eval:** 3 tiers (PR → nightly → prod); PR tier blocks CI
- **Testing:** Bun test — unit + protocol mocks + E2E (boots the real server; live-LLM/vision/gopls tests gated on keys/binaries)

## Security Defaults

- Server binds **127.0.0.1** — set `HOST=0.0.0.0` explicitly for remote access
- Optional bearer auth: set `MIRA_TOKEN`; clients pass `Authorization: Bearer …` (query-param tokens are rejected)
- Rate limiting per real socket peer (Bun `requestIP`, unforgeable); proxy headers only honored under `MIRA_TRUST_PROXY=1`; per-route SSE bucket for streaming endpoints
- Every mutating tool call is snapshotted; permission layer gates bash/edit/write/MCP

## Quick Start

```bash
bun install

# Optional keys (.env in packages/server works — gitignored)
export OPENROUTER_API_KEY=sk-or-...   # or NVIDIA_API_KEY=nvapi-...

bun run dev            # server :4096 · web :3000 · tui :3001
curl localhost:4096/health

# CLI (thin, no extra deps) — npx parity with Kilo/OpenCode
bun run --cwd packages/cli src/cli.ts -- --help
bun run --cwd packages/cli src/cli.ts -- serve --port 4096
mira session list                              # via $MIRA_API_URL
mira agent list
mira complete --prefix "function add(a,b) {" --file src/math.ts
```

Without keys the gateway serves a stub stream — the whole pipeline (tools, permissions, SSE, persistence) still runs.

Slack bot (no tunnel, Socket Mode):

```bash
# Mint an owner-scoped key for the Slack team, then run the bot
curl -X POST http://127.0.0.1:4096/admin/api-keys -H "Authorization: Bearer $MIRA_TOKEN" -d '{"owner":"slack-team"}'
MIRA_API_URL=http://127.0.0.1:4096 MIRA_API_KEY=<key> SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... bun run --cwd packages/slack src/bot.ts
# in Slack: /mira explain ./src/index.ts  or  @Mira refactor this
```

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

## Production Deployment

```bash
# Build image
docker build -t ghcr.io/slab1/mira:latest .

# Run with persistent data volume
docker run -d \
  --name mira \
  -p 4096:4096 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  ghcr.io/slab1/mira:latest
```

**Required env vars:** `HOST=0.0.0.0`, `MIRA_TOKEN`, `OPENROUTER_API_KEY` or `NVIDIA_API_KEY`. See `.env.example` for the full set (multi-tenant keys, CORS allowlist, loop limits, eval gate).

Health checks:
- `GET /healthz` — unauthenticated liveness (used by Docker/compose HEALTHCHECK; works under auth)
- `GET /health` — detailed, behind the bearer gate

### Multi-tenancy

Set `MIRA_API_KEYS=key-alice:alice,key-bob:bob` to issue per-user credentials. Sessions are stamped with an owner; every session route (prompt, messages, export, todos, snapshots, jobs) and WebSocket event stream is owner-scoped — foreign resources return 404. Child sessions spawned by the `task` tool inherit the parent's owner.

Single-token mode (`MIRA_TOKEN` only) maps everything to an implicit `"default"` owner and behaves exactly as before.

### API surface

| Route | Auth | Description |
|-------|------|-------------|
| `GET /healthz` | none | liveness |
| `GET /metrics` | see note | Prometheus scrape |
| `GET/POST /session` | bearer | list (owner-scoped) / create |
| `GET/DELETE /session/:id` | bearer | detail / delete (404 if foreign) |
| `POST /session/:id/prompt` | bearer | SSE stream; body `{prompt, model?, maxSteps?}` |
| `GET /session/:id/message` · `/todo` · `/export` | bearer | history, todos, transcript |
| `GET/POST/DELETE /session/:id/queue` | bearer | message queue while streaming |
| `GET /session/:id/snapshots` · `POST …/revert` | bearer | file undo/rewind |
| `GET /session/:id/jobs` · `GET /job/:id` · `POST /job/:id/cancel` | bearer | background subagent job board |
| `WS /` | bearer or first-message auth | live bus events, owner-scoped |

Agent tools include `finding_write` / `finding_list` / `finding_resolve` — structured cross-session team memory (open findings are auto-injected into every loop context).

CI/CD: `.github/workflows/cd.yml` builds multi-arch image to GHCR and deploys when `vars.DEPLOY_ENABLED=true`.

## License

MIT — Open source, provider-agnostic, community-driven.
