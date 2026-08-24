---
name: refactor-safe
description: Behavior-preserving restructuring — tests first, one move at a time, revert freely.
triggers:
  - refactor
  - rename
  - extract method
  - extract function
  - cleanup
  - restructure
---

# Refactor Safe

## Preconditions
- Tests exist and are green. If not, characterize current behavior with tests FIRST.
- Refactors ship separately from features — never mix in one diff.

## Discipline
1. One refactoring move at a time (extract function, inline variable, rename).
2. Run tests after EVERY move. Green → next move. Red → revert the single move.
3. Prefer mechanical, reversible edits over clever rewrites.
4. Keep public APIs stable unless the task explicitly says otherwise.

## Common moves
- Extract pure logic from side-effectful code (makes it testable).
- Replace primitive obsession with domain types (`UserId`, not `string`).
- Collapse duplicated branches into table-driven code.
- Move mutation to edges; keep cores immutable.

## Stop conditions
- You're tempted to "also fix" behavior — stop, that's a feature change.
- Tests need mocking gymnastics after your change — reconsider the seam.
