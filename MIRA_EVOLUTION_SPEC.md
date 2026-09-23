# Mira Evolution Spec

> **Status:** `Implemented` (shadow) / `Target` (promotion gate) — see per-section.  
> **Policy:** Evolution must be eval-gated and canary-rolled; no silent promotion.

## Evolution Loop — Policy

```text
Observe → Research → Diagnose → Propose → Experiment → Patch → Verify → Canary → Promote / Roll Back → Remember
```

Policy: Every patch must pass `runEval("pr")` before promotion (fail-closed, `MIRA_STRICT_AUTH`-like gate). `observe` and `research` use `firecrawl`/`tavily` MCP with citations.

## Observe — Implemented

* **Implemented:** `shared/aether_core.py` hourly cognitive pulse (cron `oc-aether-pulse.sh`), `shared/memory_controller.py` HCM packet (L2+L3+L4), `shared/eval/` 3-tier gating, `metrics` (http + gateway cost), `Bus` events, `learning.scheduler` online every 60m.
* **Target:** Unified `strategy_effectiveness` log across lanes (currently per-agent).

## Research — Target

* **Target:** `MIRA_ONLINE_LEARNING.md` research system — autonomous `skill_synthesizer` (`platforms/skill_synthesizer.py`) researching + writing + validating new skills when capability gap detected. Currently scaffold mode, needs honest eval gate.

## Diagnose — Implemented (Target: automation)

* **Implemented:** `PAIN_POINTS_TOLERANCE_FIXES.md` + `MIRA_CHALLENGES.md` manual pain-point detection; `diagnose` via `oracle` agent (strategic review) when `critic` rejects.
* **Target:** `logic_evolve.py` analyzes `strategy_effectiveness` → proposes patches to core orchestration logic automatically.

## Propose — Target

* **Target:** `opencode_improvement/logic_evolve.py` proposes patches to `shared/`/`agents/` with diff + rationale, before `simulation_sandbox`.

## Experiment — Implemented (shadow)

* **Implemented:** `shared/simulation_sandbox.py` creates Virtual Diffs before touching real codebase; `agents/critic.md` APPROVE/REJECT/REVISE verdicts.
* **Policy:** Experiments must earn place through reproducible e2e (see `docs/benchmarking.md` 5 rules, colibri protocol) — no microbenchmark-only adoption.

## Patch — Implemented

* **Implemented:** `opencode_improvement/spawner.py` accepts `cognitive_packet`, injects HCM context, `hash-anchored-edits` skill (68% edit success vs 7% stale-line).

## Verify — Implemented

* **Implemented:** `agent-eval` (golden datasets), `brio.test.ts` mock, `typecheck` (6 tsconfigs `preserveSymlinks`) + `test` (523 pass) + `build` must all green before promotion. `MIRA_SELF_HEALING.md` verifies via `diagnose` tool.

## Canary — Target

* **Target:** Canary deploy to `local` lane (`colibri/olmoe` 0-cost) before `default` (`nvidia`). Currently `local`/`compaction` keep `nvidia` primary, `colibri` fallback — canary would flip primary for canary sessions only.

## Promote / Roll Back — Policy

* **Policy:** Promotion requires `runEval("pr")` pass + `canary` metrics (latency, cost, `brio` entropy, `hasKey` health) within +20%/ -0.5pp hit. Rollback on `circuit breaker OPEN` or `costCap` breach. `git revert` + `mira.json` rollback via `saveConfig`.
* **Implemented:** Manual `feat(mira):` commits with `MIRA_NO_AUTOPROVISION` isolation for tests; `git log` `19cf9641`/`c34759a8` show promotion path.

## Remember — Implemented

* **Implemented:** `memory/` episodic append (`appendActiveWork()`), `semantic_memory.json`, `skill registry` L4, `MIRA_SYSTEM_DOCUMENTATION.md` maintenance checklist below.

## Documentation Maintenance — Policy (10 items)

When a planned subsystem becomes **Implemented**, update its doc with:

1. Implementation path
2. Public interfaces
3. Events
4. Configuration
5. Tests
6. Security boundaries
7. Operational procedures
8. Migration strategy
9. Rollback strategy
10. Known limitations

Example: Brio was `Target` → now `Implemented` in `1dc2ca45`/`19cf9641`/`c34759a8` with path `packages/server/src/tools/brio.ts`, interface `POST /tools/brio` + `POST /v1/brio`, events `brio.choice`, config `provider:colibri`, tests `brio.test.ts` 2 pass, security `COLI_API_KEY` local, ops `serve-local.sh` probe, migration `fallback` added, rollback `git revert` + remove `colibri` from `fallback`, limitation `needs :8000` else hint.
