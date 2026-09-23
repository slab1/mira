# Mira UI Evolution Specification

**Status:** Target Specification
**Date:** 2026-09-23

## 1. Purpose

This document defines the UI requirements for Mira's autonomous improvement and self-evolution capabilities.

The system must make evolution visible without allowing uncontrolled self-modification.

---

# 2. Evolution Lifecycle

```text
OBSERVE
   ↓
DIAGNOSE
   ↓
RESEARCH
   ↓
PROPOSE
   ↓
EXPERIMENT
   ↓
VERIFY
   ↓
SHADOW
   ↓
CANARY
   ↓
PROMOTE
```

At any stage:

```text
                ┌──────────┐
                │ ROLLBACK │
                └──────────┘
                     ↑
                     │
                  Failure
```

---

# 3. Evolution Dashboard

The dashboard should show:

```text
MIRA EVOLUTION

System Health
─────────────────────────────
Agent Engine       ● Healthy
Memory Engine      ● Healthy
Planning Engine    ● Healthy
Evaluation Engine  ● Healthy
Learning Engine    ● Healthy

Active Experiments
─────────────────────────────
3

Pending Approval
─────────────────────────────
2

Recent Improvements
─────────────────────────────
7
```

---

# 4. Improvement Candidate

Each improvement should have a detailed card.

```text
IMPROVEMENT #104

Title:
Improve planning reliability

Type:
Quality

Evidence:
23 failed tasks

Affected engine:
Planning Engine

Risk:
Medium

Expected impact:
Improved planning completion

Status:
Verified

Benchmark:
+14%

Regression:
0

Security:
Passed
```

Actions:

```text
[View Evidence]
[View Diff]
[Run Shadow]
[Approve Canary]
[Reject]
```

---

# 5. Research Evidence

Research must be visible.

```text
Research

Sources:
- Repository evidence
- Test failures
- Technical documentation
- Research papers
- Benchmarks

Evidence strength:
Strong

Research confidence:
0.86
```

Research alone must never automatically trigger production changes.

---

# 6. Experiment View

```text
EXPERIMENT

Production
────────────────
Version: 1.8.2

Candidate
────────────────
Version: 1.9.0-exp

Comparison

Metric          Production   Candidate
Success         82%          89%
Latency         2.4s         2.1s
Cost            $0.31        $0.28
Regression      0            1
Security        Pass         Pass
```

---

# 7. Canary View

```text
CANARY

Candidate:
Planning Engine v1.9.0

Traffic:
5%

Duration:
24h

Success:
91%

Errors:
2

Regression:
0

Status:
Monitoring
```

The UI should clearly distinguish:

* Candidate
* Shadow
* Canary
* Production

---

# 8. Approval Model

Recommended autonomy levels:

```text
Level 0
Observe only

Level 1
Research automatically

Level 2
Propose changes

Level 3
Run sandbox experiments

Level 4
Run bounded canaries

Level 5
Promote low-risk verified changes
```

High-risk changes require human approval.

---

# 9. Evolution History

Maintain an evolution ledger.

```text
Evolution History

#104  Planning improvement
     Verified → Canary

#103  Memory retrieval optimization
     Promoted

#102  Tool timeout adjustment
     Rolled back

#101  Research pipeline change
     Rejected
```

Failed improvements must remain visible.

---

# 10. Core Safety Principle

Mira must never follow:

```text
Research
   ↓
Modify itself
   ↓
Restart
```

The required flow is:

```text
Proposal
   ↓
Risk Analysis
   ↓
Sandbox
   ↓
Verification
   ↓
Shadow
   ↓
Canary
   ↓
Promotion
```

This is a core product rule, not merely an implementation detail.

## Documentation Maintenance — 10 items

> **Status:** `Target` (spec) — UI not yet wired to real engine data; every section becomes `Implemented` when its workspace is backed by real `GET /health`+`BusEvent`+`ledger` data.

