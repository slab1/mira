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

| #   | Claim                     | Verdict                                                                                                                                                                          |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Root cause analysis       | PARTIAL — regex heuristics, request-driven                                                                                                                                       |
| 2   | Patch proposal engine     | PARTIAL — templated, rollback not co-emitted                                                                                                                                     |
| 3   | Validation loop           | ALREADY EXISTS — fail-closed governance                                                                                                                                          |
| 4   | Confidence thresholds     | PARTIAL — risk-keyed, not unified policy                                                                                                                                         |
| 5   | Strategic agent layer     | PARTIAL — task-scoped planning only                                                                                                                                              |
| 6   | Execution agent layer     | PARTIAL — tools + personas, not a layer                                                                                                                                          |
| 7   | Validation agent layer    | PARTIAL — cross-cutting roles                                                                                                                                                    |
| 8   | Learning agent layer      | PARTIAL — background subsystem, not agentic                                                                                                                                      |
| 9   | Working memory            | ALREADY EXISTS                                                                                                                                                                   |
| 10  | Episodic memory           | ALREADY EXISTS                                                                                                                                                                   |
| 11  | Semantic memory           | ALREADY EXISTS                                                                                                                                                                   |
| 12  | Procedural memory         | ALREADY EXISTS                                                                                                                                                                   |
| 13  | Strategic memory          | REAL GAP                                                                                                                                                                         |
| 14  | Decision log              | PARTIAL — audit log ≠ rationale log; `appendDecision()` never called                                                                                                             |
| 15  | Approval levels L0–L3     | PARTIAL — three non-aligned schemes; no deploy tier                                                                                                                              |
| 16  | Explainability dashboard  | PARTIAL — API exists (`/memory/evolution/:id/explain`), UI dead code (`ProvenancePanel.tsx` never imported)                                                                      |
| 17  | Project health score      | REAL GAP                                                                                                                                                                         |
| 18  | Repository timeline       | REAL GAP — no git-history analysis anywhere                                                                                                                                      |
| 19  | Team memory               | PARTIAL — findings real; `decisions.md`/`conventions.md` empty templates                                                                                                         |
| 20  | Impact analysis           | PARTIAL — forward deps only; `findDependents` unexposed                                                                                                                          |
| 21  | Ownership analysis        | PARTIAL — data built, zero query surface                                                                                                                                         |
| 22  | Architectural reasoning   | PARTIAL — scaffolding only                                                                                                                                                       |
| 23  | Refactoring safety        | PARTIAL — risky-edit blocking exists; no dead-code analysis                                                                                                                      |
| 24  | Beginner/Pro/Expert modes | REAL GAP — all advanced surfaces always visible                                                                                                                                  |
| 25  | Plugin marketplace        | PARTIAL — **working MCP marketplace exists** (curated, offline, one-click install); general plugins missing                                                                      |
| 26  | Agent marketplace         | REAL GAP                                                                                                                                                                         |
| 27  | Community skill packs     | PARTIAL — local skill system strong (20 packs); distribution missing                                                                                                             |
| 28  | Shared knowledge modules  | REAL GAP — in-process singleton only                                                                                                                                             |
| 29  | RBAC                      | REAL GAP                                                                                                                                                                         |
| 30  | Audit trails              | ALREADY EXISTS (no UI page/export)                                                                                                                                               |
| 31  | Compliance layer          | REAL GAP                                                                                                                                                                         |
| 32  | Multi-tenant isolation    | PARTIAL — org tenancy shipped (P3.3); per-user orgless isolation holds. Org-unscoped resources (findings, snapshots, workspace items, knowledge) still global — pre-existing gap |
| 33  | Policy enforcement        | ALREADY EXISTS (permissive default)                                                                                                                                              |
| 34  | Vertical-agent platform   | PARTIAL — multi-agent runtime exists; no verticals/marketplace                                                                                                                   |

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

## Phase 0 — Decide Core Identity (blocking, decision not code) — ✅ DONE

