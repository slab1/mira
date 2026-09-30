# Mira Codebase Review — 2026-09-29

**Reviewer:** Automated code review (3 parallel critic agents)
**Scope:** Full codebase — server, web, shared, config, CI/CD, scripts, docs
**Overall Grade:** B- (Strong foundation, needs hardening)

---

## Executive Summary

Mira is a 6-layer AI agent platform with impressive breadth: 24 tools, MCP/LSP integration, 4-tier memory, self-evolution, and 5 client interfaces. The architecture is sound but the codebase has accumulated significant technical debt, security gaps, and reliability risks that need addressing before production use.

---

## P0 — Critical Security (Fix Immediately)

### 1. Evolution Patcher — No Authentication

- **File:** `packages/server/src/evolution/patcher.ts:51-105`
- **Issue:** `applyPatch()` can be called without any authentication. If exposed via API, an attacker could modify arbitrary files.
- **Fix:** Add authentication check (API key or internal token) before allowing patch application.
- **Effort:** Low

### 2. Permission Reply Spoofing

- **File:** `packages/server/src/bus/index.ts:93-104`
- **Issue:** `waitForPermissionReply()` resolves on any `permission.reply` event with a matching `toolCallID`. An attacker who knows the `toolCallID` could publish a fake reply.
- **Fix:** Add a nonce/token to the permission request that must be echoed back in the reply.
- **Effort:** Low

### 3. Bash Tool — No Command Injection Protection

- **File:** `packages/server/src/tools/bash.ts:28`
- **Issue:** Passes command directly to `bash -c` without sanitization. Relies on guardrails layer being configured.
- **Fix:** Add `sanitizeCommand()` call inside the bash tool itself, not just in guardrails.
- **Effort:** Medium

### 4. Path Traversal Double-Encoding Bypass

- **File:** `packages/server/src/guardrails/index.ts:137-207`
- **Issue:** `sanitizePath()` decodes percent-encoding once, but double-encoding (`%252e%252e%252f`) bypasses the check.
- **Fix:** Decode repeatedly until stable, then check for traversal patterns.
- **Effort:** Low

### 5. Gateway Fetch — No SSRF Protection

- **File:** `packages/server/src/gateway/stream.ts:107`
- **Issue:** `fetch()` call doesn't validate baseURL against private ranges. A compromised provider config could exfiltrate data.
- **Fix:** Add URL validation against private IP ranges before fetch.
- **Effort:** Medium

### 6. Token Stored in localStorage

- **File:** `packages/web/src/api/client.ts:531-599`
- **Issue:** Auth token in `localStorage` is vulnerable to XSS. Any script injection exposes the token.
- **Fix:** Move to `sessionStorage` (cleared on tab close) or httpOnly cookie.
- **Effort:** Low

### 7. WebSocket Auth Over Plaintext

- **File:** `packages/web/src/api/client.ts:1374-1375`
- **Issue:** Token sent as plaintext JSON over WebSocket. If `ws://` (not `wss://`), token is exposed.
- **Fix:** Use secure WebSocket (`wss://`) in production, or encrypt token before sending.
- **Effort:** Low

### 8. Auto-Commit to Main in Tunnel Watchdog

- **File:** `scripts/tunnel-watchdog.sh:74-77`
- **Issue:** Watchdog automatically commits and pushes to main. A malformed URL could push bad code.
- **Fix:** Remove auto-commit; create a PR instead or just alert.
- **Effort:** Low

---

## P0 — Critical Reliability (Fix Immediately)

### 9. Tool Timeout Doesn't Kill Processes

- **File:** `packages/server/src/tools/registry.ts:375-382`
- **Issue:** Timeout races execution but doesn't kill the underlying process. Zombie processes accumulate.
- **Fix:** Use `AbortController` or process kill on timeout.
- **Effort:** Low

### 10. Synchronous File I/O in Memory Controller

