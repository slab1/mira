# Online Learning Module — Improvement Roadmap

> Status: **implemented plan, gaps tracked below** — branch `docs/online-learning-roadmap` (merged `1821c26b`)
> Related modules: `packages/server/src/learning/{online,scheduler,knowledge,usage,improvement}.ts`
> Refreshed **2026-09-25** against code — the 2026-09-05 ❌ rows below were closed by `feat/online-learning-p1` (merged); remaining ✅/🚧 rows are the live backlog.

## Current state (verified against code, 2026-09-25)

| Behavior                                           | Status                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Module loads and runs on schedule                  | ✅ Scheduler hourly + `POST /learning/trigger` (`scheduler.ts:186` dynamic topics)                                  |
| Default search without API keys                    | ✅ Keyless tiers: HN Algolia (`online.ts:386`), arXiv (`:408`), GitHub search (`:440`, cached) — DDG tier-4 still ❌ |
| Native fetch pipeline (HTML → markdown → insights) | ✅ Verified end-to-end; heading-aware chunking `chunkDocByHeading` (`online.ts:201`)                               |
| LLM extraction                                     | ✅ Called — `extractWithLLM(chunkedDocs, deps.gateway)` (`online.ts:207`, heuristic fallback tested)                |
| Cross-run deduplication                            | ✅ Deterministic store IDs dedupe across cycles (`knowledge.ts:317`) + Jaccard near-dup (`online.ts:647`)           |
| Feedback loop (did the insight help?)              | ✅ `adjustUtility()` called by SessionPrompt (`knowledge.ts:329`), retrieval bonus + 1%/day decay (`:415-421`)      |
| Failure-driven topics                              | ✅ `buildDynamicTopicsFromAnalysis()` (`online.ts:672`) from `failurePatterns`                                      |
| Status surfacing / ops hygiene                     | 🚧 No `topPerforming/worstPerforming` on `/learning/status`; no domain cooldown; no zero-result streak finding     |

## Goal

Turn the online learner from a passive keyword scraper into a **calibrating learning system**: it should increasingly surface _useful_ insights and stop surfacing _useless_ ones — with the evidence to prove it.

---

## Roadmap — 5 phases, ordered by ROI

### Phase 1 — Better acquisition (minimum viable) — ✅ 5/6 (DDG tier-4 remaining)

**Problem (resolved):** keyless tiers HN/arXiv/GitHub + hourly topic rotation now exist; only DuckDuckGo last-resort remains.

| Change                                                                                                                    | File / Location                                                                                      | Effort |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| Add HN Algolia search (`https://hn.algolia.com/api/v1/search?query=…`) — keyless, fast, high signal for agent/dev content | `createDefaultSearchFn()` tier-3 fallback in `online.ts`                                             | ½ day  |
| Add arXiv Atom API for `research-paper` topics (`export.arxiv.org/api/query`)                                             | Per-category dispatcher + paper-shaped result parser                                                 | ½ day  |
| Add GitHub Repository Search API (keyless, 60 req/hr) for `github-repo` topics                                            | same                                                                                                 | ½ day  |
| DuckDuckGo HTML endpoint as last-resort general web search                                                                | tier-4 fallback                                                                                      | 1 day  |
| Per-topic source hints: papers → arXiv + HN, repos → GitHub, tools → general web                                          | replace `DEFAULT_TOPICS` array with `StructuredTopic = { query, category, sourceHints, timeWindow }` | ½ day  |
| Rotate time windows (past week / month / year) alongside topic rotation                                                   | `pickTopics()`                                                                                       | ½ day  |

**Acceptance:** `learnOnce()` with no keys returns non-empty insights on a machine with network access.

### Phase 2 — Extraction quality — 🚧 3/5 (verifiers + code-fence candidates remaining)

**Problem (mostly resolved):** heading chunking (`chunkDocByHeading`, `online.ts:201`) + auto LLM extraction (`:207`) are wired; per-insight `verifiers` count and code-fenced pattern candidates are not yet.

| Change                                                                                                | Location                                                                     | Effort  |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------- |
| Chunk by heading structure; keep top 2–3 sections ranked by relevance to the topic                    | `extractInsights()` (new `chunkSections()` helper)                           | 1 day   |
| Auto-enable LLM extraction when `deps.gateway` is provided — fall back silently to heuristic on error | `learnOnce()` branch: `this.deps.gateway ? extractWithLLM : extractInsights` | 2 hours |
| Accept code-fenced snippets as pattern candidates alongside imperative lines                          | `extractPattern()`                                                           | ½ day   |
| Per-insight `verifiers: number` (count of distinct sources backing the same pattern)                  | `KnowledgeBase.storeInsight()` merge                                         | 1 day   |

**Acceptance:** insights for long technical pages pull out mid-document substance; `verifiers ≥ 2` when two sources agree (measurable in `/learning/insights` output).

### Phase 3 — Persistent dedupe & lifecycle — 🚧 2/4 (hitCount/lastSeen + tombstone sweep remaining)

