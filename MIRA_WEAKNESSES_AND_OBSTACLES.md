# Mira Weaknesses and Obstacles

**Status:** Engineering Review
**Review Date:** 2026-09-23
**Repository:** `slab1/mira`

---

## 1. Executive Summary

Mira already has a substantial autonomous engineering foundation: persistent sessions, memory, model routing, tools, permissions, MCP/LSP integration, subagents, queues, snapshots, recovery mechanisms, online research, diagnostics, evaluation, and runtime monitoring.

However, the biggest remaining obstacle is not adding more features.

The biggest obstacle is:

> **Mira needs a rigorous mechanism for proving that a change it makes to itself is actually an improvement.**

The long-term engineering loop should become:

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
PATCH
   ↓
VERIFY
   ↓
EVALUATE
   ↓
SHADOW
   ↓
CANARY
   ↓
PROMOTE / ROLLBACK
   ↓
REMEMBER
```

Mira must never operate on an unrestricted:

```text
Research → Modify Mira → Restart
```

model.

Instead:

```text
Research
   ↓
Improvement Proposal
   ↓
Risk Analysis
   ↓
Sandbox Experiment
   ↓
Verification
   ↓
Evaluation
   ↓
Shadow
   ↓
Canary
   ↓
Promotion OR Rollback
```

---

# 2. Current Strengths

Mira already contains important foundations:

* Persistent sessions
* Model gateway and model routing
* Memory and knowledge systems
* Tool registry
* Permission and guardrail layers
* MCP integration
* LSP/code intelligence
* Child sessions/subagents
* Queue and job management
* File snapshots
* Revert/rewind capabilities
* Doom-loop detection/recovery
* Online research and learning
* Diagnostics
* Evaluation infrastructure
* Runtime watchdog
* Web UI
* TUI
* Token/cost/latency tracking
* Agent and model selection

These foundations mean the remaining problems are primarily about **control, verification, evolution, scalability, and system-level safety**.

---

# 3. Major Weaknesses

## 3.1 No Complete Controlled Self-Evolution Loop

### Problem

Mira can research and learn, but research is not yet connected to a complete controlled self-improvement pipeline.

The missing chain is:

```text
Failure
 ↓
Diagnosis
 ↓
Research
 ↓
Proposal
 ↓
Experiment
 ↓
Patch
 ↓
Verification
 ↓
Evaluation
 ↓
Shadow
 ↓
Canary
 ↓
Promotion
```

### Impact

Without this, Mira can learn about better techniques without reliably converting that knowledge into safe measurable improvements.

### Required Solution

Implement an Evolution Engine containing:

```text
EvolutionObserver
DiagnosisEngine
ImprovementProposal
ExperimentRunner
Verifier
Evaluator
ImprovementLedger
```

### Priority

**P0**

### Acceptance Test

A real Mira failure should produce:

```text
Failure
→ diagnosis
→ improvement proposal
→ isolated experiment
→ verification
→ measurable result
→ accepted/rejected decision
→ permanent ledger entry
```

---

# 4. Verification Is Not Independent Enough

## Problem

Mira may generate a change and then use related reasoning to determine whether the change works.

This creates a potential:

```text
Mira proposes change
       ↓
Mira tests change
       ↓
Mira decides change is good
```

loop.

The verification layer needs stronger independence.

## Required Model

Use multiple forms of evidence:

```text
Unit Tests
+
Integration Tests
+
Regression Tests
+
Static Analysis
+
Security Checks
+
Performance Benchmarks
+
Behavioral Evaluation
+
Baseline Comparison
```

For important changes:

```text
Candidate
   ↓
Independent verification
   ↓
Baseline comparison
   ↓
Decision
```

## Priority

**P0**

---

# 5. Shadow Mira Is Not Fully Implemented

## Problem

Mira needs a safe environment where experimental versions can operate without immediately replacing production behavior.

### Target Architecture

```text
                PRODUCTION MIRA
                      │
                  Telemetry
                      │
                      ▼
                 SHADOW MIRA
                      │
             Experimental Engine
                      │
                Benchmarks
                      │
                 Evaluation
                      │
             ┌────────┴────────┐
             │                 │
           Reject            Canary
                               │
                           Production
