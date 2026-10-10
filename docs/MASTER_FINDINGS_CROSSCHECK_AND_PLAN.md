# Master Findings — Cross-Check & Prioritized Action Plan

Date: 2026-10-10
Source: `docs/MASTER_FINDINGS_ADDENDUM.md`
Method: Independent codebase audits of `packages/server`, `packages/web`, `packages/tui`, `agents/`, `shared/`.

This document does two things:

1. **Cross-checks** every gap claim in the addendum against the actual code (verdicts: ALREADY EXISTS / PARTIAL / REAL GAP).
2. **Prioritizes** genuine gaps into a sequenced action plan.

---

# Part 1 — Cross-Check Results

## 1.1 Corrections to the Addendum

The addendum is directionally right on strategy but overstates gaps in three areas. Correcting these avoids wasted effort rebuilding what exists.

### Memory architecture — least accurate section (addendum lines 200–232)

The claim that Working/Episodic/Semantic/Procedural memory are "missing" is **false**. All four are explicitly implemented, named, typed, persisted, and UI-filterable:

| Layer             | Verdict        | Evidence                                                                                                                                                                               |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working Memory    | ALREADY EXISTS | `packages/server/src/memory/memory_controller.ts:4-8` (L1 taxonomy), `:467-481` (cognitive packet), `session/prompt.ts:1642,1665-1678`                                                 |
| Episodic Memory   | ALREADY EXISTS | `memory_controller.ts:6,135-302` (`episodic_memory.jsonl`, TF-IDF retrieval), `learning/knowledge.ts:43`                                                                               |
| Semantic Memory   | ALREADY EXISTS | `memory_controller.ts:7,304-371` (S/P/O triples), `learning/knowledge.ts:321-378,691-802` (graph), UI filter `Intelligence.tsx:112-122`                                                |
| Procedural Memory | ALREADY EXISTS | `memory_controller.ts:8,373-465` (skills), `skills/` loader, prompt injection `prompt.ts:1653-1664`                                                                                    |
| Strategic Memory  | **REAL GAP**   | No `MemoryTier` beyond 3 (`knowledge.ts:43`); `upsertActiveTask()` (`learning/ledger.ts:264`) and workspace `kind:'roadmap'` (`workspace/intelligence.ts:15`) have **zero call sites** |

Separation is already explicit at four levels: TypeScript union, SQLite `knowledge_entries.tier` column + index, `memory_search.scope` tool parameter, and the UI tier dropdown. The recommendation "explicitly separate these memory categories" is **already satisfied for 4/5**.

### Self-healing — overstated (addendum lines 51–108)

Infrastructure claimed "missing" substantially exists in `packages/server/src/evolution/` and `packages/server/src/patching/`:

| Claimed gap           | Verdict            | Evidence                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Root Cause Analysis   | PARTIAL            | `evolution/diagnosis.ts:52-97` — regex taxonomy (9 patterns), wired at `routes/evolution.ts:137`. Heuristic only; not auto-triggered on all failures                                                                                                                                       |
| Patch Proposal Engine | PARTIAL            | `evolution/proposal.ts`, `patching/patcher.ts:115-146`, `learning/improvement.ts:99`, Virtual Diff + critic gate (`experiment.ts:70-80`, `agents/critic.md`), rollback points (`evolution/rollback.ts`). Patches are templated notes, not real diffs; rollback not co-emitted per proposal |
| Validation Loop       | **ALREADY EXISTS** | `patching/verifier.ts:52-100` (RCSI "never verified=true unconditionally"), `evolution/{verifier,evaluator}.ts`, governance state machine `PROPOSED→BENCHMARK→SECURITY→CANARY→PROMOTED` with fail-closed promote (`governance/index.ts:105-281`)                                           |
| Confidence Thresholds | PARTIAL            | Detector thresholds gate auto-patch (`detector.ts:52-62`); autonomy gates on **risk** not confidence (`autonomy.ts:70-78`). No unified confidence∧validation∧rollback gate                                                                                                                 |

The honest critique is "heuristic, placeholder, request-driven, and not unified into one enforced policy" — not "missing."

### Enterprise — partially overstated (addendum lines 415–438)

