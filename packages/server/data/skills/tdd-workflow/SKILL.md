---
name: tdd-workflow
description: Red-green-refactor loop — write the failing test first, then make it pass, then clean up.
triggers:
  - tdd
  - test-driven
  - failing test
  - red-green
  - write tests first
---

# TDD Workflow

## When to use
Any new feature, bug fix, or behavior change with verifiable outcomes.

## Loop
1. **Red** — write ONE small failing test that encodes the desired behavior.
   Run it. Confirm it fails for the expected reason (not a typo/import error).
2. **Green** — write the minimal production code to pass. No extra features.
3. **Refactor** — clean names, remove duplication; tests stay green.
4. Repeat with the next behavior.

## Rules
- Never write production code without a failing test demanding it.
- One behavior per test; name tests as specifications (`rejects_expired_token`).
- If fixing a bug: reproduce it as a failing regression test FIRST, then fix.
- Run the full suite before declaring done — green new test + no regressions.
- If a test is hard to write, the design is wrong — fix the seams, not the test.
