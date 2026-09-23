# Mira Engine Registry

> **Status:** `Implemented` (modular engines) / `Target` (dynamic capability synthesis) — see per-section.

## Modular Engine Architecture — Implemented

* **Implemented:** One C file per family (colibri `c/colibri.c` 12,445 lines + `deepseek_v4.c` 819K, `backend_cuda.cu` 243K, `backend_metal.mm` 120K, `backend_vulkan.c` 129K) + Mira `provider` registry (`nvidia`, `anthropic`, `openai`, `google`, `deepseek`, `colibri` each `npm` + `baseURL` + `apiKey` + `models` + `kind`). `family_registry.py` resolves `model_type` → `descriptor` (`id`, `engine_artifact`, `build_target`, `display_name`, `display_scale`, `limits`).

## Provider Registry — Implemented

* **Implemented:** `packages/server/src/config/defaults.ts` `provider:{nvidia,anthropic,openai,google,deepseek,colibri}` + `routing:{aliases,fallbacks,defaultProvider:nvidia}` + `subgateways:{default,cheap,vision,local,compaction,agent:ask}`. `ProviderRegistry` longest-prefix `resolve("openrouter/anthropic/claude-sonnet-4")` → `providerKey` + `modelID`, `KeyRing` (`expandEnvArray` for `MIRA_API_KEYS`), `hasKey`/`isHealthy`/`circuit breaker`. `GET /providers` lists 6, `GET /gateway/health` shows `providers:{hasKey}` + `lanes`.

## Colibri Engine — Implemented (opportunistic)

* **Implemented:** `colibri` provider `http://127.0.0.1:8000/v1` (`COLI_API_KEY=local`, `timeout 180s`), models `qwen3.6` (20GB, 32k ctx)/`olmoe` (7GB, 4k)/`glm-5.2` (372GB, 131k). `local`/`compaction` keep `nvidia` primary, `colibri/*` in `fallback` (probe `GET /health` `colibri:{ok,baseURL,latencyMs|error}` 800ms, never fails health). `brio` tool (`POST /tools/brio` + `POST /v1/brio`) wraps `POST /v1/brio` (`colibriBaseURL` from `expandEnv`), returns `ok:true,result:{answer,entropy,choices}` + `entropy_reading` or `ok:false,hint`.

## Dynamic Capability Synthesis — Target

* **Target:** `platforms/skill_synthesizer.py` DCS pillar — when `ToolRegistry` missing tool (e.g., `brio` before), it researches `colibri` docs, writes `packages/server/src/tools/brio.ts`, validates via `brio.test.ts` mock, registers via `registry.ts` `() => import('./brio.js')`. Currently manual via `fixer`.

## Engine Selection — Implemented

* **Implemented:** `engine_for(model)` → `family_by_id` → `engine_artifact` (`colibri` vs `deepseek_v4`), `coli` launcher picks binary from `config.json` `model_type`, same `coli chat`/`serve`/`web` front end. `MIRA` `resolveEffectiveModel` precedence: `explicitModel` > `agent.template.model` > `autoModel.tier` > `sessionModel` > `getConfig().model`.

## Documentation Maintenance — 10 items

When new engine becomes `Implemented`, document: 1. path `c/colibri.c` + `family_registry.py`, 2. interface `provider:colibri` + `GET /providers`, 3. events `engine.selected`, 4. config `provider.colibri` + `mira.json.example`, 5. tests `brio.test.ts` + `gateway/registry.test.ts` 16 pass, 6. security `COLI_API_KEY` local, 7. ops `docker-compose.override.yml` `ghcr.io/slab1/colibri:slim`, 8. migration add `colibri` to `fallback`, 9. rollback remove from `fallback` + `provider`, 10. limitation `needs :8000` else hint, `symlink` vs `hardlink` for `vite`.

