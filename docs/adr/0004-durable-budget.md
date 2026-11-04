# ADR-0004: Durable Budget Accounting

**Status:** ✅ Accepted  
**Date:** 2026-10-14  
**Author:** Mira Engineering Team  
**Related:** packages/server/src/evolution/durable-budget-store.ts, PR #4

---

## Context

Mira's autonomous self-improvement pipeline executes expensive operations:

- LLM API calls for code generation and review
- Benchmark runs comparing candidate vs baseline
- Canary deployments with real traffic
- Tool executions (code search, analysis, etc.)

### The Problem

The existing budget tracking in `packages/server/src/evolution/resources.ts` uses **in-memory counters** that reset on process restart:

```typescript
// BEFORE (in-memory only):
export class ResourceLimits {
  private spend: Record<string, number> = {}

  addSpend(key: string, amount: number): void {
    this.spend[key] = (this.spend[key] ?? 0) + amount
  }
}
// ❌ Counters reset when process restarts!
```

This creates a **critical safety gap**:

1. **Budget Reset on Restart:** Process crash/restart = budget starts at 0
2. **No Atomicity:** Race conditions between check and spend
3. **No Persistence:** Cannot survive server restarts
4. **No Tenant Isolation:** Shared budget across all tenants
5. **No Reconciliation:** Cannot verify actual vs tracked spend

### Safety Implications

Without durable budget accounting:

- **Runaway Costs:** Autonomous system could spend unlimited money after restart
- **Budget Bypass:** Race conditions could allow overspending
- **No Audit Trail:** Cannot verify what was spent and when
- **No Tenant Limits:** One tenant could exhaust shared budget
- **Violation of Fail-Closed:** Budget service unavailable → assume unlimited (fail-open)

---

## Decision

**Implement durable, atomic budget accounting with SQLite-backed storage:**

### 1. SQLite Storage

- ✅ **Atomic operations:** Reserves are atomic (check + deduct in one transaction)
- ✅ **Persistence:** Survives process restarts
- ✅ **Tenant isolation:** Per-tenant budget tracking
- ✅ **Queryable:** Can audit all spending
- ✅ **No external dependencies:** Uses Bun's built-in SQLite

### 2. Budget Types

- **Daily:** Resets at midnight UTC
- **Monthly:** Resets on the 1st of each month
- **Per-Tenant:** Configurable limits per tenant
- **Per-User:** Optional per-user limits
- **Per-Mission:** Budget for specific missions/tasks

### 3. Atomic Reservation System

```typescript
// Reserve budget before expensive work
const reservation = await budgetStore.reserve({
  tenantId: 'tenant-123',
  missionId: 'mission-456',
  amount: estimatedCost,
  description: 'LLM code generation',
})

if (!reservation.success) {
  // BLOCKED - cannot proceed
  throw new Error('BUDGET_EXCEEDED')
}

try {
  // Do expensive work
  await generateCode()

  // Reconcile actual cost
  await budgetStore.reconcile({
    reservationId: reservation.id,
    actualAmount: actualCost,
  })
} catch (error) {
  // Release reservation on failure
  await budgetStore.release(reservation.id)
  throw error
}
```

### 4. Fail-Closed Behavior

- ✅ **When budget service unavailable:** BLOCK (fail-closed)
- ✅ **When budget exceeded:** BLOCK (fail-closed)
- ✅ **When reservation fails:** BLOCK (fail-closed)
- ✅ **No assumptions:** Never assume budget is available

---

## Implementation

### Core Module: `packages/server/src/evolution/durable-budget-store.ts`

```typescript
export class DurableBudgetStore {
  private readonly db: MiraDB

  /**
   * Reserve budget atomically
   * Returns reservation ID on success, null on failure
   */
  async reserve(opts: {
    tenantId?: string
    missionId?: string
    agentId?: string
    amount: number
    description: string
    budgetType?: 'daily' | 'monthly' | 'mission'
  }): Promise<ReservationResult | null> {
    // Atomic transaction: check + reserve
    return this.db.sqlite.transaction(() => {
      // Check current usage
      const current = this.getCurrentUsage(opts)
      const limit = this.getBudgetLimit(opts)

      if (current + opts.amount > limit) {
        return null // BLOCKED
      }

      // Reserve atomically
      const reservationId = this.generateReservationId()
      this.createReservation({
        id: reservationId,
        tenantId: opts.tenantId,
        missionId: opts.missionId,
        amount: opts.amount,
        description: opts.description,
        status: 'reserved',
        createdAt: Date.now(),
      })

      return { success: true, id: reservationId }
    })()
  }

  /**
   * Reconcile actual cost against reservation
   */
  async reconcile(opts: { reservationId: string; actualAmount: number }): Promise<void> {
    this.db.sqlite
      .prepare('UPDATE budget_reservations SET actual_amount = ?, status = ? WHERE id = ?')
      .run(opts.actualAmount, 'reconciled', opts.reservationId)
  }

  /**
   * Release reservation (on failure)
   */
  async release(reservationId: string): Promise<void> {
    this.db.sqlite.prepare('DELETE FROM budget_reservations WHERE id = ?').run(reservationId)
  }

  /**
   * Get current budget usage
   */
  getCurrentUsage(opts: { tenantId?: string; missionId?: string }): number {
    // Sum all reconciled reservations for this budget period
  }

  /**
   * Get budget limit
   */
  getBudgetLimit(opts: { tenantId?: string; missionId?: string }): number {
    // From configuration or database
  }
}
```

### Database Schema

