# Session Handoff — 2026-10-12

> Written at session end so the next session resumes without re-deriving context.
> Everything below is committed and pushed (`main` = `ffc0f7a` at time of writing).

## State: the entire next-queue is closed

Every item from the previous handoff's queue (1–6) is now implemented, tested and
merged to `main`, plus a full provider/model subsystem audit whose five P0
broken contracts are fixed. CI / Security / CD are green on the real pipeline.

## What this session added

1. **Catalog publish path (P3.7)** — the missing write side of the distribution
   catalog. `community/publish.ts` validates a proposed artifact against exactly
   the constraints install enforces later (skill slug + body, agent slug +
   `system ≥ 10`, knowledge entries inside the store caps, vertical components
   resolvable), so a successful publish is a successful install. Curated names are
   immutable (409) — publishing may only create new names or replace an earlier
   _published_ entry. Project-local (`<cwd>/.mira/community/<kind>.json`), re-read
   per lookup so publish→install needs no restart; `cwd` threaded (optionally)
   through `loadRegistry`/`searchRegistry`/`getRegistryEntry`/`planVertical` so a
   published entry is genuinely installable. Routes: `POST /community/publish`,
   `GET /community/published`, `DELETE /community/published/:kind/:name`.
   24 tests in `routes/publish.test.ts`.
2. **Gateway-routed embeddings** — `providers/embedding.ts` speaks the same
   OpenAI-compatible dialect the chat path already uses (`liveOpenAIStream`),
   so _any_ provider in `mira.json` can serve embeddings (OpenAI, DeepSeek,
   NVIDIA, local Colibri, OpenRouter) with no new dependency. The AI SDK path is
   gone: it only supported OpenAI. Cache key is now provider-qualified
   (`provider/model`) so two providers' vectors can never be compared, and a
   dimension mismatch degrades to "signal absent" instead of a false `0.0`
   "completely unrelated" warning. 7 + 5 tests.
3. **Blast-radius blocking** — under `MIRA_STRICT_EDIT_TARGET=1`, an edit whose
   file is imported by ≥ `MIRA_BLAST_RADIUS_BLOCK` (default 10) files now blocks
   instead of warning. The block uses a dedicated `BlastRadiusBlock` error so it
   can travel through the cold-graph `try/catch` without being swallowed like a
   real graph failure. 4 tests.
4. **Provider/model audit — 5 P0 contracts fixed**, each with a regression test
   proven to fail without the fix. Full write-up in
   `docs/MASTER_FINDINGS_CROSSCHECK_AND_PLAN.md` (final section). Highlights:
   fallback chain advanced only on 401/429 (a 503 killed the request despite
   configured fallbacks); `resolveWithFallbacks` threw `CIRCUIT_OPEN` before
   building the chain; provider health was never recorded (two disjoint circuit
   breakers — every health endpoint reported `healthy` forever); the config merge
   was one level deep, so setting only `provider.openai.options.apiKey` dropped
   `baseURL` → requests to `undefined/chat/completions`.
5. **`self_healing.test.ts`** (16 tests) — fault injection against every
   self-healing contract that is actually implemented in TypeScript: circuit
   opens at 5 failures → cool-down → half-open probes → closes; a failed probe
   re-opens (no false heal); per-provider isolation; no retry-loop; snapshot →
   rollback restores content and is session-scoped; `MIRA_AUTO_ROLLBACK` is
   opt-in. The doc's `Target` items (`POST /dev/heal`, `heal.*` events,
   `features.selfHealing`) do **not** exist and are deliberately not faked; the
   `disk 98%` / `symlink EPERM` faults are shell-level and cannot be unit-tested.
6. **Deploy gate** — verified wired and fail-closed (no-op when unset, hard-errors
   on partial config so a hook can never deploy unauthenticated, simulated all
   four cases). Fixed one real inconsistency: the deploy step interpolated
   `${{ vars.DEPLOY_HOOK_URL }}` into a `run:` block — precisely the
   template-injection surface the file's own comment forbids. It now reads the
   env var like every other var in that workflow.

