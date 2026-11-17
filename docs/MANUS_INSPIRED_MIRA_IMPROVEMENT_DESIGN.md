# Mira Improvement Design: Capable, Persistent, and Verifiable Agent Work

- **Status:** Proposed design; no application-code changes made
- **Repository basis:** `slab1/Mira`, reviewed at `48a70e83` on `fix/security-review-findings`
- **Intent:** Use Manus as a product-quality inspiration, not as a feature checklist or claim of exact parity.

## Executive proposal

Mira already has many important primitives: a model gateway, tool permissions, snapshots and undo, persistent sessions, child sessions, DAG orchestration, SQLite-backed jobs, memory, verification states, multiple clients, and evaluation infrastructure. The largest opportunity is not to add more isolated features. It is to make those pieces behave as one dependable end-to-end system.

Make a **Mission** the durable, cross-client unit of work. A Mission should retain its goal, plan, delegated jobs, progress, approvals, checkpoints, changed files, verification evidence, cost, and deliverables. A user should be able to start a task in one client, see what is happening, safely resume it in another, and tell the difference between completed, partially verified, blocked, and merely claimed work.

The design directly addresses the weaknesses observed during Mira’s review: missing a related code path, integration hooks failing late, unavailable checks being mistaken for validation, and losing context in long-running work. It also builds on Mira’s strengths: openness, local-first operation, provider choice, inspectable tools, memory, and undo.

## Product principles

1. **Outcome over feature count.** Optimize for safely finishing real user goals, not for a longer feature matrix.
2. **One durable work record.** Jobs, subagents, questions, approvals, checkpoints, evidence, and outputs belong to a Mission.
3. **Evidence before claims.** A model’s statement is not proof that a test ran, a change was reviewed, or a task succeeded.
4. **Resume safely.** Persist enough state to continue after a disconnect or restart without silently repeating external side effects.
5. **One contract across clients.** Web, TUI, VS Code, CLI, and Slack should show the same task state and pending action, subject to the same authorization.
6. **User control over scope.** Tool permissions, memory retention, sharing, budgets, and external actions should be understandable and reversible where possible.
7. **Degrade honestly.** Missing tools, skipped checks, unavailable runtimes, and incomplete evidence should be visible states, never implicit success.

## Product model: Mission

A Mission is a persistent goal and its auditable execution—not just a chat session or a background job. Reuse existing session/job records where practical, but expose one coherent Mission contract rather than creating a disconnected second system.

A Mission should contain:

- **Identity and scope:** mission ID, owner/org, workspace/project, originating client, authorization scope, base branch/commit, and creation/update times.
- **Goal and plan:** user objective, constraints, acceptance criteria, plan revisions, and which steps require human input.
- **Execution graph:** child tasks, dependencies, owner/lease, attempt and idempotency IDs, per-node limits, and terminal reason.
- **Current state:** `DRAFT`, `AWAITING_APPROVAL`, `QUEUED`, `RUNNING`, `NEEDS_INPUT`, `BLOCKED`, `VERIFYING`, `INTERRUPTED`, `COMPLETED`, `FAILED`, or `CANCELLED`. Define legal transitions centrally; do not let clients infer state from transient socket events.
- **Checkpoint:** structured objective, decisions, completed steps, current next step, blockers, changed files, and evidence references, anchored to a source-message or workspace hash.
- **Pending actions:** durable questions and action-bound permission requests with target, effect, expiry, and decision state.
- **Evidence and outputs:** validation manifest, review-coverage manifest, cost/latency, artifacts, links, and errors.

A Mission is **not** `COMPLETED` merely because an agent stopped or a job row says `completed`. Its terminal summary must state what was delivered, what was actually verified, what was skipped, and what remains unresolved.

## Target user journey

1. **Understand:** classify the request, identify workspace and constraints, and ask only for missing information that materially affects safety or outcome.
2. **Plan:** produce a short plan with acceptance criteria, risk, estimated resources, and possible approvals. Allow the user to edit it.
3. **Execute:** run a dependency-correct task graph with bounded concurrency, per-node and aggregate budgets, scoped permissions, and visible progress.
4. **Checkpoint:** persist state after meaningful work and before/after actions that may have external effects.
5. **Verify:** derive required checks from the diff and task type, run them on the exact candidate tree, and store status plus artifact identity.
6. **Deliver:** show a concise result and first-class deliverables, with the Mission ready to resume, export, or hand off.

