# Mira — Live Codebase Stage Cross-Check
**Review date:** 2026-10-13 (UTC)  
**Repository:** slab1/mira  
**Branch:** main  
**Scope:** Current commit, GitHub checks/release configuration, candidate governance, approvals, sandboxing, rollback, budgets, orchestration, and status documentation.

> **Resolution (2026-10-14):** the P0/P1 items raised here were implemented across
> `d4454bc`, `0ce8b03`, `9d7dd6e` and `b2b3cf3`. Two follow-up defects were found
> while verifying that work and are recorded in those commit messages: a missing
> `api_keys` migration that silently disabled all issued API keys (`b2b3cf3`), and
> a cross-tenant WebSocket event-fan-out leak (`9d7dd6e`). Unlisted items and the
> runtime/deployment verification gap below remain open.

---

## 1. Executive Verdict
**Stage:** engineering hardening; **not ready for unrestricted autonomous self-modification or production promotion.**

Mira has moved forward materially: the code now contains durable budget reservations, explicit sandbox profiles, candidate worktree materialization, candidate traffic routing/attribution, and a mission-budget implementation with targeted tests. But several important capabilities remain either unwired in production, unsafe in one route, or not independently verified.

The most urgent newly confirmed release-governance finding is that **GitHub reports main as not protected**, the repository's rulesets endpoint returned an empty list, and the current CD deploy job was skipped. CI passing is good evidence for code quality, but it is not equivalent to branch protection or a production smoke test.

---

## 2. Current Repository and CI State
- **Current main HEAD:** df1108d0342bfa960b95b04e68eb99a5bbb8b822, commit message: `feat(orchestration): mission-scoped budget that children cannot evade` (2026-10-13 02:59:46 UTC).
- The commit message reports 1,443 tests passing, 0 failing, with typecheck and lint clean; the GitHub CI workflow for this head also reports success.
- **CI:** Run 434 — success. Test, typecheck, build, repo-hygiene, auth-guard, and eval (PR fast) checks passed.
- **Security:** Run 442 — success. CodeQL, dependency audit, and secrets scan passed.
- **CD:** Run 434. Build, Docker, and release steps succeeded, but the **deploy job was skipped** because `.github/workflows/cd.yml` gates it on `vars.DEPLOY_ENABLED == 'true'`.
- **Branch governance:** GitHub's branch endpoint returned `protected: false`; the repository rulesets endpoint returned `[]`. This is direct evidence that no standard branch protection or repository ruleset was visible/configured at the time of this check.
- **Production state:** not verified. The CD workflow's production deploy did not run, so the green release result cannot be presented as proof that this revision is deployed or healthy.

---

## 3. Highest-Priority Findings (P0)

### P0 — main has no visible protection rules
**Evidence:** main branch metadata returned `protected: false`; repository rulesets returned an empty list.  
**Risk:** A direct push can bypass pull-request review and required checks. This undermines the safety controls being built into autonomous modification and release governance: passing CI does not help if changes can be pushed to main without those checks being required.  
**Required action:** Protect main with pull-request-only changes, required CI/security checks, required review (and CODEOWNERS review for safety-critical paths), stale-approval dismissal after new commits, conversation resolution, and restrictions on force-push/deletion and bypass. Confirm the rules by querying GitHub again after configuration.

### P0 — Approval endpoint can record a failed approval as verified
**Evidence:** `packages/server/src/routes/evolution.ts`, POST `/evolution/approve/:id`, calls `approvalGate.approve(id, identity)` but updates any pending ledger verdict to `verified` without checking `result.approved` or whether a result is authoritative.  
**Failure case:** The pending/decision maps in `packages/server/src/evolution/approval.ts` are in memory. After a restart, a still-pending ledger entry can remain while the gate no longer has its pending request. `approve()` then returns `approved: false`, but the route still writes `verified` to the ledger. A medium-risk mock result can also be `approved: true` but explicitly `authoritative: false`, which should not be recorded as a human-verified decision.  
**Required action:** Only update approval evidence/verdict when `result.approved === true` and `result.authoritative !== false`; otherwise preserve the pending/denied state and return a non-success response. Persist pending approvals and decisions. Add regression tests for lost in-memory state, unauthenticated calls, denied results, non-authoritative mock decisions, and restart/replay behavior.