- **File:** `packages/server/src/memory/memory_controller.ts:154-162`
- **Issue:** `fs.openSync/writeSync/fsyncSync` blocks the event loop on every memory write.
- **Fix:** Switch to async `fs.promises` API.
- **Effort:** Medium

### 11. Non-Transactional Session Forking

- **File:** `packages/server/src/session/prompt.ts:676-693`
- **Issue:** Inserts messages and parts in a loop without a transaction. Partial copy on failure.
- **Fix:** Wrap in a database transaction.
- **Effort:** Low

### 12. Silent Error Swallowing Throughout

- **Files:** Multiple files across the codebase
- **Issue:** `catch {}` blocks silently ignore errors, making debugging impossible.
- **Fix:** Add logging to all catch blocks.
- **Effort:** Medium

### 13. Compaction Failure is Silent

- **File:** `packages/server/src/session/compaction.ts`
- **Issue:** If compaction fails, the loop continues with full uncompacted context, potentially exceeding context window.
- **Fix:** Add error handling that stops the loop or retries with smaller context.
- **Effort:** Medium

---

## P1 — High Priority (Next Sprint)

### Architecture & Code Quality

| #   | Finding                                    | Location                                             | Effort |
| --- | ------------------------------------------ | ---------------------------------------------------- | ------ |
| 14  | `prompt.ts` is 1383+ lines — god file      | `packages/server/src/session/prompt.ts`              | High   |
| 15  | `App.tsx` is 1691 lines — god component    | `packages/web/src/App.tsx`                           | High   |
| 16  | Dead code in `stream.ts` — empty if blocks | `packages/server/src/gateway/stream.ts:339-399`      | Low    |
| 17  | `RealtimeLayer` class is never used        | `packages/web/src/realtime/websocket.ts`             | Low    |
| 18  | Duplicated `applyChange` function          | `patching/applier.ts` + `patching/verifier.ts`       | Low    |
| 19  | MemoryGraph O(n²) per node per render      | `packages/web/src/components/MemoryGraph.tsx:42-107` | Medium |
| 20  | No connection pooling in gateway           | `packages/server/src/gateway/stream.ts`              | Medium |

### Performance

| #   | Finding                             | Location                                                  | Impact           |
| --- | ----------------------------------- | --------------------------------------------------------- | ---------------- |
| 21  | Streaming updates O(n) per token    | `packages/web/src/state/app.ts:510-517`                   | UI jank          |
| 22  | TF-IDF ranking is O(n*m)            | `packages/server/src/memory/memory_controller.ts:210-273` | Slow retrieval   |
| 23  | Guardrails check on every tool call | `packages/server/src/guardrails/index.ts:429-732`         | Added latency    |
| 24  | No backpressure on SSE writes       | `packages/server/src/session/prompt.ts:917-920`           | Memory leak risk |

### Test Coverage Gaps

| #   | Area                   | Missing Tests                         |
| --- | ---------------------- | ------------------------------------- |
| 25  | Evolution pipeline     | Failure recovery, promotion/rollback  |
| 26  | Tool timeout           | Process killing verification          |
| 27  | Guardrail bypasses     | Double-encoding, command substitution |
| 28  | MCP/LSP crash recovery | Reconnection logic                    |
| 29  | Web components         | Only 1 static a11y test file exists   |
| 30  | Compaction             | Tool-boundary preservation            |

---

## P2 — Medium Priority (Plan for Future)

### Configuration & CI/CD

| #   | Finding                                                          | Location                            |
| --- | ---------------------------------------------------------------- | ----------------------------------- |
| 31  | Bun version mismatch — `package.json` says 1.4.0, CI uses 1.3.14 | Root config                         |
| 32  | Dev dependencies in production Docker image                      | `Dockerfile:39`                     |
| 33  | No ESLint on commit — only Prettier                              | `.lintstagedrc.json`                |
| 34  | Audit failures silently ignored                                  | `.github/workflows/security.yml:39` |
| 35  | No staging environment                                           | CI/CD                               |
| 36  | Secret detection false positives — regex matches git SHAs        | `.github/workflows/ci.yml:110`      |