Approval should be required for high-impact or irreversible actions, not routine low-risk steps. A disconnected client, expired request, or transport failure must never turn into an approval.

## Priority roadmap

### Phase 0 — Make control and truth consistent

**P0.1 — Unify job lifecycle and cancellation.** Move task jobs and orchestration DAG jobs behind one state-transition service for creation, controller registration, cancellation, event publication, and atomic settlement. Persist skipped and budget-denied DAG outcomes; ensure they cannot remain `running`. Preserve dependency order in every planner/fallback: dense graphs may reduce concurrency, but must not flatten dependent work into a parallel wave. Carry mission budgets explicitly per root/descendant tree, not through shared ambient mutable state. Add route-level tests for cancel-vs-complete races and tests that every settled graph has zero orphaned running rows.

**P0.2 — Adopt one evidence contract.** Standardize validation outcomes as `PASS`, `FAIL`, `BLOCKED`, and `SKIPPED` (with `NOT_RUN` where useful). Define which checks are required by affected package and risk surface. Bind every result to the exact candidate/base hash, command, runtime, exit status, timestamp, and retained output/artifact. Missing, stale, skipped, syntax-only, or unavailable checks must not count as behavioral verification. Reconcile advertised CI/evaluation tiers with the evaluator’s accepted tier names; reject invalid tier names rather than silently substituting a default. Add tests proving a required skipped check cannot produce an overall pass.

**P0.3 — Make review completeness explicit.** For code-review and remediation Missions, generate a coverage manifest from the diff: changed files, consequential callers/dependents, tool and event registrations, adapters/hooks, configuration, schemas/migrations, and expected tests. Track each item as inspected, tested, not applicable with reason, or unresolved. If graph or index coverage is incomplete, widen the review/test scope and say so. Require accepted findings to map to a code change or documented disposition and a regression test where feasible. Use mutation tests that deliberately omit an alternate writer, registration path, or migration consumer to measure whether the review gate catches omissions.

**P0.4 — Enforce memory boundaries before expanding sharing.** Apply explicit owner, org, project/workspace, and session scopes on memory writes, retrieval, graph expansion, import, and export. Legacy unscoped memories should be quarantined or migrated explicitly, not silently exposed across workspaces. Add cross-owner and cross-project retrieval tests. Provide user controls for memory off/ask/automatic, retention, export, correction, and forgetting.

**P0.5 — Reconcile claims with implementation.** Maintain a capability register with separate states such as designed, implemented, unit-tested, runtime-integrated, and production-verified. Generate or periodically audit status tables in docs; remove contradictions such as a design document that says both “implemented” and “pending.” Avoid “verified” in product copy unless the evidence contract supports it.

**Exit criteria:** route-level cancel works for task and DAG jobs; dense DAG tests preserve dependencies; no settled execution leaves a job running; required validations cannot pass when skipped or run on a different candidate; cross-scope memory tests show zero leakage; documentation distinguishes code presence from runtime/production evidence.

### Phase 1 — Make long work persistent and resumable

**P1.1 — Durable worker recovery.** Add queued/running/terminal job leases, heartbeat/expiry, attempt IDs, and startup reconciliation. At startup, every formerly running job must become safely resumable, interrupted, failed with a reason, or require user direction. Before retrying tools with external side effects, reconcile idempotency keys or ask the user. Keep the first implementation single-process if appropriate, while defining claims/leases so later workers cannot run the same job twice.

**P1.2 — Persist structured context checkpoints.** Extend compaction from an in-memory summary to a versioned checkpoint anchored to source messages and workspace state. Preserve objective, constraints, decisions, completed work, current next step, open questions, files changed, verification, and evidence refs. Keep the original transcript canonical and rebuildable. Evaluate on a fixed set of long coding/research tasks; target at least 95% recall of required facts and pending actions, while ensuring restart never repeats a completed side effect.

**P1.3 — Add replayable job progress.** Persist sequenced progress/checkpoint events and expose a cursor-based REST read. WebSocket events remain a low-latency hint, not the source of truth. Clients should fetch current Mission state after opening/reconnecting, then subscribe to later events.

### Phase 2 — Make the experience coherent across clients