**Problem (mostly resolved):** cross-cycle dedup via deterministic store IDs (`knowledge.ts:317`) and Jaccard near-dup on patterns (`online.ts:647`, chosen over simhash); content-hash `hitCount`/`lastSeen` counters and the 60-day expiry sweep are not yet.

| Change                                                                                                                               | Location                                              | Effort |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------ |
| Hash-based dedupe: `contentHash = sha256(markdown + pattern)`; on store, existing entry updates `lastSeen` and increments `hitCount` | `online_learnings` table + `knowledge.storeInsight()` | 1 day  |
| Near-dup simhash over patterns (Hamming ≤ 3 = same pattern)                                                                          | `extractInsights()` → `insights` list hygiene         | 1 day  |
| Periodic "expiry sweep": entries not seen for > 60 days get `tombstone=1`, hidden from retrieval                                     | scheduler + `knowledge.ts` list/query paths           | ½ day  |

**Acceptance:** re-running the same topic twice in a row returns identical `insights[]` and does not grow the stored count.

### Phase 4 — Utility feedback loop (the actual "learning") — ✅ 3/4 (`/learning/status` surfacing remaining)

**Problem (mostly resolved):** `adjustUtility()` is called by SessionPrompt each turn (`knowledge.ts:329`) and retrieval ranks `utility * relevance` with decay (`:415-421`); `topPerforming`/`worstPerforming` are not yet surfaced on `/learning/status`.

```
                ┌──────────────┐
                │  learnOnce   │──┐
                └──────────────┘  │
                                  ▼
┌──────────────┐      ┌──────────────────────────────────┐
│ usage.learner│◄─────│ onPrompt: tag context.inserted    │
│  (runs after │      │   insight IDs in assistant message│
│  each turn)  │      └──────────────────────────────────┘
└──────┬───────┘                    ▼
       │              ┌───────────────────────────┐
       └─────────────►│ correlate: sessions that    │
                      │ used insight X succeed more │
                      │ often → utility += 1        │
                      └───────────────────────────┘
```

| Change                                                                                                        | Location                | Effort |
| ------------------------------------------------------------------------------------------------------------- | ----------------------- | ------ |
| Persist the insight IDs injected into a turn onto the message row (`message_meta.injectedInsights: string[]`) | `prompt.ts loadContext` | ½ day  |
| In `UsageLearner.recordSession()`, bump each injected insight's `utility` by ±1 based on success flag         | `usage.ts`              | 1 day  |
| Retrieval: `ORDER BY utility * relevance DESC` instead of just relevance                                      | `knowledge.retrieve()`  | ½ day  |
| Surface `topPerforming / worstPerforming` on `/learning/status`                                               | `learning/index.ts`     | ½ day  |

**Acceptance:** utility ranking changes which insights get injected within the first week, measured via `SELECT COUNT(*) FROM insights WHERE utility <> 0`.

### Phase 5 — Ops hygiene — 🚧 1/4 (domain cooldown, zero-result streak finding, cycle telemetry remaining; failure-driven topics done via `buildDynamicTopicsFromAnalysis`, `online.ts:672`)

| Change                                                                                                                 | Location                                            | Effort |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------ |
| Per-domain politeness cooldown (any domain with ≥1 fetch error in a run → 2h cooldown)                                 | `online.ts`                                         | ½ day  |
| Zero-result streak alert: 3 consecutive cycles with no insight → `HIGH` severity finding (`findings` store + UI badge) | `scheduler.ts`                                      | ½ day  |
| Cost/latency telemetry per cycle (tokens spent by LLM extraction, duration)                                            | attach to trace + gateway stats                     | ½ day  |
| Query bank generated from recent failures (top 3 `failurePatterns` → "how to fix X" searches)                          | `DEFAULT_TOPICS` replaced by `buildDynamicTopics()` | 2 days |

## Explicit non-goals

- **No external memory service dependence**: keeps working with SQLite alone (postgreSQL/pgvector remains optional via `DATABASE_URL`).
- **No unconditional patch application**: `MIRA_EVAL_GATE=1` remains opt-in; learning stays read/journal-safe by default.
- **No model-key hard requirement**: all improvements above work (degraded) with zero keys.

## Test plan

- ✅ `learning/online.test.ts`: mock searchFn + fetchFn, insights shape + dedupe + keyless fallback + LLM extraction (`online.test.ts:33,127`)
- ✅ `learning/knowledge.test.ts`: store/merge/retrieval incl. utility bonus
- ❌ `learning/utility.test.ts`: simulate multiple sessions per insight, assert ordering flips by success correlation — **to write with Phase 4 surfacing**
- ❌ `learning/scheduler.cycle.test.ts`: 3-cycle streak of emptiness → finding raised — **to write with Phase 5 streak alert**
- ❌ E2E: `e2e/learning.e2e.test.ts` against live (local) network with HN API

## References

- `packages/server/src/learning/online.ts` (current implementation)
- `packages/server/src/learning/knowledge.ts` ("mocked vector" cosine — see also pgvector path)
- `MIRA_ONLINE_LEARNING.md` (research/skill-synthesis policy + 10-item maintenance table)
