# Session Handoff — 2026-10-11

> Written at session end so the next session resumes without re-deriving context.
> Everything below is committed and pushed (`main` = `8b18e65` at time of writing).

## State: ALL documented findings closed

The master-findings plan (`docs/MASTER_FINDINGS_CROSSCHECK_AND_PLAN.md`) is fully
executed — P0 → P3.6 plus every correction sweep. Items 1–21 in that doc are the
authoritative record of what shipped and how. Do **not** re-audit from scratch;
read that doc first.

## What this session added (chronological)

1. **Wrong-edit defense stack** — read-guard covers `patch` (was bypassed);
   global ambiguity gate in `edit-fallback.ts` (multi-match `oldString` refused
   before any layer); Layer 6/9 position validation (no blind splice, no fake
   `verified: true`); `near` intent anchor on `edit` (refuses perfect matches
   in the wrong function); symbol binding + task-text relevance + module-boundary
   signals (`tools/edit-target.ts`); embedding relevance
   (`tools/embed-relevance.ts`, AI SDK, sqlite-cached, needs `OPENAI_API_KEY`);
   edit critic (`tools/edit-critic.ts`, opt-in second-model review, writes
   finding + optional revert); agent-callable `revert`/`revert_list` tools
   (file-scoped, never deletes messages); blast-radius advisory (codegraph
   `findDependents`, only when graph already built, project-relative paths); 30
   → 41 registered tools (registerAll preferred `default` over `tools` arrays —
   `patch` was unreachable).
2. **Auto-rollback** — `FAILED_VERIFICATION` reverts the run's file edits via
   snapshots (`compliance/index.ts rollbackSessionMutations`). Opt-in:
   `MIRA_AUTO_ROLLBACK=1` or `compliance.autoRollback`. Fires in `finishJob`
   after the atomic settle; files only, messages preserved.
3. **Tenancy completion** — findings + file_snapshots owner/org scoped
   (`auth/session-access.ts sessionVisibleTo` — one predicate everywhere);
   `deleteSession` stamps audit rows with owner/org (evidence survives);
   `session-crud.ts` deleted (dead 384-line duplicate of SessionPrompt — a
   compliance hazard).
4. **Compliance** — redaction at write chokepoints (AuditLogger +
   persistToolResult) and on reads; retention sweeps (`audit_entries` was
   unbounded); violation reports with org scoping; audit `error` +
   `owner_id`/`org_id` columns. ReDoS fixed in redaction patterns (6.5s → 11ms
   per 50KB — keep quantifiers bounded).
5. **CI/CD hardened** — all 57 actions SHA-pinned (Dependabot keeps them
   current; PR #2 merged); turbo cache namespace `turbo-main-` (PRs restore
   only, never save — poisoning impossible); per-job least-privilege
   permissions; deploy vars via `env:` indirection + jq payload; release
   pre-flights `npm whoami` (the repo's `NPM_TOKEN` is **invalid** — job falls
   back to GitHub-release-only with a warning; rotate the token to restore npm
   publishing). Verified green on real runs: CI ✓ Security ✓ CD ✓ Pages ✓.
6. **Verticals (P3.6)** — `community/verticals.ts` + 4th registry kind;
   `luxora`/`security-audit`/`dev-workflow` bundles; plan-before-write; ADR
   amendment in `docs/ADR/0001-core-identity.md` records owner authorization.
7. **Think/observe** — `think` tool (scratchpad, persisted to traces); critic
   findings injected with an act-on-it header (`openFindingsForContext`).
8. **Session auto-titling** — `session/title.ts` at the `streamResponse`
   chokepoint; only replaces placeholder titles; subagent children were already
   titled by `runSubagent`.
9. **Canary automation** — `startCanary(..., {auto})` / `MIRA_CANARY_AUTO=1`
   acts on the evaluate decision at expiry (auto-promote/rollback); manual
   promote/rollback clear the timer; promoter events aligned to its documented
   contract (`canary.promoted`/`canary.rollback`); promote route auto-starts a
   canary when `MIRA_CANARY_AUTO_START=1` (`canaryStart` hook → CanaryManager).

## Verification status

- Server: 1,156+ tests passing (`bun test src` from `packages/server`)
- Typecheck + lint clean (server, web, shared)
- CI/Security/CD/Pages all green on GitHub (verified via `gh run list`)
- Working tree clean, `origin/main` in sync

## Next queue (prioritized — all scoped in the plan doc)

1. **Publish path for community catalogs** — verticals/skills install but
   nothing publishes; offline-curated only.
2. **Gateway-routed embedding models** — embed-relevance is OpenAI-only;
   route via the gateway's multi-provider config.
3. **Blast-radius blocking mode** — promote the warning to a block under
   `MIRA_STRICT_EDIT_TARGET` (high-fan-in edits).
4. **`self_healing.test.ts`** — fault-injection suite spec'd in
   `MIRA_SELF_HEALING.md` §5 (disk 98%, symlink EPERM → verify heal).
5. **Web-review treatment audit** — `docs/MIRA_WEB_REVIEW_AND_FINDINGS.md`
   (963 lines) never verified against code.
6. **Deploy gate** — user must set `DEPLOY_ENABLED=true` (+ hook URL/token)
   in Actions vars/secrets; commands in `.env.example` bottom block. The
   Codespace token gets 403 on Actions variables.

## Operational gotchas (hit this session, all documented)

- **Hermetic tests**: `packages/server/bunfig.toml` preloads
  `tests/preload.ts` (temp ledger + memory bank) but ONLY when `bun test` runs
  from `packages/server`. Repo-root runs use the root bunfig. `ledger.decisions.test.ts`
  has belt-and-braces env setting. If `shared/context.json` shows up modified
  after a test run, that's a hermeticity leak — find the test calling
  `appendDecision`/`saveContext` without the env.
- **lint-staged**: touched files must be eslint-clean or the commit fails
  (commitlint: header ≤ 72 chars, `fix:`/`feat:`/`ci:`/`docs:`/`chore:` types).
  Pre-existing lint debt exists in files NOT being touched (brio, browser,
  glob, lsp, mcp_marketplace, memory, other) — only fix files you modify.
- **RAM**: 8GB no-swap Codespace. Run targeted `bun test src/<area>`, not the
  full suite, alongside builds; commit in small batches (lint-staged cost).
- **bunfig preload cwd trap**: `bun -e` / direct script imports bypass the
  preload — hermeticity only guaranteed under `bun test`.
- **`findDependents`** needs project-relative paths (absolute silently
  matches nothing). **`codeGraphFor(db)`** — only query when
  `graph.stats().files > 0`, never trigger a build from the edit path.
- **`applyChange` appends** a review note (does not replace) — the patcher's
  contract, not a replace-in-place.