| Claimed gap            | Verdict            | Evidence                                                                                                                                                                                                       |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit Trails           | **ALREADY EXISTS** | `guardrails/index.ts:349-413` AuditLogger, `audit_entries` table (`storage/schema.ts:241-258`), queryable `GET /admin/audit` (`routes/admin.ts:165-219`), wired into every tool call (`tools/registry.ts:442`) |
| Policy Enforcement     | **ALREADY EXISTS** | `policy/engine.ts:46-152` deny-first engine, 5-layer `permission/index.ts`, full `guardrails/` stack. Caveat: default posture is permissive (`enforce: false`)                                                 |
| Multi-Tenant Isolation | PARTIAL            | Per-user owner isolation is real (`MIRA_API_KEYS`, `ownerID` column, session/WS owner filtering). Org-level multi-tenancy missing                                                                              |
| RBAC                   | REAL GAP           | Binary admin (`resolveOwner(bearer)==='default'`, `admin.ts:32-53`); no roles                                                                                                                                  |
| Compliance Layer       | REAL GAP           | Self-patch governance exists; enterprise compliance (retention, redaction, reporting) does not                                                                                                                 |

### Repository understanding — understated (addendum lines 269–294)

Three graphs are built at boot: CodeGraph (AST, `codegraph/`), RepoKnowledgeGraph (`repo/graph.ts`), and SemanticGraph including an **ownership graph** (`repo/semantic.ts:37-57`). The shortfall is **exposure/query surface**, not knowledge-graph existence: `findDependents`, `linkExternal()`, and `dependents()` all have zero callers.

## 1.2 Full Verdict Matrix

| #   | Claim                     | Verdict                                                                                                     |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Root cause analysis       | PARTIAL — regex heuristics, request-driven                                                                  |
| 2   | Patch proposal engine     | PARTIAL — templated, rollback not co-emitted                                                                |
| 3   | Validation loop           | ALREADY EXISTS — fail-closed governance                                                                     |
| 4   | Confidence thresholds     | PARTIAL — risk-keyed, not unified policy                                                                    |
| 5   | Strategic agent layer     | PARTIAL — task-scoped planning only                                                                         |
| 6   | Execution agent layer     | PARTIAL — tools + personas, not a layer                                                                     |
| 7   | Validation agent layer    | PARTIAL — cross-cutting roles                                                                               |
| 8   | Learning agent layer      | PARTIAL — background subsystem, not agentic                                                                 |
| 9   | Working memory            | ALREADY EXISTS                                                                                              |
| 10  | Episodic memory           | ALREADY EXISTS                                                                                              |
| 11  | Semantic memory           | ALREADY EXISTS                                                                                              |
| 12  | Procedural memory         | ALREADY EXISTS                                                                                              |
| 13  | Strategic memory          | REAL GAP                                                                                                    |
| 14  | Decision log              | PARTIAL — audit log ≠ rationale log; `appendDecision()` never called                                        |
| 15  | Approval levels L0–L3     | PARTIAL — three non-aligned schemes; no deploy tier                                                         |
| 16  | Explainability dashboard  | PARTIAL — API exists (`/memory/evolution/:id/explain`), UI dead code (`ProvenancePanel.tsx` never imported) |
| 17  | Project health score      | REAL GAP                                                                                                    |
| 18  | Repository timeline       | REAL GAP — no git-history analysis anywhere                                                                 |
| 19  | Team memory               | PARTIAL — findings real; `decisions.md`/`conventions.md` empty templates                                    |
| 20  | Impact analysis           | PARTIAL — forward deps only; `findDependents` unexposed                                                     |
| 21  | Ownership analysis        | PARTIAL — data built, zero query surface                                                                    |
| 22  | Architectural reasoning   | PARTIAL — scaffolding only                                                                                  |
| 23  | Refactoring safety        | PARTIAL — risky-edit blocking exists; no dead-code analysis                                                 |
| 24  | Beginner/Pro/Expert modes | REAL GAP — all advanced surfaces always visible                                                             |
| 25  | Plugin marketplace        | PARTIAL — **working MCP marketplace exists** (curated, offline, one-click install); general plugins missing |
| 26  | Agent marketplace         | REAL GAP                                                                                                    |
| 27  | Community skill packs     | PARTIAL — local skill system strong (20 packs); distribution missing                                        |
| 28  | Shared knowledge modules  | REAL GAP — in-process singleton only                                                                        |
| 29  | RBAC                      | REAL GAP                                                                                                    |
| 30  | Audit trails              | ALREADY EXISTS (no UI page/export)                                                                          |
| 31  | Compliance layer          | REAL GAP                                                                                                    |
| 32  | Multi-tenant isolation    | PARTIAL — per-user owner isolation; no orgs                                                                 |
| 33  | Policy enforcement        | ALREADY EXISTS (permissive default)                                                                         |
| 34  | Vertical-agent platform   | PARTIAL — multi-agent runtime exists; no verticals/marketplace                                              |

