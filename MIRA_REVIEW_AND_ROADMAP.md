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
