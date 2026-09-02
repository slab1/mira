# Mira Review — 2026-09-02

**Repo:** `slab1/mira` @ `/tmp/aether` | **Commit:** `1ba6288e` | **Purpose:** Freeze review findings before H1 hardening

## Executive Summary

- **Single-node ceiling:** God files (`index.ts` 1380 lines, `prompt.ts` 880 lines), SQLite WAL + in-memory Bus (1000 ring, not persisted), `loadContext` full scan → OOM at 10k msgs. No horizontal scale.
- **Honesty gaps:** `priceFor()` hardcoded, `stubStream` silently succeeds with no key in prod, retry no jitter/circuit breaker, `toolCallAccum` unbounded.
- **Bet the company:** Memory + Eval flywheel — ship `GET /learning/score` this week, pgvector spike next. Only durable moat vs commodity models.

## 1. Architecture — 5 Strengths / 5 Weaknesses

**Strengths**
1. Thin engine + thin clients — `packages/server/src/index.ts:6` single `SessionPrompt.loop` reused by Web/TUI/VSCode/Slack. No process-per-agent.
2. Event-driven, no polling — `packages/server/src/bus/index.ts:37` `Bus.publish` fan-out to typed + session handlers + WS. `recent(50)` catch-up.
3. Defense-in-depth tool safety — `permission/index.ts:132` 5 layers + `BashArity` + `guardrails/index.ts:223` + `tools/registry.ts:189` snapshot-before-mutation + `storage/snapshots.ts:36` undo/rewind.
4. Hierarchical memory — `learning/knowledge.ts:88` KnowledgeBase (episodic/semantic/procedural, cosine+tag+graph, auto-linked) + `session/prompt.ts:759` memory_bank injection.
5. Provider-agnostic gateway — `gateway/index.ts:156` OpenAI-compat wire → OpenRouter/NVIDIA/Anthropic/OpenAI, `priceFor()` cost tracking, prompt caching for Claude.

**Weaknesses**
1. God file `index.ts` ~1380 lines — HTTP, WS, auth, rate-limit, metrics, static serving, session CRUD, queue, snapshots all inline.
2. Single-node SQLite WAL ceiling — `storage/db.ts:36` WAL, no pgvector (keyword hash 64-dim `knowledge.ts:335`).
3. Ephemeral bus — `bus/index.ts:30` maxHistory 1000 ring, not persisted. Crash loses waiters `bus/index.ts:93` (60s timeout) and SSE deltas.
4. Stub fallback masks misconfig — `gateway/index.ts:268` `stubStream` returns plausible text when no API key. Loop still runs, burns steps.
5. SessionPrompt god class 880 lines — `session/prompt.ts:130` owns queue, compaction, doom-loop, cost-cap, subagent spawning.

## 2. Code Quality — Top 10 Issues

| # | Severity | File:Line | Issue | Effort |
|---|----------|-----------|-------|--------|
| 1 | High | `bus/index.ts:64` `catch {}` | Session handler errors swallowed — 100 hits `catch.*{}` | 1h |
| 2 | High | `tools/edit-fallback.ts:238` | Layer 7 writes collapsed content, destroys formatting | 30m |
| 3 | High | `eval/benchmarks.ts:240` `stubAgent()` | Benchmark always passes — never calls real SessionPrompt | 2h |
| 4 | Medium | `gateway/index.ts:168` + `prompt.ts:87` | `priceFor()` duplicated (6 models) — drift risk | 15m |
| 5 | Medium | `tools/browser.ts:34` `@ts-expect-error` | Optional puppeteer no pin, no try/catch around launch() | 1h |
| 6 | Medium | `learning/knowledge.ts:335` `EMBED_DIM=64` | Keyword hash embedding high collision, no IDF | 4h |
| 7 | Medium | `learning/improvement.ts:391` `applyChange()` | RCSI patch appends comment only — never rewrites logic | 3h |
| 8 | Medium | `tools/mcp_marketplace.ts:25` | Offline hardcoded 10-entry registry stale | 2h |
| 9 | Low | `routes/config.ts:86,92` | `@ts-expect-error` without reason comment | 5m |
| 10 | Low | `index.ts:421` `rateLimitBuckets` | No cap, IP churn grows unbounded until TTL | 30m |

## 3. Test Coverage

- **Claimed:** 134 pass / 22 files (Phase B). Actual: ~24 suites (19 server + 3 e2e + shared + slack).
- **Gaps:** No coverage tool (`bun test --coverage` not wired), live tests auto-skip (`OPENROUTER_API_KEY`, `hasGopls`), critical paths untested (cost-cap `prompt.ts:482`, compaction `prompt.ts:520`, `waitForPermissionReply` timeout, `revertToMessage`), eval stubbed (`benchmarks.ts:240` + heuristic judge).
- **E2E:** `e2e/server.e2e.test.ts` boots real Hono, tests SSE/queue/snapshots/revert. Missing multi-tenant ownership, orchestrate DAG, browser tool.