The addendum's "Vision Risk" section is correct and is the actual root prioritization problem. The codebase is overwhelmingly a **coding/engineering agent platform** with agent-OS ambitions layered on top.

**Action:** Record one primary identity and one secondary identity. Recommended, based on existing investment:

- **Primary:** Autonomous engineering agent platform (governed self-improvement + deep repo intelligence)
- **Secondary:** Agent-OS substrate for verticals (defer marketplace/vertical work until primary is excellent)

**Resolved (2026-10-11):** owner confirmed the recommendation. ADR recorded at `docs/ADR/0001-core-identity.md`. All subsequent priorities below follow this ordering.

---

## P0 — Unblock Existing Scaffolding (1–2 weeks each, high leverage)

> **Status (2026-10-10): P0.1–P0.5 DONE.**

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

### P0.5 Decide on guardrails enforce default — ✅ DONE

- `GUARDRAILS_SUMMARY.md` documented `enforce: false` default; the addendum assumed enforcement that is off. **Resolution:** `guardrails/index.ts` now resolves enforcement per call — explicit `MIRA_GUARDRAILS_ENFORCE` > per-project `config.guardrails.enforce` > **production default = fail-closed (enforced)** > dev fail-open-with-warn. A boot warning fires (`warnIfEnforcementOffInProduction`) if enforcement is disabled in a production-looking environment, so the fail-open state is never silent.
- High-risk classes (path/command) are covered by the sandbox/allowlist checks themselves; the enforced-by-default-in-production posture closes the security gap without breaking local DX.

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

### P2.1 Strategic memory (the one genuinely missing memory layer) — ✅ DONE

Add a `strategic` tier (or a dedicated goals store) with: goal records, milestones, rationale, status. Wire the existing dead scaffolding: `upsertActiveTask()`, workspace `kind:'roadmap'`, `MemoryTier` union in `learning/knowledge.ts:43`, `memory_search.scope` enum in `tools/memory.ts:13`.

- Shipped as a dedicated goals store: `strategic/goals.ts` (`strategic_goals` table: goal records, rationale, milestones, status, priority), `tools/goals.ts` (`goal_write`/`goal_list`/`goal_update` agent tools), injected into every prompt via `sharedGoals` (`session/prompt.ts`), consumed by the agent layer (`agents/layers.ts` STRATEGIC→EXECUTION link, `learning/index.ts`).

### P2.2 Project Health Score — ✅ DONE

Aggregate: test coverage signal, guardrail deny rate, open findings by severity, governance regression count, technical-debt workspace items. Must consume P0.1 workspace items. Distinguish clearly from existing `/health` (process) and `/learning/score` (session).

- `workspace/health.ts` `computeProjectHealth()`: components for guardrail deny rate (audit_entries), open findings by severity, governance regressions, tech-debt workspace items; exposed at `GET /workspace/health` (distinct from `/health` and `/learning/score`, `learning/index.ts:392`). Tests: `workspace/health.test.ts`.

### P2.3 Team memory writers — ✅ DONE

`decisions.md`, `conventions.md`, `tech_debt.md` are header-only templates injected into every prompt (`session/prompt.ts:1648-1652,1763-1779`) — agents read empty files. Add writers (from P0.2 decisions; convention extraction from successful task patterns; tech-debt from findings). Set `ProvenanceScope = 'team'` on team-level collectors (`memory-evolution/provenance.ts:32`).

- `appendDecision()` mirrors human-readable entries into `decisions.md` (`learning/ledger.ts:287`); timeline hotspots mirror into `tech_debt.md` (`repo/timeline.ts:178`); `tools/team_memory.ts` covers conventions writes (manual + pattern capture). Tests: `memory/team_memory.test.ts`.

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

## P3 — Platform & Enterprise

> **Status (2026-10-11): P3.1–P3.5 DONE — under the recommended primary identity
> (autonomous engineering agent platform). P3.6 authorized (ADR 0001 amendment)
> and DONE — the full P0–P3 sequence is complete.**

Order within P3 assumes primary identity = engineering agent platform.

