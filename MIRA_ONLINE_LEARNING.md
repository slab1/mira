# Mira Online Learning

> **Status:** `Implemented` (scheduler + research scaffolding) / `Target` (active research loop) — see per-section.
> **Server module roadmap:** `docs/ONLINE_LEARNING_ROADMAP.md` (5 phases, status refreshed 2026-09-25 — keyless acquisition, LLM extraction, cross-run dedup, utility loop all ✅; remaining: DDG tier-4, verifiers, tombstone sweep, status surfacing, ops hygiene + 2 test files).

## Research System — Target (scaffold Implemented)

* **Implemented:** `shared/learning/scheduler` (online every 60m, improvement every 24h, `knowledge=12`), `MCP` `firecrawl`/`tavily` for web research, `platforms/skill_synthesizer.py` scaffold mode (researches + writes + validates new skills when gap detected, but honest eval gate not yet enforced).
* **Target:** Active research loop that autonomously researches via `firecrawl_search` + `firecrawl_scrape`/`extract`, validates via `agent-eval`, and proposes skill patches. Currently manual via `librarian` agent.

## Online Learning Loop — Policy

* **Policy:** Research must be citation-backed (`publish_date`, `url`, `excerpts`), `firecrawl_search_feedback` after use (refund 1 credit), no hallucinated sources. `MIRA_ONLINE_LEARNING.md` must distinguish `Implemented` (verified to exist) vs `Target` (proposed).

## Sources — Implemented

* **Implemented:** `firecrawl` (web search/scrape/extract), `tavily`, `context7`, `supabase` docs, `huggingface` via `colibri` model cards, `github` via `gh` CLI.

## Skill Synthesis — Target

* **Target:** `platforms/skill_synthesizer.py` DCS pillar — detects capability gap (e.g., `brio` before `1dc2ca45`), researches `colibri` docs, writes `packages/server/src/tools/brio.ts`, validates via `brio.test.ts` mock, then promotes. Currently manual via `fixer`/`designer`.

## Memory Integration — Implemented

* **Implemented:** `memory_controller.py` generates Cognitive Packets (L2+L3+L4) for workers, `~/.config/opencode/memory/aether/` (episodic_memory.jsonl, semantic_memory.json), `appendActiveWork()` + `ensureMemoryBank()` + `prompt.ts` hooks.

## Evaluation of Learning — Implemented

* **Implemented:** `shared/eval/` 3-tier, `brio` entropy `0.12` + `entropy_reading`, `gateway` `hasKey`/`costCap`, `health` `colibri:{ok,latencyMs}`.

## Documentation Maintenance — 10 items

When research subsystem becomes `Implemented`, document: 1. path `platforms/skill_synthesizer.py`, 2. interface `POST /tools/research`, 3. events `research.completed`, 4. config `features.onlineLearning`, 5. tests `skill_synthesizer.test.ts`, 6. security `firecrawl` rate limit, 7. ops `aether_core.py` pulse, 8. migration from manual `librarian` to auto, 9. rollback via `skill` disable, 10. limitation `firecrawl` daily cap 100 credits.

| # | Item | Status | Evidence (path / interface) |
|---|------|--------|------------------------------|
| 1 | Implementation path | `Implemented` (scaffold) / `Target` (auto) | `Implemented`: `shared/learning/scheduler` (online 60m, improvement 24h `knowledge=12`), `platforms/skill_synthesizer.py` scaffold mode; `Target`: `platforms/skill_synthesizer.py` DCS honest eval-gate (researches+writes+validates new skills autonomously) |
| 2 | Public interfaces | `Implemented` (MCP) / `Target` (auto) | `Implemented`: MCP `firecrawl` (`firecrawl_search`/`firecrawl_scrape`/`extract` + `firecrawl_search_feedback` refund) + `tavily` + `context7` via `packages/server/src/tools/mcp_marketplace.ts`, `GET /mcp` list; `Target`: `POST /tools/research` autonomous loop (`Target` in spec) |
| 3 | Events | `Implemented` / `Target` | `Implemented`: `learning.updated` BusEvent (`packages/server/src/types/index.ts`), `server.heartbeat`; `Target`: `research.completed` / `skill.synthesized` / `research.evidence` (ledger after eval-gate promotes) |
| 4 | Configuration | `Implemented` | `mira.json`/`mira.json.example` `mcp:{firecrawl:{url:"https://mcp.firecrawl.dev/mcp",enabled:false,headers:{Authorization:"Bearer {env:FIRECRAWL_API_KEY}"}}, tavily}`, `~/.mira/mira.env` `FIRECRAWL_API_KEY`; `features.onlineLearning` `Target` (planned `mira.json` flag) |
| 5 | Tests | `Implemented` (scaffold) / `Target` | `Implemented`: `brio.test.ts` 2 pass validates research-to-tool pattern (mock `:18080`), `shared/eval/` 3-tier gating mocks; `Target`: `skill_synthesizer.test.ts` (detect gap → research colibri docs → write `packages/server/src/tools/brio.ts` → `brio.test.ts` mock → registry `() => import('./brio.js')` before promotion) |
| 6 | Security boundaries | `Implemented` | `FIRECRAWL_API_KEY` via `{env:}` expansion (never logged), web content treated as untrusted (must validate/extract → proposal → sandbox → verification → eval, never `Web Page→Instruction→Modify`); `MIRA_NO_AUTOPROVISION=1` isolates tokens in tests |
| 7 | Operational procedures | `Implemented` | `shared/aether_core.py` hourly cognitive pulse (`oc-aether-pulse.sh` cron), `shared/memory_controller.py` HCM packet (L2+L3+L4 → `~/.config/opencode/memory/aether/episodic_memory.jsonl`), `learning.scheduler` `knowledge=12` cap |
| 8 | Migration strategy | `Target` | `Implemented` manual via `librarian`/`fixer` agent (researches `docs/colibri brio.md`, writes `brio.ts`, validates `brio.test.ts`); `Target` autonomous: `ToolRegistry` missing tool → `skill_synthesizer` researches + writes + `agent-eval` validates → `registry.ts` lazy import before promotion |
| 9 | Rollback strategy | `Target` | `Target`: disable synthesized skill via `opencode.jsonc`/`mira.json` `skill` flag + `git revert` patch + `saveConfig` fallback; audit via `evolution/ledger.ts` (`Target`) + existing `Bus` `recent(50)` + `MIRA_SYSTEM_DOCUMENTATION.md` snapshot/revert foundation |
| 10 | Known limitations | `Implemented` | `firecrawl` daily cap 100 credits (requires `publish_date`+`url`+`excerpts` citations, `firecrawl_search_feedback` after use); scaffold mode honest eval gate not yet enforced — autonomous loop still needs human `proceed`; contamination risk → `colibri DIRECT=1` etc. opt-in only |
