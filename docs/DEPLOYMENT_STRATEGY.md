# Mira Deployment Strategy

**Version:** 1.0  
**Last Updated:** 2026-10-14  
**Owner:** Mira Engineering Team

---

## 🎯 Overview

Mira's deployment strategy is designed to **maximize safety** while enabling **rapid iteration** on its autonomous self-improvement capabilities. The strategy follows a **phased rollout approach** with multiple safety gates and rollback mechanisms.

### Core Principles

1. **Fail-Closed by Default:** All safety-critical decisions default to BLOCKED
2. **Progressive Exposure:** New changes see limited traffic before full rollout
3. **Automated Rollback:** Complete rollback system for all changed components
4. **Human in the Loop:** Critical decisions require human approval
5. **Observability First:** Comprehensive monitoring and alerting at every stage

---

## 📋 Deployment Phases

```
┌─────────────────────────────────────────────────────────────────┐
│                    MIRA DEPLOYMENT PIPELINE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐    │
│  │   Develop   │────▶│    Staging   │────▶│   Canary    │    │
│  │             │     │             │     │             │    │
│  └─────────────┘     └─────────────┘     └──────┬──────┘    │
│                                                  │           │
│                                                  ▼           │
│                                              ┌─────────────┐    │
│                                              │ Production  │    │
│                                              │             │    │
│                                              └─────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    SAFETY GATES                                 │ │
│  │                                                                  │ │
│  │  Phase 1: Code Review & Tests                                   │ │
│  │  ├─ Branch protection (required PR + approvals)                │ │
│  │  ├─ CI checks (lint, typecheck, tests)                         │ │
│  │  ├─ Security scanning (vulnerabilities)                         │ │
│  │  └─ Governance tests (fail-closed verification)               │ │
│  │                                                                  │ │
│  │  Phase 2: Staging Verification                                  │ │
│  │  ├─ Full test suite passes                                     │ │
│  │  ├─ Health checks pass                                          │ │
│  │  ├─ Governance gates function correctly                        │ │
│  │  └─ Manual verification (optional)                             │ │
│  │                                                                  │ │
│  │  Phase 3: Canary Analysis                                       │ │
│  │  ├─ Limited traffic (5% by default)                             │ │
│  │  ├─ SLO monitoring (latency, error rate)                       │ │
│  │  ├─ Provenance verification (all memories tracked)             │ │
│  │  └─ Budget tracking (no overspend)                              │ │
│  │                                                                  │ │
│  │  Phase 4: Production Rollout                                   │ │
│  │  ├─ Gradual traffic increase (5% → 25% → 50% → 100%)           │ │
│  │  ├─ Continuous SLO monitoring                                   │ │
│  │  └─ Human approval for final promotion                         │ │
│  │                                                                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Phase 1: Development

### Local Development

**Environment:** `MIRA_ENV=development`

**Features:**

- Hot reload enabled
- No isolation required (optional)
- All features enabled
- Debug logging
- In-memory budget tracking

**Commands:**

```bash
# Start development server
bun run dev

# Start with hot reload
bun run --watch packages/server/src/index.ts

# Run tests
bun test

# Run specific tests
bun test packages/server/src/patching/governance/
```

### Pre-commit Hooks

**Automated checks before every commit:**

```yaml
# .husky/pre-commit
- Linting (ESLint with auto-fix)
- Type checking (TypeScript)
- Unit tests for changed files
- Provenance verification (if memory changes)
```

**Pre-commit configuration:**

```json
{
  "lint-staged": {
    "*.{ts,tsx,js,jsx}": ["prettier --write", "eslint --fix", "bun run typecheck"],
    "*.{json,md,yml,yaml,css}": ["prettier --write"]
  }
}
```

### Branch Strategy

| Branch Type   | Naming               | Protection         | Purpose               |
| ------------- | -------------------- | ------------------ | --------------------- |
| `main`        | `main`               | ✅ Full protection | Production-ready code |
| Feature       | `feat/description`   | ❌ None            | New features          |
| Bug Fix       | `fix/description`    | ❌ None            | Bug fixes             |
| Hotfix        | `hotfix/description` | ⚠️ Partial         | Emergency fixes       |
| Release       | `release/v*`         | ✅ Full protection | Release candidates    |
| Documentation | `docs/description`   | ❌ None            | Documentation only    |
| Experiment    | `exp/description`    | ❌ None            | Experimental changes  |

**Branch Protection Rules (main):**

- ✅ Required PR
- ✅ Required human approval (1+)
- ✅ Required status checks (CI)
- ✅ Required signed commits
- ✅ No force pushes
- ✅ No direct pushes
- ✅ Include administrators

---

## 🧪 Phase 2: Staging

### Deployment

**Environment:** `MIRA_ENV=staging`

**Trigger:**

- Push to `main` branch
- Manual workflow dispatch

**Deployment Steps:**

```bash
# Build Docker image
docker build -t ghcr.io/slab1/mira:sha-${GITHUB_SHA} .