**Operational note (GitHub Codespaces devcontainer):** this workspace has 8GB
RAM, no swap. The VS Code remote stack + agent processes leave ~2GB headroom;
full-suite test runs and multi-package eslint in the same command can OOM and
get killed by the kernel (looks like an "abort"). Working rules that kept
sessions healthy:

- Run targeted test files (`bun test src/<area>/...`), not the full suite, in
  the same command as builds or lint
- Commit in small batches so lint-staged lints fewer files per invocation
- On mysterious command kills: check `free -m` and `ps aux --sort=-%rss` — stale
  VS Code extension-host zombies from reconnects can hold ~1GB; kill only
  low-CPU-time ones and never the long-running active host

### P3.1 RBAC — ✅ DONE

- `auth/roles.ts`: viewer / operator / admin primitives; `MIRA_API_KEYS=key:owner[:role]` (backward compatible — 2-segment keys stay operator; non-role colons in owners preserved).
- `resolveRole()` wired: middleware blocks viewer writes globally (403 on non-GET/HEAD/OPTIONS); `isAdmin` is role-backed (master token + explicitly-roled admins); mint accepts/stores role (idempotent `role` column), list shows it, revoke cleans it up; `GET /me` exposes the caller's role for UI adaptation.
- Tests: `auth/roles.test.ts` (7), `middleware/rbac.test.ts` (6), admin route tests extended (5).

### P3.2 Audit trail UI + export — ✅ DONE

- `GET /admin/audit/export?format=csv|json` — same filters as `/admin/audit`, 10k row cap, Content-Disposition attachment; CSV escapes per RFC 4180. Tests cover CSV shape, JSON filters, format validation, auth gate.
- UI shipped in the System workspace: `components/AuditTrail.tsx` — filterable table (tool / decision / sessionID / limit), decision badges, and CSV/JSON export honoring current filters. Admin-gated server-side; non-admins see a role note instead of data (401/403 handled without clearing valid tokens).

### P3.3 Org multi-tenancy — ✅ DONE

Extend per-user owner isolation (already solid) with org entities, org-scoped resources, org admin. Larger change — schema + session stamping + WS filtering.

- **Schema**: `orgs` + `org_members` tables (`storage/schema.ts`, `storage/db.ts` DDL + idempotent adds); `sessions.org_id` column + index. Single-org-per-owner enforced (`UNIQUE(owner)`) so owner → org is a function — session stamping and access checks stay deterministic.
- **Stamping**: sessions record the creating owner's org at creation (REST create, both import paths); subagent/fork children inherit it. Stamps are immutable — membership changes alter access, never history.
- **Access rule** (`auth/session-access.ts`, one shared predicate): readable ⟺ ownerless (legacy/shared) ∨ owner match ∨ same-org member. Wired into GET /session lists, the per-session `authorizedSession` gate (extracted — was duplicated twice in index.ts), /jobs, /manager, and WS event delivery. Foreign resources 404 (no existence leaks).
- **Org management** (`routes/orgs.ts`): platform admin creates orgs (first org admin designated or self); org admins manage membership; members read. Live in-memory mirrors (boot-loaded from db, mutated on write) mirror the API_KEY_OWNERS pattern — membership changes apply immediately.
- **Identity/presence**: `GET /me` exposes `org` alongside `role`; the prompt pipeline now threads the driving owner through `LoopOptions.callerOwner` — when a same-org member runs a colleague's session the agent is told who is present and addresses them by name (`config/prompt.ts` presence line; the default-name `'user'` still never leaks into prompts).
- **Honest scope notes**: findings, file_snapshots, workspace_items and knowledge_entries remain owner-unscoped (pre-existing gap, orthogonal to orgs — flagged in §1.3 and still open); orgs are DB-managed via REST (like minted API keys) — env-only `MIRA_API_KEYS` deployments gain orgs only after an admin mints keys / uses the db.
- Tests: `routes/orgs.test.ts` (21), `routes/session-org.test.ts` (16), `config/prompt.test.ts` presence cases (5).

### P3.4 Community distribution (skills → agents → knowledge modules) — ✅ DONE

