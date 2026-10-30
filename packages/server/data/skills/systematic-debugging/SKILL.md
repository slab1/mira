---
name: systematic-debugging
description: Hypothesis-driven root cause investigation — reproduce, isolate, verify before fixing.
triggers:
  - debug
  - debugging
  - root cause
  - stack trace
  - bug
  - not working
  - crash
---

# Systematic Debugging

## Phase 1 — Understand
- Read the exact error. Reproduce it with the smallest possible input.
- Identify what changed recently (git log, diff) around the failure site.

## Phase 2 — Hypothesize
- Write 2-3 concrete hypotheses ("cache returns stale rows after update").
- Rank by likelihood × cheapness to test.

## Phase 3 — Isolate
- Test one hypothesis at a time with logs, breakpoints, or a minimal repro script.
- Binary-search the pipeline: comment out halves, dump intermediates.
- Do NOT fix anything yet — a fix without a proven cause is a guess.

## Phase 4 — Fix & Verify
- Fix the cause, not the symptom (validate inputs at the boundary, don't catch downstream).
- Add a regression test that fails before the fix and passes after.
- Re-run the full suite; check for the same class of bug elsewhere.

## Anti-patterns
- Shotgun changes ("try this, maybe it works").
- Fixing symptoms with try/catch or null checks over a real invariant violation.
