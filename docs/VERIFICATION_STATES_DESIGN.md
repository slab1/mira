# Task Verification States — Design (strategy-doc §13)

**Status:** design only. Success criteria (per brief): _a task/agent result must carry whether it was
**actually** verified; an agent claiming VERIFIED without running tests is impossible (or clearly
marked self-reported)._ States: `UNVERIFIED → PARTIALLY_VERIFIED → VERIFIED` + `FAILED_VERIFICATION`.

**Scope note / §13 traceability:** the strategy doc's §13 text is **not in this repo** —
`PARTIALLY_VERIFIED|FAILED_VERIFICATION` has zero matches repo-wide and in `~/.config/opencode`;
`MIRA_WEAKNESSES_AND_OBSTACLES.md` §13 (line 621) is _Autonomous Cost Control_; `MIRA_SYSTEM_DOCUMENTATION.md`
ends at §12. This design implements the state names quoted in the brief. Flagged as a documentation gap.

---

## Implementation Status

| Component                                                                                           | Status                | Notes                                                                                |
| --------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `VerificationState` enum (`UNVERIFIED` / `PARTIALLY_VERIFIED` / `VERIFIED` / `FAILED_VERIFICATION`) | Pending               | New module `packages/server/src/verification.ts`                                     |
| `verification_state` / `verification_evidence` / `verification_updated_at` columns on `jobs`        | Pending               | 3 columns via `addColumn` in `storage/db.ts` after provenance block                  |
| `computeVerification(parts)` — pure state computation                                               | Pending               | Classifies tool-result parts into `{typecheck, test, build}`; latest-per-class wins  |
| `buildVerificationPatch(db, childSessionID)`                                                        | Pending               | SELECT parts → `{verificationState, verificationEvidence, verificationUpdatedAt}`    |
| Enforcement at `finishJob()` (`task.ts:87-96`)                                                      | Pending               | Merge verification patch into terminal `WHERE status='running'` update               |
| Enforcement at orchestrate inline updates (`orchestrate.ts:482-491`)                                | Pending               | Same compute-then-single-UPDATE pattern                                              |
| `EvidenceRef` reuse from `memory/provenance.ts`                                                     | Depends on Provenance | `kind:'message'` + `{check, ok}` extras; cap 8                                       |
| `verification` in `taskResponseSchema`                                                              | Pending               | Optional field on task response; foreground reads back after `finishJob`             |
| `job.updated` bus event with `payload.kind = 'verification.state'`                                  | Pending               | Published from terminal settle only when state ≠ `UNVERIFIED`                        |
| Backfill (`UNVERIFIED` for existing jobs)                                                           | Pending               | `UPDATE jobs SET verification_state = 'UNVERIFIED' WHERE verification_state IS NULL` |
| Unit tests (`verification.test.ts`)                                                                 | Pending               | Table-driven `computeVerification` tests + e2e on `:memory:` DB                      |
| Enforcement sweep test                                                                              | Pending               | Every terminal write path leaves `verification_state` non-null and in-enum           |

**Summary:** All components are **pending implementation**. The design depends on the provenance
module (`memory/provenance.ts`) for the `EvidenceRef` type. Implementation order: provenance P0 first,
then verification states per the plan in §7.

---

## 1. Current state (explored, file:line)

Every "work item" and its status today:

| Work item      | Table / location                   | Status today                                      | Verification today                                   |
| -------------- | ---------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| **Task (job)** | `jobs` `storage/schema.ts:117-140` | `running/completed/failed/cancelled` (`:128`)     | **None** — `completed` is an assertion, not evidence |
| Todo           | `todos` `schema.ts:78-96`          | `pending/in_progress/completed/cancelled` (`:86`) | n/a — plans, not results                             |
| Session        | `sessions` `schema.ts:11-36`       | **no status column** (`parentID :20`)             | n/a — carrier (P1: derive from child jobs)           |
| Message        | `messages` `schema.ts:38-52`       | `role` only                                       | n/a — carrier                                        |
| Part           | `parts` `schema.ts:54-76`          | `isError :72`, `result :71`                       | **evidence storage** (raw tool output)               |
| Finding        | `findings` `schema.ts:143-164`     | `open/resolved :156`, `evidence TEXT :155`        | free-text evidence (coexists)                        |