# Deploy to staging
docker run -d \
  --name mira-staging \
  --restart unless-stopped \
  -p 3000:3000 \
  -e MIRA_ENV=staging \
  -e MIRA_DB=/data/mira-staging.db \
  -v /data:/data \
  ghcr.io/slab1/mira:sha-${GITHUB_SHA}
```

### Verification

**Automated checks:**

- [ ] All tests pass
- [ ] Health check passes
- [ ] Governance gates function
- [ ] Memory system loads
- [ ] Database migrations applied

**Manual verification (optional):**

- [ ] Run smoke tests
- [ ] Verify API endpoints
- [ ] Test governance pipeline
- [ ] Check memory provenance

### Staging Environment

| Configuration | Value                                  |
| ------------- | -------------------------------------- |
| Environment   | `staging`                              |
| Database      | SQLite (`/data/mira-staging.db`)       |
| Port          | 3000                                   |
| Isolation     | Optional (can be disabled for testing) |
| Budget        | Durable (SQLite-backed)                |
| Logging       | Debug level                            |
| Metrics       | Enabled                                |

---

## 🎯 Phase 3: Canary

### Deployment

**Environment:** `MIRA_ENV=canary`

**Trigger:**

- Manual workflow dispatch (after staging verification)
- Automated (future: after staging tests pass)

**Deployment Steps:**

```bash
# Deploy canary
docker run -d \
  --name mira-canary \
  --restart unless-stopped \
  -p 3001:3000 \
  -e MIRA_ENV=canary \
  -e MIRA_DB=/data/mira-canary.db \
  -e MIRA_CANARY_MODE=true \
  -e MIRA_CANARY_TRAFFIC_PERCENT=5 \
  -v /data:/data \
  ghcr.io/slab1/mira:sha-${GITHUB_SHA}
```

### Canary Configuration

| Configuration                 | Value     | Description                     |
| ----------------------------- | --------- | ------------------------------- |
| `MIRA_CANARY_MODE`            | `true`    | Enable canary mode              |
| `MIRA_CANARY_TRAFFIC_PERCENT` | `5`       | Percentage of traffic to canary |
| `MIRA_CANARY_DURATION`        | `3600000` | Canary duration in ms (1 hour)  |
| `MIRA_CANARY_MIN_SAMPLES`     | `100`     | Minimum samples before decision |
| `MIRA_CANARY_MAX_ERROR_RATE`  | `0.01`    | Max error rate (1%)             |
| `MIRA_CANARY_MAX_LATENCY`     | `5000`    | Max p95 latency (5s)            |

### Canary Analysis

**Automated SLO Monitoring:**

```typescript
// Canary SLOs
const slos = {
  errorRate: {
    threshold: 0.01, // 1%
    window: 300000, // 5 minutes
  },
  latency: {
    p95: 5000, // 5 seconds
    p99: 10000, // 10 seconds
    window: 300000, // 5 minutes
  },
  quality: {
    // Quality metrics (future)
  },
}

// Decision logic
if (errorRate > slos.errorRate.threshold) {
  // REJECT: Error rate too high
  return { decision: 'REJECT', reason: 'error_rate_too_high' }
}

if (p95Latency > slos.latency.p95) {
  // REJECT: Latency too high
  return { decision: 'REJECT', reason: 'latency_too_high' }
}

if (sampleCount < slos.minSamples) {
  // BLOCK: Not enough data
  return { decision: 'BLOCK', reason: 'insufficient_samples' }
}

if (duration < slos.duration) {
  // BLOCK: Canary not run long enough
  return { decision: 'BLOCK', reason: 'insufficient_duration' }
}