| # | Item | Status | Evidence (path / interface) |
|---|------|--------|------------------------------|
| 1 | Implementation path | `Target` | Planned `packages/web/src/pages/Evolution.tsx` + `EvolutionDashboard.tsx` + `ImprovementCard.tsx` + `ExperimentView.tsx` + `CanaryView.tsx`; today only `packages/web/src/pages/Brio.tsx` (1064 lines) + `GET /health` badge as reference impl |
| 2 | Public interfaces | `Target` | `Target`: `GET /evolution` (dashboard `System Health` + `Active Experiments` + `Pending Approval` + `Recent Improvements`), `GET /evolution/:id` (detail `Evidence`+`Risk`+`Benchmark`), `POST /evolution/:id/{approve,reject,runShadow}`, `GET /system/health` (per-engine `● Healthy`) — today `Implemented`: `GET /health` (`colibri:{ok,latencyMs}`) + `GET /gateway/health` |
| 3 | Events | `Target` | `Target`: `learning.updated`, `job.created/updated/cancelled`, `gateway.fallback`, `cost.warning` already `Implemented` (`packages/server/src/types/index.ts` BusEvent), plus `evolution.proposed`/`evolution.verified`/`evolution.shadowed`/`evolution.canary`/`evolution.promoted`/`evolution.rolledback` (ledger stream → SSE `server.heartbeat`) |
| 4 | Configuration | `Target` | `Target`: `mira.json` `features:{evolutionUI:true, autonomyLevel:0..5}` + `routing` canary traffic `5%` + `opencode.jsonc` Evolution workspace toggle; `Implemented`: `mira.json.example` provider/colibri + `~/.mira/mira.env` `MIRA_TOKEN` (`MIRA_STRICT_AUTH` gate) pattern to reuse |
| 5 | Tests | `Target` | `Target`: `Evolution.spec.ts` (dashboard renders `System Health` 5 engines, `Improvement #104` card `Status:Verified` + `Benchmark +14%`, canary `5% 24h Monitoring`, history `Verified→Canary`/`Promoted`/`Rolled back`), today `Implemented`: `packages/server/src/tools/brio.test.ts` 2 pass mock as evolution evidence pattern |
| 6 | Security boundaries | `Target` | `Target`: autonomy levels 0-5 (`MIRA_UI_EVOLUTION_SPEC.md` §8) — Level 4 `Run bounded canaries` + Level 5 `Promote low-risk` require `MIRA_TOKEN` + human approval for high-risk (`Security policy`/`Permissions`/`Auth`/`Large deps` per `MIRA_WEAKNESSES_AND_OBSTACLES.md` §18); fail-closed `permission.ask` → `BUS` `permission.reply` |
| 7 | Operational procedures | `Target` | `Target`: `scripts/serve-local.sh` + `packages/server/scripts/dev-watch.ts` hot-reload Evolution UI + `shared/aether_core.py` hourly pulse feeding `learning.updated`; today `Implemented`: `serve-local.sh` logs `colibri: ready` and `GET /health` probe pattern to reuse for engine health |
| 8 | Migration strategy | `Target` | `Target`: incremental — Phase 1 Information Architecture (`/work`/`/missions`/`/intelligence`/`/changes`/`/system`/`/evolution` per `MIRA_UI_IMPLEMENTATION_ROADMAP.md`) → Phase 8 Evolution UI (dashboard→candidate→evidence→experiment→shadow→canary→promotion→history), no big rewrite; reuse `Brio.tsx` as slice pattern |
| 9 | Rollback strategy | `Target` | `Target`: `git revert` Evolution UI + `saveConfig` remove `features.evolutionUI` + `BusEvent` `evolution.rolledback` ledger entry; canary rollback on `circuit OPEN`/`costCap` breach/`entropy>0.8` via `packages/server/src/bus/index.ts` `server.error` + `gateway.fallback` |
| 10 | Known limitations | `Target` | `Target` spec only — no real `ImprovementLedger`/`ExperimentRunner`/`Verifier` yet (see `MIRA_WEAKNESSES_AND_OBSTACLES.md` §21 P0 gaps); today `Implemented` limits to carry forward: `vite` `symlink` vs `hardlink` proot EPERM, `1.3G 98%` disk (`headless_shell` only), `colibri` needs `:8000` else degraded |