```typescript
// In packages/server/src/storage/db.ts migrate() function

// Budget reservations table
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS budget_reservations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT,
    mission_id TEXT,
    agent_id TEXT,
    amount REAL NOT NULL,
    actual_amount REAL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'reserved', -- reserved, reconciled, released
    budget_type TEXT NOT NULL DEFAULT 'daily', -- daily, monthly, mission
    created_at INTEGER NOT NULL,
    reconciled_at INTEGER,
    released_at INTEGER
  );
  
  CREATE INDEX IF NOT EXISTS budget_reservations_tenant_idx ON budget_reservations(tenant_id);
  CREATE INDEX IF NOT EXISTS budget_reservations_mission_idx ON budget_reservations(mission_id);
  CREATE INDEX IF NOT EXISTS budget_reservations_status_idx ON budget_reservations(status);
  CREATE INDEX IF NOT EXISTS budget_reservations_created_idx ON budget_reservations(created_at);
`)

// Budget limits table
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS budget_limits (
    id TEXT PRIMARY KEY,
    tenant_id TEXT,
    budget_type TEXT NOT NULL,
    limit_usd REAL NOT NULL,
    reset_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  
  CREATE INDEX IF NOT EXISTS budget_limits_tenant_type_idx ON budget_limits(tenant_id, budget_type);
`)
```

### Integration with Existing Code

```typescript
// packages/server/src/evolution/resources.ts
import { getBudgetStore } from './durable-budget-store.js'

export class ResourceLimits {
  private budgetStore: DurableBudgetStore

  constructor() {
    this.budgetStore = getBudgetStore()
  }

  async addSpend(key: string, amount: number): Promise<boolean> {
    // Use durable budget store instead of in-memory
    const result = await this.budgetStore.reserve({
      missionId: key,
      amount,
      description: `Resource spend: ${key}`,
    })

    return result !== null
  }

  async getSpend(key: string): Promise<number> {
    return this.budgetStore.getCurrentUsage({ missionId: key })
  }
}
```

---

## Consequences

### Positive

1. **Safety:** Budget survives process restarts
2. **Atomicity:** No race conditions between check and spend
3. **Audit Trail:** All spending is tracked and queryable
4. **Tenant Isolation:** Per-tenant budget limits
5. **Fail-Closed:** Budget unavailable = BLOCK (not assume unlimited)
6. **Reconciliation:** Actual vs estimated costs tracked

### Negative

1. **Complexity:** More complex than in-memory counters
2. **Performance:** SQLite operations add ~1-5ms overhead
3. **Storage:** Requires SQLite database
4. **Migration:** Existing deployments need schema migration

### Trade-offs

We accepted **complexity** and **performance overhead** in exchange for **safety and durability**. This is the correct choice because:

1. Budget tracking is a P0 safety requirement
2. 1-5ms overhead is negligible compared to LLM call latency
3. SQLite is already a dependency (no new external services)
4. The safety benefits far outweigh the complexity costs

---

## Verification

### Test Coverage

```bash
# Run durable budget tests
bun test packages/server/src/evolution/durable-budget-store.test.ts
```

### Specific Test Cases

- ✅ Atomic reservation (check + deduct in one transaction)
- ✅ Budget exceeded → reservation fails
- ✅ Reservation release on failure
- ✅ Budget reset on new period (daily/monthly)
- ✅ Tenant isolation (tenant A cannot use tenant B's budget)
- ✅ Reconciliation of actual vs estimated costs
- ✅ Fail-closed when budget service unavailable
- ✅ Concurrent reservations handled correctly

### Production Monitoring

```yaml
# Prometheus metrics
- mira_budget_reservations_total{status, tenant, budget_type}
- mira_budget_usage_usd{tenant, budget_type}
- mira_budget_limit_usd{tenant, budget_type}
- mira_budget_percentage_used{tenant, budget_type}
- mira_budget_reservation_duration_seconds
```

### Alerting Rules

```yaml
# Alert when budget exceeds thresholds
- alert: BudgetWarning
  expr: mira_budget_percentage_used > 80
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: 'Budget usage exceeds 80% for {{ $labels.tenant }}'

- alert: BudgetCritical
  expr: mira_budget_percentage_used > 95
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: 'Budget usage exceeds 95% for {{ $labels.tenant }}'

- alert: BudgetExceeded
  expr: mira_budget_percentage_used > 100
  labels:
    severity: critical
  annotations:
    summary: 'Budget exceeded for {{ $labels.tenant }}'
```

---

## Lifecycle

### Budget Periods

- **Daily:** Resets at 00:00 UTC
- **Monthly:** Resets at 00:00 UTC on the 1st of each month
- **Mission:** Persists until mission completion

### Reset Process

```typescript
// Called by scheduler at midnight UTC
async function resetDailyBudgets(): Promise<void> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Delete old reservations
  await db.sqlite
    .prepare('DELETE FROM budget_reservations WHERE budget_type = ? AND created_at < ?')
    .run('daily', today.getTime())

  // Reset budget limits
  await db.sqlite
    .prepare('UPDATE budget_limits SET reset_at = ? WHERE budget_type = ?')
    .run(today.getTime() + 24 * 60 * 60 * 1000, 'daily')
}
```

---

## Related Decisions

- [ADR-0001: Governance Gates Must Fail Closed](../adr/0001-governance-fail-closed.md) - Foundational safety
- [ADR-0002: Memory Provenance on ALL Memories](../adr/0002-memory-provenance.md) - Knowledge safety
- [ADR-0003: Branch Protection for Main](../adr/0003-branch-protection.md) - Release safety
- [ADR-0005: Complete Rollback System](../adr/0005-complete-rollback.md) - Recovery guarantee

---

## Amendments

None. This decision is foundational and should not be changed without a full safety review.

---

## Supersedes

- The in-memory budget tracking in `packages/server/src/evolution/resources.ts`
- The documented note that "counters reset on process restart" (now fixed)
