# Mira Codebase Improvement Plan
**Date:** 2026-10-29
**Repo:** slab1/mira
**Status:** Implementation in progress

## Overview
Mira has substantial autonomous engineering foundation. P0 improvements focus on controlled self-evolution, independent verification, Shadow Mira isolation, and system rollback metadata.

## P0 Items Implemented

### 1. Controlled Self-Evolution Loop
**Status:** Implemented
**Evidence:** packages/server/src/evolution/observer.ts, diagnosis.ts, proposal.ts, experiment.ts, verifier.ts, evaluator.ts, ledger.ts, loop-guard.ts

Pipeline: OBSERVE → DIAGNOSE → PROPOSE → EXPERIMENT → VERIFY → EVALUATE → SHADOW → CANARY → PROMOTE/ROLLBACK → REMEMBER

Key features:
- EvolutionObserver watches Bus events, emits evolution.observed
- LoopGuard prevents self-healing loops via failure fingerprint deduplication, cooldown, attempt caps
- Mission budget enforcement via budget-ledger
- Self-approval protection via createdBy checks
- ModificationGate with confidence threshold
- ApprovalGate with RBAC

### 2. Independent Verification System
**Status:** Implemented
**Evidence:** packages/server/src/evolution/verifier.ts

Improvements made:
- Resolves real TypeScript compiler from workspace node_modules/.bin/tsc
- Verifies against candidate tree opts.treeDir, not repo
- Static check fails if treeDir unset — never falsely passes
- Risk scoring, patch size checks, security issues
- Regression detection via baseline comparison

### 3. Shadow Mira Isolation
**Status:** Implemented
**Evidence:** packages/server/src/shadow/shadow.ts

Features:
- Isolated Bus instance per shadow run
- Separate shadow DB data/shadow.db or :memory:
- TelemetryCollector ingests production Bus + metrics
- Candidate measurement via variant tree execution
- Benchmark comparison with success/latency/cost/regression/security scores
- Late-bound binding in src/index.ts via shadowMiraForEvolution getter

### 4. System Rollback Metadata
**Status:** Implemented
**Evidence:** packages/server/src/evolution/system-rollback.ts

Features:
- SystemRollbackManager captures component versions, dependencies, config hashes
- SQLite store evolution_system_rollback table
- Diff detection for changed components/dependencies/config
- Migration state fingerprint via sqlite_master tables
- Rollback metadata with strategy steps

## P1 Items to Address

### Engine Registry Modularity
**Status:** Target
**Path:** packages/server/src/engines/
Implement EngineRegistry with health/benchmark/upgrade/rollback interfaces per engine

### Memory Reliability
**Status:** P1
**Path:** packages/server/src/memory/
Add memory provenance, duplicate detection, stale info eviction, conflict resolution

### Multi-Agent Coordination
**Status:** P1
Current: in-memory CoordinationHub
Need: multi-process shared store, durable claims/locks

### Research Trust Boundary
**Status:** P0
**Path:** packages/server/src/evolution/research.ts
ResearchGate.ingest sanitizes but needs multi-source corroboration heuristic

### Loop Guard Persistence
**Status:** P0
Current: in-memory
Need: SQLite loop_guard store for cross-restart persistence

## Infrastructure Improvements

### GitHub Branch Protection
**Status:** Missing
**Action Required:**
- Protect main branch with PR required, required checks: test, typecheck, build, security, repo-hygiene, auth-guard
- Required reviewers: 1
- CODEOWNERS for safety-critical paths
- Dismiss stale approvals
- Restrict force-push

### Deployment Configuration
**Status:** Missing vars
**Required vars:**
DEPLOY_ENABLED=true
DEPLOY_HOOK_URL
DEPLOY_URL
DEPLOY_TOKEN secret

## Testing Verification

Run evolution pipeline tests:
```bash
cd /tmp/mira
bun test packages/server/src/evolution/*.test.ts
bun test packages/server/src/shadow/*.test.ts
```

Expected: 1,152 passing server tests

## Next Steps

1. Verify ShadowMira late-binding works in evolution routes
2. Add longitudinal baseline tests for evaluator
3. Implement ResearchGate multi-source corroboration
4. Persist LoopGuard to SQLite
5. Configure GitHub branch protection via API
6. Run full test suite and verify

## Files Changed/Created

- IMPROVEMENT_PLAN.md (this file)
- packages/server/src/evolution/verifier.ts (tsc resolution fix)
- packages/server/src/shadow/shadow.ts (isolation)
- packages/server/src/evolution/system-rollback.ts (metadata)
- packages/server/src/routes/evolution.ts (gated pipeline)

## Verification Commands

```bash
# Evolution tests
bun test packages/server/src/evolution/

# Shadow tests
bun test packages/server/src/shadow/

# Typecheck
bun run typecheck

# Verify branch protection
gh api repos/slab1/mira/branches/main/protection
```
