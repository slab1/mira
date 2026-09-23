# Mira UI Implementation Roadmap

**Status:** Implementation Plan
**Date:** 2026-09-23

## Phase 1 — Information Architecture

### Goals

Reduce navigation complexity.

### Tasks

* Create five primary workspaces.
* Consolidate secondary features.
* Simplify header.
* Establish consistent navigation.
* Define shared route structure.

```text
/work
/missions
/intelligence
/changes
/system
/evolution
```

---

# Phase 2 — Mission Control

Build the autonomous execution cockpit.

### Tasks

* Mission overview
* Parent/child agents
* Agent states
* Current operation
* Tool activity
* Files changed
* Token usage
* Cost
* Pause/cancel
* Transcript

---

# Phase 3 — Agent Activity

Create human-readable execution stages.

```text
Planning
Research
Implementation
Testing
Verification
Completed
```

Technical details remain expandable.

---

# Phase 4 — Memory Provenance

Add:

* Source
* Evidence
* Confidence
* Timestamp
* Scope
* Explainability
* Forget
* Correct
* Promote

Primary UX question:

> Why did Mira know or choose this?

---

# Phase 5 — Changes

Create:

* Change timeline
* Diff viewer
* Snapshot viewer
* Rewind
* Rollback
* Compare versions

Every autonomous mutation should be traceable.

---

# Phase 6 — Cost Cockpit

Implement:

* Session cost
* Mission cost
* Agent cost
* Model cost
* Tool cost
* Token usage
* Budget
* Cost trends

---

# Phase 7 — Error and Permission UX

Replace generic errors with structured incidents.

Implement permission explanations:

```text
Action
Reason
Risk
Policy
Options
```

---

# Phase 8 — Evolution UI

Implement:

* Evolution dashboard
* Improvement candidates
* Evidence
* Research
* Experiments
* Benchmarks
* Shadow
* Canary
* Promotion
* Rollback
* Evolution history

---

# Phase 9 — Mobile

Create dedicated mobile navigation:

```text
Chat
Missions
Memory
Changes
More
```

Avoid simply stacking the desktop layout.

---

# Phase 10 — TUI Parity

Align Web and TUI around shared concepts.

```text
/new
/sessions
/jobs
/queue
/memory
/changes
/undo
/cost
/agents
/models
/research
/evolution
/settings
```

---

# Phase 11 — Accessibility

Implement and test:

* Keyboard navigation
* Focus management
* Semantic controls
* ARIA labels
* Screen-reader announcements
* Keyboard shortcuts
* Contrast
* Reduced motion
* Accessible errors
* Accessible status updates

---

# Phase 12 — Validation

Before declaring the redesign complete, test these workflows:

### Workflow 1 — Normal Task

```text
User request
→ Planning
→ Implementation
→ Testing
→ Completion
```

### Workflow 2 — Failed Task

```text
Failure
→ Diagnosis
→ Recovery
→ Verification
```

### Workflow 3 — Autonomous Change

```text
Proposal
→ Snapshot
→ Experiment
→ Verification
→ Diff
→ Approval
```

### Workflow 4 — Memory

```text
Question
→ Retrieval
→ Evidence
→ Decision
```

### Workflow 5 — Evolution

```text
Failure pattern
→ Research
→ Improvement
→ Experiment
→ Benchmark
→ Shadow
→ Canary
```

---

# Final Product Model

The completed Mira UI should communicate:

```text
                 MIRA
                  │
       ┌──────────┴──────────┐
       │                     │
      WORK                 THINK
       │                     │
 Chat / Files        Memory / Research
 Terminal            Learning / Planning
       │                     │
       └──────────┬──────────┘
                  │
               EXECUTE
                  │
          Missions / Agents
                  │
               VERIFY
                  │
        Tests / Evaluation
                  │
               IMPROVE
                  │
       Evolution / Shadow
                  │
              REMEMBER
```

The UI is complete when the user can understand this entire lifecycle without needing to understand Mira's internal code architecture.

## Documentation Maintenance — 10 items

> **Status:** `Target` (plan) — roadmap is incremental; each phase becomes `Implemented` when its workspace backs real `packages/server/src/*` routes + `BusEvent` evidence.

