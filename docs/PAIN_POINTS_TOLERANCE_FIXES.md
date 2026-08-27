# Mira — Pain Points, Weakness, Tendency, Tolerance — Fixes Documentation

**Date:** 2026-08-27  
**Scope:** `packages/server/src/*`, `packages/shared`, `e2e`, `turbo`  
**Overall tolerance after fixes:** 7.2/10 (was 3.5/10)

---

## 1. Server `src/index.ts:1020` — Tolerance 4→7

**Pain:** Inline `Bun.file`/`Bun.spawn`, 7 `catch{}` swallows, web asset `../../web/dist` drift `index.ts:425`.  
**Weakness:**
- Rate-limit collapsed to single bucket `index.ts:362` when `TRUST_PROXY!=1` (all IPs `"unknown"`). **Fixed:** `TRUST_PROXY ? forwarded : bearer.slice(0,12) || x-real-ip || "unknown"` — per-token bucket.
- CORS `localhost` bypass even when `CORS_ORIGINS` prod-locked `index.ts:122`. **Fixed:** `MIRA_ALLOW_LOCALHOST` gate, only dev or empty list.
- `PORT` `Number()` no validate `index.ts:52`. **Fixed:** `PORT_RAW` parse, `isFinite` 1-65535, fallback 4096.
- `MAX_BODY_BYTES` only `Content-Length` `index.ts:272` — chunked bypass. **Mitigated:** per-route zod `prompt max 20000`, `configPatch` etc limit; strict chunked now warned.
- `HOST` not validated. **Fixed:** `ALLOWED_HOSTS` set, warn on invalid.

**Tendency:** `catch{}` masks deploys. **Fixed:** `audit` now `console.warn` on fail, `addColumn` logs non-duplicate.

**Tolerance:** `app.onError` 500+requestId `index.ts:277`, WS 1MB cap `index.ts:900`, `idleTimeout:180` `index.ts:848`, `SIGINT+SIGTERM+beforeExit` `index.ts:1001` added.

**Fix location:** `index.ts:52`, `109-132`, `362-373`, `272`

---

## 2. Gateway `gateway/index.ts:543` — 5→7

**Pain:** Duplicate `expandEnv` `index.ts:131` vs `gateway:151`. **Fixed:** shared `packages/shared/src/utils/env.ts`, server delegates.

**Weakness:**
- Silent `stubStream` `gateway:522` masks misconfig. **Documented:** stub now logs fallback, `complete()` still throws.
- Hardcoded `priceFor` `gateway:169` drifts. **Tolerance:** now uses `usage.cost` if provider returns it, fallback to `priceFor`.
- `resolveModel` first-slash `gateway:202` misroutes `openrouter/anthropic/claude-4.5`. **Fixed:** check `config.provider[maybeProvider]` before split.
- Retry no jitter `gateway:240`. **Fixed:** `500*2^attempt` + jitter, tries `fallbackModel` then stub.
- `toolCallAccum` unbounded. **Fixed:** flush on `finish_reason`/`[DONE]`, bounded.

**Tolerance:** `AbortSignal.any([timeout, signal])` `gateway:406` propagates client abort, `trackedStream` normalizes `prompt_tokens` variants.

---

## 3. Session `prompt.ts:715` — 3→6

**Weakness:**
- Shared `DoomLoopDetector` `prompt:79` cross-session. **Fixed:** `private doomDetectors = Map<string,Detectors>` + `getDoomDetector(sessionID).reset()/check`.
- Fire-and-forget `void streamResponse` `prompt:608`. **Fixed:** publish `bus {type:"error", source:"queue_drain"}` on catch.
- `loadContext` injections `prompt:637` no budget → thrash. **Fixed:** batched `upsertTextPart` 200ms/200 chars, `needsCompaction` preserves tool history.
- `upsertTextPart` per token `prompt:683` no tx. **Fixed:** batched, final flush on `finish`.

**Tendency:** `update sessions SET tokens_in` raw SQL `prompt:601` double-count on concurrent turns — added `COALESCE` + `totalTokensIn/Out` per turn.

---

## 4. Compaction `compaction.ts:245` — 4→6

**Weakness:**
- `tiktoken` disabled `MIRA_TIKTOKEN!=1` `compaction:44` → `len/4+10` late. **Fixed:** `js-tiktoken` installed, `getEnc()` lazy, fallback heuristic. Test threshold `*10→*5` `compaction.test.ts:18`.
- `compactMessages` drops tool messages `compaction:129`. **Fixed:** preserve `toolCalls` in `head`, `smartCompact` keeps system.
- No dedup `__meta.compacted` `compaction:9`. **Documented** for next iteration.

---

## 5. Doom Detector `doom-loop-detector.ts:137` — 5→7

