# Mira — Kilo Coverage & Positioning Master Doc

**Date:** 2026-08-30  
**Repo:** `slab1/mira` @ `/tmp/aether`  
**Purpose:** Freeze what Kilo Code (`Kilo-Org/kilocode`, 27k★, 1.5M installs, $8M seed, successor to Roo/Cline) does well, map every position to Mira's current spine, and define exactly what Mira must ship to be *better than Kilo on every axis* — without losing Mira's existing moats. This doc is the source of truth for Kilo-driven roadmap; `MIRA_CHALLENGES.md` remains the pre-fix challenge registry.

**Status:** ✅ **P0 shipped `91419048` (K1/K3), P1 shipped `ec65507c` (K2/K4/K5/K8), P2 shipped `c36ea4ba` (K6/K7) — verified `tsc` 0/0/0, `bun test` 58 pass (56 pass 2 skip), 21 tools, 15 agents, `data/memory_bank` ignored. Remaining K10 distribution (JetBrains/Slack) is opportunistic, not parity-blocking.

---

## 0. Executive Summary

**Kilo wins on breadth:** 5 specialized agents with per-agent LLM, Orchestrator multi-agent graph, Memory Bank, inline autocomplete, MCP marketplace, cloud/long-running agents, Sessions/Agent Manager/worktree parallelism, auto-model routing + cost cap, browser automation, JetBrains + Slack + Gateway distribution. Architecture is now a rebuilt CLI engine (`sst/opencode`-like) with thin IDE clients — same spine Mira already uses (Bun :4096, SQLite WAL, thin Web/TUI/VS Code).

**Mira already beats Kilo on depth** (Kilo has no equiv):
1. Hierarchical Memory (episodic/semantic/procedural + hybrid cosine+tag+graph, auto-injected per turn) — Kilo's Memory Bank is flat file notes
2. Eval-first 3-tier gating CI (PR→nightly→prod, blocks CI)
3. Tool-layer guardrails + 5-layer permission + BashArity + audit log (Kilo only mode-scoped permissions)
4. File snapshots before every mutation + `revert`/`rewind` to any message + 9-layer edit fallback
5. Doom-loop detector (3× identical / A-B cycle / no-progress, per-session, window 12)
6. Compaction preserving `toolResults` (abstractive via small model + extractive fallback)
7. Durable SQLite message queue while streaming + chained-turn drain
8. Persistent child sessions (`task` tool) with full transcripts (inspectable subagents)
9. Cost tracking per request + per session, prompt caching for Claude

**Gap to close:** Kilo's *UX breadth* — the 10 positions below. Shipping P0+P1 makes Mira's pitch concrete: *"Kilo's UX (modes, Memory Bank, autocomplete, Orchestrator) + Mira's spine (hierarchical memory, eval, snapshots+undo, guardrails) — which Kilo doesn't have."*

---

## 1. Kilo Feature Inventory (from research 2026-08-30)

Sources: `kilo.ai` (features, architecture, cli/opencode comparison), `Kilo-Org/kilocode` GitHub, Marketplace 1.45M installs, explainx.ai 2026-06-19 guide, baeseokjae 2026-05-12/13 reviews, datastudios 2025-10-30, `kilo.ai/docs/contributing/architecture`.