### P0 — Self-approval protection lacks durable proposal authorship
**Evidence:** `proposalAuthor()` in `approval.ts` checks `author`, `by`, or `agent`. The `ImprovementProposal` interface and `propose()` output in `proposal.ts` do not define/populate an immutable creator/owner field.  
**Risk:** For ordinary proposals generated by the current proposal function, the self-approval check can have no author to compare with the authenticated approver. Authentication proves who clicked approve, but does not by itself prove independent approval authority.  
**Required action:** Store immutable `createdBy`/`origin` identity and source session/actor as part of the proposal or approval record. Enforce independent approver identity and a role/policy check for high-risk changes; persist the decision audit trail.

### P0 — Candidate governance is implemented in pieces but not wired end to end
**Evidence:** `createLearningSystem()` constructs `createGovernanceGate()` with `db`, `bus`, `rootDir`, and `onStagePass`. It does not supply a production `TrackerMeasurementSource`, executable `VariantWorkspace`, candidate router, or `CanaryRunner` dependencies. `GovernanceGate` defaults to `new CanaryRunner()` and `new UnavailableMeasurementSource()` when not injected. The latter intentionally returns no real baseline/candidate pair, which blocks promotion safely.  
The new `canary.ts`, `measurement.ts`, `attribution.ts`, and `variant.ts` provide useful foundations, but the production constructor does not connect them into one live pipeline. `canaryAttribution()` was found in implementation and tests, not wired as server request middleware in the reviewed production path. The evolution health endpoint itself still labels canary and shadow as target phases.  
**Risk:** The safeguard correctly refuses to promote without evidence, but normal candidate evaluation cannot yet complete end to end. Unit tests around the components do not establish that real production requests exercise the candidate tree or that telemetry is actually measuring the intended proposal.  
**Required action:** Wire a real disposable candidate workspace, real candidate-specific traffic routing/attribution, latency/error/SLO measurement, cleanup, and governance stage dependencies into the production learning/gateway startup path. Add an integration test that boots the actual server path, routes a request to a patched worktree, observes candidate-specific telemetry, passes/fails gates, and proves production files remain unchanged.

### P0 — Rollback is not yet a verified full-system recovery mechanism
**Evidence:** `packages/server/src/evolution/rollback.ts` restores file snapshots when available, but catches and ignores many restore errors. Database rollback is explicitly a placeholder; config rollback is also explicitly a placeholder. The separate `packages/server/src/patching/governance/rollback.ts` records/notifies rollback but does not itself restore source files. No post-rollback build/health verification is performed before returning success.  
**Risk:** Mira may record `rolledback` even if some changed files were not restored, and config/database/schema/runtime state can remain at the incompatible version.  
**Required action:** Use one coordinated rollback contract across governance and evolution; restore source/config/schema/dependencies as relevant; fail loudly on partial failure; retain a durable rollback journal; then run build, startup, health and key regression checks before reporting success. Exercise interrupted/partial rollback in integration tests.

---

## 4. Important P1 Integration and Operational Gaps

### P1 — New mission budget exists, but orchestrator does not enforce it yet
**Evidence:** `mission-budget.ts` and its tests implement shared counters, depth/retry/wall-clock/spend/tool-call caps, reserves, cancellation, and derived child budgets. But `tools/orchestrate.ts` still declares per-task `budgetSteps` and local limits. Its production `execute()` path does not import or call `MissionBudget`, `withAmbientMission`, `getAmbientMission`, admission, or charging functions; code search found the mission API in the module and tests, not in the orchestrator runtime path.  
**Risk:** The new unit tests validate the class, not production orchestration. Nested orchestrator calls can continue to use local task-count/concurrency caps instead of a shared mission-wide budget.  
**Required action:** Wire admission before each task spawn and retry, propagate a single derived budget to child orchestrations, charge actual cost/tool calls, enforce deadline/depth caps, and propagate cancellation. Test through `orchestrateTool.execute()` with nested calls rather than only testing `MissionBudget` in isolation.