## 4. Competitive Gaps (vs Kilo/Cursor/Windsurf/Cline 2026)

| # | Gap | Who Has It | Mira Today |
|---|-----|------------|------------|
| G1 | JetBrains native | Kilo/Claude/Cursor JetBrains plugins | Only VS Code (8 cmds), no JetBrains |
| G2 | Cloud Agents / sync | Kilo Cloud ($5/hr, 500+ models), Cursor Background (52hr runs) | `task` child sessions but no cloud runner / cross-device resume |
| G3 | Inline autocomplete | Cursor Tab 200-500ms, Kilo Tab multiline | Stub gated by `MIRA_AUTOCOMPLETE=1`, no SLO |
| G4 | Orchestrator DAG / board | Claude Agent Teams (87.6% SWE-bench), Cursor Agents Window, Kilo Agent Manager | Manual `task` fan-out, no DAG/board |
| G5 | Browser / voice / indexing | Kilo Puppeteer + Voice + `kilo-indexing`, Cline browser | `webfetch` only, no Puppeteer/voice/index |

*Mira beats rivals on 9 positions:* hierarchical memory, eval-first 3-tier CI, guardrails+audit, snapshots+undo+9-layer edit, doom-loop detector, compaction preserving toolResults, durable queue, inspectable subagents, cost tracking + caching.

## 5. Enhancement Opportunities — Ranked

| Rank | Opportunity | Impact | Effort | Mira Hook |
|------|-------------|--------|--------|-----------|
| 1 | Agents + Memory Bank UX (K1/K3) — 4 agents per-LLM + `data/memory_bank/*.md` injection | High | Low (1w) | `config/index.ts`, `tools/registry.ts`, `prompt.ts:loadContext` |
| 2 | Task surface + AG-UI streaming — separate activity panel, STEP lifecycle, pause/resume | High | Medium | `bus/index.ts`, `web/src/*`, `tui/src/routes/session` |
| 3 | Auto-model + cost cap + caching GA — tier cheap/balanced/max + `costCap` + prompt caching | High | Low | `gateway/index.ts:202`, `prompt.ts:460` |
| 4 | MCP marketplace + browser — search `mcp.so` + Puppeteer gated by guardrails | Medium-High | Medium | `tools/registry.ts`, `mcp/http-client.ts` |
| 5 | Vision + 1M ctx — wire `MIRA_VISION_MODEL` + 1M ctx (Opus 4.7/Kimi K3) | Medium | Low-Med | `gateway/index.ts:273`, `prompt.ts` |

## 6. Roadmap — 3 Horizons

### Horizon 1 — Next 2 Weeks: Polish & Stability
*Goal: single-node rock-solid + distribution real. No new moat yet.*

**H1-1 Distribution Unblock (2–3d)**
- Why: `product-expansion-plan.md` code-done but not live: `NPM_TOKEN` not set, Slack needs `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`.
- What: Set `NPM_TOKEN` + publish `mira-cli-ts@0.1.0`, create Slack app Socket Mode, add `GET /healthz` provider check to CI gate.
- Metric: `npx mira --help` resolves, bot posts in thread.

**H1-2 Persistence & Perf (4–5d)**
- Why: R1 kills at 100 sessions. `ChatView.tsx:43k` no virtualization janks at 1k msgs. `loadContext` full scan #1 latency.
- What: Paginate `GET /session/:id/message?cursor=&limit=50`, virtualize ChatView (`@tanstack/virtual`), cap `loadContext` 200 msgs + compaction summary, LRU eviction for `doomDetectors`/`rateLimitBuckets`, enable `js-tiktoken` default.
- Metric: p95 `loadContext` <200ms at 5k msgs; no OOM at 10k.

**H1-3 Gateway Honesty (2d)**
- Why: R2 stub masking is prod incident.
- What: Fail-closed stub in prod, real `usage.cost` from provider, circuit breaker (3×429→60s cooldown), bound `toolCallAccum` (max 20).
- Metric: `stubStream` never fires when `NODE_ENV=production`.

**H1 Quick Wins (this batch):**
- [x] `edit-fallback.ts:232-289` Layer 7 preserves formatting via original offsets
- [x] `gateway/pricing.ts` single source `priceFor()` (was duplicated)
- [x] `.github/workflows/*.yml` `turbo-${{github.sha}}` → `turbo-${{hashFiles('bun.lock')}}` (restores cache hits)

**Exit bar:** `npx mira` live, `GET /learning/score` visible, p95 <200ms, no stub in prod.

### Horizon 2 — Next 2 Months: Differentiation
*Goal: turn 9 superior positions into visible moat.*

**H2-1 Memory v2: Graph + Temporal (3–4w)**
- Promote `knowledge_entries` to `pgvector` (keep SQLite for sessions, add Postgres when `MIRA_PG_URL` set). Temporal decay, entity graph (file→symbol→decision), `memory_search` rerank. `memory_bank/*.md` becomes view over graph. Eval: LongMemEval nightly.
- Answers "Why not just Claude Code?" → "Mira remembers your repo's decisions across months, with proof."