// PROMOTE: All SLOs met
return { decision: 'PROMOTE', reason: 'all_slos_met' }
```

### Canary Metrics

**Monitored Metrics:**

- Request rate (RPS)
- Error rate (%)
- Latency (p50, p95, p99)
- Memory usage
- CPU usage
- Database query time
- External API calls

**Alerting:**

- Error rate > 1% for 5 minutes → Alert
- p95 latency > 5s for 5 minutes → Alert
- Sample count < 100 after 1 hour → Alert

---

## 🏭 Phase 4: Production

### Deployment

**Environment:** `MIRA_ENV=production`

**Trigger:**

- Manual workflow dispatch (after canary verification)
- Requires human approval

**Deployment Steps:**

```bash
# Create rollback point
docker exec mira-production bun run packages/server/src/evolution/complete-rollback.ts create

# Deploy new version
docker run -d \
  --name mira-production-new \
  --restart unless-stopped \
  -p 3002:3000 \
  -e MIRA_ENV=production \
  -e MIRA_DB=/data/mira-production.db \
  -v /data:/data \
  ghcr.io/slab1/mira:sha-${GITHUB_SHA}

# Wait for health check
curl -f http://localhost:3002/api/health

# Switch traffic (using load balancer or service mesh)
# Gradually shift traffic from old to new

# Stop old container
docker stop mira-production
docker rm mira-production

# Rename new container
docker rename mira-production-new mira-production
```

### Production Configuration

| Configuration             | Value                      | Description                       |
| ------------------------- | -------------------------- | --------------------------------- |
| `MIRA_ENV`                | `production`               | Production mode                   |
| `MIRA_DB`                 | `/data/mira-production.db` | Production database               |
| `MIRA_ISOLATION_REQUIRED` | `true`                     | Require isolation for experiments |
| `MIRA_DAILY_BUDGET_USD`   | `100`                      | Daily budget limit                |
| `MIRA_LOG_LEVEL`          | `info`                     | Production logging level          |
| `MIRA_LOG_REDACT`         | `true`                     | Redact sensitive data             |

### Production Requirements

**Before Production Deployment:**

- [ ] All governance gates fail-closed
- [ ] Branch protection enabled
- [ ] Rollback system tested
- [ ] Monitoring in place
- [ ] Alerting configured
- [ ] Human approval obtained
- [ ] Canary analysis passed
- [ ] Budget limits configured

**Production SLOs:**

| Metric        | Target | Alert Threshold |
| ------------- | ------ | --------------- |
| Availability  | 99.9%  | < 99.5%         |
| Latency (p95) | < 1s   | > 2s            |
| Error rate    | < 0.1% | > 1%            |
| Memory usage  | < 80%  | > 90%           |
| CPU usage     | < 70%  | > 85%           |

---

## 🔄 Rollback Procedures

### Automated Rollback

**Trigger:**

- Canary SLO violation
- Production health check failure
- Manual trigger

**Rollback Process:**

```bash
# 1. Identify rollback target
ROLLBACK_ID=$(bun run packages/server/src/evolution/complete-rollback.ts list | grep ${DEPLOYMENT_SHA} | head -1 | awk '{print $1}')

# 2. Execute rollback
bun run packages/server/src/evolution/complete-rollback.ts rollback ${ROLLBACK_ID}

# 3. Verify rollback
bun run packages/server/src/evolution/complete-rollback.ts verify ${ROLLBACK_ID}
```

**Rollback Guarantees:**

- ✅ Files restored from backup
- ✅ Dependencies rolled back
- ✅ Configuration restored
- ✅ Database migrations reversed
- ✅ Runtime restarted
- ✅ Health verified

### Rollback Triggers

| Trigger                   | Rollback Type | Traffic Impact      |
| ------------------------- | ------------- | ------------------- |
| Canary SLO violation      | Automatic     | Canary traffic only |
| Production health failure | Automatic     | Full traffic        |
| Manual trigger            | Manual        | Configurable        |
| Budget exceeded           | Automatic     | Full traffic        |
| Governance failure        | Automatic     | Full traffic        |

### Rollback Verification

**Post-Rollback Checks:**

- [ ] Health check passes
- [ ] Governance state correct
- [ ] Memory system functional
- [ ] Database schema correct
- [ ] All services responding
- [ ] No errors in logs

---

## 🎛️ Traffic Management

### Traffic Routing

**Options:**

1. **Load Balancer (Recommended)**
   - NGINX
   - HAProxy
   - AWS ALB
   - GCP Load Balancer

2. **Service Mesh**
   - Istio
   - Linkerd
   - Consul Connect

3. **Application-Level**
   - Built-in traffic splitting
   - Feature flags

### Canary Traffic Splitting

```nginx
# NGINX configuration for canary
upstream mira_production {
  server localhost:3000;  # Production
  server localhost:3001 backup;  # Canary
}