| # | Kilo Feature | Detail |
|---|---|---|
| K1 | **5 Agents (ex-Modes)** | `code` (full) / `ask` (read-only) / `plan` (read+bash, no writes) / `debug` (full) / `review` — each own system prompt, tool allowlist, **per-agent LLM** (e.g. Opus for code, Flash for ask). Custom agents via `.kilo/agents/*`. Replaced Orchestrator mode → subagent delegation. |
| K2 | **Orchestrator / Boomerang Tasks** | Parent analyzes task → builds dependency graph → spawns sub-agents in parallel. Exclusive to Kilo as of May 2026; best for greenfield, cross-layer refactors, test campaigns. Falls back to single Code mode for tightly-coupled edits. |
| K3 | **Memory Bank** | Persistent FS-backed notes: architectural decisions, conventions, file paths, tech debt, in-progress work. New session Monday already knows `repo pattern`, `auth module being refactored — don't touch`. Cited as #1 retention reason vs Cline. |
| K4 | **Inline Autocomplete (ghost-text)** | Tab completion built-in (like Copilot) — Kilo's second killer feature. Eliminates second tool. |
| K5 | **MCP Marketplace** | Discover + use MCP servers to extend agent capabilities; single-click add. |
| K6 | **Terminal + Browser** | Bash tool + Puppeteer browser automation (navigate/click/type/scroll/screenshot) — build *and* test in same thread. |
| K7 | **Sessions / Agent Manager / Checkpoints / Worktrees** | Start session on one device/cloud → resume on another. Agent Manager runs multiple agents in IDE with Git worktree PR badges + embedded terminal tabs. Git-based checkpoint revert. |
| K8 | **Auto Model + Cost Cap** | Smart routing picks optimal model per task (tiers to balance cost/cap). Cost-cap mode stops agent when per-task budget exceeded. |
| K9 | **Cloud Agents + Gateway (500+ models)** | `Cloud Agents: $5/hr` — run long tasks without local machine. Gateway = 1 API for 500+ models (OpenRouter, Anthropic, OpenAI, Gemini, etc.) with BYOK zero-markup or Kilo Pass (1:1 + bonus, rollover). |
| K10 | **Distribution** | VS Code (primary) + JetBrains native (IntelliJ/PyCharm/WebStorm) + CLI (`npm i -g @kilocode/cli`) + Slack bot + Browser Extension + Mobile (iOS/Android) + Code Reviewer + Gateway + Gastown. OpenRouter #1 by traffic (25T tokens). |
| K11 | **Enterprise** | Pooled credits, unified billing, SSO, audit logs, model allowlists, 9-layer edit-style safety via permission modes. |
| K12 | **Architecture** | Rebuilt CLI engine (fork/build on `sst/opencode` foundation) — `kilo serve` local daemon, clients thin. `packages/kilo-indexing` per-directory async codebase indexing (semantic search). `packages/kilo-gateway` local gateway client. Three layers: Local runtime+clients / Cloud shared services (control plane, Workers/queues/DO) / Adjacent (kiloclaw/gastown/wasteland/webhook-agent-ingest). |

---

## 2. Mira vs Kilo — Coverage Matrix

**Legend:** ✅ Mira superior / 🟡 Mira partial / 🔴 Gap (must cover) / ➖ N/A