**Verification signals that already exist (sources of truth for evidence):**

- `diagnose` (`tools/other.ts:189-239`): runs `tsc --noEmit` / `bun test` / `bun run build` (`:208-212`),
  per-check `ok = exit===0` (`:230`), returns `{ok, checks, results}` (`:237`) — **default is `['typecheck']`
  only** (`:204`), and it never throws, so `parts.isError` stays `false` even on failure → verdicts must
  be parsed from `result`, never from `isError`.
- `bash` (`tools/bash.ts:30-39`): returns `{stdout, stderr, exitCode, command}` (`:39`) — exit code evidence.
- Persistence chokepoint: `persistToolResult()` `session/prompt.ts:1794-1824` writes every tool result
  **in full** (success path `:1430`; error paths `{error}` + `isError=true` `:1227/:1289/:1304/:1370`).
- Job lifecycle writers: `finishJob()` `tools/task.ts:87-96` (bg `:155-179`, fg `:197/:208`) and orchestrate's
  **inline** terminal updates `tools/orchestrate.ts:482-491` — both guarded `WHERE status='running'`.

**Adjacent verification machines (coexist, don't duplicate):** patch verifiers `evolution/verifier.ts:31/:46`
(`{verified, benchmark, regression}`), `patching/verifier.ts:20-21` (`{verified, reason}`) — patch-level, not
task-level; `UNVERIFIED-DO-NOT-USE` **string markers** on staged skill scaffolds (`orchestrate.ts:295/:310/:329`,
`learning/improvement.ts:390-459`) — exactly the ad-hoc convention this design retypes for jobs (scaffolds stay
P1); orchestrate `evalGate` (`orchestrate.ts:210`); canary machine (`canary.ts:42`), evolution ledger tasks
(`learning/ledger.ts:38`), governance proposal states — separate subjects; `guardrails.enforce`
(`index.ts:540-552`, `MIRA_GUARDRAILS_ENFORCE`) = **command safety, not test verification** — orthogonal;
per-target verification-command map precedent `improvement.ts:481-524`.

## 2. State machine + storage

### 2.1 States & transitions

The state is a **pure function of the job's stored evidence**, recomputed at each terminal settle — no
hand-rolled transition drift. Evidence is append-only, so `UNVERIFIED` is never re-entered.

```
UNVERIFIED ──passing non-test check──────────▶ PARTIALLY_VERIFIED
     │      ──passing test-class check────────▶ VERIFIED
     │      ──any failing check───────────────▶ FAILED_VERIFICATION
PARTIALLY_VERIFIED ──test pass, no failing class──▶ VERIFIED
VERIFIED / PARTIALLY ──newer failing check────────▶ FAILED_VERIFICATION
FAILED_VERIFICATION ──failed class re-passes──────▶ PARTIALLY_VERIFIED / VERIFIED
```

**Hard rule:** `VERIFIED` is unreachable without a passing **test-class** run — an agent cannot claim it
(§5). `PARTIALLY_VERIFIED` = only typecheck/build evidence (including `diagnose`'s default single check).

### 2.2 DDL — columns on `jobs` (3 columns; mirrors provenance migration `storage/db.ts:261-278`)

```sql
-- storage/db.ts addColumn block (immediately after the provenance block :278) — idempotent for fresh+existing DBs:
addColumn('jobs', 'verification_state',     "TEXT NOT NULL DEFAULT 'UNVERIFIED'")
addColumn('jobs', 'verification_evidence',  "TEXT NOT NULL DEFAULT '[]'")
addColumn('jobs', 'verification_updated_at','INTEGER')
-- duplicate-safe backfill (existing rows — honest default, see §2.4):
UPDATE jobs SET verification_state = 'UNVERIFIED' WHERE verification_state IS NULL;
UPDATE jobs SET verification_evidence = '[]'      WHERE verification_evidence IS NULL;
```

Do **NOT** also edit the inline `CREATE TABLE jobs` (`db.ts:~128-145`) — `addColumn` runs on every boot
(the provenance block proves it boot-safe); one source avoids CREATE/addColumn drift.

`storage/schema.ts` (jobs `:119-135`, add after `updatedAt :134`):

```ts
verificationState: text('verification_state', { enum: ['UNVERIFIED','PARTIALLY_VERIFIED','VERIFIED','FAILED_VERIFICATION'] })
  .notNull().default('UNVERIFIED'),
verificationEvidence: text('verification_evidence', { mode: 'json' }).$type<EvidenceRef[]>()
  .notNull().default('[]'),          // type-only import from '../memory/provenance.js' (no runtime dep)
verificationUpdatedAt: integer('verification_updated_at'),
```

### 2.3 TypeScript surface

`Job` already flows from `typeof jobs.$inferSelect` (`task.ts:17`) → `getJob/listJobs` (`:55/:62`) →
`GET /session/:id/jobs`, `GET /jobs`, `GET /jobs/:id` (`routes/session.ts:409/:433/:464`) and
`activeJobs` (`routes/session-extras.ts:258-278`) — **columns appear everywhere with zero route changes.**

### 2.4 Backfill policy — _unknown → the lowest honest rung_ (provenance §2.4 precedent)

All existing job rows → `UNVERIFIED`, `evidence=[]`. Never infer historical verification (parts may be
compacted — `storage/snapshots.ts:105` deletes; `session/compaction.ts` trims — and inferring trust from
possibly-deleted artifacts is the failure mode this feature exists to prevent). Job insert default keeps
every new row born `UNVERIFIED`.

## 3. State computation (fail-closed, per class)

1. **Collect** the child session's tool-result parts (`type='tool-result' AND tool IN ('diagnose','bash')`,
   indexed `parts_session_idx` `schema.ts:75`). No child-session link (failure paths — `task.ts:171/:208`,
   `orchestrate.ts:470/:488` drop `childSessionID`) → **no evidence → stays `UNVERIFIED`** (honest; P1 fix §8).
2. **Classify** each entry into a closed class set `{typecheck, test, build}`:
   - `diagnose`: `results[].check` (enum `other.ts:191`) + `ok` per check; run fails if any check fails.
   - `bash`: only if `command` matches verification patterns (mirror `improvement.ts:481-524`:
     `bun test|npm test|pytest` → `test`, `tsc --noEmit` → `typecheck`, `run build` → `build`);
     `ok = exitCode===0`; tool-crash result (`{error}`, `isError=true`) on a matching command = **fail**.
     **Unrecognized commands are ignored** (fail-closed — `ls` exit 0 proves nothing).
3. **Latest-per-class wins**, then:

```
no entries                          → UNVERIFIED
any class's latest run failed       → FAILED_VERIFICATION
latest 'test' run passed            → VERIFIED
else any class latest passed        → PARTIALLY_VERIFIED
```

Scenario table: diagnose[typecheck] ok → `PARTIAL` · diagnose[test] ok → `VERIFIED` · test ok then
typecheck fail → `FAILED` · typecheck fail then test ok (typecheck never re-run) → `FAILED`
(**fail-closed: a failed class must be re-passed** — rerun `diagnose` to clear) · bash `bun test` exit 1 →
`FAILED` · bash `ls` → ignored · text-only claim → `UNVERIFIED`.

## 4. Evidence — reuse `EvidenceRef`, fork nothing

`EvidenceRef` (`memory/provenance.ts:31-35`) is reused **unchanged**: `{kind:'message', ref:'msg:<messageID>#<toolCallID>', at}` +
extra fields `{check, ok}` — legal because the interface `extends Record<string, JsonValue>` (`:31`), and
`kind:'message'` is exactly a tool-call id (provenance §4 vocabulary). Optional `ref` dangles after part
compaction — acceptable: `check/ok` are snapshotted **into the ref**, and provenance already treats refs as
opaque (`PROVENANCE_DESIGN.md` §7). Cap: `EVIDENCE_CAP = 8` (`provenance.ts:72`), newest-8 kept. Stored in
`jobs.verification_evidence` as JSON. **No change to `memory/provenance.ts`** (shipped at HEAD `a12d574c`).

## 5. Enforcement — _VERIFIED only from exit codes_

**Single writer:** new module `packages/server/src/verification.ts` —
`computeVerification(parts)` (pure) + `buildVerificationPatch(db, childSessionID)` (SELECT parts →
`{verificationState, verificationEvidence, verificationUpdatedAt}`).
**Chokepoints (compute-then-single-UPDATE):** every terminal job write merges the patch into its _existing_
`WHERE status='running'` update, so status and verification land atomically and settle exactly once:

1. `finishJob()` `task.ts:87-96` (covers bg `:155/:169`, fg `:197/:208`) — only when `childSessionID` present.
2. Orchestrate node terminal updates `orchestrate.ts:482-491` (completed branch `:484` has `res.sessionID`).
3. `cancelJob` `task.ts:75-84`: **no change** (row lacks child link → stays `UNVERIFIED`; cancelled ≠ verified).

**Agent claim = impossible in P0:** there is no tool, route, or payload that writes these columns — only the
two chokepoints above, fed by persisted exit codes. Free-text claims ("tests pass!") remain prose; the job
row contradicts them. DB `DEFAULT 'UNVERIFIED'` backstops raw inserts (provenance §5 precedent). Honesty
note: a subagent with `bash` + a `sqlite3` binary could tamper — a pre-existing vector that already applies
to provenance/guardrails rows; out of P0 scope (guardrails own command safety).

**Enforcement test (executable form of §13):** (a) table-driven unit tests over `computeVerification` (the
§3 scenario table); (b) e2e on a `:memory:` DB — insert job + child session + fake `diagnose` parts →
settle → assert the row + event; every terminal write path leaves `verification_state` non-null and in-enum
(sweep, provenance §5 style); (c) raw INSERT omitting columns inherits `'UNVERIFIED'/'[]'`; (d) no-child
failure path → stays `UNVERIFIED` without crashing; (e) delete parts after settle → state+evidence survive.

## 6. Surface — minimal & additive

- **Bus:** reuse existing `job.updated` (`types/index.ts:109`) with `payload.kind = 'verification.state'`
  (discriminator precedent: `learning.updated` + `{kind:'learning.improvement.applied'}`
  `improvement.ts:318-319`) — payload `{jobID, kind:'verification.state', verification:{state, at}}`.
  **No new `BusEventType` member.** Published from the terminal settle only when state ≠ `UNVERIFIED`.
- **Parent visibility (the keystone's consumer):** `taskResponseSchema` (`task.ts:24-34`) gains optional
  `verification` — foreground reads it back after `finishJob` (`:197`); background includes it in the
  `message.updated` payloads (`:161/:175`, additive) and via `getJob` polling. The parent sees _verified_,
  not the child's prose.
- **UI:** nothing in P0 — the dirty web lane can read the fields off existing `GET /jobs*` responses later.
  Orchestrate node results / wave payloads: P1 (job rows already carry it).

## 7. Implementation plan (ordered, small diffs) + tests + non-goals

1. **NEW `packages/server/src/verification.ts`** (~130 lines): `VerificationState`, class-pattern matcher,
   `computeVerification`, `buildVerificationPatch`.
2. `storage/schema.ts`: 3 columns (§2.2, type-only `EvidenceRef` import).
3. `storage/db.ts`: `addColumn`×3 + backfill `UPDATE`×2 after `:278`.
4. `tools/task.ts`: merge patch in `finishJob` (+ `.returning()` to publish on change); `verification` in
   `taskResponseSchema` + fg return + `:161/:175` payloads.
5. `tools/orchestrate.ts`: merge patch at `:482-491`; `verification` in the `:496` payload.
6. Tests: **NEW `verification.test.ts`** (§5 a–e), then `bun test` + `tsc --noEmit`.

**Test plan additions:** extend existing job/route tests only where row literals require the new fields;
**run unchanged:** `orchestrate-cancel.test.ts` (status asserts unaffected; its job literal at `:41` needs
the 3 new fields — tsc will flag), `snapshots.test.ts`, `session` route tests, provenance tests.

**NON-goals (P0):** no session-level verification (derive from child jobs later); no agent claim tool
(P1: self-reported, hard-capped at `PARTIALLY_VERIFIED` with `via:'agent'`); no history backfill; no UI
badges; no new BusEvent type; no retyping `UNVERIFIED-DO-NOT-USE` scaffolds; no feeding
`evolution/patching verifier` outcomes in (P1 evidence link); no reliability metrics (lane's untracked
`agents/metrics.ts` is a future consumer); no touching todos/findings/governance/ledger/canary machines.

## 8. Risks & edge cases

- **Dirty parallel lanes (highest):** P0 touches only currently-clean files (`verification.ts`, `schema.ts`,
  `db.ts`, `task.ts`, `orchestrate.ts`) — verify with `git status` at implementation time; never edit
  `index.ts` (dirty; its runner wrapper `:612-619` explicitly lists fields — that's why early child-session
  linking is deferred), `context.json`, web files, or untracked lane dirs; hash-anchored edits.
- **Failure paths lose the child link** (`task.ts:171/:208`, `orchestrate.ts:470/:488`): settle is skipped →
  `UNVERIFIED` (honest). **P1 fix:** early `onSession` hook would need the dirty `index.ts:612-619` edit —
  deliberately out of P0.
- **`orchestrate.ts` writes jobs inline** (not via `finishJob`): easy to miss → the enforcement sweep test
  must exercise both chokepoints.
- **Two writers, one row:** all updates keep the existing `WHERE status='running'` guard → settle-once; a
  cancel/finish race can drop verification exactly like it already drops status (existing semantics).
- **Type breakage:** `Job` literals in tests (e.g. `orchestrate-cancel.test.ts:41`) must add the 3 fields —
  caught by `tsc`, test-only fix.
- **Class patterns:** bash matcher false-negatives fail **closed** (stay lower) — safe direction; `diagnose`
  is the preferred, precise source. Output truncation (`other.ts:231`, `bash.ts:36-38`) never touches
  `ok`/`exitCode`.
- **Fail-closed stickiness:** `FAILED_VERIFICATION` persists until the failed class is re-run and passes —
  intended; document in the task response so agents know to rerun `diagnose`.

---

**Report-back summary:** storage = **`jobs`** (+3 columns `verification_state`/`verification_evidence`
/`verification_updated_at`, `UNVERIFIED` backfill); chokepoint = **compute-then-single-`UPDATE` merged into
the two terminal writers** (`finishJob` `task.ts:87-96` + orchestrate `:482-491`), single module
`verification.ts`, agent claims have **no write path** (impossible, not merely marked); evidence =
**`EvidenceRef` reused unchanged** (kind `'message'` + `{check,ok}` extras, cap 8) parsed from
`persistToolResult` parts; event = **existing `job.updated` + `payload.kind='verification.state'`** (no new
union member); contradiction = **§13 text absent from the repo** (state names taken from the brief).