Sequenced by existing substrate strength: skills (20 local packs, loader done) → agents (templates + custom agents done) → knowledge modules (needs export format). Build a publish/install flow on top of the existing MCP marketplace pattern (`mcp/marketplace.ts`) rather than from scratch. Remote registry (currently offline-only, per its own comment) is the natural extension point.

- **Generic registry** (`community/registry.ts`): one catalog loader over three kinds (skill/agent/knowledge) reusing the MCP marketplace shape — committed JSON + embedded fallback + module cache + `resetRegistryCache()` + search scoring. Catalogs: `community-{skill,agent,knowledge}-registry.json` (14 skill packs, 4 agent personas, 3 knowledge modules).
- **Install targets are live-loaded — no restart**: skills → `<cwd>/.mira/skills/<name>.md` (the dir the skills loader already scans; same writer shape as learning promotion), agents → `mira.json → agents` (merged per call by `getAgentTemplates`), knowledge → `KnowledgeBase.store` entries.
- **Routes** (`routes/community.ts`): `GET /community/registry?kind=&q=&limit=` (q validated with `sanitizePath`, limit 1–50), `POST|DELETE /community/skills/:name`, `POST|DELETE /community/agents/:name`, `POST /community/knowledge/:name` (seed-only — uninstalling memories is deliberately out of scope), `GET /community/skills` (installed list). All writes cwd-scoped via the same `resolveCwd` contract as `PATCH /config` (sanitize + allowedRoots 403).
- **UI**: Settings → Community tab (`components/CommunityPanel.tsx`) — kind filter, search, install/remove, installed-skill state.
- **Correctness fixes found while building** (each caught by a test): popularity alone must not count as a search match (the MCP marketplace has this flaw — noted, not changed); `saveConfig` deep-merges so removing a key silently keeps it → new `removeAgentFromConfig()` mirroring `removeMcpFromConfig`; unknown catalog kind returns `[]` instead of `undefined`.
- **Honest scope notes**: offline-curated only — no remote registry fetch (same posture as the MCP marketplace, which its own comment names as the extension point); knowledge modules are seed-only with no provenance gate beyond `user-stated`; there is no publish/upload path yet — entries are committed to the catalogs.
- Tests: `community/registry.test.ts` (15), `routes/community.test.ts` (22) — install/uninstall lifecycles, traversal rejection on name and cwd, kind mismatches, agent registry read-back, temp-dir isolation so installs never touch the repo.

### P3.5 Compliance layer — ✅ DONE

Retention, redaction, policy-violation reporting. Only meaningful with P3.1–P3.3 in place.

- **Redaction** (`compliance/redact.ts`, one shared redactor): two passes — secret-named keys replaced wholesale (camelCase/separator-normalized, so `apiKey`, `API-KEY` and `awsSecretAccessKey` all match while `keyword`/`author` don't) and high-signal token patterns (reusing the no-secrets PR scanner's list from `eval/secrets.ts`) plus bearer tokens, env-assignment form and email/phone PII. Size-capped per field.
- **Applied at both evidence write chokepoints**: `AuditLogger.log()` (file mirror + DB mirror) and `SessionCrud.persistToolResult()` (the `parts` rows) — redacting only the audit trail would be trivially bypassed via `GET /session/:id/message`. **Also on read** (`/admin/audit`, JSON export) as defense-in-depth for rows written before this existed. Redaction is deliberately lossy.
- **Retention** (`compliance/index.ts`): `audit_entries` was append-only and unbounded — no purge existed anywhere (`scripts/gc-db.ts` covers sessions/snapshots only). `applyRetention()` deletes past the window (default 90d) and trims to a row cap (default 100k, oldest first). Runs at boot and on demand via `POST /admin/compliance/retention`; configurable via `compliance.retentionDays` / `compliance.maxRows` or `MIRA_COMPLIANCE_RETENTION_DAYS`. The `compliance` config section required the 5 coordinated edits (KNOWN_TOP_KEYS, patch schema, shared zod schema, `MiraConfig`, both `mergeSection` lists).
- **Violation reporting**: `GET /admin/compliance/violations` groups deny/warn rows by a category taxonomy derived from the producers' reason prefixes (`bash`/`patch`/`task`/`mcp`/`webfetch`/`guardrail error`), with per-tool counts and optional `?org=` scoping through the P3.3 session→org mapping.
- **Honest caveats, surfaced in the report rather than hidden**: (a) each tool call audits **twice** (guardrail pre-check + post-execution `logResult`), so the report exposes `rows` AND distinct `events` rather than pretending rows are events; (b) org scoping resolves rows via `session_id`, so orphaned rows (no session, deleted session) are counted as `unscopedRows` instead of silently disappearing; (c) `audit_entries` still carries no owner/org column — denormalizing would put an org lookup on the hot write path; (d) `policy/engine.ts` (3-layer taxonomy) remains dead scaffolding; (e) `deleteSession()` still does not cascade to audit rows.
- **Performance**: bounded every redaction quantifier — unbounded ones caused catastrophic backtracking (measured 6.5s per 50KB payload, i.e. minutes of CPU per hour of audit traffic). Now 11ms, with a regression test asserting the bound.
- **UI**: the System audit panel gains a violations/retention strip (30d rows vs events, category badges, retention state, run-sweep button).
- Tests: `compliance/redact.test.ts` (19), `compliance/compliance.test.ts` (12), `guardrails/audit-redact.test.ts` (7), `routes/compliance.test.ts` (12).