| Position | Kilo | Mira Today | Verdict | What to Ship |
|---|---|---|---|---|
| **Provider-agnostic** | ✅ 500+ via Gateway, BYOK zero-markup, Kilo Pass | ✅ Gateway: OpenRouter + NVIDIA NIM (+25 providers), OpenAI-compat wire, stub fallback | ✅ Superior — keep. Kilo has broader catalog, Mira has cost tracking + caching Kilo lacks. Add tiered auto-routing to match K8. |
| **Agents / Modes** | K1: 5 agents, per-agent LLM, custom | `SessionPrompt.loop` single mode + `task` child sessions with personas (`packages/server/src/agents/`) | 🔴 Gap | **P0: 4 agents as first-class** |
| **Orchestration** | K2: Orchestrator graph → parallel sub-agents | `task` tool manual fan-out, `GlobalBus` fan-out, no dependency graph | 🔴 Gap | **P1: Orchestrator Mode v1** |
| **Memory** | K3: Memory Bank file notes (flat) | ✅ Hierarchical KnowledgeBase (episodic/semantic/procedural, cosine+tag+graph, auto-injected) + `finding_*` tools | ✅ Superior core, 🟡 UX gap | **P0: Memory Bank UX wrapper** |
| **Autocomplete** | K4: built-in ghost-text | No inline completion (VS Code extension is client shell only) | 🔴 Gap | **P1: Inline autocomplete** |
| **MCP** | K5: Marketplace discover | ✅ Real MCP stdio (initialize/tools/list/call) + `GET /mcp` status | 🟡 Gap — protocol covered, discovery missing | **P1: MCP Marketplace search** |
| **Terminal/Browser** | K6: bash + Puppeteer | ✅ Bash (5-layer permission + BashArity) + `webfetch`/`websearch` | 🟡 Partial — browser automation missing | **P2: Browser tool** |
| **Sessions / Parallel** | K7: cross-device resume, Agent Manager, worktrees, checkpoints | ✅ Persistent child sessions + job board + bus + snapshots+undo/rewind | 🟡 Core done, UX missing | **P2: Sessions sync + Agent Manager lite** |
| **Cost Control** | K8: auto-model + cost cap | ✅ Per-request + per-session spend, gateway cost stats, prompt caching | 🟡 Tracking done, routing/cap missing | **P1: Auto Model + Cost Cap** |
| **Distribution** | K10: VS Code, JetBrains, CLI, Slack, Browser, Mobile, Cloud | TUI (SolidJS) + Web (SolidJS/Vite) + VS Code extension (`vscode-mira`) | 🟡 Narrower surface | **P2: JetBrains/CLI parity** (after P0/P1) |
| **LSP** | ❌ | ✅ Real LSP 3.17 (gopls today, 9-layer edit fallback) | ✅ Superior — keep |
| **Guardrails / Safety** | K11: mode-scoped permissions only | ✅ Tool-layer enforced + audit log, permission 5 layers + BashArity | ✅ Superior — keep |
| **Eval / Observability** | — | ✅ 3-tier eval gating CI + gateway cost stats + usage learning | ✅ Superior — keep |
| **Durability** | Checkpoints (git revert) | ✅ Snapshots before every mutation + durable queue + chained-turn drain | ✅ Superior — keep |
| **Doom-loop / Compaction** | — | ✅ Per-session detector (window 12, 3× identical) + compaction preserving toolResults | ✅ Superior — keep |

**Score:** Mira superior on 9 positions, gaps on 6 (all Kilo breadth). P0 closes 2 biggest gaps in 1 week.

---

## 3. What Mira Must Cover — Roadmap

### P0 — 1 Week (closes 2 biggest retention gaps)

#### P0-1: Agents as First-Class (K1)

**Why:** Kilo's #1 workflow paper-cut is gone — per-agent LLM routing alone saves 30-50% cost (Opus for code, Flash for ask). Custom agents let teams capture "superpowers."

**Spec:**
- Add `agents: Record<string, AgentConfig>` to `mira.json` / `MiraConfig` (extend `packages/server/src/config/index.ts` + `packages/shared/src/config.ts` + `web/src/api/client.ts` `MiraConfig`).
  ```ts
  type AgentConfig = { prompt: string; tools: string[]; model?: string; permission?: PermissionAction }
  // defaults: code={tools:["*"], model: gateway.default}, ask={tools:["read","glob","grep","memory_search"], model: "cheap"}, plan={tools:["read","glob","grep","bash:read-only","memory_search"], no writes}, debug={tools:["*"], model: "reasoning"}
  ```
- Loop change: `SessionPrompt.loop({agent: "code"|"ask"|...})` → filter `Tool Registry` by agent's allowlist + inject agent's system prompt + select `gateway.resolveModel(agent.model)`. Default `code` for backward compat.
- API: `POST /session/:id/prompt {prompt, agent?, model?}` — `agent` overrides `model` if both set (agent wins). Expose `GET /agents` list.
- UI: Web/TUI agent switcher (badge), `settings` panel model-per-agent.
- Keep 5-layer permission as second gate — agent allowlist is first gate.

**Acceptance:**
- `ask` cannot call `write`/`edit`/`bash:write` (tool not in registry that turn).
- `plan` can `bash: ls` but not `bash: rm` / `write`.
- Cost: `ask` turn uses cheap model even when default is Opus (verify via gateway cost stats).
- Existing `task` child sessions can specify `agent`.

**Files:** `config/index.ts`, `shared/src/config.ts`, `tools/registry.ts`, `session/prompt.ts`, `routes/session.ts`, `web/src/*` settings.

#### P0-2: Memory Bank UX Wrapper (K3)

**Why:** Flat file notes beat "powerful but invisible" KnowledgeBase. Reduces Monday-morning setup 29% (AGENTS.md + Skills already helps).