**H2-2 Eval as Product: Mira Score (2–3w)**
- User-visible per-session `{score,cost,doomLoops,toolErrors,memoryHits}` from `learning/usage.ts` + `knowledge.ts`. Trace viewer (OTel spans `index.ts:291` + `X-Request-Id`) + Langfuse link. Gate autopilot PRs on score delta.
- Metric: Every PR shows `Mira Score: 8.2/10 (cost $0.12, 3 tool errors, 0 doom-loops)`.

**H2-3 Orchestrator v2 + Skill Synthesis (3w)**
- `orchestrate` with `inferDAG:true` — parent LLM emits `tasks[]` with `dependsOn`, waves run via `Promise.all`. `skill_synthesizer` watches `findings`+`audit_entries` and proposes `mira.json: skills` patches, verified via shadow eval.

### Horizon 3 — Next 6 Months: Platform
*Goal: tool → ecosystem with network effects.*

**H3-1 Cloud Control Plane (6–8w)** — Postgres+pgvector for sessions/memory, Redis/NATS for Bus (replace in-memory), `MIRA_PG_URL`+`MIRA_REDIS_URL` opt-in, keep SQLite for local dev, workspaces, SSO (Clerk), Stripe billing.
**H3-2 Plugin & Agent SDK + Marketplace (6w)** — `@mira/sdk` (`defineTool()`), WASM/Deno sandbox, versioned marketplace (extend `mcp_marketplace.ts` + `skills/loader.ts`), revenue share. Dogfood Slack bot as first plugin.
**H3-3 Enterprise Trust (4–6w)** — Policy-as-code (`mira.json: guardrails` → OPA-style), data residency, BYOK encryption, SOC2 audit export, `HOST=0.0.0.0`+`MIRA_STRICT_AUTH=1` checklist.

## 7. Bet the Company

**Memory + Eval Flywheel — make Mira the only agent that gets *provably* smarter per repo.**

Models commoditize (OpenRouter 500+ models), UX copyable in weeks. Only durable moat is compounding memory with eval proof. Mira has hierarchical episodic/semantic/procedural + hybrid retrieval + auto-injection (`prompt.ts:784` `searchKnowledge`) but heuristic; has 3-tier eval gating CI but internal, not user-visible.

**Bet:** H2 ship Memory v2 (graph+temporal+pgvector) + Mira Score as single flywheel: every session writes `findings`+`knowledge_entries`, every night eval measures recall (LongMemEval) + task success, every week score published per repo. Repo's Mira Score becomes hiring signal ("this repo's agent is 8.7/10").

**First step (this week, before H2):** `GET /learning/score?sessionID=` returning `{score,cost,doomLoops,toolErrors,memoryHits}` from already-collected `learning/usage.ts` + `knowledge.ts`. Show in `ChatView` header next to `pill-cost` (`App.tsx:389`). No new infra. Turns invisible moat into visible proof, forces measurement before scaling.

## Appendix A — Quick Wins Checklist

- [x] Layer 7 edit-fallback preserves formatting
- [x] priceFor single source
- [x] turbo cache key hashFiles
- [ ] `catch {}` → `console.warn` (top 10)
- [ ] `bun test --coverage` + badge
- [ ] `@ts-expect-error` add reasons (2 in `routes/config.ts`)
- [ ] `rateLimitBuckets` cap (1000) + LRU
- [ ] `js-tiktoken` enable by default

## Appendix B — Dependency Audit (2026-09)

| Workspace | Deps | Latest | Verdict |
|-----------|------|--------|---------|
| root | `turbo 2.10.11`, `ts 5.9.3`, `bun@1.2.0` | Turbo latest, Bun 1.3 latest | Bun stale |
| server | `ai 5.0.0`, `hono 4.7.0`, `drizzle 0.44`, `zod 4.0`, `ws 8.18` | All latest/1 minor behind | Modern |
| web | `solid-js 1.9.0`, `vite 6.2`, `vite-plugin-solid 2.11` | Vite 7 beta | Modern |
| tui | `@opentui/solid 0.1.0` | Pre-1.0 | Early, watch |
| vscode-mira | `vscode ^1.99`, `@types/node ^20` | Node 22 LTS | Node types stale |
| Missing | — | — | Need `biome`, `puppeteer`/`playwright-core`, `@modelcontextprotocol/sdk`, `vite-plugin-pwa` |

## Appendix C — File Map

- `packages/server/src/index.ts:1380` — god file
- `packages/server/src/session/prompt.ts:880` — god class
- `packages/server/src/gateway/index.ts:598` — gateway + stub
- `packages/server/src/bus/index.ts:142` — ephemeral bus
- `packages/server/src/learning/knowledge.ts:369` — KB + 64-dim hash
- `packages/server/src/tools/edit-fallback.ts:289` — 9-layer edit
- `docs/KILO_COVERAGE.md:205` — P0/P1/P2 shipped
- `docs/product-expansion-plan.md:150` — npm/PWA/Slack done, blocked on creds

