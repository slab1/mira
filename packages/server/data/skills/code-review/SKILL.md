---
name: code-review
description: Structured review pass — correctness, security, performance, style with severity-rated findings.
triggers:
  - review
  - code review
  - pr review
  - approve
  - look over my
  - check my diff
---

# Code Review

## Method

1. Read the diff hunks AND enough surrounding context (callers, tests).
2. Trace data flow: where does untrusted input enter? Where does it reach sinks?
3. Check the negative space: what should the tests cover but don't?

## Finding categories (in priority order)

- **Correctness**: logic errors, off-by-one, null/undefined paths, race conditions.
- **Security**: injection, authz gaps, secret leakage, unsafe deserialization.
- **Performance**: N+1 queries, unbounded loops, missing indexes, hot-path allocations.
- **Design**: leaky abstractions, duplicated knowledge, dead code.
- **Style**: only if conventions exist in the repo — cite them.

## Output format

For each finding: `[severity] file:line — problem — why it matters — suggested fix`.
Severities: critical (blocker), high, major, minor, nit.
End with verdict: APPROVE / REQUEST CHANGES / COMMENT.

## Rules

- Review the code, not the author. Every finding needs a rationale.
- Don't demand perfection — flag what actually matters for this change's scope.

## Mandatory coverage manifest

1. Start by calling `review_coverage` with `action: "generate"`; use the intended base ref and `headRef: "WORKTREE"` for the current checkout, including untracked files. If the base is unclear, identify it explicitly rather than silently reviewing only `HEAD^`.
2. Read the exact changed hunks with `review_coverage` `action: "diff"`, then inspect each changed file and every generated dependent/caller candidate. The graph is a partial candidate index, not proof that no other consumer exists.
3. Disposition every changed/dependent item and every required section (`changed_files`, callers/dependents, tool/event registrations, adapters/hooks, configuration/schema/migrations, expected tests, and analysis limitations). Use `inspected` with concrete evidence references, `tested` with evidence plus the command, or `not_applicable` with a specific reason. Never leave an item pending or mark an unknown as absent.
4. When graph coverage is partial, widen the search manually (including dynamic imports, non-source/config consumers, registrations, alternate writers, and migration consumers) and record the exact evidence in `analysis_limitations`.
5. Record each accepted finding through `review_coverage` `action: "finding"`. A fixed finding must map to a changed file and a passing regression test, or document why a test is not feasible. Other dispositions (not applicable, deferred, duplicate, not reproducible) require a rationale; duplicates must link to the prior finding.
6. Call `action: "finalize"` and include its manifest ID and state in the report. Do not claim complete coverage or approve while blockers remain. Summarize any unresolved or deferred findings and validation limits.