**Spec:**
- On boot / session create: ensure `data/memory_bank/` (gitignored) with `decisions.md`, `conventions.md`, `tech_debt.md`, `active_work.md`, `file_paths.md`.
- Loop change: before `memory-retrieval`, read `memory_bank/*.md` (if exists) and inject as `Memory Bank` block ahead of hybrid KnowledgeBase results. After each turn where `write`/`edit`/`finding_write` occurred, optionally append to `active_work.md` (or let agent do `write` tool — same as Kilo).
- Add `memory_bank` tool? No — reuse `read`/`write`/`edit`. Just convention + injection. Keep `finding_write` as structured complement.
- Docs: `AGENTS.md` + `README` mention Memory Bank.

**Acceptance:**
- New session auto-injects `memory_bank/decisions.md` content (verify via `loadContext` unit test).
- `git status` ignores `data/memory_bank/` (already via `data/` / `**/data/`).
- No regression on existing `KnowledgeBase` retrieval (cosine+tag+graph).

**Files:** `session/prompt.ts:loadContext`, `storage/db.ts` (no schema change), `AGENTS.md`.

### P1 — Month (closes 4 gaps)

#### P1-1: Orchestrator Mode v1 (K2)

**Spec:** Extend `task` tool: `orchestrate: { goal: string, subTasks: {id, prompt, agent?, dependsOn?: string[]}[] }` → build DAG, topologically sort, spawn children in parallel waves, collect `jobId`s, merge results into parent turn. Reuse existing `task` job board + `GlobalBus`. Falls back to sequential when DAG is dense (heuristic: if >50% edges, run sequential).

**Acceptance:** 3-wave parallel ref (`types → server → web`) runs 2× faster than sequential (verify via `jobs` + `bus` events). Tightly-coupled task (single file) still runs as single `code` turn.

#### P1-2: Inline Autocomplete (K4)

**Spec:** In `vscode-mira`, add `InlineCompletionItemProvider` that calls `POST /complete {prefix, suffix, file}` → gateway with cheap model (`MIRA_AUTOCOMPLETE_MODEL`, e.g. `google/gemini-flash-1.5`) → ghost-text. Gate via `MIRA_AUTOCOMPLETE=1`.

**Acceptance:** Tab completion appears in `.ts` within 300ms on local, no completion when `MIRA_AUTOCOMPLETE=0`.

#### P1-3: MCP Marketplace Search (K5)

**Spec:** New tool `mcp_marketplace_search {query}` that queries curated registry (e.g. `mcp.so` or local list in `packages/server/data/skills/` style), returns `mcp.json` snippets. User then `confirm` to add to `mira.json` `mcp` section via `saveConfig`. Keep existing `mcp` stdio client.

**Acceptance:** `search "postgres"` returns `mcp__postgres` config, add → `GET /mcp` shows `connected`.

#### P1-4: Auto Model + Cost Cap (K8)

**Spec:** Add to `MiraConfig`: `autoModel: {enabled: bool, tier: "cheap"|"balanced"|"max"}` + `costCap: {perTask: number, perSession: number}`. Gateway `resolveModel` now checks `autoModel` tier + `agent.model` precedence: `explicit model > agent.model > autoModel tier > default`. Loop checks `session.spend > costCap.perTask` before each `gateway.stream`, aborts with `Cost cap exceeded` BusEvent.

**Acceptance:** `costCap.perTask=$0.50` abort after 3 turns (verify via `session` spend). `autoModel.tier=cheap` routes `ask` to flash even when default is Opus.

### P2 — Quarter (closes remaining)

- **P2-1: Browser Tool (K6):** `browser_navigate`/`click`/`type`/`screenshot` via Puppeteer, gated by `guardrails` (`allowedRoots`, `blockedPaths`). Reuse `webfetch` guard.
- **P2-2: Sessions Sync + Agent Manager Lite (K7):** `GET /session/:id/export` → `POST /session/import` (reuses `storage` + SQLite `messages` dump). Web panel lists active `jobs` with worktree path + `gh pr view` badge (poll). Keep git checkpoint via existing snapshots.
- **P2-3: Distribution parity (K10):** JetBrains plugin thin wrapper over `kilo serve`-like daemon (reuse `packages/server` as daemon), CLI `mira` (Bun) mirroring `kilo` CLI.