```

### Why It Matters

Shadow execution allows Mira to compare:

```text
Current Mira
vs
Candidate Mira
```

before allowing the candidate to become authoritative.

### Priority

**P0**

---

# 6. Canary Promotion and System-Level Rollback

File snapshots provide valuable rollback capability.

However, self-evolution can modify more than files.

Potential changes include:

* Dependencies
* Models
* Prompts
* Configuration
* Database schema
* Agent definitions
* Tool permissions
* Engine versions
* Memory policies
* Retrieval strategies

Therefore:

```text
File rollback
```

is not equivalent to:

```text
System rollback
```

## Required Capability

Every evolution candidate should have:

```text
Candidate Version
Parent Version
Changed Components
Dependencies
Configuration
Migration State
Benchmark Results
Security Results
Rollback Metadata
```

### Priority

**P0**

---

# 7. Engine Modularity Is Still a Target Architecture

Mira should eventually have clear engine boundaries:

```text
Engine Registry
├── Agent Engine
├── Memory Engine
├── Retrieval Engine
├── Planning Engine
├── Evaluation Engine
├── Learning Engine
├── Tool Engine
├── Security Engine
└── Model Engine
```

Each engine should have:

```ts
interface MiraEngine {
  id: string
  version: string
  capabilities: string[]

  health(): Promise<HealthReport>

  benchmark(): Promise<BenchmarkReport>

  upgrade(): Promise<UpgradeResult>

  rollback(): Promise<void>
}
```

## Why This Matters

Without modular engine boundaries, Mira can become a large interconnected system where changing one subsystem unexpectedly affects many others.

### Priority

**P1**

---

# 8. Memory Reliability

Mira's memory system is powerful, but memory itself creates engineering risks.

Potential problems:

* Duplicate memories
* Stale information
* Incorrect memories
* Conflicting memories
* Low-value memories
* Incorrect prioritization
* Memory pollution
* Research contamination
* Failed strategies being forgotten

## Required Model

Memory should have:

```text
Source
Confidence
Timestamp
Scope
Evidence
Importance
Validity
Provenance
Last Verified
```

For example:

```text
Memory
├── Source: project
├── Confidence: 0.91
├── Created: 2026-09-23
├── Last Verified: 2026-09-23
├── Evidence: test/result/session
└── Status: active
```

### Priority

**P0/P1**

---

# 9. Memory Provenance and Explainability

Mira needs to answer:

> "Why did you use this information?"

The UI should expose:

```text
Why Mira chose this
─────────────────────

Evidence:
• Project memory
• Previous session
• Repository code
• Research result
• User instruction

Confidence:
91%

Last verified:
Today

Actions:
[View Evidence]
[Forget]
[Promote]
```

This becomes especially important when Mira makes autonomous engineering decisions.

### Priority

**P1**

---

# 10. External Research Is an Untrusted Input

Mira's online learning system can discover:

* Papers
* GitHub repositories
* Documentation
* Articles
* Agent techniques
* MCP information
* Evaluation methods

But:

> **Research should never automatically become executable instruction.**

Web content must be treated as untrusted data.

The safe pipeline is:

```text
Web Research
     ↓
Extract Knowledge
     ↓
Validate
     ↓
Compare Evidence
     ↓
Generate Proposal
     ↓
Experiment
```

Not:

```text
Web Page
 ↓
Instruction
 ↓
Modify System
```

### Priority

**P0**

---

# 11. Self-Healing Can Become a Retry Loop

Runtime healing is useful.

But autonomous recovery can accidentally produce:

```text
Failure
 ↓
Retry
 ↓
Failure
 ↓
Retry
 ↓
Failure
 ↓
Retry
```

This is a doom loop.

## Required Controls

Every healing attempt needs:

```text
Maximum retries
Maximum time
Maximum cost
Maximum patch attempts
Maximum files changed
Risk limit
Escalation threshold
```

After repeated failure:

```text
RECOVERY FAILED
       ↓
ESCALATE
       ↓
