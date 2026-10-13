# Mira — Long-Term Risk Mitigation and Scalability Plan

**Review date:** 2026-10-11
**Repository:** `slab1/mira`
**Review type:** Source-level architecture, safety, evolution, memory, and scalability review
**Status:** Engineering assessment — implementation and production verification remain separate states

> **This document is a remediation plan, not a record of completed work.**
> Nothing in it should be read as an implemented change or a verified capability.
> Section 16 records which claims were independently re-checked and which remain unverified.

## 1. Executive assessment

Mira has substantial infrastructure for an AI agent platform, including persistent sessions,
orchestration, tool permissions, memory, model routing, evaluation, observability,
self-improvement proposals, and rollback-related components.

The principal long-term risk is not a lack of features. It is the possibility that
individually useful components combine into a system that can make changes, consume
resources, retain incorrect knowledge, or promote a candidate without sufficiently
independent evidence.

**Immediate objective:** Make every safety-critical decision fail closed, ensure every
autonomous action is bounded and recoverable, and establish measurable acceptance criteria
before increasing autonomy.

## 2. Priority summary

| Priority | Risk                                             | Required outcome                                                    |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| P0       | Benchmark or canary passes without evidence      | Missing, invalid, or incomparable measurements block promotion      |
| P0       | Unsafe autonomous code execution                 | High-risk experiments require enforced isolation                    |
| P0       | Unverified promotion and weak release governance | Independent checks and protected release paths                      |
| P0       | Rollback cannot restore the complete system      | Versioned, tested recovery across every changed component           |
| P1       | Memory growth and contamination                  | Bounded retrieval, provenance, reversible retention, quality checks |
| P1       | Agent/task runaway and retry storms              | Aggregate budgets, cancellation, leases, idempotency                |
| P1       | Cost counters reset after restart                | Durable, atomic spend accounting                                    |
| P1       | Documentation overstates implementation          | Evidence-backed status for every major capability                   |
| P2       | Insufficient scale and resilience evidence       | Repeatable load, failure, recovery, and tenant-isolation tests      |

P0 items should be resolved before unrestricted autonomous self-modification or general
production promotion.

## 3. P0 — Make benchmark and canary governance fail closed

### Observed source-level issue

`packages/server/src/patching/governance/benchmark.ts` returns `passed: true` when the
latency tracker or required before/after measurements are absent.

`packages/server/src/patching/governance/canary.ts` also returns `passed: true` when no
latency tracker exists.

The default governance wiring in `packages/server/src/patching/governance/index.ts`
constructs runners without an injected tracker. This makes the default execution path
particularly important to test: a skipped measurement must never be interpreted as proof
of improvement.

### Required design

Use explicit outcomes:

- `PASSED`: all required evidence exists and meets policy.
- `FAILED`: evidence exists and demonstrates a regression or policy violation.
- `BLOCKED`: a required dependency or measurement is unavailable.
- `SKIPPED`: a stage was intentionally omitted and cannot authorize promotion.

Only `PASSED` can satisfy a required promotion gate.

### Required changes

1. Reject absent, empty, non-finite, stale, or invalid baseline and candidate measurements.
2. Validate that required metrics exist on both sides of the comparison.
3. Never replace missing measurements with zero and treat them as valid.
4. Require a candidate-specific evaluation, rather than using general process telemetry as
   proof that the candidate worked.
5. Make the canary lifecycle actually route the configured fraction of traffic to the
   candidate, observe it for the configured duration, and verify that enough candidate
   requests were sampled.
6. Require explicit SLOs and minimum sample counts for latency, errors, quality, and cost.
7. Persist measurement windows, sample counts, candidate version, baseline version,
   decision, and reasons.
8. Ensure all promotion routes enforce the same policy and cannot bypass the governance
   state machine.

### Acceptance tests

- No tracker → promotion blocked.
- No baseline → promotion blocked.
- Missing p95 or error-rate data → promotion blocked when required.
- NaN, Infinity, or malformed metrics → promotion blocked.
- Candidate regression → promotion rejected.
- Canary timeout or insufficient traffic → promotion blocked.
- Valid evidence with all required gates passing → eligible for promotion.
- Repeated promotion requests cannot bypass a failed or pending state.

## 4. P0 — Enforce isolation for autonomous experiments

`packages/server/src/sandbox/isolation.ts` supports Docker or Podman isolation, but the
sandbox is disabled by default. When disabled, the code can execute on the host and reports
`isolated: false`.

