# Mira System Documentation

> **Status: Implemented** — verified in `slab1/mira:main` at `c34759a8` (523 pass / 0 fail, `:4096` healthy).  
> **Policy:** Planned capabilities must not be represented as already implemented. Each section marks `Implemented` / `Target` / `Policy`.

## Overall Architecture

```
[Clients] TUI (SolidJS) | Web (SolidJS/Vite + PWA + Brio) | VS Code | Slack | CLI
         ↕ REST / SSE / WebSocket (+ MIRA_TOKEN / MIRA_API_KEYS)
[Server :4096 — Bun, Hono, SQLite]
  SessionPrompt.loop → context = system + skills + memory + history
  → Gateway (SubgatewayRegistry + ProviderRegistry) → Tools (22) → Guardrails → Bus
  → Evaluation → Learning → Evolution → Memory
```

**Implemented:** Monorepo `server` (Bun 1.3.14, Hono, SQLite `data/mira.db`), `web` (SolidJS, Vite, PWA, `Brio` page), `cli` (`mira-cli-ts`), `shared` (Zod config), `tui`, `slack`. Port file `.mira/port`, `serve-local.sh` / `scripts/dev-watch.ts` (now sources `~/.mira/mira.env`), `docker-compose.yml` + `docker-compose.override.yml` (colibri sidecar).

## Core Mira Loop — Implemented

```text
Memory → Intelligence → Agents → Tools → Execution → Evaluation → Learning → Evolution → Memory
```

* **Memory — Implemented:** `shared/memory_controller.py` HCM L1 Working/L2 Episodic/L3 Semantic/L4 Procedural; `~/.config/opencode/memory/aether/` + `memory/` injection per turn; snapshots `.coli_usage` for colibri.
* **Intelligence — Implemented:** `gateway/` `ProviderRegistry` (longest-prefix, `hasKey` via `expandEnv`), `SubgatewayRegistry` lanes `default/cheap/vision/local/compaction/agent:*`, `router.ts` + `subgateway.ts` (circuit, rate limit, retry, health).
* **Agents — Implemented:** `agents/templates.ts` `code/ask/plan` + per-agent LLM, `AgentRouter`, `orchestrator` DAG, `inspectable subagents` via `ToolRegistry` `subagentRunner`.
* **Tools — Implemented:** 22 tools (`bash, read, write, edit, glob, grep, webfetch, websearch, todowrite, task, orchestrate, browser (Playwright), findings, question, lsp, memory, session, brio, ...`) + `MCP` (firecrawl, context7, filesystem, etc.) + `mcp_marketplace` + `mcp__*` dynamic.
* **Execution — Implemented:** `ToolRegistry` with `needsPermission`, `GuardrailsManager` (enforce/audit), `PermissionManager`, `read-before-edit` guard, `snapshotFile` before mutation + `undo` to message.
* **Evaluation — Implemented:** `shared/eval/` 3-tier gating CI (`test`/`typecheck`/`build` + `eval (PR fast)`), `agent-eval` golden datasets, `brio.test.ts` mock `:18080`.
* **Learning — Implemented (target extended):** `shared/learning/` scheduler (online every 60m, improvement every 24h), `knowledge=12`, `Pain-point detection → verified patches → autopilot PRs` (implemented), `online` research via firecrawl/tavily (target: active research loop).
* **Evolution — Target:** `MIRA_EVOLUTION_SPEC.md` — observe→research→diagnose→propose→experiment→patch→verify→canary→promote/rollback→remember (implemented as `opencode_improvement/logic_evolve.py` shadow, not yet promoted without `runEval("pr")` gate — see Policy).

## System Model — Implemented

* **Storage:** SQLite (`sessions`, `messages`, `snapshots`, `audit_entries`), `Bus` (EventEmitter + WS), `metrics` (httpRequestsTotal, durations, gateway cost).
* **Gateway:** `ProviderRegistry` + `KeyRing` (`expandEnvArray` for `MIRA_API_KEYS="k1,k2"`), `hasKey`/`isHealthy`/`circuit breaker`. Providers: `nvidia` (primary, `deepseek-v4-flash`), `anthropic`, `openai`, `google`, `deepseek`, `colibri` (`http://127.0.0.1:8000/v1`, `qwen3.6`/`olmoe`/`glm-5.2`, fallback only, `brio` tool). `local`/`compaction` keep `nvidia` primary, `colibri` opportunistic (180s timeout).
* **Security:** `MIRA_TOKEN` 64-hex (`~/.mira/mira.env`), `MIRA_API_KEYS` multi-tenant `hashKey` + `timingSafeEqual`, `HOST=127.0.0.1` loopback, `CORS_ORIGINS`, `MIRA_NO_AUTOPROVISION=1` for E2E isolation (isolates `MIRA_TOKEN` from host file).
* **CI:** `CI` (`test`/`typecheck`/`build`/`repo-hygiene`/`auth-guard` + `docker`/`deploy` + `Security` `CodeQL`/`secrets scan`), `bunfig.toml` `symlink` backend + `preserveSymlinks` in 6 tsconfigs (proot aarch64).

## Interfaces — Implemented

* `GET /healthz` (no auth) + `GET /health` (auth, now includes `colibri:{ok,baseURL,latencyMs|error}` 800ms probe) + `GET /gateway/health` (lanes/providers) + `GET /metrics` (Prometheus) + `GET /providers` + `GET /tools` (22) + `POST /tools/brio` / `POST /v1/brio`.
* `POST /session`/`/prompt` (SSE `step_start`/`tool_result`/`finish`/`error`), `WS /` (BusEvent), `WS /terminal` (pty), `GET /terminal`.

## Configuration — Implemented

* `mira.json` + `mira.json.example` (provider `nvidia` + `colibri`, `routing.fallbacks`, `subgateways`, `loop`, `tools.terminal`, `features`), `opencode.jsonc` (`model: opencode/deepseek-v4-flash-free`, same `provider:colibri` added), `~/.mira/mira.env` (`MIRA_TOKEN`, `MIRA_API_KEYS`, `NVIDIA_API_KEY`, `COLI_API_KEY`).

## Tests — Implemented

* `523 pass / 0 fail / 2 skip` (276s full), `16` E2E isolated (`server.e2e` 8 + `gaps` 5 + `queue` 1 + `brio` 2 + `gateway` 16), `MIRA_NO_AUTOPROVISION=1` isolates host token.

## Security Boundaries — Policy

* `Policy:` No silent model precision/router change (colibri `DIRECT=1` etc. opt-in, `brio` `mean` vs `sum` explicit), `read-before-edit` guard, `MIRA_READ_GUARD=1`, `OWNERSHIP_ENABLED` owner-scoped sessions, WS fail-closed.

## Operational Procedures — Implemented

* `scripts/serve-local.sh` (`start`/`stop`/`status`, sources `mira.env`, `colibri: ready/not running` hint, `setsid nohup`), `scripts/dev-watch.ts` (watches `src` + `shared/src`, now loads `mira.env` before spawn), `docker-compose.yml` + `docker-compose.override.yml` (`colibri: ghcr.io/slab1/colibri:slim`, `:8000`), `slab1/colibri` fork GHCR `docker` workflow (block scalar fix `3619cf5`).

## Known Limitations — Target

* `colibri` needs 7–372GB model + fast NVMe, not required locally (fallback to `nvidia`); `turbo dev` needs `hardlink` vs `symlink` for `vite` (`picomatch` peer) on this host — keep `symlink` for CI, `hardlink` for local dev or manual link.