HUMAN / HIGHER-LEVEL AGENT
```

### Priority

**P0**

---

# 12. Multi-Agent Coordination

As Mira becomes more autonomous, multiple agents may operate simultaneously:

```text
Architect
Developer
Reviewer
Tester
Security
DevOps
Researcher
```

This creates coordination problems.

Potential conflicts:

```text
Agent A edits file
Agent B edits same file
Agent C tests old version
Agent D modifies configuration
```

## Required Controls

Introduce:

* Task ownership
* File/resource locking
* Shared mission state
* Agent priorities
* Conflict detection
* Dependency graphs
* Version-aware patches
* Transaction boundaries

### Priority

**P1**

---

# 13. Autonomous Cost Control

Self-improvement can become expensive.

Possible cost sources:

```text
Research
+
LLM calls
+
Subagents
+
Experiments
+
Benchmarks
+
Shadow execution
+
Canary workloads
```

A badly designed evolution loop could spend resources continuously.

## Required Controls

```text
Per-task budget
Per-agent budget
Per-mission budget
Per-experiment budget
Daily budget
Research budget
Evolution budget
```

And:

```text
Budget exceeded
      ↓
Pause
      ↓
Explain
      ↓
Require approval / wait
```

### Priority

**P1**

---

# 14. Scalability

A local/single-node architecture can work well during development.

But a large autonomous Mira deployment may eventually require:

```text
API Gateway
     ↓
Mira Runtime
     ↓
Agent Workers
     ↓
Research Workers
     ↓
Sandbox Workers
     ↓
Evaluation Workers
     ↓
Memory Services
     ↓
Database
     ↓
Object Storage
```

The system will eventually need stronger distributed infrastructure for:

* Multiple users
* Multiple projects
* Long-running jobs
* Parallel agents
* Sandboxed experiments
* Large memory stores
* High availability

### Priority

**P1**

---

# 15. Dependency and Model Evolution

Mira may eventually want to improve:

* npm packages
* Python packages
* LLM models
* Embedding models
* MCP servers
* Agent frameworks
* Database libraries

But automatic upgrades can introduce breaking changes.

Example:

```text
Old dependency
      ↓
New dependency
      ↓
API changed
      ↓
Mira breaks
```

Therefore every dependency/model upgrade should follow:

```text
Candidate
 ↓
Compatibility Check
 ↓
Sandbox
 ↓
Tests
 ↓
Benchmark
 ↓
Shadow
 ↓
Canary
 ↓
Promotion
```

### Priority

**P1**

---

# 16. Long-Term Evaluation

Passing a test is not enough to prove that Mira improved.

Mira needs longitudinal benchmarks.

For example:

```text
Engineering Benchmark

Task completion:      87% → 91%
Regression rate:       8% → 4%
Average latency:      12s → 9s
Cost/task:           $0.18 → $0.14
Recovery success:      72% → 84%
Security violations:   2 → 0
```

The evolution system should compare:

```text
Before
vs
Candidate
vs
After
```

### Priority

**P0**

---

# 17. Decision-Level Observability

Mira already has useful operational information.

The next level is understanding:

> Why did Mira make this decision?

A complete trace should eventually look like:

```text
User Request
     ↓
Plan
     ↓
Memory Recall
     ↓
Research
     ↓
Decision
     ↓
Tool Selection
     ↓
Tool Execution
     ↓
Code Change
     ↓
Test
     ↓
Evaluation
     ↓
Final Decision
```

Each step should have:

```text
Timestamp
Agent
Model
Input
Output
Tool
Evidence
Cost
Latency
Result
Confidence
```

### Priority

**P1**

---

# 18. Human Approval Boundaries

Mira needs clear autonomy levels.

## Level 0 — Observe

Read-only.

## Level 1 — Suggest

Can recommend changes.

## Level 2 — Experiment

Can modify sandbox environments.

## Level 3 — Execute

Can perform bounded production tasks.

## Level 4 — Canary

Can deploy controlled changes.

## Level 5 — Autonomous

Can promote low-risk improvements within strict policy.

High-risk changes should not silently cross these boundaries.

Examples requiring stronger approval:

* Security policy changes
* Permission changes
* Production infrastructure changes
* Destructive database changes
* Authentication changes
* Secret-management changes
* Large dependency changes
* Major architecture changes

### Priority

**P0**

---

# 19. UI Must Expose the Autonomous Lifecycle

Mira's UI should not only be a chat interface.

It needs to show:

```text
WORK
 ↓
THINK
 ↓
EXECUTE
 ↓
