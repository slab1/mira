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