## 1.3 Critical Blockers Discovered

These are bugs/landmines not mentioned in the addendum but which block multiple claimed features:

1. **`WorkspaceIntelligence.upsert()` has zero call sites** (`workspace/intelligence.ts:62`). The `workspace_items` table is created but never populated. Every workspace-derived feature (health score, roadmap, tech-debt, timeline) is structurally incapable of producing data today. This blocks addendum items: Project Health Score, Repository Timeline, Team Memory, Strategic Memory.

2. **`LearningLedger.appendDecision()` has zero callers** (`learning/ledger.ts:237-252`). Decision log never grows at runtime.

3. **`upsertActiveTask()` has zero callers** (`learning/ledger.ts:264-286`). Active-task continuity scaffolding is dead.

4. **Dead UI code**: `ProvenancePanel.tsx`, `AutonomyDial.tsx`, `CustomizationPanel.tsx`, `HumanInLoop.tsx` (TeachAgent/UndoRollback/EditableDraft/BehaviorAdjust), `ConfidenceIndicator`, `CitationChip` — all defined, none rendered. The explainability dashboard and UX modes are blocked half-built.

5. **`GET /memory/evolution/:id/explain` has no caller** in web or TUI.

---

# Part 2 — Prioritized Action Plan

## Priority ordering rationale

- **P0**: Wire existing scaffolding / fix dead code. Highest leverage, lowest effort, unblocks multiple downstream features.
- **P1**: Unified policies and exposure of built-but-unexposed capability (oversight, repo understanding).
- **P2**: New capability with clear differentiation (strategic memory, health score, timeline, UX modes).
- **P3**: Platform/marketplace/enterprise scale work — important but contingent on core identity decision (see Phase 0).

---

## Phase 0 — Decide Core Identity (blocking, decision not code)

The addendum's "Vision Risk" section is correct and is the actual root prioritization problem. The codebase is overwhelmingly a **coding/engineering agent platform** with agent-OS ambitions layered on top.

**Action:** Record one primary identity and one secondary identity. Recommended, based on existing investment:

- **Primary:** Autonomous engineering agent platform (governed self-improvement + deep repo intelligence)
- **Secondary:** Agent-OS substrate for verticals (defer marketplace/vertical work until primary is excellent)

**Deliverable:** A short ADR in `data/memory_bank/decisions.md` (which currently has no writer — see P0.2) or a root-level doc. All subsequent priorities below assume this ordering.

---

## P0 — Unblock Existing Scaffolding (1–2 weeks each, high leverage)

> **Status (2026-10-10): P0.1–P0.4 DONE** — 203/203 related tests pass.

### P0.1 Wire `WorkspaceIntelligence` — ✅ DONE

- Findings → issue items (`writeFinding`/`resolveFinding` + promote route); governance transitions → decision items via bus subscription; `setSharedWorkspace` singleton.
- REST: `GET/POST /workspace/items`, `GET /workspace/items/summary`, `PATCH /workspace/items/:id/status` in `learning/index.ts`.
- Files: `workspace/intelligence.ts`, `tools/findings.ts`, `learning/index.ts:130-176`, tests in `workspace/intelligence.test.ts` (9 tests).

### P0.2 Wire the decision log — ✅ DONE

- `DecisionEntry` gains `evidence[]`/`alternatives[]` (`learning/ledger.ts:27-38`); `appendDecision()` signature fixed (auto-id now reflected in type).
- Call sites: governance terminal transitions (PROMOTED/REJECTED/ROLLED_BACK) + `ApprovalGate.approve/deny` (with optional `rootDir`).
- `GET /learning/decisions` exposes the log. Tests: `learning/ledger.decisions.test.ts` (5 tests).

### P0.3 Rescue dead explainability UI — ✅ DONE

- `ProvenancePanel` (Sources w/ Inject/Forget/Promote) rendered in `SessionTurn.tsx`, replacing static citation chips.
- `ConfidenceIndicator` deliberately NOT wired — `Message` has no confidence field; rendering it would display a misleading default. Requires server-side confidence data first.

### P0.4 Expose built graph queries — ✅ DONE

- New `findDependents` tool (`tools/codegraph.ts`) → impact analysis direction now complete at the tool layer. Tests updated in `codegraph.test.ts`.

### P0.5 Decide on guardrails enforce default

- `GUARDRAILS_SUMMARY.md` confirms `enforce: false` default. Either flip for high-risk classes (path/command) or document the rationale. Security posture claim in the addendum assumes enforcement that is off.

