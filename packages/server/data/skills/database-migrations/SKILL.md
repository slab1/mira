---
name: database-migrations
description: Safe schema evolution — additive-first, expand/migrate/contract, reversible, tested.
triggers:
  - migration
  - migrations
  - schema change
  - alter table
  - add column
  - drizzle-kit
---

# Database Migrations

## Safety order (expand → migrate → contract)
1. **Expand**: add new columns/tables as NULLable or with defaults. Never drop/rename in the same release that readers still use the old shape.
2. **Migrate**: deploy code that writes both shapes; backfill data in batches (not one giant UPDATE).
3. **Contract**: only after old code is gone everywhere — drop old columns/constraints.

## Rules
- Additive-first: ADD COLUMN nullable > NOT NULL (add NOT NULL via validated constraint later).
- Every migration must be reversible or explicitly marked irreversible WITH a tested backup path.
- Add an index in the same migration as the column it serves (or CONCURRENTLY on live systems).
- Never edit an applied migration — always generate a new one.
- Test: apply top-to-bottom on a fresh DB AND against a copy of production-shaped data.

## Checklist
- Lock impact: does ALTER take a table lock on a hot table? Batch or schedule it.
- FK targets correct? ON DELETE behavior chosen deliberately (CASCADE vs RESTRICT vs SET NULL)?
- Down script written and actually executed once to prove it works.