### Open gaps carried forward (resolved 2026-10-11 in the post-P3.5 sweep)

Three defects the plan flagged but left open, closed in a follow-up sweep:

1. **`deleteSession()` orphaned audit rows** (data integrity + compliance). Audit evidence now _deliberately survives_ session deletion — deleting a session must not erase the trail — and the rows are stamped with `owner_id`/`org_id` at the cold delete path, so they stay org-attributable for reporting. New `audit_entries.owner_id`/`org_id` columns (+ index, idempotent adds).
   - **While fixing this, found `SessionCrud` (`session/session-crud.ts`, 384 lines) is entirely dead** — imported nowhere, duplicating nine live `SessionPrompt` methods including `persistToolResult` and `deleteSession`. A second copy of a compliance-critical path is a live hazard: my first fix landed in the dead copy and silently did nothing. Deleted; the live path is `SessionPrompt`.
2. **Owner-unscoped resources** (`findings`, `file_snapshots`) — a cross-tenant leak once orgs exist: any authenticated owner could list every other owner's findings and file snapshots. Both are now gated by the same P3.3 rule (ownerless → shared; owner match; else same-org). Findings attached to a session the caller can't reach are rejected (404); `/files` + `/changes` filter to the caller's sessions.
3. **Dead `policy/engine.ts`** — constructed but never called (3-layer taxonomy). Left in place, documented here: the violation taxonomy in `compliance/index.ts` is derived from the _actual_ producers' reason prefixes, which is what real rows carry; wiring the dead engine would mean reworking every denial site for no behavioural gain.

Tests: `compliance/audit-retention.test.ts` (4), `routes/tenancy-scope.test.ts` (12).

### Wrong-edit protection (2026-10-11) — ✅ DONE

Audit of "can Mira catch an agent editing the wrong file or the wrong position?" found the answer was **no** — recovery existed, detection and correction did not. Closed:

