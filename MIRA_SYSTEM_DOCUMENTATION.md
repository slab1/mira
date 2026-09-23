# Mira System Documentation

**Status:** Architecture and product baseline
**Review Date:** 2026-09-23

## 1. Purpose

Mira is an AI engineering agent platform designed to help users understand, build, modify, test, operate, and improve software systems.

Mira combines:

* AI agents
* Persistent memory
* Tool execution
* Code intelligence
* Planning
* Research
* Evaluation
* Safe code modification
* Diagnostics
* Recovery
* Controlled system evolution

The long-term product thesis is:

> Mira should not merely use AI to perform engineering work. Mira should use engineering feedback to improve how Mira performs engineering work.

## 2. System Lifecycle

The intended lifecycle is:

```text
Observe
  ↓
Learn / Research
  ↓
Diagnose
  ↓
Plan
  ↓
Experiment
  ↓
Patch
  ↓
Verify
  ↓
Canary
  ↓
Promote / Roll Back
  ↓
Remember
```

## 3. Current Architecture

The current system broadly follows:

```text
Clients
   ↓
API / SSE / WebSocket
   ↓
Agent Runtime / Sessions
   ↓
Gateway / Model Routing
   ↓
Tool Registry
   ↓
Permissions / Guardrails
   ↓
Filesystem / Shell / Diagnostics / LSP / MCP / Subagents
   ↓
SQLite / Knowledge / Events
```

## 4. Existing Capabilities

Repository review identified existing foundations including:

* Model gateway
* Agent sessions
* Memory and knowledge systems
* Tool registry
* Permissions and guardrails
* MCP integration
* LSP/code intelligence
* Child sessions and orchestration
* Diagnostics
* Evaluation
* Durable queue/state
* File snapshots
* Revert functionality
* Online research
* Runtime/tunnel watchdog
* Web research providers
* Research persistence

These capabilities form the foundation for the next architecture layer.

## 5. Target Architecture

The target architecture should progressively separate responsibilities:

```text
packages/
├── core/
│   ├── agent-runtime/
│   ├── task-engine/
│   └── orchestration/
│
├── memory/
│   ├── project-memory/
│   ├── team-memory/
│   ├── organizational-memory/
│   └── retrieval/
│
├── intelligence/
│   ├── code-intelligence/
│   ├── planning/
│   └── learning/
│
├── agents/
│   ├── architect/
│   ├── developer/
│   ├── reviewer/
│   ├── tester/
│   ├── security/
│   └── devops/
│
├── tools/
│   ├── mcp/
│   ├── lsp/
│   └── integrations/
│
├── governance/
│   ├── permissions/
│   ├── guardrails/
│   └── audit/
│
└── observability/
    ├── tracing/
    ├── evaluations/
    └── analytics/
```

This is a target architecture and should be introduced incrementally rather than through a large rewrite.

## 6. Memory Model

Mira should maintain multiple memory layers.

### Session Memory

Short-lived context required for the active task.

### Project Memory

Architecture, conventions, dependencies, decisions, important files and project-specific knowledge.

### Team Memory

Shared engineering practices and decisions.

### Organizational Memory

Long-term knowledge across projects.

### Procedural Memory

Reusable engineering procedures and workflows.

### Failure Memory

Records of failed approaches, rejected patches, regressions, causes and recovery strategies.

Failure memory is particularly important for self-improvement.

## 7. Agent Model

Every major agent should have an explicit identity and operating contract.

```ts
interface AgentDefinition {
  id: string
  purpose: string
  instructions: string
  model: string
  tools: string[]
  permissions: string[]
  budget?: {
    tokens?: number
    timeMs?: number
    cost?: number
  }
  verification: string[]
  escalationPolicy: string
}
```

## 8. Tool Security

Tools must operate under explicit permissions.

Rules:

* Fail closed.
* Validate paths.
* Validate commands.
* Restrict filesystem access.
* Audit sensitive operations.
* Snapshot mutations.
* Isolate experiments.
* Do not expose secrets.
* Treat external web content as untrusted.
* Require human approval for high-risk actions.

## 9. Evaluation

Mira should evaluate engineering changes using multiple dimensions:

* Correctness
* Regression safety
* Security
* Performance
* Latency
* Cost
* Reliability
* Maintainability
* User/task success

No single metric should determine whether an autonomous change is promoted.

## 10. Reversibility

Every autonomous mutation should have a recovery path.

Existing snapshots/revert functionality provides an important foundation.

The intended flow is:

```text
Mutation
  ↓
Snapshot
  ↓
Experiment
  ↓
Verification
  ↓
Accept
     OR
Rollback
```

## 11. Shadow Mira

A future Shadow Mira environment should allow experimental versions of Mira to operate against representative workloads without affecting production.

```text
Production Mira
      ↓
Telemetry
      ↓
Shadow Mira
      ↓
Candidate Engine
      ↓
Benchmarks
      ↓
Shadow Evaluation
      ↓
Canary
      ↓
Production
```

## 12. Definition of Done

A major Mira subsystem is not complete until it has:

* Implementation
* Public interface
* Tests
* Security boundaries
* Observability
* Error handling
* Documentation
* Migration strategy
* Rollback strategy
* Operational guidance