server {
  listen 80;

  location / {
    # 5% traffic to canary
    split_clients "${remote_addr}" $canary {
      5%    localhost:3001;
      *     localhost:3000;
    }

    proxy_pass http://$canary;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

### Gradual Rollout

**Traffic Percentage Schedule:**

| Phase   | Traffic % | Duration  | Decision Gate    |
| ------- | --------- | --------- | ---------------- |
| Canary  | 5%        | 1 hour    | SLO verification |
| Phase 1 | 25%       | 2 hours   | SLO verification |
| Phase 2 | 50%       | 4 hours   | SLO verification |
| Phase 3 | 75%       | 8 hours   | SLO verification |
| Phase 4 | 100%      | Permanent | Manual approval  |

**Automated Rollout:**

```typescript
// Gradual rollout logic
const rolloutPhases = [
  { percent: 5, duration: 3600000 }, // 5% for 1 hour
  { percent: 25, duration: 7200000 }, // 25% for 2 hours
  { percent: 50, duration: 14400000 }, // 50% for 4 hours
  { percent: 75, duration: 28800000 }, // 75% for 8 hours
  { percent: 100, duration: 0 }, // 100% forever
]

let currentPhase = 0
let phaseStartTime = Date.now()

function getCurrentTrafficPercent(): number {
  const phase = rolloutPhases[currentPhase]
  const elapsed = Date.now() - phaseStartTime

  if (elapsed >= phase.duration && currentPhase < rolloutPhases.length - 1) {
    currentPhase++
    phaseStartTime = Date.now()
    return rolloutPhases[currentPhase].percent
  }

  return phase.percent
}

function checkSLOS(): boolean {
  // Check all SLOs
  const slos = getCurrentSLOS()
  return Object.values(slos).every((slo) => slo.met)
}

// Advance phase if SLOs met
if (checkSLOS() && currentPhase < rolloutPhases.length - 1) {
  currentPhase++
  phaseStartTime = Date.now()
}
```

---

## 📊 Monitoring & Observability

### Metrics

**Application Metrics:**

```yaml
# Prometheus metrics
- mira_requests_total{method, path, status}
- mira_request_duration_seconds{method, path, quantile}
- mira_errors_total{type, path}
- mira_health_status{component, status}
- mira_governance_gate_decision{gate, outcome}
- mira_memory_count{tier, provenance}
- mira_memory_retrieval_latency_seconds{quantile}
- mira_budget_usage_usd{tenant, budget_type}
- mira_budget_limit_usd{tenant, budget_type}
- mira_rollback_count{success}
- mira_rollback_duration_seconds
```

**Infrastructure Metrics:**

```yaml
# System metrics
- node_memory_usage_bytes
- node_cpu_usage_seconds
- node_disk_usage_bytes
- node_network_receive_bytes
- node_network_transmit_bytes
- container_cpu_usage_seconds
- container_memory_usage_bytes
```

### Alerts

**Critical Alerts (PagerDuty):**

- Health check failure
- Governance gate BLOCKED > 1 hour
- Error rate > 1%
- p95 latency > 5s
- Budget exceeded
- Database connection failure
- Memory usage > 90%

**Warning Alerts (Slack):**

- Health check degraded
- Error rate > 0.5%
- p95 latency > 2s
- Budget > 80% used
- Memory usage > 80%
- CPU usage > 80%

### Dashboards

**Recommended Dashboards:**

1. **Overview Dashboard**
   - Overall health status
   - Request rate and error rate
   - Latency percentiles
   - Resource usage

2. **Governance Dashboard**
   - Gate decisions over time
   - Promotion pipeline status
   - Canary metrics
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
   - Cost trends

5. **Infrastructure Dashboard**
   - CPU, memory, disk usage
   - Container metrics
   - Network metrics

---

## 🔒 Security

### Deployment Security

**Requirements:**

- ✅ All images signed
- ✅ All dependencies scanned for vulnerabilities
- ✅ Secrets never in images (use environment variables)
- ✅ Network policies restrict traffic
- ✅ RBAC for deployment access
- ✅ Audit trail for all deployments

**Security Checks:**

```bash
# Scan for vulnerabilities
bun audit
npm audit

# Scan Docker image
trivy image ghcr.io/slab1/mira:sha-${GITHUB_SHA}

# Check for secrets
gitleaks detect --source .
```

### Secrets Management

**Recommended:**

- GitHub Secrets (for CI/CD)
- HashiCorp Vault (for production)
- AWS Secrets Manager (for AWS deployments)
- Kubernetes Secrets (for Kubernetes deployments)

**Never:**

- Hardcode secrets in source code
- Store secrets in Docker images
- Commit secrets to Git
- Share secrets via email/Slack

---

## 📝 Deployment Checklist

### Pre-Deployment

- [ ] Code review complete
- [ ] All tests passing
- [ ] Security scans clean
- [ ] Governance tests passing
- [ ] Provenance verification complete
- [ ] Branch protection enabled
- [ ] Rollback point created
- [ ] Monitoring configured
- [ ] Alerting configured
- [ ] Human approval obtained (for production)

### Post-Deployment

- [ ] Health checks passing
- [ ] All services responding
- [ ] Governance gates functioning
- [ ] Memory system loading
- [ ] Database migrations applied
- [ ] SLOs being met
- [ ] No errors in logs
- [ ] Rollback point verified
- [ ] Stakeholders notified

### Rollback

- [ ] Rollback target identified
- [ ] Rollback executed
- [ ] All components verified
- [ ] Health checks passing
- [ ] Traffic restored
- [ ] Stakeholders notified
- [ ] Incident documented

---

## 🚨 Incident Response

### Deployment Failure

**Symptoms:**

- Health checks failing
- Services not responding
- Errors in logs

**Response:**

1. **Identify:** Check health endpoints and logs
2. **Contain:** Stop traffic to affected service
3. **Rollback:** Execute rollback to last known good state
4. **Verify:** Confirm rollback was successful
5. **Investigate:** Determine root cause
6. **Fix:** Apply fix and redeploy
7. **Document:** Write incident report

### Canary Failure

**Symptoms:**

- Canary SLOs not met
- High error rate in canary
- High latency in canary

**Response:**

1. **Identify:** Check canary metrics and logs
2. **Contain:** Stop traffic to canary
3. **Rollback:** Canary rollback is automatic
4. **Verify:** Confirm production is unaffected
5. **Investigate:** Determine root cause
6. **Fix:** Apply fix and redeploy canary
7. **Document:** Write incident report

### Production Outage

**Symptoms:**

- Production health checks failing
- Users unable to access service
- High error rate in production

**Response:**

1. **Identify:** Check production metrics and logs
2. **Escalate:** Notify on-call engineer
3. **Contain:** Stop traffic if needed
4. **Rollback:** Execute production rollback
5. **Verify:** Confirm service restored
6. **Investigate:** Determine root cause
7. **Fix:** Apply fix and redeploy
8. **Document:** Write incident report

---

## 📚 References

- [Runbook](runbook.md) - Operational procedures
- [ADR-0001: Governance Gates Must Fail Closed](adr/0001-governance-fail-closed.md)
- [ADR-0002: Memory Provenance on ALL Memories](adr/0002-memory-provenance.md)
- [ADR-0003: Branch Protection for Main](adr/0003-branch-protection.md)
- [ADR-0004: Durable Budget Accounting](adr/0004-durable-budget.md)
- [ADR-0005: Complete Rollback System](adr/0005-complete-rollback.md)
- [MIRA_EVOLUTION_SPEC.md](MIRA_EVOLUTION_SPEC.md) - Evolution specification
- [PROVENANCE_DESIGN.md](docs/PROVENANCE_DESIGN.md) - Provenance system

---

## 📝 Version History

| Version | Date       | Author                | Changes         |
| ------- | ---------- | --------------------- | --------------- |
| 1.0     | 2026-10-14 | Mira Engineering Team | Initial version |

---

_This document is a living document. Please update it as deployment procedures evolve._