| # | Item | Status | Evidence (path / interface) |
|---|------|--------|------------------------------|
| 1 | Implementation path | `Target` (with `Implemented` reference) | `Target` roadmap phases map to `packages/server/src/evolution/` (`observer.ts`→`ledger.ts`) + `packages/server/src/engines/registry.ts` + `packages/web/src/pages/{Work,Missions,Intelligence,Changes,System,Evolution}.tsx`; `Implemented` reference: `packages/web/src/pages/Brio.tsx` 1064 lines + `packages/server/src/tools/brio.ts` slice pattern |
| 2 | Public interfaces | `Target` | `Target` per-phase routes: Phase 2 `GET /missions/:id` (`Parent/child agents` `Tool activity` `Token cost` `Pause/cancel`), Phase 4 `GET /memory` provenance (`Source`+`Confidence`), Phase 5 `GET /changes` (`Diff`/`Rewind`), Phase 6 `GET /cost` cockpits, Phase 8 `GET /evolution` + `GET /evolution/:id` + `POST /evolution/:id/{shadow,canary,promote}`; `Implemented`: `GET /health`/`GET /gateway/health`/`POST /tools/brio` |
| 3 | Events | `Implemented`/`Target` | `Implemented`: `BusEvent` suite (`session.created/updated/deleted`, `message.created`, `part.updated`, `todo.updated`, `job.created/updated/cancelled`, `learning.updated`, `cost.warning`, `gateway.fallback`, `server.heartbeat`) in `packages/server/src/types/index.ts` + `packages/server/src/bus/index.ts`; `Target`: `evolution.*` + `memory.promoted`/`forgotten` + `change.rolledback` for Phases 4-8 |
| 4 | Configuration | `Target` | `Target`: `mira.json` `features:{work,memory,changes,cost,evolution,mobile,a11y}` + `routing` canary `5%` + `subgateways` per lane; `opencode.jsonc` workspace toggles + `~/.mira/mira.env` `MIRA_TOKEN`; `Implemented`: `mira.json.example` `provider:colibri` + `routing.fallbacks` pattern |
| 5 | Tests | `Target` | `Target` per-workflow (Roadmap §12): W1 Normal `Planning→Implementation→Testing→Completion`, W2 Failed `Diagnosis→Recovery→Verification`, W3 Autonomous `Proposal→Snapshot→Experiment→Diff→Approval`, W4 Memory `Question→Retrieval→Evidence→Decision`, W5 Evolution `Failure→Research→Benchmark→Shadow→Canary` (playwright `Evolution.spec.ts`); `Implemented`: `brio.test.ts` 2 pass mock template |
| 6 | Security boundaries | `Target` | `Target`: `MIRA_STRICT_AUTH` gate for `POST /evolution/:id/{promote,canary}`, permission incident model (`Action`/`Reason`/`Risk`/`Policy`/`Options` per Phase 7), fail-closed `permission.ask` via `Bus`, autonomy levels 0-5 human approval for `Security`/`Permissions`/`Auth`/`Destructive DB` changes |
| 7 | Operational procedures | `Target` | `Target`: `scripts/serve-local.sh` + `packages/server/scripts/dev-watch.ts` watches `src`+`shared/src` + `scripts/watch-local.sh` watchdog + `shared/aether_core.py` pulse feed Evolution; incremental phases avoid big rewrite (§5 Target Architecture); `Implemented`: `serve-local.sh` `setsid nohup` + `GET /health` probe as template |
| 8 | Migration strategy | `Target` | `Target`: Phases 1→12 incremental (Information Architecture → Mission Control → Agent Activity stages `Planning`→`Completed` → Memory Provenance → Changes → Cost Cockpit → Error/Permission UX → Evolution UI → Mobile → TUI Parity → A11y → Validation) with shared route structure `/work`/`/missions`/…; reuse `Brio.tsx` slice before full `EvolutionDashboard` |
| 9 | Rollback strategy | `Target` | `Target`: `git revert` per-phase + `saveConfig` disable feature flag + `BusEvent` `server.error`/`gateway.fallback` triggers canary rollback; file snapshots foundation in `MIRA_SYSTEM_DOCUMENTATION.md` §10 Reversibility + `packages/server/src/tools/edit.ts` `snapshotFile`+`undo` |
| 10 | Known limitations | `Target` | `Target` plan assumes P0 gaps closed (`MIRA_WEAKNESSES_AND_OBSTACLES.md` §21 Controlled self-evolution/Shadow/Canary); carry-forward `Implemented` limits: `symlink` vs `hardlink` proot EPERM (`bunfig.toml` `preserveSymlinks` + manual `ln -s picomatch`), `1.3G 98%` disk (`headless_shell` only + `logrotate`), `colibri` needs `:8000` |
