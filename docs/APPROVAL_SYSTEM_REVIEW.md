# Mira Approval System: Code Review and Recommended Setup

> **Status (2026-10-14):** this review is an open backlog, not a closed review.
> Sprint 1 items **1** (ledger updates only on confirmed authoritative approval),
> **2** (immutable `createdBy` proposal identity), **3** (approver capability
> enforced in the gate, not only in HTTP middleware), **4** (self-approval
> rejection), **5** (persisted pending requests/decisions) and **6** (atomic
> decision transitions + stale-request expiry) are now implemented. Sprint 1 item
> **7** has tests for failed/unauthorized/self/duplicate/expired approvals and
> restart survival, but not yet for a full hostile-caller matrix. All of Sprints
> 2-4 remain open — in particular nothing yet binds an approval to an artifact
> hash, and release governance is unbuilt.

**My recommendation is to make approval a central, persistent, role-based security control in Mira—not simply an API endpoint that records whether someone approved a proposal.**

I checked the current `slab1/mira` implementation, particularly the approval route, `ApprovalGate`, proposal model, and role system.

Mira already has useful foundations: authenticated approval identity, pending approval requests, an attempt to prevent self-approval, autonomy levels, and audit events. However, several important gaps remain before I would trust it to approve its own code changes or production deployments.

## 1. What is wrong with the current approval implementation?