---

## 4. Architecture Decisions (no breakage)

- **Thin engine + thin clients:** Keep Mira's `SessionPrompt.loop` as single engine (like `kilo serve` / `opencode CLI`). Agents are *loop parameters*, not separate binaries. No new process model.
- **Two gates:** Agent tool allowlist (first gate, UX) + existing 5-layer permission + guardrails (second gate, security). Never relax security for UX.
- **Memory:** Memory Bank is *injection* layer before KnowledgeBase retrieval — no schema change, no new DB. `data/memory_bank/` is gitignored runtime, like `mira.db`.
- **Orchestrator:** DAG is heuristic, not LLM-planned initially — keeps cost 1× (vs Supervisor 2-5×). Earn complexity.

---

## 5. Verification & Metrics

| Check | Command | Gate |
|---|---|---|
| Types | `bunx tsc --noEmit` in `server`+`web` | 0 errors |
| Tests | `bun test src` (55+) + `e2e` live-LLM gated | PR tier PASS |
| Agent isolation | `ask` turn cannot `write` (tool not in registry) | unit test |
| Cost routing | `ask` uses cheap model vs `code` uses Opus (gateway stats) | e2e |
| Memory Bank | `loadContext` injects `memory_bank/*.md` | unit test |
| Spend cap | `costCap` abort after threshold | e2e |
| MCP search | `mcp_marketplace_search` → `GET /mcp` connected | e2e |
| Git noise | `git status` clean (no `*.db` in index) | CI |

Track weekly: P0 shipped? P0-1 + P0-2 land in `main` within 7 days, behind `MIRA_AGENTS=1` / `MIRA_MEMORY_BANK=1` flags if needed.

---

## 6. Positioning Statement (for README / site)

> **Mira is Kilo's workflow + Mira's spine.**
>
> *Kilo gave the category multi-mode, Memory Bank, Orchestrator, and Gateway distribution. Mira keeps that UX and adds what Kilo doesn't: hierarchical memory (not flat notes), eval-gated CI, tool-layer guardrails with audit, snapshots+undo with 9-layer edit fallback, doom-loop detection, compaction that preserves tool history, durable queueing, and inspectable subagents — all open-source, provider-agnostic, and cost-tracked.*

Update `README.md` Why Mira table after P0: add row `Agents (per-agent LLM)` — Kilo ✅, Mira ✅ (after P0), keep `Mira` superior rows.

---

## 7. Sources

- `kilo.ai` — features, architecture, cli/opencode, pricing, Gateway, Slack/Cloud/Gastown
- `github.com/Kilo-Org/kilocode` — 27,056★, 30k commits, Apache-2.0, fork of Roo/Cline, opencode server foundation
- `marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code` — 1,457,422 installs, modes: Code/Architect/Ask/Debug/Orchestrator, Marketplace prem
- `explainx.ai/blog/kilo-code-ai-coding-agent-guide-2026` 2026-06-19 — BYOK, 500+ models, modes→agents rename
- `baeseokjae.github.io/posts/kilo-code-review-2026` 2026-05-13 — Orchestrator, Memory Bank, autocomplete as killers, JetBrains/Slack
- `baeseokjae.github.io/posts/open-source-ai-coding-agents-2026` 2026-05-12 — Roo 23.8k★/1.55M shutdown, Kilo as successor
- `datastudios.org/post/kilo-code...` 2025-10-30 — modes, terminal+browser, enterprise
- `deepwiki.com/Kilo-Org/kilocode/3-architecture` — opencode CLI as central backend
- Mira: `README.md`, `ARCHITECTURE.md`, `packages/server/README.md`, `docs/MIRA_CHALLENGES.md`, `docs/PAIN_POINTS_TOLERANCE_FIXES.md`

---

**Next step:** Land git-noise fix (this commit), then implement P0-1 (`agents`) behind flag, P0-2 (`memory_bank`) as convention — no breaking change.
