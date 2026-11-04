# Mira Operations Runbook

**Version:** 1.0  
**Last Updated:** 2026-10-14  
**Maintainer:** Mira Engineering Team

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Common Issues](#common-issues)
3. [Governance Issues](#governance-issues)
4. [Memory Issues](#memory-issues)
5. [Budget Issues](#budget-issues)
6. [Rollback Procedures](#rollback-procedures)
7. [Performance Issues](#performance-issues)
8. [Security Incidents](#security-incidents)
9. [Monitoring & Alerts](#monitoring--alerts)
10. [Escalation Paths](#escalation-paths)

---

## 📊 Overview

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Mira AI Agent Platform                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   Server    │  │   Workers   │  │     Database (SQLite)    │ │
│  │  (Hono)     │  │  (Bun)      │  │  - Sessions             │ │
│  └──────┬──────┘  └──────┬──────┘  │  - Knowledge Entries     │ │
│         │                │          │  - Evolution Memory      │ │
│         └────────┬───────┘          │  - Cost Metrics          │ │
│                  │                  │  - Audit Entries          │ │
│         ┌────────▼───────┐          └─────────────────────────┘ │
│         │  Message Queue  │                                           │
│         │  (In-Memory)    │                                           │
│         └────────┬───────┘                                           │
│                  │                                                   │
│         ┌────────▼───────┐  ┌─────────────┐  ┌─────────────────┐   │
│         │   Tools        │  │  Sandbox    │  │   Memory        │   │
│         │  - memory       │  │  - Isolation │  │  - Knowledge    │   │
│         │  - orchestrate  │  │  - Docker    │  │  - Episodic     │   │
│         │  - findings     │  │  - Podman    │  │  - Semantic     │   │
│         │  - code         │  └─────────────┘  └─────────────────┘   │
│         └─────────────────┘                                          │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Learning System                           │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────┐ │ │
│  │  │  Online  │ │  Usage   │ │  Knowledge    │ │  Improvement  │ │ │
│  │  │  Learner │ │  Learner │ │  Base         │ │  Engine       │ │ │
│  │  └──────────┘ └──────────┘ └──────────────┘ └──────────────┘ │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Patching System                            │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │ │
│  │  │  Proposal     │ │  Governance   │ │  Rollback             │ │ │
│  │  │  Generator    │ │  Gate         │ │  Manager              │ │ │
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘ │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │ │
│  │  │  Benchmark    │ │  Canary       │ │  Variant Workspace    │ │ │
│  │  │  Runner       │ │  Runner       │ │  Manager              │ │ │
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Key Components

| Component  | Purpose            | Health Check         | Logs                     |
| ---------- | ------------------ | -------------------- | ------------------------ |
| Server     | HTTP API (Hono)    | `/health`            | `server.*`               |
| Database   | SQLite storage     | `/health/db`         | `database.*`             |
| Knowledge  | Memory system      | `/health/memory`     | `memory.*`, `learning.*` |
| Governance | Safety gates       | `/health/governance` | `governance.*`           |
| Sandbox    | Isolation          | N/A                  | `sandbox.*`              |
| Tools      | Agent capabilities | N/A                  | `tools.*`                |

---

## 🚨 Common Issues

---

### Issue: Governance Promotion Stuck

**Symptoms:**

- Promotion not progressing past `CANARY_PASSED`
- Governance state shows `CANARY_PASSED` but no promotion occurs
- `GET /governance/state` returns `CANARY_PASSED`

**Severity:** HIGH (blocks deployment pipeline)

**Diagnosis:**

```bash
# 1. Check governance state
curl http://localhost:3000/api/governance/state

# 2. Check canary metrics
curl http://localhost:3000/api/governance/canary/metrics

# 3. Check benchmark results
curl http://localhost:3000/api/governance/benchmark/results

# 4. Check governance logs
bun run logs:governance
```

**Common Causes:**

| Cause                | Check                     | Resolution                   |
| -------------------- | ------------------------- | ---------------------------- |
| Missing tracker      | `tracker` is null in logs | Start latency tracker        |
| No baseline          | `baseline` is null        | Run baseline benchmark first |
| Missing p95          | `p95Ms` not in metrics    | Configure metrics collection |
| Insufficient traffic | Canary traffic < minimum  | Increase canary traffic %    |
| SLO violation        | Error rate > threshold    | Fix the underlying issue     |
| State machine stuck  | State not advancing       | Restart governance service   |

**Resolution:**

```typescript
// 1. Verify all required evidence exists
const state = governance.getState()
const evidence = governance.getEvidence(state.proposalId)

if (!evidence.baseline || !evidence.candidate) {
  // Run missing benchmarks
  await benchmark.runBaseline()
  await benchmark.runCandidate()
}

// 2. Check if SLOs are met
const slos = governance.getSLOs()
if (evidence.errorRate > slos.maxErrorRate) {
  // SLO violation - fix the issue first
  throw new Error('SLO violation: error rate too high')
}

// 3. Force state transition (if safe)
// WARNING: Only do this if you're sure the evidence is complete
await governance.transitionTo('PROMOTED')
```

**Prevention:**

- Monitor `governance.gate.decision` metrics
- Alert on `BLOCKED` outcomes lasting > 1 hour
- Ensure tracker is always running

---

### Issue: Memory Retrieval Slow

**Symptoms:**

- High p95 latency on `memory_search`
- Slow response times for agent queries
- `GET /health/memory` shows degraded status

**Severity:** MEDIUM (degrades user experience)

**Diagnosis:**

```bash
# 1. Check memory system health
curl http://localhost:3000/api/health/memory

# 2. Check knowledge base size
curl http://localhost:3000/api/knowledge/count

# 3. Check database performance
sqlite3 data/mira.db "SELECT COUNT(*) FROM knowledge_entries"
sqlite3 data/mira.db "EXPLAIN QUERY PLAN SELECT * FROM knowledge_entries WHERE tier = 'semantic'"

# 4. Check memory usage
bun run logs:memory
```

**Common Causes:**

| Cause                | Check                                            | Resolution                     |
| -------------------- | ------------------------------------------------ | ------------------------------ |
| Large knowledge base | `SELECT COUNT(*) FROM knowledge_entries` > 10000 | Archive old entries            |
| Missing indexes      | `EXPLAIN QUERY PLAN` shows full table scan       | Add missing indexes            |
| High retrieval limit | `limit` > 20 in queries                          | Reduce default limit           |
| Slow embedding       | Keyword embedding taking too long                | Use real embeddings or cache   |
| Database locks       | Other queries blocking                           | Check for long-running queries |

**Resolution:**

```typescript
// 1. Check knowledge base size
const count = await knowledge.count()
if (count > 10000) {
  // Archive old entries
  await knowledge.archiveOldEntries(30) // Archive entries > 30 days
}

// 2. Add missing indexes (run migration)
await migrateDatabase()

// 3. Optimize queries
const results = await knowledge.retrieve({
  query: userQuery,
  limit: 10, // Reduce from default 20
  minScore: 0.3, // Increase from default 0.15
})

// 4. Use caching for frequent queries
const cache = new MemoryCache()
const cachedResults = await cache.getOrSet(`query:${userQuery}`, () =>
  knowledge.retrieve({ query: userQuery }),
)
```

**Prevention:**

- Monitor `memory.retrieval.latency` metrics
- Alert on p95 latency > 500ms
- Regularly vacuum SQLite database
- Set up retention policies

---

### Issue: Budget Exceeded

**Symptoms:**

- `BUDGET_EXCEEDED` errors in logs
- Requests being rejected with budget errors
- `GET /health` shows budget degraded/unhealthy

**Severity:** HIGH (blocks expensive operations)

**Diagnosis:**

```bash
# 1. Check budget status
curl http://localhost:3000/api/budget/status

# 2. Check daily spend
curl http://localhost:3000/api/budget/daily

# 3. Check cost metrics
curl http://localhost:3000/api/cost/summary

# 4. Check budget logs
bun run logs:budget
```

**Common Causes:**

| Cause                  | Check                              | Resolution                       |
| ---------------------- | ---------------------------------- | -------------------------------- |
| Daily budget exceeded  | `daily.usedUsd > daily.limitUsd`   | Wait for reset or increase limit |
| Tenant budget exceeded | `tenant.usedUsd > tenant.limitUsd` | Increase tenant limit            |
| Race condition         | Multiple requests at same time     | Use atomic reservations          |
| Budget not configured  | `limitUsd` is 0 or undefined       | Configure budget limits          |
| Cost tracking bug      | `costUsd` calculations wrong       | Audit cost calculations          |

**Resolution:**

```typescript
// 1. Check current budget status
const budgetStatus = await budgetStore.getBudgetStatus('daily')

if (budgetStatus?.exceeded) {
  // Budget exceeded - options:

  // Option A: Wait for reset (daily budgets reset at midnight UTC)
  const resetIn = budgetStatus.resetAt - Date.now()
  console.log(`Budget resets in ${Math.round(resetIn / 1000 / 60)} minutes`)

  // Option B: Increase limit (temporary)
  await budgetStore.setBudget('daily', budgetStatus.limitUsd * 2)

  // Option C: Use emergency budget (if configured)
  const emergencyBudget = await budgetStore.getBudgetStatus('emergency')
  if (emergencyBudget && !emergencyBudget.exceeded) {
    // Use emergency budget
  }
}

// 2. Verify cost calculations
const cost = costTracker.calculateCost('claude-3-5-sonnet', 1000, 500)
console.log(`Expected cost: $${cost.toFixed(4)}`)

// 3. Check for cost calculation bugs
const actualSpend = await costTracker.getSummary()
console.log(`Total spend: $${actualSpend.totalUsd.toFixed(2)}`)
```

**Prevention:**

- Monitor `budget.usage.percentage` metrics
- Alert on budget > 80% used
- Set up budget reset reminders
- Configure per-tenant limits

---

### Issue: Rollback Failed

**Symptoms:**

- Rollback returns `success: false`
- System remains in broken state after rollback
- `GET /health` shows degraded status

**Severity:** CRITICAL (system may be broken)

**Diagnosis:**

```bash
# 1. Check rollback status
curl http://localhost:3000/api/rollback/status

# 2. Check rollback logs
bun run logs:rollback

# 3. Check component verification
curl http://localhost:3000/api/rollback/verify

# 4. Check database state
sqlite3 data/mira.db "SELECT * FROM rollback_points ORDER BY created_at DESC LIMIT 1"
```

**Common Causes:**

| Cause                     | Check                           | Resolution                      |
| ------------------------- | ------------------------------- | ------------------------------- |
| File restore failed       | `files.verified = false`        | Check backup files exist        |
| Dependency restore failed | `dependencies.verified = false` | Check package.json backup       |
| Database rollback failed  | `database.verified = false`     | Check migration rollback SQL    |
| Runtime not healthy       | `runtime.verified = false`      | Check health endpoint           |
| Lock contention           | Multiple rollbacks in progress  | Wait for lock to release        |
| Backup missing            | Backup files not found          | Restore from alternative backup |

**Resolution:**

```typescript
// 1. Get last rollback attempt
const rollback = await rollbackManager.getLastRollback()

// 2. Check which components failed
const failedComponents = rollback.verification?.components
  .filter((c) => !c.verified)
  .map((c) => c.component)

if (failedComponents?.includes('files')) {
  // Files failed to restore - check backups
  for (const file of rollback.components.files ?? []) {
    if (!Bun.file(file.backupPath).exists()) {
      console.error(`Backup missing: ${file.backupPath}`)
      // Try to restore from alternative backup
      await restoreFromAlternativeBackup(file.path)
    }
  }
}

if (failedComponents?.includes('database')) {
  // Database rollback failed - check schema
  const currentSchema = await getCurrentSchema()
  const expectedSchema = rollback.components.database?.schemaChecksum

  if (currentSchema !== expectedSchema) {
    // Try manual rollback
    await manualDatabaseRollback(rollback.components.database)
  }
}

// 3. Retry rollback with force
const result = await rollbackManager.rollback(rollback.id, { force: true })

if (!result.success) {
  // Manual intervention required
  console.error('Rollback failed even with force. Manual intervention required.')
  console.error(
    'Failed components:',
    result.components.filter((c) => !c.verified).map((c) => `${c.component}: ${c.error}`),
  )
}
```

**Prevention:**

- Test rollback procedures regularly
- Verify backups exist before deployment
- Monitor rollback success rate
- Alert on rollback failures

---

### Issue: High Error Rate

**Symptoms:**

- Increased `5xx` responses
- High error rate in `GET /metrics`
- Users reporting failed requests

**Severity:** HIGH (affects user experience)

**Diagnosis:**

```bash
# 1. Check error metrics
curl http://localhost:3000/api/metrics | jq '.errors'

# 2. Check recent errors
curl http://localhost:3000/api/errors?limit=50

# 3. Check server logs
bun run logs:server --level=error

# 4. Check database errors
sqlite3 data/mira.db "SELECT * FROM audit_entries WHERE error IS NOT NULL ORDER BY created_at DESC LIMIT 20"
```

**Common Causes:**

| Cause               | Check                            | Resolution              |
| ------------------- | -------------------------------- | ----------------------- |
| Database connection | `database.error` in logs         | Check DB connectivity   |
| Rate limiting       | `429` responses                  | Increase rate limits    |
| Timeout             | `ETIMEDOUT` or `ESOCKETTIMEDOUT` | Increase timeout        |
| Memory pressure     | `JavaScript heap out of memory`  | Increase memory limit   |
| Dependency failure  | External API errors              | Check dependency status |
| Bug in code         | Specific error messages          | Fix the bug             |

**Resolution:**

```typescript
// 1. Check error patterns
const errors = await auditStore.getErrors({ limit: 100 })
const errorCounts = countBy(errors, 'error')

// 2. Handle specific error types
if (errorCounts['ECONNREFUSED'] > 0) {
  // Database connection issues
  await checkDatabaseConnection()
  await restartDatabase()
}

if (errorCounts['429'] > 0) {
  // Rate limiting
  await increaseRateLimits()
}

if (errorCounts['ETIMEDOUT'] > 0) {
  // Timeout issues
  await increaseTimeout(30000) // 30 seconds
}

if (errors.some((e) => e.error?.includes('heap out of memory'))) {
  // Memory pressure
  await increaseMemoryLimit('4g')
  await restartServer()
}

// 3. Check external dependencies
const health = await healthChecker.getHealth()
for (const check of health.checks) {
  if (check.status !== 'healthy') {
    console.error(`Unhealthy component: ${check.component}`)
    // Handle specific component
  }
}
```

**Prevention:**

- Monitor `error.rate` metrics
- Alert on error rate > 1%
- Implement circuit breakers
- Set up dependency health checks

---

## 🎯 Governance Issues

---

### Issue: Benchmark Returns BLOCKED

**Symptoms:**

- Benchmark gate returns `BLOCKED`
- Promotion stuck at `BENCHMARK_PASSED`
- `GET /governance/benchmark/status` shows `BLOCKED`

**Severity:** HIGH (blocks deployment)

**Diagnosis:**

```bash
# 1. Check benchmark status
curl http://localhost:3000/api/governance/benchmark/status

# 2. Check benchmark logs
bun run logs:benchmark

# 3. Check benchmark results
curl http://localhost:3000/api/governance/benchmark/results

# 4. Check latency tracker
curl http://localhost:3000/api/latency/tracker
```

**Common Causes:**

| Cause                    | Check                             | Resolution                 |
| ------------------------ | --------------------------------- | -------------------------- |
| No tracker               | `tracker` is null                 | Start latency tracker      |
| No baseline              | `baseline` is null                | Run baseline benchmark     |
| No candidate             | `candidate` is null               | Run candidate benchmark    |
| Invalid metrics          | NaN, Infinity, or negative values | Fix metrics collection     |
| Missing required metrics | p95, errorRate not present        | Configure required metrics |
| Benchmark timeout        | Benchmark taking too long         | Increase timeout           |

**Resolution:**

```typescript
// 1. Check if tracker is running
const tracker = getLatencyTracker()
if (!tracker) {
  // Start tracker
  startLatencyTracker()
}

// 2. Check if baseline exists
const baseline = await benchmark.getBaseline()
if (!baseline) {
  // Run baseline
  await benchmark.runBaseline()
}

// 3. Check if candidate exists
const candidate = await benchmark.getCandidate()
if (!candidate) {
  // Run candidate benchmark
  await benchmark.runCandidate()
}

// 4. Check for invalid metrics
const results = await benchmark.getResults()
if (results.some((r) => !Number.isFinite(r.value))) {
  // Fix metrics collection
  await fixMetricsCollection()
}

// 5. Re-run benchmark
const result = await benchmark.run()
if (result.outcome === 'BLOCKED') {
  console.error('Benchmark still blocked:', result.reason)
}
```

---

### Issue: Canary Returns BLOCKED

**Symptoms:**

- Canary gate returns `BLOCKED`
- Promotion stuck at `CANARY_PASSED`
- `GET /governance/canary/status` shows `BLOCKED`

**Severity:** HIGH (blocks deployment)

**Diagnosis:**

```bash
# 1. Check canary status
curl http://localhost:3000/api/governance/canary/status

# 2. Check canary metrics
curl http://localhost:3000/api/governance/canary/metrics

# 3. Check canary logs
bun run logs:canary

# 4. Check traffic routing
curl http://localhost:3000/api/traffic/status
```

**Common Causes:**

| Cause                | Check                     | Resolution               |
| -------------------- | ------------------------- | ------------------------ |
| No tracker           | `tracker` is null         | Start latency tracker    |
| Insufficient traffic | Traffic % < minimum       | Increase canary traffic  |
| Insufficient samples | Sample count < minimum    | Wait for more requests   |
| SLO violation        | Error rate > threshold    | Fix the underlying issue |
| Canary timeout       | Canary duration exceeded  | Increase timeout         |
| No candidate version | Candidate version not set | Set candidate version    |

**Resolution:**

```typescript
// 1. Check canary configuration
const config = await canary.getConfig()
console.log('Canary config:', config)

// 2. Check traffic percentage
const traffic = await canary.getTrafficPercentage()
if (traffic < config.minTrafficPercentage) {
  // Increase traffic
  await canary.setTrafficPercentage(config.minTrafficPercentage)
}

// 3. Check sample count
const metrics = await canary.getMetrics()
if (metrics.sampleCount < config.minSampleCount) {
  // Wait for more samples
  console.log(
    `Waiting for more samples. Current: ${metrics.sampleCount}, Required: ${config.minSampleCount}`,
  )
}

// 4. Check SLOs
const slos = await canary.getSLOs()
if (metrics.errorRate > slos.maxErrorRate) {
  // SLO violation - investigate and fix
  console.error(`Error rate ${metrics.errorRate} exceeds max ${slos.maxErrorRate}`)
  await investigateErrors()
}

// 5. Check latency
if (metrics.p95 > slos.maxLatencyMs) {
  // Latency too high
  console.error(`p95 latency ${metrics.p95}ms exceeds max ${slos.maxLatencyMs}ms`)
  await investigateLatency()
}

// 6. Re-run canary
const result = await canary.run()
if (result.outcome === 'BLOCKED') {
  console.error('Canary still blocked:', result.reason)
}
```

---

## 🧠 Memory Issues

---

### Issue: Knowledge Base Not Loading

**Symptoms:**

- Empty knowledge base
- `GET /knowledge/count` returns 0
- Memory searches return no results

**Severity:** MEDIUM (degrades agent capabilities)

**Diagnosis:**

```bash
# 1. Check knowledge base status
curl http://localhost:3000/api/knowledge/status

# 2. Check knowledge logs
bun run logs:knowledge

# 3. Check database
sqlite3 data/mira.db "SELECT COUNT(*) FROM knowledge_entries"

# 4. Check knowledge directory
ls -la data/memory/aether/
```

**Common Causes:**

| Cause                 | Check                    | Resolution              |
| --------------------- | ------------------------ | ----------------------- |
| Database not migrated | Missing columns          | Run migration           |
| Database file missing | `data/mira.db` not found | Restore from backup     |
| Database corrupted    | SQLite errors            | Restore from backup     |
| Load error            | Error in `load()` method | Check for syntax errors |
| Permission issues     | File access denied       | Fix file permissions    |

**Resolution:**

```typescript
// 1. Check if database exists
const dbPath = process.env.MIRA_DB ?? './data/mira.db'
if (!Bun.file(dbPath).exists()) {
  // Create new database
  await createDatabase(dbPath)
  await migrateDatabase()
}

// 2. Check if migration is needed
const needsMigration = await checkMigrationNeeded()
if (needsMigration) {
  await migrateDatabase()
}

// 3. Try reloading knowledge base
const knowledge = getKnowledgeBase()
try {
  await knowledge.load()
  console.log(`Loaded ${knowledge.size()} entries`)
} catch (error) {
  console.error('Failed to load knowledge base:', error)

  // Try with fresh database
  await knowledge.load({ force: true })
}

// 4. Check for specific errors
const logs = await getLogs({ context: 'knowledge', level: 'error' })
for (const log of logs) {
  if (log.message.includes('no such column')) {
    // Missing column - run migration
    await migrateDatabase()
  }
}
```

---

### Issue: Memory Provenance Missing

**Symptoms:**

- Memories without provenance fields
- `SELECT COUNT(*) FROM knowledge_entries WHERE provenance IS NULL` > 0
- Provenance tests failing

**Severity:** HIGH (safety issue)

**Diagnosis:**

```bash
# 1. Check for NULL provenance
sqlite3 data/mira.db "SELECT COUNT(*) FROM knowledge_entries WHERE provenance IS NULL"
sqlite3 data/mira.db "SELECT COUNT(*) FROM knowledge_entries WHERE confidence IS NULL"
sqlite3 data/mira.db "SELECT COUNT(*) FROM knowledge_entries WHERE source_kind IS NULL"

# 2. Check provenance logs
bun run logs:provenance

# 3. Run provenance tests
bun test packages/server/src/memory/provenance.test.ts
```

**Common Causes:**

| Cause            | Check                          | Resolution      |
| ---------------- | ------------------------------ | --------------- |
| Old database     | Missing provenance columns     | Run migration   |
| Migration failed | Columns exist but NULL         | Run backfill    |
| Direct INSERT    | Bypassed normalization         | Use ORM methods |
| Legacy data      | Old entries without provenance | Run backfill    |

**Resolution:**

```typescript
// 1. Check if provenance columns exist
const columns = await getDatabaseColumns('knowledge_entries')
const missingColumns = [
  'provenance',
  'confidence',
  'source_kind',
  'source_ref',
  'created_by',
  'evidence',
  'derived_from',
  'last_verified_at',
].filter((col) => !columns.includes(col))

if (missingColumns.length > 0) {
  // Run migration
  await migrateDatabase()
}

// 2. Run backfill for NULL values
const db = getDatabase()
await db.sqlite.exec(
  `UPDATE knowledge_entries SET provenance = 'unverified' WHERE provenance IS NULL`,
)
await db.sqlite.exec(`UPDATE knowledge_entries SET confidence = 0.2 WHERE confidence IS NULL`)
await db.sqlite.exec(
  `UPDATE knowledge_entries SET source_kind = 'unknown' WHERE source_kind IS NULL`,
)
await db.sqlite.exec(`UPDATE knowledge_entries SET created_by = 'legacy' WHERE created_by IS NULL`)
await db.sqlite.exec(`UPDATE knowledge_entries SET evidence = '[]' WHERE evidence IS NULL`)
await db.sqlite.exec(`UPDATE knowledge_entries SET derived_from = '[]' WHERE derived_from IS NULL`)

// 3. Verify backfill
const nullCount = (await db.sqlite
  .prepare(
    `
    SELECT COUNT(*) as c FROM knowledge_entries 
    WHERE provenance IS NULL 
       OR confidence IS NULL 
       OR source_kind IS NULL 
       OR created_by IS NULL
  `,
  )
  .get()) as { c: number }

if (nullCount.c > 0) {
  console.error(`Still have ${nullCount.c} entries with NULL provenance`)
  // Investigate specific entries
  const nullEntries = await db.sqlite
    .prepare(
      `
      SELECT id FROM knowledge_entries 
      WHERE provenance IS NULL 
         OR confidence IS NULL 
         OR source_kind IS NULL 
         OR created_by IS NULL
      LIMIT 10
    `,
    )
    .all()
  console.log('Sample NULL entries:', nullEntries)
}

// 4. Run provenance tests
const result = await runTests('packages/server/src/memory/provenance.test.ts')
if (!result.passed) {
  console.error('Provenance tests failed:', result.failures)
}
```

---

## 💰 Budget Issues

---

### Issue: Budget Service Unavailable

**Symptoms:**

- `BUDGET_SERVICE_UNAVAILABLE` errors
- All expensive operations blocked
- `GET /health` shows budget unhealthy

**Severity:** HIGH (blocks operations)

**Diagnosis:**

```bash
# 1. Check budget health
curl http://localhost:3000/api/health | jq '.checks[] | select(.component == "budget")'

# 2. Check budget logs
bun run logs:budget --level=error

# 3. Check database connectivity
curl http://localhost:3000/api/health/db

# 4. Check budget database
sqlite3 data/mira.db "SELECT COUNT(*) FROM budget_reservations"
```

**Common Causes:**

| Cause                | Check                        | Resolution            |
| -------------------- | ---------------------------- | --------------------- |
| Database connection  | DB health check fails        | Check DB connectivity |
| Database migration   | Missing budget tables        | Run migration         |
| Budget service crash | Service not responding       | Restart service       |
| Lock contention      | Lock held by another process | Wait or force unlock  |
| Permission issues    | File access denied           | Fix file permissions  |

**Resolution:**

```typescript
// 1. Check database connectivity
const dbHealth = await healthChecker.checkDatabase()
if (dbHealth.status !== 'healthy') {
  // Database issue - fix first
  await fixDatabaseConnectivity()
}

// 2. Check if budget tables exist
const tables = await getDatabaseTables()
const missingTables = ['budget_reservations', 'budget_limits'].filter((t) => !tables.includes(t))

if (missingTables.length > 0) {
  // Run migration
  await migrateDatabase()
}

// 3. Restart budget service
const budgetService = getBudgetService()
try {
  await budgetService.restart()
} catch (error) {
  console.error('Failed to restart budget service:', error)
}

// 4. Check for lock contention
const lockStatus = await budgetService.getLockStatus()
if (lockStatus.locked) {
  // Check lock age
  const lockAge = Date.now() - lockStatus.lockedAt
  if (lockAge > 300000) {
    // 5 minutes
    // Force unlock (dangerous - only in emergency)
    await budgetService.forceUnlock()
  } else {
    // Wait for lock to release
    console.log(`Waiting for lock to release (age: ${lockAge}ms)`)
  }
}

// 5. Verify budget service is working
const testReservation = await budgetService.reserve({
  amount: 0.01,
  description: 'Health check',
})

if (!testReservation) {
  console.error('Budget service still unavailable')
} else {
  await budgetService.release(testReservation.id)
  console.log('Budget service is working')
}
```

---

## 🔄 Rollback Procedures

---

### Standard Rollback Procedure

**When to use:** Failed canary, failed benchmark, deployment issues

**Steps:**

```bash
# 1. Identify the issue
curl http://localhost:3000/api/governance/state
curl http://localhost:3000/api/health

# 2. Check if rollback is needed
curl http://localhost:3000/api/rollback/needed

# 3. Get available rollback points
curl http://localhost:3000/api/rollback/points

# 4. Trigger rollback (replace ROLLBACK_ID)
curl -X POST http://localhost:3000/api/rollback/ROLLBACK_ID

# 5. Monitor rollback progress
curl http://localhost:3000/api/rollback/status

# 6. Verify rollback
curl http://localhost:3000/api/health
curl http://localhost:3000/api/governance/state
```

**Expected Output:**

```json
{
  "success": true,
  "components": [
    { "component": "files", "verified": true },
    { "component": "dependencies", "verified": true },
    { "component": "config", "verified": true },
    { "component": "database", "verified": true },
    { "component": "runtime", "verified": true }
  ],
  "durationMs": 2456,
  "verifiedAt": 1700000000000
}
```

---

### Emergency Rollback Procedure

**When to use:** Production outage, critical failure

**Steps:**

```bash
# 1. Stop traffic to affected service
curl -X POST http://localhost:3000/api/traffic/stop

# 2. Identify last known good rollback point
curl http://localhost:3000/api/rollback/points | jq 'sort_by(.createdAt) | reverse | .[0]'

# 3. Execute emergency rollback with force
curl -X POST http://localhost:3000/api/rollback/ROLLBACK_ID -d '{"force":true}'

# 4. Verify system health
curl http://localhost:3000/api/health

# 5. Resume traffic
curl -X POST http://localhost:3000/api/traffic/start

# 6. Notify stakeholders
# (Manual step - use Slack/email/pager)
```

**Escalation:** If rollback fails, follow [Break Glass Procedure](#break-glass-procedure)

---

### Break Glass Procedure

**When to use:** All other procedures failed, system is down

**Requirements:**

- 2+ admin approvals (via Slack/email)
- Time limit: 1 hour maximum
- Document all actions taken

**Steps:**

```bash
# 1. Get admin approvals
# (Manual step - contact admins via Slack/email)

# 2. Disable branch protection temporarily (if needed)
# WARNING: This allows direct pushes to main
gh api repos/slab1/mira/branches/main/protection --disable

# 3. Push emergency fix directly to main
git checkout main
git pull
git checkout -b emergency/fix-description
# Make minimal changes
 git add .
 git commit -m "Emergency fix: DESCRIPTION"
 git push origin emergency/fix-description
 gh pr create --base main --head emergency/fix-description --title "Emergency Fix" --body "Break glass fix"
 gh pr merge --auto --squash

# 4. Verify fix
git pull
bun run start
curl http://localhost:3000/api/health

# 5. Re-enable branch protection
gh api repos/slab1/mira/branches/main/protection --enable

# 6. Document the incident
# Create incident report in docs/incidents/
```

**Post-Break Glass:**

1. Audit all changes made during the window
2. Review why normal procedures failed
3. Update runbook with lessons learned
4. Implement fixes to prevent recurrence

---

## ⚡ Performance Issues

---

### Issue: High Latency

**Symptoms:**

- Slow response times
- High p95/p99 latency
- Users reporting sluggishness

**Severity:** MEDIUM-HIGH (affects user experience)

**Diagnosis:**

```bash
# 1. Check latency metrics
curl http://localhost:3000/api/metrics | jq '.latency'

# 2. Check slow endpoints
curl http://localhost:3000/api/metrics/endpoints | jq 'sort_by(.p95) | reverse'

# 3. Check database performance
sqlite3 data/mira.db ".timer on" "SELECT * FROM knowledge_entries LIMIT 100"

# 4. Check memory usage
bun run logs:performance
```

**Common Causes:**

| Cause                 | Check                     | Resolution                    |
| --------------------- | ------------------------- | ----------------------------- |
| Slow database queries | High query time in SQLite | Add indexes, optimize queries |
| Large knowledge base  | > 10000 entries           | Archive old entries           |
| High request volume   | > 100 RPS                 | Scale horizontally            |
| Slow external APIs    | High latency to providers | Add caching, timeouts         |
| Memory pressure       | High RSS usage            | Increase memory limit         |
| CPU pressure          | High CPU usage            | Scale vertically              |

**Resolution:**

```typescript
// 1. Identify slow endpoints
const endpoints = await metrics.getEndpointMetrics()
const slowEndpoints = endpoints
  .filter((e) => e.p95 > 1000) // > 1 second
  .sort((a, b) => b.p95 - a.p95)

for (const endpoint of slowEndpoints) {
  console.log(`${endpoint.path}: p95=${endpoint.p95}ms, count=${endpoint.count}`)

  // Check what's causing slowness
  const traces = await metrics.getTraces(endpoint.path)
  const slowTraces = traces.filter((t) => t.duration > 1000)

  for (const trace of slowTraces) {
    console.log(`  Trace: ${trace.id}, duration: ${trace.duration}ms`)
    console.log(
      `  Steps:`,
      trace.steps.map((s) => `${s.name}: ${s.duration}ms`),
    )
  }
}

// 2. Optimize slow queries
if (slowEndpoints.some((e) => e.path.includes('/knowledge'))) {
  // Add indexes
  await migrateDatabase()

  // Archive old entries
  await knowledge.archiveOldEntries(30)

  // Use caching
  const cache = new MemoryCache({ ttl: 300000 }) // 5 minute cache
  const cachedRetrieve = cache.memoize(knowledge.retrieve.bind(knowledge))
}

// 3. Scale resources
if (process.memoryUsage().rss > 2 * 1024 * 1024 * 1024) {
  // > 2GB
  // Increase memory limit
  await increaseMemoryLimit('4g')
}

// 4. Add timeouts
const withTimeout = <T>(fn: () => Promise<T>, timeout: number): Promise<T> => {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeout)),
  ])
}

// Use withTimeout for all external calls
const result = await withTimeout(() => externalApi.call(), 5000)
```

---

## 🔒 Security Incidents

---

### Issue: Suspicious Activity Detected

**Symptoms:**

- Unusual API access patterns
- Unexpected code changes
- Unauthorized access attempts

**Severity:** CRITICAL

**Immediate Actions:**

```bash
# 1. Check audit logs
curl http://localhost:3000/api/audit?limit=100

# 2. Check security logs
bun run logs:security --level=warn

# 3. Check for unauthorized changes
git log --oneline --since="1 hour ago"
git diff HEAD~5

# 4. Check running processes
ps aux | grep mira
ps aux | grep bun
ps aux | grep node

# 5. Check network connections
lsof -i :3000
netstat -tuln | grep 3000
```

**Response Procedure:**

1. **Contain:**
   - Revoke compromised credentials
   - Block suspicious IPs
   - Isolate affected systems

2. **Investigate:**
   - Identify attack vector
   - Determine scope of compromise
   - Preserve evidence

3. **Remediate:**
   - Remove malicious code
   - Restore from known-good backups
   - Rotate all credentials

4. **Recover:**
   - Restart services
   - Verify system integrity
   - Monitor for recurrence

5. **Report:**
   - Document incident
   - Notify stakeholders
   - File incident report

**Escalation:** Follow [Security Incident Escalation](#security-incident-escalation)

---

### Security Incident Escalation

| Severity | Response Time | Notification Method        | Team                   |
| -------- | ------------- | -------------------------- | ---------------------- |
| Critical | Immediate     | PagerDuty + Slack @channel | Security + Engineering |
| High     | < 1 hour      | Slack @channel             | Engineering            |
| Medium   | < 4 hours     | Slack DM                   | On-call                |
| Low      | < 24 hours    | Email                      | Team lead              |

**Contact Information:**

- Security Team: security@slab1.com
- Engineering Lead: eng-lead@slab1.com
- On-Call: Check PagerDuty rotation

---

## 📊 Monitoring & Alerts

---

### Key Metrics

| Metric                     | Description           | Target                      | Alert Threshold            |
| -------------------------- | --------------------- | --------------------------- | -------------------------- |
| `governance.gate.decision` | Gate decisions        | PASSED for valid candidates | BLOCKED > 1 hour           |
| `memory.retrieval.latency` | Memory search latency | p95 < 500ms                 | p95 > 1000ms               |
| `budget.usage.percentage`  | Budget usage          | < 100%                      | > 80% (warn), > 95% (crit) |
| `error.rate`               | Error rate            | < 0.1%                      | > 1%                       |
| `request.latency`          | Request latency       | p95 < 1000ms                | p95 > 5000ms               |
| `database.query.time`      | DB query time         | p95 < 100ms                 | p95 > 500ms                |
| `health.status`            | Overall health        | healthy                     | degraded > 5min            |

### Alert Rules

```yaml
# Example Prometheus alert rules
groups:
  - name: mira-alerts
    rules:
      # Governance alerts
      - alert: GovernanceStuck
        expr: governance_gate_decision{outcome="BLOCKED"} == 1
        for: 1h
        labels:
          severity: critical
        annotations:
          summary: 'Governance gate stuck at BLOCKED for 1 hour'
          description: 'Gate {{ $labels.gate }} has been BLOCKED for 1 hour'

      # Budget alerts
      - alert: BudgetWarning
        expr: mira_budget_usage_percentage > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'Budget usage exceeds 80%'
          description: 'Budget {{ $labels.budget_type }} for tenant {{ $labels.tenant }} is at {{ $value }}%'

      - alert: BudgetCritical
        expr: mira_budget_usage_percentage > 95
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: 'Budget usage exceeds 95%'
          description: 'Budget {{ $labels.budget_type }} for tenant {{ $labels.tenant }} is at {{ $value }}%'

      # Error alerts
      - alert: HighErrorRate
        expr: rate(mira_errors_total[5m]) / rate(mira_requests_total[5m]) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: 'Error rate exceeds 1%'
          description: 'Error rate is {{ $value }}%'

      # Health alerts
      - alert: HealthDegraded
        expr: mira_health_status{status="degraded"} == 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'System health degraded'
          description: 'Health check {{ $labels.component }} is degraded'

      - alert: HealthUnhealthy
        expr: mira_health_status{status="unhealthy"} == 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: 'System health unhealthy'
          description: 'Health check {{ $labels.component }} is unhealthy'
```

---

### Dashboards

**Recommended Grafana Dashboards:**

1. **Overview Dashboard**
   - Overall health status
   - Request rate and latency
   - Error rate
   - Resource usage (CPU, memory, disk)

2. **Governance Dashboard**
   - Gate decisions over time
   - Promotion pipeline status
   - Canary metrics (latency, error rate)
   - Benchmark results

3. **Memory Dashboard**
   - Knowledge base size
   - Memory retrieval latency
   - Provenance distribution
   - Cache hit rate

4. **Budget Dashboard**
   - Budget usage by tenant
   - Cost by model
   - Cost by outcome
   - Cost trends over time

5. **Performance Dashboard**
   - Endpoint latency
   - Database query performance
   - External API latency
   - Resource utilization

---

## 📞 Escalation Paths

---

### On-Call Rotation

| Day       | Primary  | Secondary | Timezone    |
| --------- | -------- | --------- | ----------- |
| Monday    | @alice   | @bob      | UTC-8 (PST) |
| Tuesday   | @bob     | @charlie  | UTC-5 (EST) |
| Wednesday | @charlie | @alice    | UTC-8 (PST) |
| Thursday  | @alice   | @bob      | UTC-5 (EST) |
| Friday    | @bob     | @charlie  | UTC-8 (PST) |
| Weekend   | @charlie | @alice    | UTC-5 (EST) |

**Contact:** Use PagerDuty or Slack @oncall

---

### Issue Severity Matrix

| Impact                   | Urgency   | Severity | Response Time |
| ------------------------ | --------- | -------- | ------------- |
| System down              | Immediate | Critical | < 15 minutes  |
| Major feature broken     | Immediate | Critical | < 15 minutes  |
| Security incident        | Immediate | Critical | < 15 minutes  |
| Data loss                | Immediate | Critical | < 15 minutes  |
| Performance degraded     | High      | High     | < 1 hour      |
| Minor feature broken     | High      | High     | < 1 hour      |
| Bug affecting some users | Medium    | Medium   | < 4 hours     |
| Bug affecting few users  | Low       | Medium   | < 24 hours    |
| Enhancement request      | Low       | Low      | < 1 week      |

---

### Escalation Contacts

| Team           | Primary Contact | Secondary Contact | Slack Channel   |
| -------------- | --------------- | ----------------- | --------------- |
| Engineering    | @eng-lead       | @eng-manager      | #engineering    |
| Security       | @security-lead  | @security-team    | #security       |
| Infrastructure | @infra-lead     | @infra-team       | #infrastructure |
| Product        | @product-lead   | @product-manager  | #product        |

---

## 📝 Incident Report Template

```markdown
# Incident Report: [Short Description]

**Incident ID:** INC-YYYYMMDD-XXX  
**Date:** YYYY-MM-DD  
**Time:** HH:MM UTC  
**Duration:** HH:MM  
**Severity:** Critical/High/Medium/Low  
**Status:** Open/Investigating/Identified/Monitoring/Resolved

---

## Summary

[1-2 sentence summary of the incident]

---

## Timeline

| Time (UTC) | Event                         | Owner               |
| ---------- | ----------------------------- | ------------------- |
| HH:MM      | Incident detected             | [Person/Automation] |
| HH:MM      | Initial investigation started | [Person]            |
| HH:MM      | Root cause identified         | [Person]            |
| HH:MM      | Mitigation applied            | [Person]            |
| HH:MM      | Service restored              | [Person]            |
| HH:MM      | Incident resolved             | [Person]            |

---

## Impact

- **Affected Services:** [List services]
- **Affected Users:** [Number/percentage of users]
- **Duration:** [Total downtime]
- **Data Loss:** [Yes/No, if yes describe]
- **Financial Impact:** [Estimated cost]

---

## Root Cause

[Detailed technical explanation of the root cause]

---

## Response

### Detection

[How was the incident detected?]

### Initial Response

[What were the first actions taken?]

### Investigation

[How was the root cause identified?]

### Mitigation

[What steps were taken to mitigate the impact?]

### Resolution

[What steps were taken to resolve the incident?]

---

## Recovery

### Immediate Actions

[Actions taken to recover from the incident]

### Long-Term Fixes

[Permanent fixes to prevent recurrence]

---

## Lessons Learned

### What Went Well

- [ ]

### What Could Be Improved

- [ ]

### Action Items

| Action     | Owner   | Due Date   | Status |
| ---------- | ------- | ---------- | ------ |
| [Action 1] | [Owner] | YYYY-MM-DD | Open   |
| [Action 2] | [Owner] | YYYY-MM-DD | Open   |

---

## Follow-Up

- [ ] Post-incident review scheduled
- [ ] Runbook updated
- [ ] Tests added
- [ ] Monitoring improved
- [ ] Documentation updated
```

---

## 📚 Additional Resources

- [Architecture Decision Records (ADRs)](./adr/) - Design decisions
- [MIRA_EVOLUTION_SPEC.md](../MIRA_EVOLUTION_SPEC.md) - Evolution specification
- [PROVENANCE_DESIGN.md](../docs/PROVENANCE_DESIGN.md) - Provenance system design
- [PROVENANCE_IMPLEMENTATION_VERIFICATION.md](../docs/PROVENANCE_IMPLEMENTATION_VERIFICATION.md) - Provenance verification
- [MIRA_LONG_TERM_RISK_MITIGATION_AND_SCALABILITY.md](../docs/MIRA_LONG_TERM_RISK_MITIGATION_AND_SCALABILITY.md) - Risk mitigation plan

---

## 🔧 Maintenance Commands

```bash
# Start server
bun run start

# Start with production config
MIRA_ENV=production bun run start

# Run tests
bun test

# Run specific tests
bun test packages/server/src/patching/governance/
bun test packages/server/src/memory/provenance.test.ts

# Run migration
bun run migrate

# Check health
curl http://localhost:3000/api/health

# View logs
bun run logs
bun run logs:governance
bun run logs:memory
bun run logs:budget

# Clean up
bun run clean
rm -rf data/mira.db data/mira.db-wal data/mira.db-shm
```

---

**Document Control:**

- **Version:** 1.0
- **Last Reviewed:** 2026-10-14
- **Next Review:** 2026-11-14
- **Owner:** Mira Engineering Team

---

_This runbook is a living document. Please update it as procedures change or new issues are discovered._
