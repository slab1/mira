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