---

## P1 — Unify Policies & Complete Oversight (2–4 weeks)

> **Status (2026-10-10): P1.1, P1.2, P1.3, P1.4, P1.5 DONE.**

### P1.1 Unified self-modification gate — ✅ DONE

- New `evolution/modification-gate.ts`: `checkSelfModificationGate()` (confidence ∧ validation ∧ rollback, fail-closed) + `gateByConfidence()` early arm.
- Wired into `routes/evolution.ts` observe pipeline: low-confidence diagnoses are capped at autonomy `Suggest`; final verdict `verified` is only possible when all three gate checks pass (otherwise `gated`).
- Tests: `evolution/modification-gate.test.ts` (9 tests).

### P1.2 Action-class approval levels (L0–L3) — ✅ DONE

- New taxonomy in `permission/index.ts`: `classifyActionClass()` maps L0 read-only / L1 file-mod / L2 git-op / L3 production-deploy. Git ops no longer share arity-1 with `mkdir`; deploy/publish commands (`kubectl apply`, `terraform apply`, `npm publish`, `vercel --prod`, …) are L3.
- Every `PermissionDecision` now carries `risk.actionClass`; L2/L3 asks get labeled `blastRadius` (`bash (L2 git-operation)`). Explicit allow rules still override (documented contract).
- Tests: 8 new cases in `permission/index.test.ts`.

### P1.3 Real diffs in the patch proposal engine — ✅ DONE

- `ImprovementProposal.rollbackPlan` co-emitted on every proposal (`evolution/proposal.ts`: snapshot/git-revert/config-restore + steps + lossless).
- New `patching/diff.ts`: `synthesizeAppendDiff()` turns recipe notes into anchored unified diffs (a/ b/ headers, last-2-line context, `+` note lines). `Patcher.generate()` now reads real target content and emits `Patch.diff` — never fabricated when the file is unreadable. `Patch.rollbackPlan` co-emitted (incl. manual patches).
- **Honest scope note**: recipes still describe _note-append_ changes, not arbitrary logic rewrites — synthesizing semantic code edits requires LLM-generated diffs, which should ride the existing Virtual Diff + critic gate. Tests: `patching/patcher.diff.test.ts` (7).

### P1.4 Trigger root-cause diagnosis automatically — ✅ DONE

- Governance REJECTED/ROLLED_BACK transitions now auto-run `diagnose()` and write a finding (cascading into workspace issues via P0.1) — `learning/index.ts` bus subscription.

### P1.5 Repo timeline via git history — ✅ DONE

- New `repo/timeline.ts`: bounded git-history analyzer (`analyzeTimeline`, `analyzeTimelineToWorkspace`). Extracts commits, churn hotspots, and regression signals (revert/hotfix/rollback subjects) via `git log` with argv-array invocation (no shell interpolation), hard caps: 500 commits, 100 files/commit, 15s subprocess timeout.
- Hotspots mirror into workspace intelligence as `tech-debt` items (idempotent via kind+title dedup) — composes with the dashboard instead of a parallel store.
- Route: `GET /repo/timeline?limit=&since=&mirror=1` in `mountLearningRoutes`.
- Tests: `repo/timeline.test.ts` (5) against a real fixture git repo; suite skips gracefully where git is absent.

---

## P2 — Differentiating Capability (1–2 months)

> **Status (2026-10-10): P2.1–P2.6 ALL DONE.** Strategic memory shipped as a dedicated goals store (per review feedback — not the dead ledger/workspace scaffolding).

### P2.1 Strategic memory (the one genuinely missing memory layer)

Add a `strategic` tier (or a dedicated goals store) with: goal records, milestones, rationale, status. Wire the existing dead scaffolding: `upsertActiveTask()`, workspace `kind:'roadmap'`, `MemoryTier` union in `learning/knowledge.ts:43`, `memory_search.scope` enum in `tools/memory.ts:13`.

### P2.2 Project Health Score

Aggregate: test coverage signal, guardrail deny rate, open findings by severity, governance regression count, technical-debt workspace items. Must consume P0.1 workspace items. Distinguish clearly from existing `/health` (process) and `/learning/score` (session).

### P2.3 Team memory writers

`decisions.md`, `conventions.md`, `tech_debt.md` are header-only templates injected into every prompt (`session/prompt.ts:1648-1652,1763-1779`) — agents read empty files. Add writers (from P0.2 decisions; convention extraction from successful task patterns; tech-debt from findings). Set `ProvenanceScope = 'team'` on team-level collectors (`memory-evolution/provenance.ts:32`).

