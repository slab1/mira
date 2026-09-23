# Mira Review and Roadmap

> **Status:** `Implemented` (review gaps closed) / `Target` (roadmap) — see per-section.  
> **Policy:** Repository review must verify `Implemented` via `git status` + `bun test` + `health` + `CI` — not via docs alone.

## Repository Review — Implemented (c34759a8)

* **Implemented:** 523 pass / 0 fail / 2 skip (276s full, `MIRA_NO_AUTOPROVISION=1` isolates host token), `test`/`typecheck`/`build`/`repo-hygiene`/`auth-guard` ✅, `docker`/`deploy`/`CodeQL` ✅ (slab1/colibri `3619cf5` `docker` `1m2s` success → `ghcr.io/slab1/colibri:slim`), `:4096` `tools:22` `providers:6` (`nvidia` primary, `colibri` fallback) `colibri:{ok:false}` when down, `1.3G 98%` after `ms-playwright` 270M prune.
* **Gaps closed:** `bunfig.toml` `symlink` + `preserveSymlinks` in 6 tsconfigs (proot aarch64 EPERM), `cli` spawn 20s timeout, `MIRA_NO_AUTOPROVISION` for 3× E2E, `nvidia` defaults + `colibri` provider + `brio` tool + `Brio.tsx` 1064 lines + `health` probe + `serve-local` `colibri: ready`.

## Gaps — Target

| Gap | Status | Next |
|-----|--------|------|
| `P2-3` JetBrains plugin | Target | Blocked: IntelliJ SDK |
| `dev` `vite` `picomatch` on `symlink` | Implemented (manual `ln -s` to cache) | Target: `hardlink` for local dev or keep `symlink` + manual link |
| `colibri` real E2E with model | Target | Needs 7GB (`olmoe`) + fast NVMe, currently mock `:18080` 2 pass |
| `disk 98%` | Target | Prune `~/.cache/huggingface` or keep `1.3G` + `logrotate` for `mira.log` |

## Implementation Roadmap — Target

1. **Release `v0.15`** — `git tag v0.15 c34759a8 && push origin v0.15` (5m).
2. **Real colibri E2E** — `MODEL_DIR=/data/olmoe COLI_RAM=8 docker compose -f docker-compose.override.yml up` → live `brio` `p`+`entropy` vs generation (needs disk <90%).
3. **Web Brio polish** — already `BrioPage` + `GET /health` badge, next `docs` nav link.
4. **Disk guard** — `logrotate` + `ms-playwright` keep `headless_shell` only (already pruned 270M).

## Documentation Status — Policy

* **Implemented** — verified to exist (`MIRA_SYSTEM_DOCUMENTATION.md` architecture, `MIRA_ENGINE_REGISTRY.md` colibri, `MIRA_SELF_HEALING.md` runtime, `docs/colibri.md`).
* **Target** — proposed architecture not yet fully implemented (`MIRA_EVOLUTION_SPEC.md` canary, `MIRA_ONLINE_LEARNING.md` active research loop).
* **Policy** — rules autonomous components must follow (Evolution loop eval-gate, Online Learning citation, Self-Healing no silent change).

## Core Loops — Policy (from prompt)

**Core Mira Loop:** `Memory → Intelligence → Agents → Tools → Execution → Evaluation → Learning → Evolution → Memory`  
**Evolution Loop:** `Observe → Research → Diagnose → Propose → Experiment → Patch → Verify → Canary → Promote / Roll Back → Remember`

## Documentation Maintenance — Policy (10 items)

Whenever planned subsystem becomes `Implemented`, update its doc with: 1. Implementation path, 2. Public interfaces, 3. Events, 4. Configuration, 5. Tests, 6. Security boundaries, 7. Operational procedures, 8. Migration strategy, 9. Rollback strategy, 10. Known limitations.

Example: `Brio` `Target` → `Implemented` in `1dc2ca45`/`19cf9641`/`c34759a8` with all 10 items (see `MIRA_EVOLUTION_SPEC.md`).