1. **Ambiguous edits were resolved by the wrong occurrence.** Layer 1 correctly refused an ambiguous `oldString`, then Layer 2 (trimmed) silently edited the _first_ match and reported success. Ambiguity is now a **global gate** before any layer runs.
2. **Wrong-position splices.** Layer 6 ("line-anchored") took the first line sharing a 20-char prefix and spliced without checking the rest of `oldString` matched. It now validates every candidate span, refuses when ambiguous, and no longer reports `verified: true` unconditionally (that flag only ever meant "bytes changed").
3. **Lossy last-resort replacement.** Layer 9 replaced only the first line, silently discarding the remainder of both strings. It now refuses multi-line and ambiguous edits rather than corrupting the file.
4. **`patch` bypassed the read-before-edit guard** (only the single-file branch called it); multi-file diffs are now held to the same discipline, and an unverifiable patch is refused rather than let through on error.
5. **The `patch` tool was never registered at all.** `edit.ts` exports both `default` and `tools = [edit, patch]`, and `registerAll` preferred `default` — so `patch`, `memory_write`, `session_fork`, `config`, `diagnose`, `skill`, `analyze_image`, `parse_document`, `exit_plan` were all unregisterable. Tool count **30 → 41**.
6. **New `revert` / `revert_list` tools** — an agent can now undo its own bad edit. Deliberately **file-scoped only**: unlike the user-facing undo it does not delete conversation messages, so a correcting agent keeps its context. Cross-session reverts refused.
7. **Auto-rollback on `FAILED_VERIFICATION`** (`compliance/index.ts`), **toggle supports both modes**: `compliance.autoRollback: true` in mira.json or `MIRA_AUTO_ROLLBACK=1`; config wins over env so both on and off are reachable in every combination. **Default OFF** — verification is evidence-based (exit codes), so a false negative would discard legitimate work. Fires in `finishJob` _after_ the atomic status+verification settle, so the job row always records the failure and rollback happens exactly once. Files only, messages preserved; emits a `job.updated` / `kind:'auto-rollback'` event. Surfaced in `GET /admin/compliance/retention`.

8. **Edit-target relevance signals** (`tools/edit-target.ts`) — the wrong-file case, evidence-based:
   - **Same basename, different file, already read this session** (`packages/server/src/foo.ts` read, `packages/web/src/foo.ts` about to be written). Fires only when the session saw **exactly one** other same-named file — otherwise `index.ts`-style names (which exist in every module) would make it noise.
   - **Creating a file with exactly one live twin** elsewhere in the tree.
   - **Outside session focus** (weak, advisory): the target shares no path segment with anything read. Sibling modules (`src/auth`, `src/db`) count as related.
   - **Advisory by default**: warnings ride back in the tool result as `editTargetWarnings` so the agent can reconsider before the change compounds. `MIRA_STRICT_EDIT_TARGET=1` makes **only** the high-confidence same-basename signal blocking, and it runs _before_ the snapshot so a blocked edit writes nothing. The twin scan is bounded (≤400 directories; skips `node_modules`/`.git`/dist).

9. **Task-intent relevance** (`analyzeTaskRelevance`) — the "does this edit belong to what was asked?" layer, evidence-based and advisory-only:
   - **Module-boundary crossing**: the session has only worked inside `packages/server` and this edit targets `packages/web`. Reported with both sides named.
   - **Task text never mentions this file** while it _does_ name another file the session touched ("fix the bug in login.ts" → editing `logout.ts`). Backed by `recentUserPrompts()` — a bounded, indexed lookup of recent user `text` parts.
   - **False-positive control**: filename tokens shorter than 3 chars and a generic stoplist (`index`, `util`, `helper`, `test`, `common`, …) are excluded, so ordinary prose containing those words never counts as a "mention". Without this, `index.ts` matches any prompt containing "index" and the signal is pure noise — caught by a test written after the flaw, not before.
   - Advisory only — never blocks, even in strict mode. A lexical heuristic that blocks legitimate work is worse than none.

