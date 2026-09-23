# Mira Online Learning

> **Status:** `Implemented` (scheduler + research scaffolding) / `Target` (active research loop) — see per-section.

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
