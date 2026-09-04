# H2-3 Orchestrator v2 — inferDAG + Wave-Context + Jobs + Skill Hook

Date: 2026-09-04. Shipped: `f262fa68` (`feat(mira): H2-3 Orchestrator v2 — inferDAG + wave-context + jobs + skill hook`).
Validation owner: orchestrator. Scope: docs only (this file changes no code).

Sources: `packages/server/src/tools/orchestrate.ts`, `packages/server/src/tools/orchestrate-planner.ts`,
`packages/server/src/learning/knowledge.ts`, `packages/server/src/learning/index.ts`,
`packages/web/src/api/client.ts`, `packages/web/src/components/MemoryGraph.tsx`.

## 1. What shipped

Three extensions (E1–E3) on top of the Kilo K2 orchestrator-mode base (`orchestrate` tool):

- **E1 — inferDAG planner** (`orchestrate-planner.ts`): when `tasks` is omitted and `inferDAG: true`,
  the cheap model (`openrouter/deepseek/deepseek-v3.2-exp`, `PLANNER_MODEL`) drafts a bounded task DAG
  from `goal` + `context`. Output is Zod-validated (`inferDAGRequestSchema`) plus structural checks
  (`validateDAG`) before the engine runs anything. **Fail-closed**: any planner parse/validation
  failure returns `{ goal, error, hint }` — the engine never silently runs a guessed plan.
- **E2 — wave-context + jobs persistence** (`orchestrate.ts:296-316, 335-403`): one `jobs` row per task
  is inserted before any spawn (same pattern as `task.ts`); `job.created` / `job.updated` /
  `job.cancelled` Bus events fire per node. Upstream output flows along `contextFrom` (⊆ `dependsOn`)
  edges as summaries; full texts stay in job rows and the parent sees 600-char previews.
- **E3 — skill-synthesis hook** (`orchestrate.ts:166-229, 398-402`): on wave failure,
  `ImprovementEngine.synthesize()` runs hook-only and fail-open; the candidate is persisted to the
  `findings` table (`source: "tool"`, `severity: "minor"`) and a `message.updated`
  `{ waveFailed, skillCandidate }` Bus event is published with a
  "Human Review Required — UNVERIFIED-DO-NOT-USE until shadow eval + promotion" note.

Guards (all in `orchestrate.ts`): tasks ≤ 12, `budgetSteps` ≤ 25, unknown agent/dep rejected,
cycle rejected once then fail-closed (cycle check runs *before* the dense fallback),
dense graph (> 50% of possible edges) collapses to a single wave, failed nodes retry exactly once,
dependents of failed nodes are `skipped` (targeted recovery, never run doomed work).
Wave parallelism is capped at 8 (`ORCHESTRATE_CONCURRENCY_CAP`).

## 2. Input shape