That fallback can be appropriate for trusted local development, but must not be silently
accepted for untrusted execution or autonomous self-modification.

### Required controls

1. Define execution profiles: trusted local, restricted tool execution, isolated
   experiment, and production deployment.
2. Require an isolated profile for untrusted code, dependency installation, and autonomous
   patch experiments.
3. Fail closed when the required runtime or isolation capability is unavailable.
4. Set container CPU, memory, process, disk, and wall-clock limits.
5. Keep production secrets, credentials, and host sockets outside the experiment environment.
6. Restrict network access by default and use an explicit allowlist when dependencies must
   be downloaded.
7. Mount source read-only for analysis; use a disposable, separately controlled worktree
   for patch experiments.
8. Record the effective isolation mode in the audit trail and reject a run if it does not
   match the requested policy.

### Acceptance tests

Verify that missing container runtime, disabled sandbox, timeout, network denial, and
resource exhaustion produce controlled failures without silently switching to unrestricted
host execution.

## 5. P0 — Make self-improvement independently verifiable

Use a strict lifecycle:

```
OBSERVE → DIAGNOSE → PROPOSE → ISOLATE → PATCH → VERIFY → EVALUATE → SHADOW → CANARY
        → PROMOTE OR ROLLBACK → RECORD
```

Each candidate must have a stable identifier and immutable evidence package containing:

- Parent commit and candidate commit.
- Exact diff and affected components.
- Dependency and configuration changes.
- Risk assessment and approval record.
- Unit, integration, regression, and security results.
- Baseline and candidate benchmark results.
- Cost and latency measurements.
- Canary traffic, duration, and sample count.
- Rollback instructions and verification outcome.

### Independence requirements

A candidate must not be allowed to rewrite the policy that approves that same candidate and
then approve itself under the new policy.

High-risk changes must require a real, authenticated human decision. A mocked approval
implementation must not be represented as production human approval.

Promotion should be a separate, auditable operation. Failed, blocked, or incomplete
evaluations must not be converted into successful states by retries or automatic expiry.

## 6. P0 — Protect release and rollback integrity

Configure branch protection or equivalent repository rules before permitting autonomous
code changes to reach the primary branch. _(Protection state could not be confirmed from
the review environment — see §16.)_

Require:

- Pull requests for self-modifying changes.
- Required tests, type checks, build checks, security checks, and relevant evaluations.
- Independent approval for high-risk changes.
- Dependency and secret scanning.
- A clear separation between code that proposes changes and code that authorizes promotion.

### System rollback

File restoration alone is insufficient when a release changes dependencies, configuration,
database schemas, prompts, permissions, or runtime versions.

Every release should have a versioned deployment manifest and a recovery plan that covers
all changed components. Database migrations must be reversible or have a tested
forward-recovery procedure.

Rollback must verify the restored version and health of the service. A rollback record must
not be considered successful merely because an exception was caught or a ledger entry was
updated.

### Acceptance tests

Exercise rollback after a failed canary, failed startup, database migration error, partial
deployment, and process restart. Confirm that the previous known-good version can be
restored and that the failure is visible in monitoring.

## 7. P1 — Scale memory without losing trust

Mira's provenance and eviction modules provide a foundation, but memory retention must
balance cost, relevance, freshness, and recoverability.

### Memory tiers

- **Working memory:** temporary context for the active task.
- **Episodic memory:** past interactions, events, and outcomes.
- **Semantic memory:** facts and knowledge with provenance.
- **Procedural memory:** verified workflows, skills, and strategies.
- **Evidence and audit records:** immutable or append-only decision evidence, subject to
  privacy and retention policy.

### Required memory policy

Every durable memory should have an owner or scope, source, creation time, confidence,
evidence, last verification time, and retention policy.

1. Deduplicate semantically similar memories.
2. Track contradictions and superseded facts explicitly.
3. Use provenance and freshness when ranking retrieval results.
4. Enforce per-task retrieval limits and context-token budgets.
5. Preserve verified critical knowledge and audit evidence from ordinary eviction.
6. Use dry-run eviction and reversible archival before permanent deletion.
7. Measure database size, index size, retrieval latency, embedding cost, and WAL growth.
8. Keep tenant-specific memory isolated and prevent cross-tenant retrieval.
9. Reconcile `docs/PROVENANCE_DESIGN.md` with the implementation in
   `packages/server/src/memory/provenance.ts`.