10. **Intent anchor (`near`)** — the hole the verification demo exposed: a stale snippet can match the file **perfectly** while sitting in the wrong function (`  return x` + `}` matched `build()` when the agent meant `target()`). No string matcher can detect that — the mismatch is intent, not text. The `edit` tool now accepts `near`: a unique nearby marker (the enclosing function's signature). The replaced text must sit **after** the anchor's last occurrence and within ~40 lines, or the edit is refused with a message explaining which side was wrong. The anchor-check runs before any layer, applies on the exact-match path (fuzzy layers keep their own span validation), and passing edits report `anchorVerified: true`. **This is the one mechanism that actually solves the "wrong position" case** — the earlier span validation only caught snippets that _didn't_ match; this catches snippets that match _the wrong place_.

11. **Symbol binding** (`analyzeTaskRelevance`, symbol level) — the undirected lexical layer: if the task text names exactly ONE symbol declared in the target file and the edit lands inside a DIFFERENT one, warn ("task mentions target() but this edit lands inside build()"). Catches the perfect-match/wrong-function case when the prompt names things. Mention detection requires a **code-reference shape** (`name(`, backticks, `name.`) — the bare word "build" in "run the build" does not count. Silent when the task names several symbols (ambiguous), names the enclosing one, or names nothing.
12. **Edit critic** (`tools/edit-critic.ts`) — the undirected semantic layer, reusing the Virtual-Diff critic pattern for agent edits: after a completed mutation, a second model call judges `{task text, before, after}` → strict JSON `{"verdict":"ok"|"unrelated","reason"}`. `unrelated` writes a **finding** (visible in the findings UI), publishes `edit.critic` on the bus, and — when `autoRollback` is also on — reverts the edit via its snapshot. **Opt-in** (`compliance.editCritic` / `MIRA_EDIT_CRITIC`; default false, a model call per edit is an operator decision), one review in flight per session, 30s timeout, unparseable/failed critic calls degrade to no-op and never revert. Conservative by design: unclear verdicts answer "ok".

**What this closes**: wrong-file (advisory + strict), wrong-position-by-ambiguity, wrong-position-by-drift, perfect-match/wrong-region (near anchor), and now undirected detection via task text (lexical symbol binding + semantic critic) with self-correction through `revert` and auto-rollback. 13. **Blast-radius advisory** — wired at last, and cheap: for `edit` targets the registry consults the boot-built code graph's reverse-dependency edges (`findDependents`) and attaches "N file(s) import this file (…)" to the result. **Only when the graph is already built** — a cold graph is skipped rather than triggering a repo parse on the edit path — and the path is normalized to project-relative (absolute paths silently matched nothing; caught by a test). 14. **Knowledge delete persists** — `DELETE /knowledge/:id` used to only clear the in-memory map (the row resurrected on every restart, per its own comment). New `KnowledgeBase.remove()` tombstones **and persists** (reusing the scheduler's expiry pattern), then drops the live entry. 15. **Audit `error` column** — post-execution failure text existed only in the file mirror; the DB mirror dropped it. New idempotent `audit_entries.error` column, written (redacted) by `AuditLogger`, returned by `/admin/audit` and the JSON export. 16. **Per-session registry state eviction** — `readPaths` (the read-guard whitelist) survived session deletion forever, and the maps grew unbounded. Now evicted on `session.deleted` (re-arming the read guard for replayed sessions) and capped at 200 tracked sessions, oldest evicted.

17. **Session auto-titling** (`session/title.ts`) — main sessions stayed `New Session` forever unless renamed manually (subagent children were already titled `↳ <prompt>` by `runSubagent`). At the single `streamResponse` chokepoint both paths share, a still-default title is replaced deterministically from the first user prompt (first non-empty line, collapsed, ≤60 chars + ellipsis; no model call). **User-chosen titles are never clobbered** — only placeholders qualify (`New Session`, `Imported Session`, legacy `<agent> session`). Fires once, publishes `session.updated` so open session lists refresh live, best-effort (never delays or fails the turn).

18. **Think + observe** — closing the agent feedback loop:
    - **`think` tool** (`tools/think.ts`): a zero-side-effect reasoning scratchpad. Agents state the target file/region, approach, risks and verification plan _before_ a mutation; the thought persists as a normal tool-call/result pair, so reasoning is visible in traces and exports instead of vanishing. No permissions; validation lives in the registry path.
    - **Critic feedback is now observable with instructions**: `openFindingsForContext` detects critic-source findings and switches its header from "avoid repeating solved problems" to "CRITIC FEEDBACK on your recent edits — re-read the flagged file, verify the change serves the task, fix or revert; do not stack edits on an unverified one". Verified that critic verdicts already flow into every turn via the findings injection (`prompt.ts` loadContext) — the loop was closed but the agent had no instruction about what the feedback meant.

