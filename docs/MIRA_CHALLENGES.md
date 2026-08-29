# Mira — Pre-Fix Challenge Registry (2026-08-29)

> **Purpose:** Freeze the 5 systemic challenges *before* fixing. This doc is the source of truth for diagnosis → strategy → verification. Read before any edit.

**Repo:** `github.com/slab1/mira` @ `/tmp/aether`  
**Stack:** Bun + Hono :4096, Drizzle SQLite WAL, Turborepo SolidJS (web/tui), Vercel AI SDK v5 → OpenRouter/NVIDIA NIM  
**Typecheck baseline:** `bunx tsc --noEmit` / `npx tsc --noEmit` green in `server`+`web` after sweep 958f3cc8; `// @ts-ignore` 44→0, `as unknown/as any` 11→0 (2 `@ts-expect-error` remain with reason).  
**Tunnel:** `https://raymond-strategic-vice-feeds.trycloudflare.com` via `scripts/tunnel-watchdog.sh` (account-less quick tunnel; `~/.cloudflared` login artifacts cause 404).  
**Auth:** `MIRA_TOKEN` 96-hex + `api_keys` SQLite → `API_KEY_OWNERS`.

---

## Challenge 1 — Context Window Death (Compaction)

**Symptom:** Long sessions (100+ tool calls, 60k tokens) exceed `contextLimit` 128k. Naive truncation drops `toolResults` → summarization hallucinates.

**Current code:**
- `packages/server/src/session/prompt.ts` `SessionPrompt.loop` calls `needsCompaction` → `compactMessages` (keep 25% tail, summarize head with `smallModel`)
- `packages/server/src/session/compaction.ts` `CompactionMessage` vs `LoopMessage` type mismatch was hidden by `as JsonValue as LoopMessage[]` (`// @ts-ignore` at prompt.ts:415)
- `CompactionMessage` had `toolCalls?: {id?:string; name?:string}[]` vs `LoopMessage.toolCalls?: {id:string; name:string; args:Record<string,JsonValue>}[]`

**Risk if not fixed:** Compaction drops tool-call history → next turn LLM re-edits same file → doom-loop. Token estimate `len/4` vs `js-tiktoken` divergence.

**Fix strategy (to be applied):** Make `CompactionMessage` properly extend `LoopMessage` fields (or map with `toolCalls`/`toolResults` preservation) and assign `messages = result.messages` directly without `JsonValue` double cast. Verify via `needsCompaction` unit test + live session >80% threshold.

**Files:** `session/prompt.ts:46 LoopMessage`, `session/compaction.ts:25 CompactionMessage`, `session/compaction.ts:89 compactMessages`

---

## Challenge 2 — Doom-Loop / Thrashing

**Symptom:** LLM repeats identical `edit`/`bash: grep` 3-5x with no file progress, burns tokens and latency (observed `prompt.ts` step loop).

**Current code:**
- `Prompt.loop` step → `gateway.stream` → tool-call → `permission.check` → execute → `finish-step` → doom-loop detect (3x identical tool-calls / 5x same file without progress → break + ask user)
- Stateful `sessionOwnerCache` 5-min TTL (fixed from infinite) + `clear()` on revoke

**Risk:** Heuristic false positive kills valid iteration; false negative → infinite loop → cost + snapshot bloat.

**Fix strategy:** Keep stateful detector, add per-file edit hash tracking, publish `doom-loop` BusEvent, verify with `packages/server/src/session/prompt.test.ts` style E2E.

**Files:** `session/prompt.ts:400 loop`, `storage/db.ts` sessions, `bus/`

---

## Challenge 3 — Tool Safety (Permission + Guardrails)

**Symptom:** Agent can `read .env`, `bash: rm -rf`, call `mcp__firecrawl__*` — 5 layers must be enforceable, auditable.

**Current code:**
- `permission/` 5 layers + `BashArity`, `tools/registry.ts` tool-layer guardrails (fail-closed outer `catch` → deny + audit, fixed from silent `catch`)
- `MiraConfig.permission: Record<string, PermissionAction|Record<...>>`, `guardrails: {enforce, allowedRoots, blockedPaths, blockedCommands, maxOutputBytes, auditLogPath}`
- Client `MiraConfig` was missing `features`/`tools` → `SettingsPanel.tsx` used `as unknown as` (fixed by extending `web/src/api/client.ts`)
- `JsonValue` recursive `string|number|boolean|null|JsonValue[]|{[k:string]:JsonValue}` caused deep instantiation when casting `Todo[]`/`Snapshot[]`/`MCPServerConfig` (`as JsonValue`) — fixed via `Todo extends Record<string,JsonValue>`, `Snapshot extends Record<string,JsonValue>`, typed `MCPServerConfig` construction

**Risk:** Over-strict → agent blocked on legit `read`; loose → `read .env` leak. `JsonValue` casts hide type holes.