`orchestrateSchema` (`orchestrate.ts:48-56`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `goal` | string (1–5000) | yes | Overall goal — parent analysis of why these subtasks exist |
| `tasks` | array (1–12) of task | no* | Explicit subtasks (*required unless `inferDAG: true` with a wired gateway) |
| `inferDAG` | boolean | no | Ask the cheap planner model to infer the DAG from `goal` + `context` (E1) |
| `context` | string (≤5000) | no | Extra context for the inferDAG planner |
| `mergeStrategy` | `lead-synthesis` \| `independent-review` \| `best-of-n` | no (default `lead-synthesis`) | How to combine node summaries |
| `background` | boolean | no | Return immediately with `jobIDs`; per-node results arrive via Bus `job.updated` events |

Per-task shape (`orchestrateTaskSchema`, `orchestrate.ts:37-45`; planner variant `inferredTaskSchema`,
`orchestrate-planner.ts:26-34` — same fields, planner ids restricted to `/^[a-z0-9-]+$/`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string (1–40) | yes | Unique task id, referenced by `dependsOn` |
| `prompt` | string (1–10000) | yes | Self-contained instructions + acceptance criteria (child needs no parent context beyond `contextFrom`) |
| `agent` | string (≤40) | no | Agent key from the catalog (`explore`/`research` normalize to `researcher`); unknown agents rejected |
| `dependsOn` | string[] | no | IDs that must complete first; unknown/self refs rejected |
| `contextFrom` | string[] | no | **Must be a subset of `dependsOn`** — summaries forwarded only along these edges |
| `budgetSteps` | int 1–25 | no (default 10) | Step budget for this node |
| `title` | string (≤200) | no | Short title for the job board |

## 3. Output shape

Synchronous result (`orchestrate.ts:409-421`):

```json
{
  "goal": "<echoed>",
  "waves": 2,
  "total": 4,
  "completed": 3,
  "failed": 0,
  "skipped": 1,
  "denseFallback": false,
  "mergeStrategy": "lead-synthesis",
  "merged": "Synthesis for \"<goal>\" (3/4 completed):\n[task-a]: <≤600 chars>\n…",
  "jobIDs": [{ "taskID": "task-a", "jobID": "<uuid>" }],
  "results": [{ "id": "task-a", "agent": "code", "jobID": "<uuid>",
                "status": "completed|failed|skipped",
                "sessionID": "<child session>", "preview": "<600-char text-or-error>" }]
}
```

Notes:

- `merged` is built from ≤600-char previews only (`mergeResults`, `orchestrate.ts:146-159`).
  Full node texts live in the `jobs` row (`result` column); poll `getJob(jobID)` for them.
- `background: true` returns `{ goal, status: "background", waves, total, jobIDs, message }`
  immediately; completion arrives via Bus `job.updated` / `job.cancelled` events (`orchestrate.ts:318-327`).
- Error shape is `{ goal, error, hint }` (planner fail-closed, no-tasks, unknown agent, cycle).
  Skipped nodes carry `error: "skipped: upstream failed (<ids>)"`.

## 4. Merge strategies

`mergeStrategySchema` (`orchestrate-planner.ts:17-18`); applied in `mergeResults`
(`orchestrate.ts:146-159`). All strategies consume **summaries only** (≤600 chars each).

| Strategy | Behavior | Use when |
|----------|----------|----------|
| `lead-synthesis` (default) | Single combined `Synthesis for "<goal>" (done/total)` listing each node's preview | Divisible work needing one coherent summary |
| `independent-review` | `Independent review for "<goal>" (done/total)` with the same preview list, framed as cross-review | Nodes checked each other's output and you want the review framing preserved |
| `best-of-n` | Deterministic winner = longest completed output; `Best of N for "<goal>": [<id>] <≤1200 chars>` | Parallel attempts at the same problem; keep the fullest answer |

When `inferDAG` is used, the planner proposes the strategy and the engine adopts it
(`orchestrate.ts:256`); explicit `tasks` callers set it directly (default `lead-synthesis`).

## 5. inferDAG usage

Use `inferDAG` when the caller has a goal but no pre-planned decomposition:

```json
{ "goal": "Add CSV export to the sessions table, with tests",
  "inferDAG": true,
  "context": "Repo uses SolidJS + TanStack Table. Keep the diff under ~300 lines." }
```

What happens, in order (`orchestrate.ts:245-260`, `orchestrate-planner.ts:140-196`):

1. `buildPlannerPrompt` forces data-dependency reasoning FIRST ("what upstream output does this
   need to read?"), then self-contained prompts, then the ≤12-task / summaries-only merge contract.
2. The prompt includes the **live agent catalog** (`getAgentTemplates()` + `mira.json` custom agents)
   and the **live skill list** (`loadSkills()`), so assignments match real capabilities.
3. The model must reply with ONLY a JSON object `{ tasks: [...], mergeStrategy }`
   (`extractPlannerJSON` strips fences/prose before `JSON.parse`).
4. `inferDAGRequestSchema.safeParse` validates shape; `validateDAG` rejects unknown deps,
   self-deps, `contextFrom ⊄ dependsOn`, and cycles (Kahn reachability).
5. Any failure returns `{ goal, error, hint }` — **pass `tasks` explicitly or retry once with more
   context**. No gateway wired → `"No gateway wired — pass tasks explicitly instead of inferDAG"`.

Planner prompt contract worth knowing when writing `goal`/`context`: prefer 3–6 tasks; split further
only for truly independent workstreams; tightly-coupled edits (same files, shared types) belong in
ONE task; `contextFrom` must be a subset of `dependsOn` (`orchestrate-planner.ts:52-85`).

## 6. Gaps (known, not yet addressed)

- **Dense fallback is silent-ish**: dense graphs (>50% edges) run as one wave with only a
  `denseFallback: true` flag — callers wanting true single-agent routing must check the flag.
- **`best-of-n` is longest-wins**, not quality-judged — a verbose wrong answer beats a terse right one.
- **No replan loop**: the planner gets one shot per call; there is no automatic "retry with the
  validation error fed back" (the hint suggests one manual retry).
- **Previews truncate at 600 chars** (1200 for forwarded context, 1200 for best-of-n winner) —
  nuanced node output is only visible via `getJob(jobID)`.
- **Skill-hook candidates are unverified by design** (E3 publishes them with an explicit
  do-not-use-until-promoted note); there is no auto-shadow-eval wiring yet.
- **Cost blind spots**: per-node token/cost accounting is not surfaced (see UI-UX-AUDIT W2);
  the 8-wide wave cap and ≤12×25-step bounds are the only cost controls.
- **Job inspection dead-ends in UI** (UI-UX-AUDIT W5): `childSessionID` is never clickable, no live
  tail/elapsed display — orchestrate-spawned jobs inherit this.

## 7. Memory graph wiring note — `GET /knowledge/graph` → MemoryGraph data contract

Shipped across H2-1 (`48c4ea6d`: temporal decay + entity graph + rerank) and the memory-graph-canvas
commit (`f7827968`: read-only SVG, standout A). Read path is strictly read-only:

```
KnowledgeBase.getGraph(limit)          packages/server/src/learning/knowledge.ts:452
  → GET /knowledge/graph?limit=N       packages/server/src/learning/index.ts:127-132  (alias: GET /learning/graph, :135-140)
  → client.getKnowledgeGraph(limit)    packages/web/src/api/client.ts:592
  → <MemoryGraph/> canvas              packages/web/src/components/MemoryGraph.tsx
```

Data contract (`knowledge.ts:103-130`):

```ts
interface GraphNode { id: string; label: string; tier: string; source: string;
  tags: string[]; entities: string[]; createdAt: number; updatedAt: number;
  lastAccessedAt: number; accessCount: number;
  kind: "knowledge" | "finding"; severity?: string; status?: string }
interface GraphEdge { from: string; to: string;
  kind: "related" | "entity" | "finding"; label?: string }
interface KnowledgeGraph { nodes: GraphNode[]; edges: GraphEdge[] }
```

Edge construction rules (`knowledge.ts:479-509` + findings block): `related` edges come from
`graphLinks` (only when both ends are in the current `limit` slice, deduped); `entity` edges connect
entries sharing a lowercased entity as a star (hub → rest, skipped when the group has <2 or >8
members to avoid noise/explosion); `finding` nodes/edges append the 50 most-recent `findings` rows
when SQLite is available. `limit` is clamped to 500 server-side. Tiers are
`episodic | semantic | procedural` (`learning/index.ts:101`).

## 8. Standout follow-ups checklist (copy, a11y, empty states)

Sourced from `docs/UI-UX-AUDIT.md` (2026-09-04). Copy = wording/microcopy, a11y = accessibility,
empty = empty-state coverage.

Copy:

- [ ] Dismissable, actionable errors: replace the single undismissable `state.error` string with
      per-surface dismiss + retry + request ID (W10).
- [ ] AuthGate polish: show/hide token toggle, stop fighting password managers
      (`autocomplete="off"`), drop the `⚠` emoji error text (W10).
- [ ] Document shortcuts visibly (`G` graph-cycle, `Ctrl+P`, `Ctrl+,` currently tooltip-only) (W12).
- [ ] Remove the surprising `/memory` · `/graph` silent-intercept-and-clear hack or confirm before
      swallowing user input (W12).
- [ ] Session delete: replace blocking native `confirm()` with undo-trash (W6).
- [ ] Job cards: show elapsed/progress instead of truncated `result.slice(0,200)` only (W5).

A11y:

- [ ] Session delete `×` is 20×20px — raise to the 44px touch-target rule (W11,
      `packages/web/src/index.css:584-596` vs rule at `:1467-1472`).
- [ ] Inspector `.seg-tab`s: add arrow-key roving tabindex (W11, `ToolView.tsx:91-99`).
- [ ] `MemoryGraph` keyboard-trap risk: `role="application"` + `tabIndex={0}` wrapping
      `tabindex={0}` SVG `<g role="button">` nodes — audit focus escape
      (`MemoryGraph.tsx:176-182, 261-279`).
- [ ] `QuestionPrompt`: add Escape path and return focus to the trigger on close
      (`QuestionPrompt.tsx:18-21`).
- [ ] Keep existing wins: Settings focus trap + Escape, `role=dialog/tablist/listbox`,
      `aria-expanded/selected`, `prefers-reduced-motion` kill-switch (W11).

Empty states:

- [x] Already covered: welcome, start-conversation, no-sessions, dashed inspector cards, graph
      empty (`MemoryGraph.tsx:442-465`), skeletons for sessions/tools/snapshots/findings,
      offline banner as `role=status` (audit §3).
- [ ] Graph-mode composer parity: single-line `<input>` in graph mode loses multiline, slash
      autocomplete, and jobs/doom-loop banners the chat composer has (W9).
- [ ] Inspector collapsed rail shows no counts — open findings / running jobs are invisible when
      collapsed (W4); History/Jobs tabs fetch only when active, so badge counts need a source.
- [ ] Mobile (≤767px): inspector stacks below chat with no height cap and can push the composer
      off-screen; add a cap or collapsible inspector (W9).