### Scale tests

Benchmark retrieval and writes with 10,000, 100,000, and 1,000,000 representative memories.
Measure p50/p95 latency, memory usage, storage growth, duplicate rate, stale-memory
retrieval, and correctness of tenant filtering.

These are proposed test sizes, not claims that Mira has already passed them.

## 8. P1 — Bound agent orchestration and recovery

The orchestration tool limits task count and parallelism, but local caps do not guarantee a
bounded overall mission.

Add aggregate controls across the entire task tree:

- Maximum nesting depth and total spawned agents.
- Shared token, monetary, wall-clock, and tool-call budgets.
- Maximum retries per node and per mission.
- Cancellation propagation to child tasks.
- Durable checkpoints and task leases.
- Idempotency keys for side-effecting actions.
- Bounded result payloads and context propagation.
- Queue backpressure and concurrency limits per tenant.
- Recovery for orphaned jobs after restart.

A task that exceeds its budget must stop or request approval. It must not spawn additional
tasks to evade its parent budget.

### Acceptance tests

Simulate cyclic plans, large DAGs, nested orchestration, provider timeouts, repeated
failures, worker termination, duplicate delivery, and cancellation during a running tool
call.

## 9. P1 — Make cost accounting durable

`packages/server/src/evolution/resources.ts` uses in-memory spend counters and documents
that these reset on process restart.

That is acceptable as an initial guardrail, but not as the authoritative budget for a
long-running autonomous platform.

Move authoritative accounting to durable storage. Reserve budget atomically before
expensive work, reconcile actual usage afterward, and make retries idempotent. Use tenant,
task, agent, mission, and daily limits.

When the budget service is unavailable, autonomous high-cost actions should stop rather than
assume that the budget is unlimited.

Monitor provider spend, tokens, retries, queue delay, task duration, and cost per successful
outcome. Add circuit breakers for repeated provider failures and cost spikes.

## 10. P1 — Keep learning from becoming self-reinforcing error

Use a controlled learning pipeline:

```
COLLECT → CAPTURE SOURCE → EXTRACT CLAIM → VERIFY → TEST → EVALUATE → APPROVE → STORE
```

Separate user statements, tool output, imported material, model-generated hypotheses, and
independently verified results.

A successful retrieval is not proof that a memory is true. A successful unit test is not
proof of overall quality. A model-generated explanation is not independent evidence.

Store failed strategies and their context when useful, so Mira does not repeatedly
rediscover or repeat them. Never allow low-confidence knowledge to silently become a trusted
procedural rule.

## 11. P1 — Make multi-tenant isolation an invariant

For every API, job, event, memory lookup, file operation, cache, and audit query, enforce
tenant and user authorization at the data boundary.

Test cross-tenant access explicitly. Do not rely solely on UI filtering or the assumption
that a caller supplies the correct project ID.

Separate credentials and secrets by scope, redact logs, define retention and deletion
policies, and audit privileged actions. High-risk permission changes require explicit
authorization and a recorded decision.

## 12. P1 — Align documentation with evidence

Use one consistent status vocabulary:

- **Proposed:** planned, not implemented.
- **Implemented:** code exists.
- **Integrated:** connected to the real application path.
- **Test-verified:** relevant tests pass in a recorded run.
- **Production-verified:** observed working under the intended deployment conditions.

A module existing is not sufficient evidence that the end-to-end feature works.

Maintain a capability register containing the status, implementation path, tests, known
limitations, owner, and last verification date. Update root documentation when a status
changes.

The README's reported test count should be linked to a reproducible CI run. Do not infer
production readiness from a test count alone.

## 13. Delivery roadmap

### Phase A — Safety blockers

- Fix benchmark and canary fail-open behavior.
- Audit every promotion entry point.
- Require evidence completeness and candidate-specific measurements.
- Enforce sandbox requirements for autonomous experiments.
- Protect `main` and require independent checks.
- Test actual rollback and human approval behavior.

**Exit criterion:** Missing evidence, failed checks, and unavailable safety dependencies
never result in promotion.

### Phase B — Reliability and cost

- Persist aggregate budget accounting.
- Add task leases, cancellation, idempotency, and restart recovery.
- Harden rollback across configuration, dependencies, and database changes.
- Add memory retention dry runs, recovery, and isolation tests.

