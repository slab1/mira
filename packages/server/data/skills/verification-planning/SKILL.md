---
name: verification-planning
description: Plan verification evidence for non-trivial changes before implementation.
triggers:
  - verification plan
  - verify change
  - acceptance criteria
  - test plan
  - evidence path
---
# Verification Planning

## Purpose
Define *how* correctness will be proven before code is written. Avoid “trust me” changes.

## Plan template
- Change description: what is changing and why.
- Risk areas: where bugs hide.
- Evidence needed: tests, logs, metrics, manual checks.
- Success criteria: quantitative thresholds.
- Rollback plan: how to revert safely.

## Evidence types
- Unit tests: fast, isolated.
- Integration/E2E: real DB, real services.
- Observability: logs, traces, metrics.
- Manual checks: screenshots, API curls.
- Property checks: invariant tests, fuzzing.

## Process
1. Write plan before coding.
2. Get review sign-off.
3. Implement to satisfy criteria.
4. Record results as artifacts.
5. Close plan only when criteria met.

## Tips
- Prefer deterministic checks over eyeball.
- Capture before/after baselines.
- Keep plans small and auditable.
