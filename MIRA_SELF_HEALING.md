# Mira Self-Healing

> **Status:** `Implemented` (runtime + code) / `Target` (auto-patch promotion) — see per-section.

## Runtime Self-Healing — Implemented

* **Implemented:** `shared/simulation_sandbox.py` Virtual Diffs before real codebase, `agents/critic.md` APPROVE/REJECT/REVISE, `ToolRegistry` `hasKey` + `isHealthy` + `circuit breaker` (5 failures → OPEN 30s, `gateway/health` shows `cooldownUntil`), `serve-local.sh` `setsid nohup` + `SIGTERM draining`, `dev-watch.ts` watches `src` + `shared/src` and restarts.
* **Policy:** Insufficient fast memory may reduce speed, must not silently change precision/router (colibri `DIRECT=1` etc. opt-in).

## Code Self-Healing — Implemented (shadow)

* **Implemented:** `diagnose` tool (`typecheck`/`test`/`build` aggregation), `hash-anchored-edits` (68% success), `snapshotFile` before `edit`/`write` + `undo` to message, `logic_evolve.py` shadow proposes patches, `skill_synthesizer` scaffold.
* **Target:** Auto-patch promotion without human `proceed` (currently `invetisgate no gessing` still needs orchestrator to drive).

## Failure Modes — Implemented

* **Implemented:** Disk 98% → `mira.log` `truncate -s 0`, `bun` `symlink` → `hardlink` fallback for `vite` `picomatch`, `turbo` `linux-arm64` missing → manual `ln -s` to cache, `MIRA_NO_AUTOPROVISION=1` isolates host token → `has NVIDIA? 0` fixed to `1` after `loadMiraEnv`, `esm` `ERR_MODULE_NOT_FOUND` for `picomatch` fixed via symlink backend.

## Canary & Rollback — Policy

* **Policy:** `canary` on `local` lane before `default`, rollback on `circuit OPEN` or `costCap` breach or `brio` entropy >0.8. `git revert` + `saveConfig` rollback.

## Documentation Maintenance — 10 items

When self-healing becomes fully autonomous `Implemented`, document: 1. path `shared/simulation_sandbox.py`, 2. interface `POST /dev/heal`, 3. events `heal.started`/`healed`, 4. config `features.selfHealing`, 5. tests `self_healing.test.ts` (inject fault, verify heal), 6. security `MIRA_STRICT_AUTH` gate, 7. ops `aether_core.py` pulse, 8. migration from manual `fixer` to auto, 9. rollback via `git revert` + `mira.json` fallback, 10. limitation `turbo` `aarch64` binary missing on proot.

| # | Item | Status | Evidence (path / interface) |
|---|------|--------|------------------------------|
| 1 | Implementation path | `Implemented` (runtime+shadow) / `Target` (auto-promote) | `Implemented`: `shared/simulation_sandbox.py` Virtual Diffs before real codebase, `agents/critic.md` APPROVE/REJECT/REVISE, `packages/server/src/tools/edit.ts`+`edit-fallback.ts` `hash-anchored-edits` (68% vs 7%), `opencode_improvement/logic_evolve.py` shadow; `Target`: `packages/server/src/evolution/` (`observer`→`diagnosis`→`propose`→`experiment`→`patch`→`verifier`) auto-patch promotion |
| 2 | Public interfaces | `Implemented` / `Target` | `Implemented`: `diagnose` tool (`typecheck`/`test`/`build` aggregation) via `packages/server/src/tools/other.ts`, `POST /tools/edit`+`write` with `snapshotFile`+`undo`; `Target`: `POST /dev/heal` autonomous heal endpoint (`Target` in spec) |
| 3 | Events | `Implemented` / `Target` | `Implemented`: `job.created`/`job.updated`/`job.cancelled` + `server.error` BusEvents (`packages/server/src/types/index.ts`), `gateway.fallback` circuit, `cost.warning`; `Target`: `heal.started`/`heal.completed`/`heal.failed`+`escalate` ledger |
| 4 | Configuration | `Implemented` | `mira.json` `loop:{maxSteps:32,contextLimit:128000,compactionThreshold:0.8}` + `guardrails:{enforce,allowedRoots,blockedPaths,blockedCommands}`, `~/.mira/mira.env` + `bunfig.toml` `symlink`; `features.selfHealing` `Target` planned flag; `canary` policy on `local` lane before `default` |
| 5 | Tests | `Implemented` | `diagnose` aggregation verified via `packages/server/src/metrics.test.ts`+`gateway/subgateway.test.ts` (`cost.warning` BusEvent), `brio.test.ts` 2 pass mock, full suite 523 pass /0 fail/2 skip with `MIRA_NO_AUTOPROVISION=1`; `Target`: `self_healing.test.ts` (inject fault `disk 98%`/`symlink EPERM`/`ERR_MODULE_NOT_FOUND` → verify `truncate -s 0`/`hardlink fallback`/`ln -s` heal + no retry-loop `escalate`) |
| 6 | Security boundaries | `Implemented` | `MIRA_STRICT_AUTH` gate (prod fail-closed without `MIRA_TOKEN`/`MIRA_API_KEYS`), `MIRA_TOKEN` 0o600 `~/.mira/mira.env`, `guardrails.enforce` default in prod, `snapshotFile` before `edit`/`write` + audit path validation + fail-closed permissions |
| 7 | Operational procedures | `Implemented` | `scripts/serve-local.sh` `setsid nohup` + `SIGTERM` draining + `mira.log` `truncate -s 0` on 98% disk, `packages/server/scripts/dev-watch.ts` watches `src`+`shared/src` and restarts, `scripts/watch-local.sh` watchdog + `aether_core.py` hourly pulse, `GET /health`/`GET /healthz` liveness |
| 8 | Migration strategy | `Implemented` (manual) / `Target` (auto) | `Implemented` manual via `fixer`/`hash-anchored-edits` + `spawner.py` HCM injection; `Target` auto: `shared/simulation_sandbox.py` Virtual Diff → `critic.md` verdict → `logic_evolve.py` proposes patch with diff+rationale → shadow verify → canary before promotion |
| 9 | Rollback strategy | `Implemented` | `git revert` + `mira.json` `saveConfig` fallback + `snapshotFile` `undo` to message; rollback on `circuit breaker OPEN` (5 failures→OPEN 30s, `gateway/health` `cooldownUntil`) or `costCap` breach or `brio` entropy `>0.8` abstain |
| 10 | Known limitations | `Implemented` | `turbo` `linux-arm64` missing → manual `ln -s` to cache (proot aarch64 EPERM); `bun` `symlink`→`hardlink` fallback for `vite` `picomatch` `ERR_MODULE_NOT_FOUND`; `serve-local.sh` still needs orchestrator `proceed` for auto-patch; `invetisgate no gessing` still requires driver |