**P2.1 — Shared Mission view.** Web, TUI, VS Code, CLI, and Slack should show the same goal, current phase, completed/blocked items, pending question/approval, changed files, and resume/cancel action. Map Slack threads to persistent sessions. Hydrate VS Code history on open. Let CLI list, inspect, resume, and cancel Missions. Test cross-client start → disconnect → continue journeys; require all surfaces to agree on current state and not replay completed work.

**P2.2 — Durable approval and clarification inbox.** Persist pending questions and tool permissions with action-bound IDs, expiry, exact target/effect, and state. Provide authenticated pending-action retrieval plus approve/deny/answer/defer APIs. Route the same readable prompt to each supported client. Keep live tool permission prompts distinct from administrative self-improvement approvals. Test stale IDs, cross-client decisions, denial, expiry, and client reconnect; only the action represented by the request may be approved.

**P2.3 — First-class deliverables.** Return a Mission artifact manifest containing label, type, safe workspace-relative path or URL, producing step, availability, and preview/download action. Present reports, changed files, test evidence, and exports separately from raw transcript. Slack should link to complete authorized content instead of truncating away key results; VS Code and CLI should expose the same artifact set. Enforce ownership, path containment, and link lifetime at the API boundary.

**P2.4 — Recoverable connector status.** Standardize error categories for Mira server reachability, authentication, provider quota, provider timeout, MCP handshake/configuration, and tool execution. Show likely cause and safe next action, preserve session context, and retry only when idempotent. Use contract fixtures across clients so a server error-envelope change cannot silently degrade to “done” or a blank response.

### Phase 3 — Earn more autonomy with representative evidence

Build a versioned holdout evaluation suite across coding, debugging, alternate integration paths, security, migrations, long-context recovery, approvals, and multi-client reconnect. Run baseline and candidate on the same isolated environment. Publish per-slice quality, regression, cost, latency, sample size, and uncertainty. Keep static safety checks separate from observed task success; never substitute a heuristic score for a benchmark. Promotion or self-improvement should require predeclared minimum samples and explicit non-regression gates. High-risk promotion remains a separate, auditable human decision.

## Quality measures

Track these as product metrics and release gates, not as decorative dashboard counters:

- **Truth:** 0 false `VERIFIED` states; 100% of claimed required checks resolve to evidence tied to the candidate hash.
- **Reliability:** 0 permanently running jobs after recovery; cancellation reaches signal-aware workers within the defined SLO; no duplicate external side effects in crash/retry tests.
- **Completeness:** every changed file and detected high-risk surface has an explicit review/validation disposition; report unresolved dynamic or graph blind spots.
- **Continuity:** cross-client and post-restart Missions reconstruct the same pending action and next step; no duplicated completed work.
- **Privacy:** 0 cross-owner/workspace memory retrievals; memory deletion remains effective after restart and index rebuild.
- **Usability:** users can find all listed deliverables and decide every pending approval from supported clients without digging through raw tool JSON.
- **Efficiency:** measure successful task completion, recovery time, cost, latency, user corrections, and safe-abort rate by task category; do not optimize cost at the expense of verification or privacy.

## Recommended first implementation slice

Start with **Phase 0.1 + Phase 0.2**: canonical job transitions/cancellation and an evidence-bound, tri-state verification contract. They address the clearest reliability and confidence risks and create the foundation needed for durable Missions. In the same slice, fix any confirmed CI/eval tier mismatch and add route-level regression tests. Follow with memory scope enforcement, then checkpoints and cross-client Mission APIs.

Do not begin by adding more autonomous behavior, marketplace integrations, or more model choices. First ensure every running task can be cancelled, recovered, understood, and honestly reported.

## Evidence boundaries and open decisions

This design is based on repository documentation and read-only static inspection at the commit listed above; no runtime behavior was exercised for this design. Several findings are call-path risks that need targeted tests before declaring production impact—especially concurrent mission-budget isolation and infrastructure not visible in the checked-in repository. Some project design/status documents are stale or contradictory and should be reconciled before treating their implementation claims as authoritative.

Before implementation, decide: the canonical Mission schema/API; retention for execution evidence and artifacts; which tool actions are idempotent; required validation policy by risk category; whether interrupted tasks auto-resume or await user direction; and which channels support rich approvals versus secure links to the Web inbox.