### Documentation

| #   | Finding                                        | Location                                                |
| --- | ---------------------------------------------- | ------------------------------------------------------- |
| 37  | Unverified test count claim — "119-test suite" | `README.md:5`                                           |
| 38  | Missing API reference                          | `docs/`                                                 |
| 39  | Missing deployment guide                       | `docs/`                                                 |
| 40  | Design docs without implementation status      | `PROVENANCE_DESIGN.md`, `VERIFICATION_STATES_DESIGN.md` |

---

## Architecture Strengths

1. **6-layer architecture** — Clean separation of concerns at the macro level
2. **Hierarchical compaction** — 3-tier with tool-call boundary preservation
3. **Doom-loop detection** — 5 strategies with stateful tracking
4. **MCP dual-transport** — Streamable HTTP + legacy SSE fallback
5. **LSP circuit breaker** — Per-language failure isolation
6. **Event-driven glue** — BusEvent → GlobalBus → Worker pattern
7. **Hash-anchored patching** — 9-layer edit fallback
8. **Provenance tracking** — 8 columns for trust & memory lifecycle

---

## File Size Hotspots (Needs Splitting)

| File                                              | Lines | Issue                       |
| ------------------------------------------------- | ----- | --------------------------- |
| `packages/web/src/App.tsx`                        | 1691  | God component               |
| `packages/server/src/session/prompt.ts`           | 1383  | God file                    |
| `packages/web/src/api/client.ts`                  | 1447  | Too many responsibilities   |
| `packages/web/src/components/SettingsPanel.tsx`   | 1446  | Massive settings UI         |
| `packages/web/src/pages/Missions.tsx`             | 1430  | God component               |
| `packages/web/src/components/SessionList.tsx`     | 1305  | Duplicated rendering        |
| `packages/web/src/components/ChatView.tsx`        | 1293  | Complex parsing + rendering |
| `packages/web/src/components/TraceViewer.tsx`     | 1119  | Large viewer component      |
| `packages/server/src/guardrails/index.ts`         | 732   | Monolithic check method     |
| `packages/server/src/memory/memory_controller.ts` | 626   | Mixed concerns              |

---

## Test Coverage Summary

| Package           | Test Files       | Coverage | Notes                                 |
| ----------------- | ---------------- | -------- | ------------------------------------- |
| `packages/server` | 6 test files     | ~40%     | Core paths tested, edge cases missing |
| `packages/web`    | 1 test file      | ~5%      | Only static a11y checks               |
| `packages/shared` | 1 test file      | ~30%     | Schema validation tested              |
| **Overall**       | **8 test files** | **~25%** | **Below industry standard**           |

---

## Recommended Action Plan

### Immediate (This Week)

1. Add authentication to evolution patcher
2. Fix permission reply spoofing (add nonce/token)
3. Sanitize bash commands in the tool itself
4. Fix path traversal double-encoding
5. Add SSRF protection to gateway fetch
6. Move token to sessionStorage or cookie
7. Remove auto-commit from tunnel watchdog

### Short-Term (Next 2 Weeks)

8. Kill processes on tool timeout
9. Make memory controller async I/O
10. Add transaction to session forking
11. Split `prompt.ts` into smaller modules
12. Split `App.tsx` into sub-components
13. Fix MemoryGraph O(n²) layout
14. Add connection pooling to gateway

### Medium-Term (Next Month)

15. Add tests for evolution pipeline failure paths
16. Add tests for guardrail bypasses
17. Add component tests for web UI
18. Fix Bun version mismatch
19. Remove dev deps from production image
20. Add ESLint to pre-commit hook
21. Create staging environment
22. Write API reference and deployment docs