### P2.4 UX modes (Beginner / Professional / Expert) — ✅ DONE

- `stores/uxMode.ts`: persisted mode (localStorage, theme pattern) + capability mapping — beginner: work+changes; professional: +missions/intelligence/system; expert: all.
- `UXModeSwitcher` always visible; `TopNav` gains `only` prop (render + keyboard nav gated); App guard redirects away from hidden workspaces on mode switch or deep link.
- Dead `AutonomyDial`/`CustomizationPanel` imports removed from App.tsx.

### P2.5 Agentic agent hierarchy (reframe, don't rebuild) — ✅ DONE

- `agents/layers.ts`: the four layer contracts as types (StrategicLink, ExecutionOutcome) with the previously missing hand-off actually wired: task outcomes feed the learning layer (`recordOutcome` + `logStrategy` RCSI ledger), keyed `agent:<persona>`, with goal attribution.
- `task` tool: optional `goalId` at spawn (strategic→execution link), outcome recorded at all four terminal paths; VERIFIED-only success semantics (unverified work is not evidence of a working strategy).
- Validation layer already real (`VerificationState` on jobs); learning now consumes it. Tests: `agents/layers.test.ts` (9) including end-to-end through the real task tool.

### P2.6 Architectural reasoning / dead-code analysis — ✅ DONE

- `codegraph/analysis.ts`: `analyzeRemovalSafety` — verdicts safe/caution/unsafe from graph evidence (reverse imports, cross-file calls of exported symbols, entry-point heuristic). Blind spots documented in output (`checked` list).
- New `findDeclarationsInFile` CodeGraph query; `analyzeRemoval` agent tool registered. Tests: 7 new in `codegraph.test.ts` (26 total).
- Architect-rationale persistence: covered transitively — P0.2's decision log + P2.3's decisions.md writer capture rationale; template-produced rationale flows there via the standard `appendDecision` call sites.

---

## P3 — Platform & Enterprise (defer until Phase 0 identity is settled)

Order within P3 assumes primary identity = engineering agent platform.

### P3.1 RBAC

Replace binary admin-vs-owner (`admin.ts:32-53`) with role primitives: viewer / operator / admin, org-scoped. Prerequisite for any multi-user story.

### P3.2 Audit trail UI + export

Backend exists (`GET /admin/audit`). Add a page and CSV/JSON export. Low effort, high enterprise credibility.

### P3.3 Org multi-tenancy

Extend per-user owner isolation (already solid) with org entities, org-scoped resources, org admin. Larger change — schema + session stamping + WS filtering.

### P3.4 Community distribution (skills → agents → knowledge modules)

Sequenced by existing substrate strength: skills (20 local packs, loader done) → agents (templates + custom agents done) → knowledge modules (needs export format). Build a publish/install flow on top of the existing MCP marketplace pattern (`mcp/marketplace.ts`) rather than from scratch. Remote registry (currently offline-only, per its own comment) is the natural extension point.

### P3.5 Compliance layer

Retention, redaction, policy-violation reporting. Only meaningful with P3.1–P3.3 in place.

### P3.6 Vertical agents

Runtime substrate exists (templates, custom agents from `mira.json`, subagents, engine registry). Domain agents (Luxora, research, business) are pure greenfield. Do not start until P0–P2 are solid and Phase 0 identity is settled — this is the addendum's "platform model" bet and should be a deliberate second product, not a distraction.

---

## What NOT to build (based on cross-check)

- **Memory layers for Working/Episodic/Semantic/Procedural** — already built; invest in Strategic only.
- **A validation loop for self-patches** — exists and is fail-closed; invest in unifying the gate (P1.1), not rebuilding verification.
- **Audit trail backend** — exists; build the UI (P3.2).
- **A new MCP marketplace** — exists offline-curated; extend it (P3.4).
- **A new multi-agent runtime** — exists; add layer interfaces (P2.5) instead of new infrastructure.

---

## Summary Sequence

```
Phase 0  Decide identity (ADR)
P0       Wire dead scaffolding → unblock 6 downstream features
P1       Unify gates + complete oversight (approval levels, real diffs, auto-RCA, timeline)
P2       Differentiate (strategic memory, health score, team memory, UX modes, layer interfaces)
P3       Scale (RBAC, audit UI, orgs, distribution, compliance, verticals)
```

The through-line: **most of the addendum's "missing" infrastructure is half-wired, not absent.** P0 alone converts a large share of REAL GAPs into PARTIAL/ALREADY EXISTS at minimal cost, and is the highest-leverage work available.