| # | Item | Status | Evidence (path / interface) |
|---|------|--------|------------------------------|
| 1 | Implementation path | `Implemented` (review) / `Target` (roadmap) | `Implemented`: `packages/server/src/config/defaults.ts` (`nvidia` primary `deepseek-v4-flash`/`pro`, `colibri` 3 models), `packages/server/src/tools/brio.ts` + `packages/web/src/pages/Brio.tsx` 1064 lines, `packages/server/src/routes/health.ts` probe, `bunfig.toml` `symlink` fix; `Target`: `MODEL_DIR=/data/olmoe` live E2E + `v0.15` tag |
| 2 | Public interfaces | `Implemented` | `GET /health` (`colibri:{ok,baseURL,latencyMs\|error}` 800ms, never fails), `GET /healthz`, `GET /providers` (6), `GET /gateway/health` (`providers:{hasKey,lane,cooldownUntil}`), `POST /tools/brio`/`POST /v1/brio` (`tools:22`), `GET /mcp` |
| 3 | Events | `Implemented` | `BusEvent` (`packages/server/src/types/index.ts` + `packages/server/src/bus/index.ts`): `session.created`, `job.created/updated/cancelled`, `learning.updated`, `cost.warning`, `gateway.fallback`, `server.heartbeat/error` + `brio.choice` (`entropy_reading`); review verified via `git status`+`bun test`+`health`+`CI` (not docs-alone) |
| 4 | Configuration | `Implemented` | `mira.json`/`mira.json.example` (`model:"nvidia/deepseek-ai/deepseek-v4-flash"`, `provider`, `routing.fallbacks`, `subgateways`), `~/.mira/mira.env` 0o600 `MIRA_TOKEN`/`COLI_API_KEY=local`/`NVIDIA_API_KEY`, `opencode.jsonc`, `bunfig.toml` `preserveSymlinks` 6 tsconfigs |
| 5 | Tests | `Implemented` | `packages/server/src/tools/brio.test.ts` 2 pass (mock `:18080` `p 0.97 entropy 0.12`), full 523 pass/0 fail/2 skip 276s with `MIRA_NO_AUTOPROVISION=1` (isolates 3× E2E `queue`/`server.e2e`/`gaps`), `typecheck`+`build`+`repo-hygiene`/`auth-guard` ✅, `docker` `slab1/colibri 3619cf5 1m2s ghcr.io/slab1/colibri:slim` ✅ |
| 6 | Security boundaries | `Implemented` | `MIRA_TOKEN` 0o600 `~/.mira/mira.env` (auto-gen 64-hex on first boot, never overwrites existing, `MIRA_NO_AUTOPROVISION=1` opts out), `MIRA_STRICT_AUTH` prod fail-closed, `COLI_API_KEY=local` loopback, `VITE_MIRA_TOKEN` dev-only (`NODE_ENV !=='production'`), `gh auth token` push pattern (not `$GITHUB_PAT`) |
| 7 | Operational procedures | `Implemented` | `scripts/serve-local.sh` start/stop/status (`setsid nohup`, `SIGTERM` draining, `colibri: ready` logs, `:4096`), `packages/server/scripts/dev-watch.ts` watches `src`+`shared/src`, `scripts/watch-local.sh` watchdog + `backup-db.sh` + `gc-db.ts`, `shared/aether_core.py` pulse; `docs/colibri.md` quick-start `COLI_MODEL=/data/olmoe ./colibri/c/coli serve --port 8000` |
| 8 | Migration strategy | `Target` | `Target`: `git tag v0.15 c34759a8 && push` → real colibri E2E `MODEL_DIR=/data/olmoe COLI_RAM=8 docker compose -f docker-compose.override.yml up` (needs disk `<90%` + 7GB) → `docs` nav `BrioPage`; `Implemented`: `fallback` add `colibri/qwen3.6`→`olmoe` behind `nvidia` primary (probe never fails health) |
| 9 | Rollback strategy | `Implemented` | `git revert 1dc2ca45`/`19cf9641`/`c34759a8` removes provider+tool+health probe, `mira.json` `saveConfig` removes `colibri` from `fallback`; `MIRA_SYSTEM_DOCUMENTATION.md` §10 `Snapshot→Experiment→Verification→Rollback` foundation (`snapshotFile`+`undo`) |
| 10 | Known limitations | `Implemented` | `1.3G 98%` disk after `ms-playwright` 270M prune → keep `headless_shell` only + `logrotate` `mira.log`; `vite` `picomatch` `ERR_MODULE_NOT_FOUND` on `symlink` → manual `ln -s` to cache (`Target`: `hardlink`); `P2-3` JetBrains plugin Blocked `IntelliJ SDK`; mock vs live `brio` (`completion_tokens=0` live `p` vs generation; use `brio` for triage to avoid 10-20k prefill hour) |

## Documentation Maintenance — 10 items

> Canonical heading for audit compliance — same 10-item table as `## Documentation Maintenance — Policy (10 items)` above. Status `Implemented` (review gaps) / `Target` (roadmap).