### P1 — Durable budget reservations lack complete request lifecycle wiring
**Evidence:** `resources.ts` delegates to the durable ledger when the DB is available and exposes `settleReservation()` / `releaseReservation()`. The reviewed call sites do not pass a stable idempotency key to `checkBudget()` or settle/release the returned reservation after work completes. Search found the settle/release methods only at their definitions, not invoked by the production request lifecycle.  
**Risk:** Reserved amounts can remain reserved after completion/failure, slowly exhausting capacity; retries may not reuse the same reservation decision without a stable idempotency key.  
**Required action:** Capture reservation IDs in the request/job lifecycle, create stable keys from mission/task/proposal identity, settle with measured provider cost on completion, release only when work did not run, and reconcile stale reservations after process restart.

### P1 — Sandbox profiles do not automatically mean autonomous work is isolated
**Evidence:** `sandbox/isolation.ts` defines `trusted-local`, `restricted`, `isolated-experiment`, and `production`. `resolveProfile()` defaults to `trusted-local` if no explicit profile/config or `MIRA_SANDBOX=1` is set. The isolated profile correctly requires a container, but the default-selection function itself is not risk-aware.  
**Risk:** A caller that fails to explicitly request an isolated profile can execute under the local trusted profile. Safety depends on every autonomous/high-risk caller selecting the right profile.  
**Required action:** Make high-risk and autonomous experiment execution explicitly choose `isolated-experiment`; prohibit falling back to host execution when the container is missing; test the actual autonomous call path with no sandbox environment configured.

### P1 — CD does not currently prove production deployment or health
**Evidence:** CD workflow runs deploy only when `vars.DEPLOY_ENABLED == 'true'`. On the reviewed latest run, deploy was skipped. The health-check script also emits a warning rather than failing the job if the post-deploy health check does not pass.  
**Risk:** The repository can show green CI/CD while no production deployment occurred or health was never established.  
**Required action:** Decide and document the deployment target; configure deployment variables/secrets if production deployment is intended; make the production smoke/health check a hard gate; record the deployed SHA and environment result. Until then report production status as unverified/not deployed by this run.

---

## 5. Documentation Freshness
`docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md` is dated 2026-10-11, before the 2026-10-13 safeguards listed above. It correctly says it is a remediation plan, not an implementation record, but its orchestration and cost-accounting descriptions no longer fully reflect new code. Update it with distinct status labels:
- **Implemented:** code/component exists.
- **Unit-tested:** component tests pass.
- **Runtime-integrated:** production path invokes and enforces it.
- **Production-verified:** deployed SHA and smoke/health checks are confirmed.
- **Unverified:** integration, configuration, or production evidence is missing.

Do not change a risk to "resolved" merely because a module or unit test now exists.

---

## 6. Recommended Fix Order
1. **Immediately:** protect main; fix the approval route's false-verified path and persist approval decisions/authorship.
2. **Next:** wire candidate workspace/routing/measurement into production governance and add an end-to-end runtime integration test.
3. **Then:** unify rollback and verify restored state; enforce isolated execution for autonomous/high-risk tasks.
4. **Then:** integrate mission budgets into the actual orchestrator and close reservation settlement/idempotency/reconciliation.
5. **Before calling it production-ready:** configure and require deploy health checks, verify deployed SHA, run load/failure/recovery tests, and refresh the docs with evidence-backed statuses.

---

## 7. Final Assessment
The latest revision is a meaningful improvement and CI/Security checks are green. The key distinction is between **safety mechanisms present in source** and **mechanisms invoked on every real execution path**. The newest mission-budget module is not yet called by the production orchestrator; candidate canary/measurement pieces are not connected into the live governance constructor; approval can still stamp a denied result as verified; full rollback is not verified; and the branch/release path is not protected by visible GitHub rules.

**Current recommendation:** continue controlled engineering tests; do not enable unrestricted autonomous self-modification or claim production readiness until the P0 items are fixed and the actual runtime path plus deployment have been verified.

---

## Evidence Links
- Current main commit
- CI run 434
- Security run 442
- CD run 434
- Branch metadata
- Repository rulesets