---
name: testing-strategy
description: Test pyramid planning — unit core, integration seams, few e2e; fast deterministic suites.
triggers:
  - test strategy
  - test plan
  - coverage
  - integration tests
  - e2e
  - flaky
  - test suite
  - unit tests
---

# Testing Strategy

## Pyramid allocation
- **Unit (many)**: pure logic, edge cases, error paths. Milliseconds each.
- **Integration (some)**: real DB/HTTP at the seams — repository queries, route handlers.
- **E2E (few)**: critical user journeys only. Every e2e needs a maintenance budget.

## What to test (behavior, not implementation)
- Public contracts: inputs → outputs, error cases, boundary values (0, 1, max, empty).
- Regression tests for every bug fixed — the bug may not recur, but its cousins will.
- NOT private methods, NOT exact mock call sequences — those tests break on refactors.

## Suite health rules
- Deterministic: no sleeps, no real clocks (inject time), no network (stub it), seeded randomness.
- Isolated: any test order passes; tests clean their own state.
- Fast: >10s suite = people stop running it locally = bugs ship.
- Flaky test policy: fix or quarantine within a day — a red suite trains people to ignore red.

## Coverage honesty
Coverage measures execution, not assertion quality. 80% with weak asserts < 50% that
verifies behavior. Target: every branch of business logic has an asserting test.
