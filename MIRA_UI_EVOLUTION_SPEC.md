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