VERIFY
 ↓
IMPROVE
 ↓
REMEMBER
```

Important future workspaces:

```text
WORK
MISSIONS
INTELLIGENCE
CHANGES
SYSTEM
EVOLUTION
```

The Evolution workspace should expose:

```text
System Health
Improvement Candidates
Research Evidence
Experiments
Benchmarks
Shadow Results
Canary Status
Rollback History
Evolution Ledger
```

### Priority

**P1**

---

# 20. Complexity Is Itself a Risk

This may become one of Mira's most important architectural problems.

As features are added:

```text
Memory
+
Learning
+
Agents
+
Tools
+
Research
+
Evolution
+
Self-Healing
+
Shadow
+
Canary
+
Observability
+
Security
```

Mira could become too complex to understand.

The system could reach a point where:

> Mira is capable of doing many things, but nobody can confidently explain how the entire system behaves.

Therefore complexity must be treated as an engineering metric.

Track:

```text
Number of engines
Number of dependencies
Number of autonomous actions
Number of state transitions
Number of agents
Number of tools
Number of permissions
Number of failure paths
```

### Priority

**P0**

---

# 21. Priority Matrix

| Priority | Weakness                     |
| -------- | ---------------------------- |
| 🔴 P0    | Controlled self-evolution    |
| 🔴 P0    | Independent verification     |
| 🔴 P0    | Shadow Mira                  |
| 🔴 P0    | Canary + system rollback     |
| 🔴 P0    | Research trust boundary      |
| 🔴 P0    | Self-healing loop prevention |
| 🔴 P0    | Long-term evaluation         |
| 🔴 P0    | Human autonomy boundaries    |
| 🔴 P0    | Complexity management        |
| 🟠 P1    | Engine Registry              |
| 🟠 P1    | Memory reliability           |
| 🟠 P1    | Memory provenance            |
| 🟠 P1    | Multi-agent coordination     |
| 🟠 P1    | Cost control                 |
| 🟠 P1    | Scalability                  |
| 🟠 P1    | Dependency evolution         |
| 🟠 P1    | Decision observability       |
| 🟠 P1    | Evolution UI                 |

---

# 22. Target Evolution Architecture

```text
                       ┌──────────────┐
                       │   OBSERVER   │
                       └──────┬───────┘
                              ↓
                       ┌──────────────┐
                       │  DIAGNOSIS   │
                       └──────┬───────┘
                              ↓
                       ┌──────────────┐
                       │   RESEARCH   │
                       └──────┬───────┘
                              ↓
                       ┌──────────────┐
                       │   PROPOSAL   │
                       └──────┬───────┘
                              ↓
                       ┌──────────────┐
                       │ EXPERIMENTER │
                       └──────┬───────┘
                              ↓
                       ┌──────────────┐
                       │    PATCH     │
                       └──────┬───────┘
                              ↓
                       ┌──────────────┐
                       │   VERIFIER   │
                       └──────┬───────┘
                              ↓
                       ┌──────────────┐
                       │  EVALUATOR   │
                       └──────┬───────┘
                              ↓
                       ┌──────────────┐
                       │ SHADOW MIRA  │
                       └──────┬───────┘
                              ↓
                       ┌──────────────┐
                       │   CANARY     │
                       └──────┬───────┘
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓
                PROMOTE              ROLLBACK
                    │                   │
                    └─────────┬─────────┘
                              ↓
                       ┌──────────────┐
                       │   MEMORY /   │
                       │    LEDGER    │
                       └──────────────┘
```

---

# 23. Recommended Implementation Order

## Phase 1 — Evolution Core

Build:

```text
packages/server/src/evolution/

observer.ts
diagnosis.ts
proposal.ts
experiment.ts
patcher.ts
verifier.ts
evaluator.ts
ledger.ts
```

First working pipeline:

```text
Failure
 ↓
Observer
 ↓
Proposal
 ↓
Sandbox
 ↓
Verifier
 ↓
Ledger
```

---

## Phase 2 — Safety

Add:

```text
Risk Engine
Autonomy Levels
Approval Gates
Resource Limits
Security Validation
Rollback Manager
```

---

## Phase 3 — Engine Registry

Introduce:

```text
packages/server/src/engines/