**Fix strategy:** Keep `Todo`/`Snapshot` extending `Record` (domain types are Json-serializable by definition), construct `MCPServerConfig` as `MiraConfig["mcp"][string]` directly, remove all `as unknown`. Verify via `permission.test.ts` + `guardrails` audit log.

**Files:** `types/index.ts:50 Todo`, `storage/snapshots.ts:13 Snapshot`, `routes/mcp.ts:7 mcpCreateSchema`, `routes/extras.ts` queue/todo/finding routes, `permission/index.ts`, `tools/registry.ts`

---

## Challenge 4 — State Durability & Recoverability

**Symptom:** Crash mid `edit`/`write` → WAL corruption, lost queue, snapshots orphaned.

**Current code:**
- `storage/snapshots.ts` auto-snapshot before every mutation, `revertLast`/`revertToMessage`/`listSnapshots` (50)
- `storage/db.ts` SQLite WAL, `sessions/messages/parts/todos/snapshots/queue/knowledge` tables; `deleteSession` now cascades `file_snapshots`/`jobs`/`findings`/`knowledge_entries`/`message_queue` (was orphaning)
- `routes/extras.ts` `queueMessage`/`getQueue`/`clearQueue` durable SQLite, chained-turn drain while streaming
- `api_keys` persisted, reloaded into `API_KEY_OWNERS` at boot

**Risk:** Missing cascade → orphan snapshots; `bun:sqlite` FK `audit_logs.user_id → auth.users NO ACTION` requires `DISABLE TRIGGERS` transactionally on delete (pattern from audit). `c.req.param("id"): string|undefined` not guarded → 404 vs 500 confusion.

**Fix strategy:** Keep cascade deletes, add `requireId(c)` guard (already in `extras.ts` `requireId` helper), verify via `e2e/server.e2e.test.ts` (boots real server) + manual `revert` test.

**Files:** `storage/snapshots.ts`, `storage/db.ts:44 mira as MiraDB (now Object.assign typed)`, `routes/extras.ts:24 mountExtrasRoutes`, `session/prompt.ts:643 loadContext`

---

## Challenge 5 — Public Exposure & Networking

**Symptom:** Local `127.0.0.1:4096` must be publicly reachable via `slab1.github.io` Pages + `cloudflared`, with `MIRA_TOKEN` gate, `x-real-ip` rate-limit, CORS `CORS_ORIGINS`, OTel `startSpan`.

**Current code:**
- `packages/server/src/index.ts` bearer gate (header only, no `?token=`), `isPublicUiPath` bypass for SPA shell, `WS_AUTH_TIMEOUT_MS 20_000`, `cachedTracer: {startSpan}|null` (fixed from `as typeof cachedTracer` + `cachedTracer.startSpan` null-narrowing via `tracer` local)
- `packages/web/src/api/client.ts` `baseUrl()` reads `VITE_API_URL`, `TOKEN_KEY=mira_token`, `setToken/getToken` + `wsUrl()` first-message auth
- `scripts/tunnel-watchdog.sh` self-heals quick tunnel; Pages `VITE_API_URL` from `vars` + `allowedHosts:true` (fixed from `@ts-ignore` → `@ts-expect-error` with Vite type note)

**Risk:** `cloudflared login` artifacts → quick tunnel HTTP 404 (registered but no backend) — we remove `~/.cloudflared/{config.yml,<uuid>.json,cert.pem}`; named tunnel blocked (no domain, `dpdns.org` → ULA `fd10::/8`); OTel `trace.getTracer` cast needs explicit shape; rate-limit `c.req.header("x-real-ip")` vs bearer prefix.

**Fix strategy:** Keep watchdog, never `cloudflared login` in this account, document `VITE_MIRA_TOKEN` bake vs paste decision. Verify via `curl /healthz`, `/session` 401→200, `/admin/api-keys` 200 through tunnel, `bunx tsc --noEmit` green.

**Files:** `server/src/index.ts:160 @ts-expect-error Resource interop, 252 cachedTracer`, `web/src/api/client.ts:108 MiraConfig`, `tui/vite.config.ts:22 allowedHosts`, `scripts/tunnel-watchdog.sh`, `.github/workflows/pages.yml`

---

## Metrics Baseline (pre-fix)

- `// @ts-ignore` 44 (extras 27, mcp 13, prompt 1, shared 2, tui 1) → target 0
- `as unknown`/`as any` 11 → target 0 (allow 2 `@ts-expect-error` with reason)
- `bunx tsc --noEmit` / `npx tsc --noEmit` → 0 errors in `server`+`web` (verified after sweep)
- `grep -rn as\ unknown` → 0, `grep -rn //\ @ts-ignore` → 0

## Procedure (Document → Fix → Verify)

1. This doc freezes challenges.
2. Fix surgically per challenge (smallest edit, read before write, `ast_grep` where bulk).
3. Verify conclusively: `bunx tsc --noEmit` + `grep` counts + live tunnel `curl` checks; commit with conventional message; update this doc with outcome.

