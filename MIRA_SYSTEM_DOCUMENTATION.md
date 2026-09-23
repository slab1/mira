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

## Documentation Maintenance — 10 items (per subsystem)

> **Status:** `Implemented` baseline (2026-09-23) — every `Target`→`Implemented` subsystem must fill this table before promotion (eval-gated, canary-rolled). Example: `Brio` `1dc2ca45`/`19cf9641`/`c34759a8` with path `packages/server/src/tools/brio.ts`.

| # | Item | Status | Evidence (path / interface) |
|---|------|--------|------------------------------|
| 1 | Implementation path | `Implemented` | Baseline: `packages/server/src/config/defaults.ts` (6 providers `nvidia`/`anthropic`/`openai`/`google`/`deepseek`/`colibri`), `packages/server/src/tools/brio.ts`, `packages/server/src/routes/health.ts`, `packages/server/src/bus/index.ts`, `shared/memory_controller.py` HCM, `shared/simulation_sandbox.py`, `platforms/skill_synthesizer.py` scaffold |
| 2 | Public interfaces | `Implemented` | `GET /health` (`colibri:{ok,baseURL,latencyMs\|error}` 800ms) + `GET /healthz` + `GET /providers` (6) + `GET /gateway/health` (lanes+`hasKey`+`cooldownUntil`) + `POST /tools/brio`/`POST /v1/brio` + `GET /mcp`/`POST /tools/*` (22 tools) + `GET /health` terminal probe |
| 3 | Events | `Implemented` | `BusEvent<T>` (`packages/server/src/types/index.ts`): `session.created/updated/deleted/abort`, `message.created/updated`, `part.created/updated`, `todo.updated`, `job.created/updated/cancelled`, `learning.updated`, `permission.ask/reply`, `question.ask/reply`, `cost.warning`, `model.retired`, `gateway.fallback`, `server.heartbeat/error`, `github.webhook`, `config.updated` + `brio.choice` |
| 4 | Configuration | `Implemented` | `mira.json`/`mira.json.example` (`model`, `loop`, `provider:{nvidia,anthropic,openai,google,deepseek,colibri}`, `routing`, `subgateways:{default,cheap,vision,local,compaction,agent:ask}`, `agents`, `guardrails`), `~/.mira/mira.env` (0o600, `MIRA_TOKEN`/`MIRA_API_KEYS`/`COLI_API_KEY`/`NVIDIA_API_KEY`), `opencode.jsonc`, `bunfig.toml` (`symlink` + `preserveSymlinks` 6 tsconfigs) |
| 5 | Tests | `Implemented` | `packages/server/src/tools/brio.test.ts` 2 pass (mock `Bun.serve :18080` `POST /v1/brio`), `gateway/registry.test.ts` 16 pass, full suite 523 pass /0 fail/2 skip (`MIRA_NO_AUTOPROVISION=1` 276s), `typecheck` 6 tsconfigs `preserveSymlinks` + `build` + `repo-hygiene`/`auth-guard` ✅ |
| 6 | Security boundaries | `Implemented` | `MIRA_TOKEN` (`~/.mira/mira.env` 0o600, `MIRA_STRICT_AUTH` prod fail-closed), `MIRA_NO_AUTOPROVISION=1` isolates host token in E2E (3×), `COLI_API_KEY=local` loopback, `FIRECRAWL_API_KEY` `{env:}` expansion, guardrails fail-closed `allowedRoots`/`blockedPaths`/`blockedCommands` + `snapshotFile` before mutations |
| 7 | Operational procedures | `Implemented` | `scripts/serve-local.sh` (`setsid nohup` `SIGTERM` draining, `:4096` `tools:22` `providers:6` logs `colibri: ready`), `packages/server/scripts/dev-watch.ts` watches `src`+`shared/src`, `scripts/watch-local.sh` watchdog + nightly `backup-db.sh` + weekly `gc-db.ts`, `shared/aether_core.py` hourly pulse, `docs/colibri.md` quick-start |
| 8 | Migration strategy | `Implemented` / `Target` | `Implemented`: add `colibri/*` to `subgateways.local/compaction.fallback` (`nvidia` stays primary); `Target`: `Evolution Core` `packages/server/src/evolution/` (`observer`→`ledger`) + `Engine Registry` `packages/server/src/engines/registry.ts` + `Shadow Mira` + `Canary` (see `MIRA_WEAKNESSES_AND_OBSTACLES.md` Phases 1-5), `auto-model routing` Kilo K8 `Target` |
| 9 | Rollback strategy | `Implemented` | `git revert <sha>` (e.g. `1dc2ca45`/`19cf9641`/`c34759a8` Brio promotion) + `mira.json` `saveConfig` fallback + `snapshotFile` `undo` to message; rollback triggers `circuit OPEN` (5 failures→30s `cooldownUntil` in `gateway/health`) or `costCap` breach or `brio` entropy `>0.8` |
| 10 | Known limitations | `Implemented` | Needs `:8000` else `colibri:{ok:false}` hint `COLI_MODEL=/data/olmoe ./colibri/c/coli serve --port 8000`; `symlink` vs `hardlink` proot EPERM (`bunfig.toml` `symlink` + manual `ln -s picomatch` to cache); `1.3G 98%` disk after `ms-playwright` 270M prune (`headless_shell` only + `logrotate` `mira.log`); `glm-5.2` 372GB needs NVMe streaming, 10-20k prefill slow — use `brio` for triage |
