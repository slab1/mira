# ADR-0001: Governance Gates Must Fail Closed

**Status:** ✅ Accepted  
**Date:** 2026-10-13  
**Author:** Mira Engineering Team  
**Related PR:** #4

---

## Context

During the initial review of Mira's autonomous self-improvement pipeline, a critical safety issue was discovered: the benchmark and canary governance gates contained **fail-open paths**. This meant that when required evidence (latency data, tracker availability, baseline measurements) was missing, the gates would return `passed: true` instead of blocking promotion.

### The Problem

In `packages/server/src/patching/governance/benchmark.ts`:

```typescript
// BEFORE (fail-open):
if (!tracker) {
  return { passed: true, ... } // ❌ Missing evidence counted as success!
}
if (!baseline) {
  return { passed: true, ... } // ❌ Missing baseline counted as success!
}
```

In `packages/server/src/patching/governance/canary.ts`:

```typescript
// BEFORE (fail-open):
if (!tracker) {
  return { passed: true, ... } // ❌ No tracker, but still "passed"!
}
```

This violated Mira's **core safety principle**: _Missing evidence must never count as proof of improvement._

### Why This Matters

1. **Safety Risk:** A candidate could be promoted without any actual evidence of improvement
2. **Violation of Fail-Closed Principle:** Safety-critical systems must fail closed (deny by default)
3. **Documentation Drift:** The `MIRA_EVOLUTION_SPEC.md` explicitly states fail-closed policy, but implementation didn't match
4. **Production Risk:** Could lead to regressions being deployed without detection

---

## Decision

**All governance gates must implement explicit fail-closed behavior using a strict outcome enum:**

```typescript
export type GovernanceOutcome = 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED'
```

**Only `PASSED` can satisfy a promotion gate.** All other outcomes (including missing evidence) must result in `BLOCKED`.

### Implementation

1. **Explicit Outcomes:** Every gate returns one of four explicit outcomes
2. **Evidence Completeness:** All required evidence must be present and valid
3. **Never Infer Success:** Missing measurements, trackers, or baselines → `BLOCKED`
4. **State Machine Enforcement:** Promotion only allowed from `CANARY_PASSED` state

### Changes Made

**commit `20b1ca4` (Oct 13, 2026):**

- ✅ `benchmark.ts`: Returns `BLOCKED` when tracker or baseline missing
- ✅ `canary.ts`: Returns `BLOCKED` when tracker unavailable
- ✅ `index.ts`: State machine enforces explicit outcomes
- ✅ All promotion paths verify evidence completeness

---

## Consequences

### Positive

1. **Safety Guaranteed:** No candidate can be promoted without complete evidence
2. **Fail-Closed Policy Enforced:** Missing evidence = blocked promotion
3. **Documentation Alignment:** Implementation now matches `MIRA_EVOLUTION_SPEC.md`
4. **Audit Trail:** All gate decisions are explicit and traceable
5. **Test Coverage:** 177 governance tests verify fail-closed behavior

### Negative

1. **Stricter Requirements:** Candidates must have complete evidence before promotion
2. **Potential Delays:** Missing metrics will block promotion (intentional)
3. **Testing Overhead:** Must verify all failure modes in tests

### Trade-offs

We accepted the trade-off of **potential delays** in exchange for **guaranteed safety**. This is the correct choice for an autonomous self-improvement system where the cost of a bad deployment far exceeds the cost of a delayed good deployment.

---

## Alternatives Considered

### 1. Fail-Open with Warnings (REJECTED)

- **Proposal:** Return `passed: true` with warnings when evidence missing
- **Rejection:** Violates fail-closed principle; warnings can be ignored
- **Risk:** Safety-critical decisions could be bypassed

### 2. Default to Previous State (REJECTED)

- **Proposal:** Use previous successful state when evidence missing
- **Rejection:** Stale evidence is not valid evidence
- **Risk:** Promotes candidates based on outdated information

### 3. Partial Evidence Scoring (REJECTED)

- **Proposal:** Score based on available evidence, pass if score > threshold
- **Rejection:** Allows promotion with incomplete evidence
- **Risk:** Creates incentive to game the scoring system

---

## Verification

### Test Coverage

```bash
# All governance tests verify fail-closed behavior
bun test packages/server/src/patching/governance/
# Result: 177 tests passing, 0 failures
```

### Specific Test Cases

- ✅ No tracker → promotion blocked
- ✅ No baseline → promotion blocked
- ✅ Missing p95/error-rate → promotion blocked
- ✅ NaN/Infinity metrics → promotion blocked
- ✅ Candidate regression → promotion rejected
- ✅ Canary timeout → promotion blocked
- ✅ Insufficient traffic → promotion blocked
- ✅ Valid evidence → eligible for promotion

### Production Monitoring

- Monitor `governance.gate.decision` metrics
- Alert on `BLOCKED` outcomes (expected)
- Alert on `PASSED` without complete evidence (should never happen)

---

## Related Decisions

- [ADR-0002: Memory Provenance on ALL Memories](../adr/0002-memory-provenance.md) - Extends fail-closed principle to memory system
- [ADR-0003: Branch Protection for Main](../adr/0003-branch-protection.md) - Prevents direct pushes to main
- [ADR-0004: Durable Budget Accounting](../adr/0004-durable-budget.md) - Ensures cost tracking survives restarts
- [ADR-0005: Complete Rollback System](../adr/0005-complete-rollback.md) - Guarantees recoverability

---

## Amendments

None. This decision is foundational and should not be changed without a full safety review.

---

## Supersedes

None. This is the first ADR in the governance safety series.