**Exit criterion:** Fault injection and restart tests demonstrate bounded, recoverable
behavior.

### Phase C — Scalability

- Run memory and retrieval benchmarks at increasing data volumes.
- Load-test concurrent missions, queues, tool calls, and provider failures.
- Test tenant isolation under concurrency.
- Define service-level objectives and capacity thresholds.
- Measure cost per successful task and failure recovery time.

**Exit criterion:** Published results identify supported workloads, limits, and degradation
behavior.

### Phase D — Controlled production rollout

- Begin with human-approved releases.
- Use shadow evaluation before traffic exposure.
- Increase canary traffic only after evidence passes.
- Automatically stop or roll back on SLO violations.
- Expand autonomy only for capabilities that have passed the preceding stages.

**Exit criterion:** Each autonomy level has explicit permissions, budgets, evidence
requirements, and a tested recovery path.

## 14. Definition of done

Mira is ready for broader autonomous operation only when:

- Required evaluation gates fail closed.
- Candidate-specific benchmark and canary evidence is complete.
- The experiment environment enforces the intended isolation level.
- Human approvals are real, authenticated, and auditable where required.
- Budgets remain correct across retries and process restarts.
- Memory retention and tenant isolation have automated tests.
- Rollback restores a known-good system state and verifies health.
- CI checks are required for the release path.
- Documentation distinguishes implementation from verified operation.
- Load, fault-injection, and recovery results are recorded and reproducible.

## 15. Review evidence and limitations

Primary source files reviewed:

- `packages/server/src/patching/governance/benchmark.ts`
- `packages/server/src/patching/governance/canary.ts`
- `packages/server/src/patching/governance/index.ts`
- `packages/server/src/patching/governance/types.ts`
- `packages/server/src/evolution/risk.ts`
- `packages/server/src/evolution/approval.ts`
- `packages/server/src/evolution/resources.ts`
- `packages/server/src/evolution/rollback.ts`
- `packages/server/src/routes/evolution.ts`
- `packages/server/src/sandbox/isolation.ts`
- `packages/server/src/tools/orchestrate.ts`
- `packages/server/src/memory/provenance.ts`
- `packages/server/src/memory/eviction.ts`
- `docs/PROVENANCE_DESIGN.md`
- `MIRA_EVOLUTION_SPEC.md`
- `README.md`

This was a remote source review, not a local execution of the full test suite or a
production penetration test. The repository's reported test count and any declared feature
status require confirmation through the corresponding CI evidence and runtime tests.

## 16. Re-verification of key claims

Added 2026-10-13. The following load-bearing claims were independently re-checked against
the working tree. This is source inspection only — no acceptance test in this document has
been executed, and none of the P0 items are fixed.

| Claim                                             | Method                                             | Result                                                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `benchmark.ts` passes when tracker/stats absent   | Read `benchmark.ts:12-19`                          | **Confirmed** — `passed: true` with reason `benchmark skipped — no latency data available`                                                 |
| `canary.ts` passes when no tracker                | Read `canary.ts:11-17`                             | **Confirmed** — `passed: true` with reason `canary skipped — no latency tracker available`                                                 |
| Default governance wiring injects no tracker      | Read `governance/index.ts:69,73`                   | **Confirmed** — `deps.benchmark ?? new BenchmarkRunner()`, `deps.canary ?? new CanaryRunner()`; both constructors take an optional tracker |
| Sandbox disabled by default                       | Read `isolation.ts:41`                             | **Confirmed** — `enabled: config.enabled ?? process.env.MIRA_SANDBOX === '1'`                                                              |
| Spend counters are in-memory and reset on restart | Read `resources.ts:57-61` and header table row 10  | **Confirmed** — `Map`-based per-agent/per-mission spend; header documents "in-memory only; daily resets on process restart"                |
| `main` branch protection is disabled              | `gh api repos/slab1/mira/branches/main/protection` | **Unverified** — HTTP 403, token lacks scope. Must be checked with a properly scoped credential before relying on it.                      |

Not re-verified: every acceptance test, every scale-test figure, and the behavioural claims
about memory, orchestration bounds, tenant isolation, and release governance. Those remain
as stated in the original review.

## 17. Final recommendation

Prioritize correctness of the safety gates over adding more autonomy. A smaller Mira that
refuses unsafe or unverified changes is more valuable than a more autonomous Mira that can
mistake missing evidence for success.