## Verification status

- Server: **1,242 tests passing**, 1 skip, 0 fail (baseline was 1,156)
- Typecheck + lint clean (server); prettier-clean
- CI ✓ Security ✓ CD ✓ green on the real pipeline for `ffc0f7a`
- Working tree clean, `origin/main` in sync

## Next queue

The old queue is empty. From the audit's "still open" list, in priority order:

1. **Dead config needs a decision, not a patch** — `provider.*.npm`,
   `models[].limit.*`, `options.kind`, `routing.lanes`,
   `subgateways.*.{provider,enabled}` are declared, validated and documented but
   never read. For each: honor it or delete the declaration. Separately,
   `subgateways.*.timeout` is shadowed on the stream path by the provider's own
   timeout, so the `compaction`/`local` lanes configured at 180s actually time out
   at 120s.
2. **Dead modules** — `providers/{cache,health,rate-limiter,pricing}.ts`,
   `gateway/{retry,pricing}.ts`, `providers/index.ts` have no call sites outside
   their own tests. `providers/rate-limiter.ts` is the trap: the real rate
   limiter is the unrelated `gateway/rate-limiter.ts` `TokenBucket`.
3. **Env layer is dead (P0-5 in the audit)** — `envToConfigMap`/`parseEnvConfig`
   are never applied, so `MIRA_MODEL` has no effect. Provider keys work only
   because `config/defaults.ts` hardcodes `{env:VAR}` templates — a different
   mechanism from the documented one.
4. **`complete()` bypasses cost caps** — `stream()` enforces `checkCostCap()` and
   per-session cost tracking; `complete()` (the autocomplete path) does neither.
5. **Test coverage** — `gateway/stream.ts` (401 lines, the real SSE transport) and
   `providers/auth.ts` are the largest untested surfaces. `providers/registry.ts`
   and the fallback path are now covered.
6. **Web-review audit leftovers** — the highest-value items from item 5 of the
   previous queue are still unfixed: unlabeled synthetic data on the Evolution
   page, and raw `fetch` calls in `Changes`/`Intelligence`/`System` that 401
   whenever a token is set (which is the default).

## Operational gotchas (added this session)

- **Two circuit breakers, not one.** The lane breaker (`subgateways.*.circuitBreaker`)
  and the provider breaker (registry default: 5 failures) are separate stores. If
  the lane threshold is the lower of the two, the lane opens first and
  short-circuits `stream()` _before_ the candidate loop — so the provider counter
  stops accumulating and provider health never heals. `self_healing.test.ts`
  pins this interaction; set the lane threshold above 5 if you want the provider
  breaker to be the one that governs.
- **`successCount` on a breaker is a HALF_OPEN probe counter, not a lifetime
  counter** — it only increments while half-open. Assert on `state`/`status`,
  not `successCount`, when testing health.
- **A test that stubs `globalThis.fetch` must delegate non-target hosts back to
  the captured original**, or it intercepts the test's own localhost call.
- **commitlint header ≤ 72 chars** (the 2026-10-12 commits hit this twice), and
  the allowed `scope` enum is `[server, web, tui, cli, shared, slack, vscode,
deps, ci, dx, eval, gateway, memory, auth, guardrails, lsp, mcp]` — `community`
  is a warning, not an error.
- **`git checkout` on a file mid-session silently discards uncommitted work.**
  I lost an `expandAlias` fix this way; a stray `git stash pop` then created a
  merge conflict that needed `--abort` + `reset --hard`.
- **`rollbackSessionMutations` is async** (it dynamically imports `node:fs`);
  forgetting `await` makes the file assertions run before the write.
- All previous handoff gotchas still apply (bunfig preload cwd, lint-staged,
  `findDependents` project-relative paths, `codeGraphFor(db)`, RAM limits).