**Still genuinely open**: embedding-based relevance — deferred, documented, not pretended.

Tests: `tools/edit-position.test.ts` (8), `tools/edit-anchor.test.ts` (10), `tools/revert.test.ts` (10), `compliance/auto-rollback.test.ts` (15), `tools/auto-rollback.e2e.test.ts` (5, through the real task pipeline), `tools/edit-target.test.ts` (11), `tools/task-relevance.test.ts` (11), `tools/symbol-binding.test.ts` (8), `tools/edit-critic.test.ts` (14). Session titling: `session/title.test.ts` (11), `session/title-wiring.test.ts` (3, through real `streamResponse`).

Tests: `tools/edit-position.test.ts` (8), `tools/edit-anchor.test.ts` (10), `tools/revert.test.ts` (10), `compliance/auto-rollback.test.ts` (15), `tools/auto-rollback.e2e.test.ts` (5, through the real task pipeline), `tools/edit-target.test.ts` (11), `tools/task-relevance.test.ts` (11).

Tests: `tools/edit-position.test.ts` (8), `tools/revert.test.ts` (10), `compliance/auto-rollback.test.ts` (15), `tools/auto-rollback.e2e.test.ts` (5, through the real task pipeline), `tools/edit-target.test.ts` (11), `tools/task-relevance.test.ts` (11).

### P3.6 Vertical agents — ✅ DONE (authorized, see ADR 0001 amendment)

Runtime substrate exists (templates, custom agents from `mira.json`, subagents, engine registry). Domain agents (Luxora, research, business) are pure greenfield. Do not start until P0–P2 are solid and Phase 0 identity is settled — this is the addendum's "platform model" bet and should be a deliberate second product, not a distraction. **The ADR gate was met (P0–P3.5 complete) and the owner explicitly authorized this work — see the ADR amendment.**

- **A vertical is a bundle, not a fork** (`community/verticals.ts`): one installable unit composing the P3.4 kinds — an agent persona (inline, or a reference to a catalog agent), the skills it should always carry, and a knowledge module that grounds it in the domain. Added as a fourth kind (`vertical`) to the existing community registry, so browse/search/install are uniform.
- **Resolution before any write** (`planVertical`): components resolve against their catalogs first; a vertical referencing something missing fails with `409` naming the missing entries and writes nothing. Install order is deliberate: agent → skills → knowledge (persona exists before the material it reasons over).
- **Routes**: `POST /community/verticals/:name` (atomic install; per-component `failed` list with `207` on partial failure), `DELETE /community/verticals/:name` (removes agent + skills; **knowledge is kept** — seeded memories have no uninstall and the response says so explicitly).
- **Shipped verticals** (`community-vertical-registry.json`):
  - `luxora` — fashion design assistant (the addendum's flagship vertical): inline readonly persona covering garment specs, fabric behaviour (drape/pilling/shrinkage), collection coherence, and honest trade-offs ("a beautiful drape that pills"). Self-contained — installs today.
  - `security-audit` — composes the existing `security-audit` + `security-threat-model` skills with the `api-security-basics` knowledge module, so reviews run against concrete rules rather than generic advice.
  - `dev-workflow` — references the catalog `test-writer` agent plus `tdd-workflow` + `verification-planning` skills (exercises the by-reference composition path).
- **Hardening the sweep exposed**: the tests wrote into a literal `packages/server/undefined/` directory because `resolveCwd` accepted the string `"undefined"` as a cwd and resolved it against the server's own working directory. Community installs now **require an absolute cwd** (`400` otherwise) — install targets are file writes, and a relative path would write into whatever directory the server happens to run from.
- **Honest scope notes**: verticals are offline-curated (same posture as every other catalog); there is no publish/upload path; a vertical is a _behavior_ bundle, not an isolated runtime — it configures the one agent engine rather than shipping its own.

Tests: `routes/verticals.test.ts` (16) — planning/resolution, atomic install (agent+skills+knowledge), idempotent re-install, missing-reference refusal, uninstall semantics (knowledge kept), registry search, temp-dir isolation.

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