registry.ts
agent.ts
memory.ts
retrieval.ts
planning.ts
evaluation.ts
learning.ts
tool.ts
security.ts
model.ts
```

---

## Phase 4 — Shadow Mira

Implement:

```text
Production Mira
       ↓
Telemetry
       ↓
Candidate Engine
       ↓
Shadow Environment
       ↓
Benchmark
       ↓
Comparison
```

---

## Phase 5 — Canary

Implement:

```text
Candidate
 ↓
Canary
 ↓
Monitor
 ↓
Evaluate
 ↓
Promote
   OR
Rollback
```

---

## Phase 6 — Memory Evolution

Teach Mira to remember:

```text
Successful Improvements
Failed Improvements
Rejected Proposals
Rollback Events
Regression Causes
Useful Research
Benchmark Results
```

This is important because **failed improvements are also knowledge**.

---

# 24. Definition of Done

The self-improvement system should not be considered complete until Mira can:

* Detect a real failure.
* Preserve the evidence.
* Diagnose the likely cause.
* Research possible solutions.
* Generate an improvement proposal.
* Assign a risk level.
* Select an appropriate autonomy level.
* Create an isolated experiment.
* Modify code safely.
* Run tests.
* Run regression checks.
* Run security checks.
* Run performance/evaluation benchmarks.
* Compare against a baseline.
* Explain the decision.
* Reject bad candidates.
* Roll back failed changes.
* Run successful candidates in Shadow Mira.
* Promote candidates through a controlled canary.
* Record the entire evolution history.
* Learn from both success and failure.
* Prevent infinite recovery/evolution loops.

---

# 25. The Most Important Engineering Principle

Mira's next stage should **not** be measured by how many additional features it can execute.

It should be measured by whether Mira can demonstrate:

```text
"This change improved me,
and here is the evidence."
```

That evidence should include:

```text
Tests
Benchmarks
Regression Results
Security Results
Performance
Cost
Reliability
User/Task Success
Rollback Safety
```

The ultimate Mira loop becomes:

```text
OBSERVE
   ↓
LEARN
   ↓
EXPERIMENT
   ↓
VERIFY
   ↓
IMPROVE
   ↓
REMEMBER
   ↺