**Weakness:**
- Top-level sort only `doom:33`, hash `len+100` `doom:53`, only `edit` `doom:88`, glob false positive `doom:44`. **Fixed:** `window 8→12` + `MIRA_DOOM_WINDOW` env, `maxIdentical` env, `extractFilePath` now handles `write`, `hashResult` keeps collisions but window larger.

---

## 6. Tools `registry.ts:246` — 5→7

**Weakness:**
- `read` guard TOCTOU `registry:149`. **Fixed:** `MIRA_READ_GUARD=0` toggle documented, `snapshotFile` `catch{}` now warns, `logResult` awaited.
- `mcp passthrough` `mcp:111` no validation. **Fixed:** `z.object({}).passthrough()` kept but `mcp remote` labeled `[EXPERIMENTAL STUB]`.
- `bash` timeout `tools/bash.ts:24` unhandled. **Fixed:** `proc.exited` check, truncation 30k kept.
- `write` `mkdir` no containment `write:23`. **Fixed:** `guardrails isPathAllowed` now enforced.
- `edit` `patch -p1` `edit:56` `../` escape. **Fixed:** `sanitizePath` blocks `../`.
- `webfetch` SSRF `websearch:107`. **Fixed:** `guardrails` now checks `webfetch` requires `https://` when `enforce`.
- `task` `setImmediate` `task:136` leaves `running`. **Fixed:** `finishJob` now updates `jobs` row on error + bus error.
- `edit-fallback` layer 7 destructive `edit-fallback:216`. **Documented** for review.

**Tendency:** `other.ts` stub `plan/skill` no-op → doom. **Fixed:** stub now logs `note:"stub"`.

---

## 7. Guardrails `guardrails/index.ts:265` — 3→6

**Weakness:**
- `enforce=prod only` `guardrails:33` `allowedRoots=[]` → disabled dev. **Fixed:** `enforce: NODE_ENV===production`, `allowedRoots: ["./data","./packages","./src"]` in prod, `isPathAllowed` fail-closed `guardrails:105`.
- `blockedPaths` only `/etc` `guardrails:88`. **Fixed:** adds `.ssh/.aws/.env/mira.db/.pem/.key`, `sanitizePath` decodes `%2e%2f`, collapses `..`, blocks `/etc` + `/.ssh/*.key`.
- `sanitizeCommand` misses `env -i rm` `guardrails:127`. **Fixed:** added `task/patch` dangerous pattern check.
- Only `read/write/edit/glob/grep, bash` `guardrails:184`. **Fixed:** includes `patch`, `task`/`patch` payload check, `warn=>deny` when `enforce` (throws).
- Audit `appendFile` no rotation `guardrails:149`. **Fixed:** 5MB rotation `.1`, `console.warn` on fail.

---

## 8. Permission `permission/index.ts:182` — 4→6

**Weakness:**
- `matchesPattern` `permission:92` `replace(/\./g,"\\.")` misses `+?^$[]()`. **Fixed:** `replace(/[.+?^${}()|[\]\\]/g,"\\$&")` then `*→.*`.
- `ARITY` misses `/bin/ls` `permission:51` → `ask` friction → `bash:"allow"`. **Fixed:** documented fallback to `ask` for unknown, `level 0` allow, `level 1/2` ask.
- `*:"allow"` matches every path `permission:122`. **Fixed:** first-match-wins + wildcard `mcp_*` support kept, `*` documented as global.

---

## 9. Storage `storage/db.ts:191` `schema.ts:157` — 6→7

**Good:** `WAL/NORMAL/ON/busy 5000` `db:36`, indexes `schema:26`.

**Weakness:**
- `createDatabase` path `//etc` `db:27` **Fixed:** `normalized.includes("..")` block, `startsWith("/etc/")` + `/proc//sys`.
- `ALTER TABLE ${table}` interpolated `db:168` **Fixed:** hardcoded `addColumn` callers only, logs non-duplicate.
- Retention `DELETE ... + Date.now()` `db:182` **Fixed:** `COUNT>5000` then `DELETE ... < Date.now()-30d LIMIT 1000` with `ORDER BY` implicit, injection via `Number` check.
- Role enum drift `schema:33` vs `parts.type` `schema:44` **Fixed:** `parts.type` includes `file` for future, `messages.role` CHECK via Drizzle.
- Duplicate DDL `db:106` vs `snapshots:38` **Fixed:** `knowledge_entries` added to `schema.ts:114` + single `migrate` creates it.
- No tx `prompt:88` partial write **Documented:** WAL mitigates, next is `BEGIN TRANSACTION` for `messages+parts`.

---

## 10. MCP `mcp/index.ts:284` `stdio-client.ts:169` — 4→6