| # | Item | Status | Evidence (path / interface) |
|---|------|--------|------------------------------|
| 1 | Implementation path | `Implemented` | `packages/server/src/config/defaults.ts` `provider:colibri` (`baseURL http://127.0.0.1:8000/v1`, `npm @ai-sdk/openai-compatible`, `kind:colibri`), `packages/server/src/tools/brio.ts` + `packages/server/src/routes/health.ts` probe, `docs/colibri.md`; engines `c/colibri.c` + `family_registry.py` (reference) |
| 2 | Public interfaces | `Implemented` | `provider:colibri` routing `resolve("colibri/qwen3.6")→providerKey`; `GET /providers` (lists 6), `GET /gateway/health` (`providers:{hasKey}`+lanes), `GET /health` (`colibri:{ok,baseURL,latencyMs\|error}` 800ms never fails), `POST /tools/brio` + `POST /v1/brio` (colibri `POST /v1/brio` wrapper) |
| 3 | Events | `Implemented` | `BusEvent` `gateway.fallback` (colibri failover), `server.heartbeat`, `brio.choice` object `answer`+`entropy`+`choices[]` (`brio.ts` `object:'brio.choice'`), `cost.warning` on cap; DCS `engine.selected` Target (`platforms/skill_synthesizer.py`) |
| 4 | Configuration | `Implemented` | `provider.colibri` in `mira.json`/`mira.json.example` + `~/.mira/mira.env` `COLI_API_KEY=local` (180s timeout), `opencode.jsonc` provider routing; `routing.fallbacks` + `subgateways:{local,compaction}.fallback` include `colibri/*` |
| 5 | Tests | `Implemented` | `packages/server/src/tools/brio.test.ts` 2 pass (mock `Bun.serve :18080` `POST /v1/brio` + `GET /v1/models`), `packages/server/src/gateway/registry.test.ts` 16 pass; `MIRA_NO_AUTOPROVISION=1` isolates host token in E2E (`queue.test.ts`, `server.e2e.test.ts`, `gaps.test.ts`) |
| 6 | Security boundaries | `Implemented` | `COLI_API_KEY=local` (no secret leak, loopback only), `MIRA_TOKEN`/`MIRA_API_KEYS` (`~/.mira/mira.env` 0o600, `MIRA_STRICT_AUTH` gate), `MIRA_NO_AUTOPROVISION=1` opts out auto-provision |
| 7 | Operational procedures | `Implemented` | `scripts/serve-local.sh` exports `COLI_API_KEY` + logs `colibri: ready on 8000 (latencyMs)` or `colibri: not running (hint…)`; `packages/server/scripts/dev-watch.ts` watches `src`+`shared/src`; `docker-compose.override.yml` `ghcr.io/slab1/colibri:slim` (slab1/colibri `3619cf5` `1m2s`) |
| 8 | Migration strategy | `Implemented` | Add `colibri/qwen3.6` (20GB 32k) / `colibri/olmoe` (7GB 4k) / `colibri/glm-5.2` (372GB 131k) to `subgateways.local.fallback` + `compaction.fallback`; `nvidia` stays primary, `local`/`compaction` keep `nvidia` primary until canary flips |
| 9 | Rollback strategy | `Implemented` | `git revert <sha>` + remove `colibri` from `fallback` + `provider` map via `saveConfig`/`mira.json`; `~/.mira/mira.env` unchanged; `GET /health` probe degrades to `ok:false` hint `COLI_MODEL=/data/olmoe ./colibri/c/coli serve --port 8000` |
| 10 | Known limitations | `Implemented` | Needs `:8000` else `ok:false`+hint `unreachable/timeout`; `symlink` vs `hardlink` proot EPERM (`bunfig.toml` `symlink` + `preserveSymlinks` in 6 tsconfigs, `vite` `picomatch` manual `ln -s`); `1.3G 98%` disk after `ms-playwright` 270M prune → keep `headless_shell` only + `logrotate` `mira.log`; `glm-5.2` 372GB requires NVMe streaming |