```

This is the foundation for turning Mira from an autonomous engineering assistant into a **controlled, measurable, continuously improving engineering system**.

## Documentation Maintenance — 10 items

> **Status:** `Implemented` (review 2026-09-23) / `Target` (roadmap gaps) — this review itself is evidence-backed (`git status`+`bun test`+`health`+`CI` per `MIRA_REVIEW_AND_ROADMAP.md` policy), not docs-alone.

| # | Item | Status | Evidence (path / interface) |
|---|------|--------|------------------------------|
| 1 | Implementation path | `Implemented` (review) / `Target` (evolution) | `Implemented`: review foundations `packages/server/src/config/defaults.ts` (6 providers), `packages/server/src/tools/brio.ts`+`brio.test.ts`, `packages/server/src/routes/health.ts` colibri probe, `shared/simulation_sandbox.py`, `shared/memory_controller.py`, `platforms/skill_synthesizer.py` scaffold; `Target`: `packages/server/src/evolution/` (`observer.ts`→`ledger.ts`) + `packages/server/src/engines/registry.ts` + Shadow/Canary (Phases 1-6 §23) |
| 2 | Public interfaces | `Implemented` / `Target` | `Implemented`: `GET /health` (`colibri:{ok,latencyMs}` 800ms) + `GET /healthz` + `GET /providers` (6) + `GET /gateway/health` (lanes/`hasKey`/`cooldownUntil`) + `POST /tools/brio`/`POST /v1/brio` (22 tools via `registry.ts`) + `GET /mcp`; `Target`: `GET /evolution` + `POST /evolution/:id/{shadow,canary,promote}` + `GET /memory` provenance + `GET /changes` rollback (see `MIRA_UI_EVOLUTION_SPEC.md`) |
| 3 | Events | `Implemented` / `Target` | `Implemented`: `BusEvent` (`packages/server/src/types/index.ts`): `session.*`, `message.*`, `part.*`, `todo.updated`, `job.created/updated/cancelled`, `learning.updated`, `permission.ask/reply`, `cost.warning`, `gateway.fallback`, `server.heartbeat/error`, plus `brio.choice` entropy; `Target`: `evolution.proposed/verified/shadowed/canary/promoted/rolledback` + `heal.started/healed` + `research.completed` ledger stream |
| 4 | Configuration | `Implemented` | `mira.json`/`mira.json.example` (`model`, `loop`, `provider`, `routing`, `subgateways:{default,cheap,vision,local,compaction,agent:ask}`, `guardrails`), `~/.mira/mira.env` `MIRA_TOKEN` 0o600 + `COLI_API_KEY=local`/`NVIDIA_API_KEY`/`FIRECRAWL_API_KEY` via `{env:}`, `opencode.jsonc`, `bunfig.toml` `symlink` + `preserveSymlinks` 6 tsconfigs |
| 5 | Tests | `Implemented` (foundations) / `Target` (longitudinal) | `Implemented`: `packages/server/src/tools/brio.test.ts` 2 pass (mock `:18080`), `gateway/registry.test.ts` 16 pass, full 523 pass/0 fail/2 skip (`MIRA_NO_AUTOPROVISION=1`), `typecheck`+`build`+`repo-hygiene`/`auth-guard` ✅, `slab1/colibri` `3619cf5` `docker` `1m2s`; `Target`: longitudinal benchmarks `task 87%→91%`, `regression 8%→4%`, `latency 12s→9s`, `cost $0.18→0.14` (§16) + `self_healing.test.ts` |
| 6 | Security boundaries | `Implemented` / `Target` | `Implemented`: `MIRA_STRICT_AUTH` fail-closed (prod needs `MIRA_TOKEN`/`MIRA_API_KEYS`), `MIRA_TOKEN` 0o600, `guardrails.enforce` default ON in prod, `MIRA_NO_AUTOPROVISION=1` isolates tokens, web-research untrusted → `Validate→Compare→Proposal→Sandbox` never `Web→Instruction→Modify` (§10); `Target`: autonomy levels 0-5 + P0 Risk Engine + Approval Gates per §23 Phase 2 |
| 7 | Operational procedures | `Implemented` | `scripts/serve-local.sh` `setsid nohup` + `SIGTERM` draining + `mira.log` `truncate -s 0` on 98% + logs `colibri: ready`, `packages/server/scripts/dev-watch.ts` watches `src`+`shared/src`, `scripts/watch-local.sh` watchdog + nightly `backup-db.sh` + weekly `gc-db.ts`, `shared/aether_core.py` hourly pulse, `docs/colibri.md` + `scripts/ci/turbo-tri-state.js` |
| 8 | Migration strategy | `Target` | `Target` §23 Phases: Phase 1 Evolution Core (`observer.ts`→`ledger.ts` minimal `Failure→Ledger`), Phase 2 Safety (Risk/Approval/Resource/Security/Rollback), Phase 3 Engine Registry (9 engines), Phase 4 Shadow (`Telemetry→Candidate→Benchmark`), Phase 5 Canary (`Candidate→Monitor→Promote/Rollback`), Phase 6 Memory Evolution (remember successes+fails); `Implemented` fallback-add `colibri` to `local`/`compaction` |
| 9 | Rollback strategy | `Implemented` (file) / `Target` (system) | `Implemented`: file snapshots `packages/server/src/tools/edit.ts` `snapshotFile`+`undo` + `git revert <sha>` + `mira.json` `saveConfig` fallback; triggers `circuit OPEN` (5→30s) or `costCap` breach or `brio` entropy `>0.8`; `Target`: system rollback `Candidate Version`+`Parent Version`+`Changed Components`+`Deps`+`Migration State`+`Rollback Metadata` per §6 |
| 10 | Known limitations | `Implemented` | `1.3G 98%` disk after `ms-playwright` 270M prune → `headless_shell` only + `logrotate` (`mira.log` `truncate -s 0`); `symlink` vs `hardlink` proot EPERM (`bunfig.toml` `symlink` + `preserveSymlinks` + manual `ln -s picomatch`); `colibri` needs `:8000` else `ok:false` hint; `turbo` `linux-arm64` missing manual `ln -s` cache; `glm-5.2` 372GB needs NVMe streaming, 10-20k prefill slow — use `brio` |