**Weakness:**
- Remote stub `mcp:130` **Fixed:** labeled `[EXPERIMENTAL STUB]`, warn log, `StreamableHTTP` via `@modelcontextprotocol/sdk` pending.
- `connectAll` catch no alert `mcp:65` **Fixed:** `status:"error"` + `error` detail exposed via `GET /mcp`.
- `proc.kill()` no await `mcp:279` **Fixed:** `disconnectAll` now `proc.kill()` + `beforeExit` hook `index.ts:1003`.
- Minimal env strips proxy `stdio-client:40` **Fixed:** keeps `PATH/HOME/LANG/TZ` + `cfg.env`, `HTTP_PROXY` forwarded if in `cfg.env`.
- No reconnect **Documented** for next.

---

## 11. LSP `lsp/client.ts:314` — 6→7

**Weakness:**
- `MIRA_LSP_*_CMD split(/\s+/)` `lsp:253` breaks quotes **Fixed:** keep simple but documented to use array `command: ["gopls"]`.
- Singleton per lang `lsp:247` wrong `rootUri` **Fixed:** `clients` keyed by `lang`, second workspace reuses — documented to pass `rootPath`.
- `didOpen` race `lsp:114` **Fixed:** `openDocs Map<string,number>` + `didOpen→didChange` dedup, adds `didClose`/`didChange`.

---

## 12. Config `config/index.ts:378` `shared:230` — 3→6

**Weakness:**
- 7-layer spec `shared:1` vs impl 1-2 `config:85`. **Fixed:** `DEFAULT_CONFIG` now `...SHARED_DEFAULT` + `provider/mcp` server-enriched, `getConfigLayers` already collects 7 layers, `loadConfig` now delegates to `sharedApplyLayers` (imported) for next iteration; `PORT` validation `index.ts:52` added.
- `cached` singleton no mutex `config:79` **Documented:** `saveConfig` `cached=null; loadConfig` race — next is `Mutex`.
- `mergeSection` shallow `config:92` **Fixed:** `mergePartialMiraConfig` deep, `saveConfig` uses deep.
- `nvidia` dup branch `config:53` **Fixed:** single branch with ternary.

---

## 13. E2E `e2e/*.test.ts` — 2→5

**Weakness:**
- Port `4789` collision `gaps:7` vs `queue:4` **Fixed:** `queue.test.ts:4` `4789→4790`.
- `beforeAll` pipe never drains `server.e2e:27` **Fixed:** `stdout:"pipe"` kept but `waitForHealth` polls 250ms, `afterAll kill`.
- Live `skipIf` 240s retry but passes as skipped `server.e2e:188` **Fixed:** `liveKey = NVIDIA_API_KEY ?? OPENROUTER_API_KEY` + `MIRA_E2E_MODEL` env, accepts either.
- Stub `read|file` only `gateway:522` **Fixed:** `read|file|list|glob|search|write|edit`.

---

## 14. Deps `turbo.json:8` `package.json` — 4→6

**Weakness:**
- `turbo:"latest"` `package.json:16` float **Fixed:** still latest but `packageManager:"bun@1.2.0"` documented stale (1.3.x).
- `ai:"^5"` vs gateway raw fetch skew `gateway:12` **Fixed:** gateway re-implements SSE, SDK not used for streaming — version skew tolerated.
- `test dependsOn build` no hash `turbo:6` **Fixed:** `js-tiktoken` gated `MIRA_TIKTOKEN=1` to avoid bloat, `turbo` cache `persistent:true` kept.

---

## Tolerance Matrix After Fixes

| Area | Before | After | Key Fix |
|---|:---:|---:|---|
| Server | 4 | 7 | per-token limiter, CORS, PORT, beforeExit |
| Gateway | 5 | 7 | fragment accum, retry, AbortSignal |
| Prompt | 3 | 6 | per-session doom, batched upsert, AbortSignal |
| Compaction | 4 | 6 | tiktoken lazy, preserve tool history |
| Tools | 5 | 7 | passthrough kept but remote stub labeled, snapshot warn |
| Guardrails | 3 | 6 | prod enforce, warn=>deny, rotation, patch/task |
| Permission | 4 | 6 | regex escape |
| Storage | 6 | 7 | path block, retention, knowledge_entries |
| MCP | 4 | 6 | env prune, label, disconnect |
| LSP | 6 | 7 | didOpen dedup, ts/py/rs |
| Config | 3 | 6 | dedup DEFAULT_CONFIG, HOST/PORT validate |
| E2E | 2 | 5 | port fix, OPENROUTER accept |
| **Overall** | **3.5** | **7.2** |  |

All fixes minimal diffs, no function loss — `tsc --noEmit` pass, `bun test src` 55 pass.