The relevant code is in [`approval.ts`](https://github.com/slab1/mira/blob/main/packages/server/src/evolution/approval.ts), [`evolution.ts`](https://github.com/slab1/mira/blob/main/packages/server/src/routes/evolution.ts), and [`proposal.ts`](https://github.com/slab1/mira/blob/main/packages/server/src/evolution/proposal.ts).

| Priority | Finding | Why it matters |
|---|---|---|
| **P0** | Approval route can update the ledger even when approval fails | The route must never record an unsuccessful approval as verified. |
| **P0** | Proposal authorship is not reliably recorded | The self-approval check cannot reliably identify the proposal creator. |
| **P0** | Approval checks authentication, but the reviewed route does not enforce a dedicated approver role | An authenticated user should not automatically gain authority to approve risky changes. |
| **P0** | Pending and decided approvals are held in memory | A restart can lose pending requests and decision history held by the gate. |
| **P1** | The reviewed approval workflow does not provide a complete durable decision lifecycle | Approval, rejection, expiration, cancellation, and retries need consistent persisted states. |
| **P1** | Approval must be tied to the exact change being approved | A changed patch or deployment artifact must not inherit approval for an earlier version. |

The most urgent defect is in the route that handles `POST /evolution/approve/:id`. It calls the approval gate and subsequently updates the ledger when the existing verdict is pending, without first requiring `result.approved === true`.

The approval gate itself can correctly return `approved: false` when no pending request exists. The route must preserve that failure rather than turning it into a successful ledger state.

**This should be fixed before enabling autonomous self-modification or production promotion.**

---

# 2. The approval architecture I recommend for Mira

Use a dedicated approval service connected to Mira's existing policy engine, authentication, autonomy levels, database, and audit system.



The intended flow should be:

**Agent proposes → Risk classification → Policy evaluation → Approval decision → Isolated execution → Verification → Controlled promotion → Audit**

Every stage must enforce the decision made by the preceding stages.

### Step 1: Mira creates a proposal

Each proposal should contain:

- Unique proposal ID.
- Authenticated creator or initiating principal.
- Risk level and requested autonomy level.
- Explanation of the problem and proposed solution.
- Exact patch or artifact hash.
- Affected files, engines, tools, and services.
- Test, benchmark, security-scan, and canary evidence.
- Expected impact and possible failure modes.
- Resource budget and execution limits.
- Rollback strategy and verification criteria.
- Creation time, expiration time, and policy version.

The proposal creator must be stored as an immutable field. Mira should not infer authorship from optional fields that the current proposal generator does not populate.

### Step 2: The policy engine determines the required approval

The model must not decide for itself whether its proposed change needs human approval.

Instead, Mira's policy engine should evaluate the proposal using deterministic rules covering:

- Risk and potential impact.
- Whether the action is reversible.
- Requested permissions.
- Data sensitivity.
- Affected engine or service.
- Production versus development environment.
- Whether the action changes Mira's own security controls.
- Whether the proposal has sufficient verification evidence.

If the risk cannot be determined reliably, the approval policy should escalate to a stricter category or deny the operation.

### Step 3: An authorized person reviews the proposal

The reviewer should see the actual change, its risk, the evidence supporting it, and its rollback plan.

Approval must come from an authenticated identity with the necessary authority. Being able to log in to Mira should not automatically make someone an authorized approver.

### Step 4: Mira verifies the approval before execution

Before execution, Mira must confirm that:

1. The approval exists and was granted.
2. The approver was authorized for that risk level.
3. The approver was not the proposal's creator.
4. The approval has not expired or been revoked.
5. The proposal and artifact hashes still match.
6. The policy version and required evidence remain valid.
7. The execution request is within the approved scope.

If any condition fails, execution must stop.

### Step 5: Mira executes, verifies, and records the result

Approval is permission to execute a specific action—not proof that the action succeeded.

After execution, Mira must verify the outcome independently, record the evidence, and either retain the approved state, reject the change, or initiate rollback.

This separation between authorization and verification is essential for a self-improving agent.

---

# 3. Recommended approval levels

Mira already has autonomy levels. I recommend preserving that foundation and defining clear approval requirements for each category of action.

| Action category | Recommended approval | Execution policy |
|---|---|---|
| Read-only research and analysis | No human approval required | Follow existing access controls and logging rules. |
| Drafting code or documentation | No approval to draft | Keep the result as an uncommitted proposal. |
| Low-risk changes in an isolated workspace | Automated policy approval | Run tests and preserve rollback capability. |
| Changes to ordinary application code | One independent reviewer for protected-branch changes; runtime approval according to risk | Review the diff and require appropriate checks. |
| Changes to the agent's tools, orchestration, or permissions | Human approval | Execute in an isolated environment and verify behavior. |
| Changes to guardrails, authentication, security policy, or approval logic | Designated security or maintainer approval; two-person review where feasible | No autonomous promotion. Require security tests and explicit review. |
| Production deployment or configuration changes | Explicit authorized deployment approval | Deploy a specific verified artifact with health checks and rollback. |
| Database migrations or destructive operations | Explicit approval based on impact | Require backup, recovery plan, and post-operation verification. |
| Changes to the approval system itself | Independent approval and additional security review | The proposed change cannot weaken the controls that authorize it. |

**Important:** Code review approval and runtime approval are separate controls. A pull request being approved does not automatically authorize Mira to execute arbitrary actions at runtime.

For high-risk changes, a two-person rule is preferable. If you are the only available maintainer, Mira should keep such changes blocked until an independent reviewer is available, rather than allowing the agent or proposal creator to approve their own work.

---

# 4. Implement role-based approval authority

Mira already has the roles `viewer`, `operator`, and `admin` in [`roles.ts`](https://github.com/slab1/mira/blob/main/packages/server/src/auth/roles.ts).

Those roles are a useful starting point, but approval authority should be explicit.

I recommend the following model:

| Capability | Viewer | Operator | Admin | Designated approver |
|---|---:|---:|---:|---:|
| View proposals | Yes, subject to access scope | Yes | Yes | Yes |
| Create proposals | No | Yes, subject to policy | Yes | Yes |
| Approve ordinary low-risk changes | No | Only if explicitly authorized by policy | According to policy | Yes |
| Approve security-sensitive changes | No | No | Only if separately authorized | Yes, with the required security authority |
| Approve own proposal | No | No | No | No |
| Approve production deployment | No | No by default | Only with deployment authority | Yes, with deployment authority |
| Change approval policies | No | No | Restricted administrative operation | Restricted administrative operation |

The key is that **`admin` should not automatically mean unrestricted approval authority**.

An administrator might be able to manage users without being authorized to approve a particular production release. Model the approval capabilities separately, for example:

- `proposal.approve.low`
- `proposal.approve.medium`
- `proposal.approve.high`
- `security.change.approve`
- `deployment.approve`
- `approval.policy.manage`

Mira should derive these capabilities from trusted server-side identity and authorization records, never from request-body fields supplied by the caller.

---

# 5. Make approval persistent and resistant to replay

Mira should store approval requests and decisions in its database rather than relying solely on in-memory maps.

I recommend an approval record with fields similar to these:

| Field | Purpose |
|---|---|
| `approval_id` | Unique approval request identifier |
| `proposal_id` | Proposal being considered |
| `creator_id` | Original authenticated initiator |
| `approver_id` | Authenticated reviewer |
| `status` | Current approval state |
| `risk_level` | Risk classification at request time |
| `artifact_hash` | Exact change or artifact being approved |
| `policy_version` | Policy used to authorize the decision |
| `evidence_hash` | Reference to the reviewed verification evidence |
| `reason` | Required explanation for rejection; rationale for approval |
| `created_at` | Request creation time |
| `expires_at` | Approval expiration time |
| `decided_at` | Time of the decision |
| `executed_at` | Time execution began or completed |
| `idempotency_key` | Prevents duplicate processing |

### Use a strict state machine

The permitted transitions should be explicit:

`PENDING → APPROVED → EXECUTING → VERIFIED`

Alternative terminal paths:

- `PENDING → DENIED`
- `PENDING → EXPIRED`
- `PENDING → CANCELLED`
- `EXECUTING → FAILED`
- `EXECUTING → ROLLED_BACK`

A failed approval must not transition to `APPROVED` or `VERIFIED`.

Additional rules:

- Repeated requests must not create duplicate execution.
- A decided request cannot be silently changed by a retry.
- Expired requests must be rejected.
- A material change to the patch must invalidate the old approval.
- An approval decision and its audit record should be persisted atomically.
- If the database or authorization service is unavailable, high-risk operations must fail closed.

For Mira, I would also distinguish **approved**, **executed**, and **verified** in the ledger. They represent different facts.

---

# 6. Protect Mira's own approval system

This is especially important because Mira is intended to learn and improve itself.

A proposal that changes the approval service, role checks, policy engine, sandbox, guardrails, or deployment controls should automatically receive a higher risk classification.

The following restrictions should apply:

1. The model cannot grant itself additional approval privileges.
2. The model cannot change its own role or an approver's role.
3. The model cannot disable the approval gate and then use the disabled gate to authorize the same change.
4. The model cannot change the risk classification after approval to bypass the required review.
5. A change to the approved patch or deployment artifact invalidates the existing approval.
6. Missing benchmark, security, or canary evidence must not count as a passing result.
7. An approval cannot override an independent hard security prohibition.
8. The execution service must independently enforce the decision; hiding or disabling the approval UI must not bypass it.

I recommend separating the **policy that authorizes a change** from the **agent that proposes and executes it**. The agent may request an exception, but it must not be able to authorize that exception itself.

This is consistent with the governance principles in the NIST AI Risk Management Framework, which emphasizes accountable oversight, clearly defined responsibilities, and documented risk management. See the official [NIST AI RMF resources](https://airc.nist.gov/airmf-resources/) and [GOVERN playbook](https://airc.nist.gov/airmf-resources/playbook/govern/). [NIST SI Resource Center](https://airc.nist.gov/airmf-resources/?utm_source=chatgpt.com)

---

# 7. Separate GitHub code approval from Mira runtime approval

Mira needs both.

### A. GitHub approval

Configure repository rules for `main` to require:

- Pull requests instead of direct pushes.
- Required CI and security checks.
- At least one independent approving reviewer.
- Dismissal of stale approvals when new commits change the reviewed patch.
- Approval of the latest reviewable push by someone other than the person who pushed it.
- No force pushes or branch deletion.
- Restricted bypass permissions.
- Additional security-owner review for changes to approval logic, authentication, sandboxing, and guardrails where feasible.

GitHub documents these controls in its official guides to [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) and [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches). [GitHub Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets?utm_source=chatgpt.com)

### B. Mira runtime approval

Separately, Mira must enforce approval before it:

- Executes a high-risk tool action.
- Applies a sensitive self-modification.
- Changes security controls.
- Promotes a candidate into a live environment.
- Performs an approved production deployment.

A GitHub pull request approval is not a substitute for this runtime authorization.

---

# 8. Implementation order I recommend

I would implement the changes in the following order.

### Sprint 1 — Fix critical approval integrity issues

1. Update `POST /evolution/approve/:id` so the ledger changes only after confirmed, authoritative approval.
2. Add immutable proposal creator identity.
3. Enforce approver capabilities on the server.
4. Reject self-approval.
5. Persist pending requests and decisions.
6. Introduce explicit approval states and transactional transitions.
7. Add tests for failed approval, unauthorized users, self-approval, duplicate requests, restarts, and expired approvals.

**Acceptance condition:** No failed, unauthorized, stale, or self-issued approval can authorize execution or be recorded as a successful approval.

### Sprint 2 — Integrate approval with policy and autonomy

1. Define a centralized risk-to-approval policy.
2. Connect it to the existing autonomy levels and policy engine.
3. Require independent approval for high-risk changes.
4. Bind approval to the exact artifact hash and evidence.
5. Enforce approval in every execution and promotion path.
6. Ensure hard security policies cannot be overridden by ordinary approval.

**Acceptance condition:** Every sensitive operation is checked against the same server-side authorization policy, regardless of which route or agent initiates it.

### Sprint 3 — Build the operational workflow

1. Add a pending-approval queue.
2. Show reviewers the actual diff, risk assessment, evidence, scope, and rollback plan.
3. Support approve, deny, expire, cancel, and request-changes operations.
4. Record an append-only audit history.
5. Notify the appropriate reviewer when an approval is required.
6. Add execution monitoring, rollback verification, and alerts for failed recovery.

**Acceptance condition:** A reviewer can understand exactly what is being approved, and the system can prove which identity approved which artifact under which policy.

### Sprint 4 — Enforce release governance

1. Configure GitHub branch protection or repository rulesets.
2. Require the relevant CI and security checks.
3. Restrict production deployment credentials.
4. Require approval of the exact release artifact.
5. Run a post-deployment health check.
6. Verify rollback behavior through integration tests.

**Acceptance condition:** A green test run alone cannot authorize a release, and a successful deployment workflow cannot be mistaken for proof of production health.

---

## My final recommendation

Mira should use **risk-based human approval, role-based authorization, immutable proposal authorship, persistent approval records, artifact-bound decisions, and fail-closed execution gates**.

Do not implement approval as a simple Boolean such as `approved: true`. The system needs to know *who approved what, with which authority, under which policy, for which exact change, and whether execution was subsequently verified*.

I would prioritize the approval route's false-success condition and the missing reliable authorship/approver authorization checks before expanding Mira's autonomous capabilities.

**Next best step:** implement Sprint 1 first, with regression tests that prove a failed approval can never be recorded as verified. Then connect the approval gate to every high-risk execution and promotion path before enabling unrestricted self-modification.