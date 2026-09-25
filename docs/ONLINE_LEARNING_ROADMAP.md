# Online Learning Module — Improvement Roadmap

> Status: **documented plan**, branch `docs/online-learning-roadmap`  
> Related modules: `packages/server/src/learning/{online,scheduler,knowledge,usage,improvement}.ts`

## Current state (verified by live execution)

| Behavior                                           | Status                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| Module loads and runs on schedule                  | ✅ Works — scheduler starts on boot, `POST /learning/trigger` works        |
| Default search without API keys                    | ❌ Returns nothing (honest, no fabricated results), but effectively silent |
| Native fetch pipeline (HTML → markdown → insights) | ✅ Works — verified end-to-end with a real web page                        |
| LLM extraction                                     | ⚠️ Implemented (`extractWithLLM`) but **never called**                     |
| Cross-run deduplication                            | ❌ Only same-run URL dedup — same page can be re-learned every cycle       |
| Feedback loop (did the insight help?)              | ❌ No utility tracking at all                                              |

## Goal

Turn the online learner from a passive keyword scraper into a **calibrating learning system**: it should increasingly surface _useful_ insights and stop surfacing _useless_ ones — with the evidence to prove it.

---

## Roadmap — 5 phases, ordered by ROI

### Phase 1 — Better acquisition (minimum viable)

**Problem:** Today, without a paid Firecrawl/Tavily key, the learner finds nothing. The default topics list is static, so it always asks the same questions.

| Change                                                                                                                    | File / Location                                                                                      | Effort |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| Add HN Algolia search (`https://hn.algolia.com/api/v1/search?query=…`) — keyless, fast, high signal for agent/dev content | `createDefaultSearchFn()` tier-3 fallback in `online.ts`                                             | ½ day  |
| Add arXiv Atom API for `research-paper` topics (`export.arxiv.org/api/query`)                                             | Per-category dispatcher + paper-shaped result parser                                                 | ½ day  |
| Add GitHub Repository Search API (keyless, 60 req/hr) for `github-repo` topics                                            | same                                                                                                 | ½ day  |
| DuckDuckGo HTML endpoint as last-resort general web search                                                                | tier-4 fallback                                                                                      | 1 day  |
| Per-topic source hints: papers → arXiv + HN, repos → GitHub, tools → general web                                          | replace `DEFAULT_TOPICS` array with `StructuredTopic = { query, category, sourceHints, timeWindow }` | ½ day  |
| Rotate time windows (past week / month / year) alongside topic rotation                                                   | `pickTopics()`                                                                                       | ½ day  |

**Acceptance:** `learnOnce()` with no keys returns non-empty insights on a machine with network access.

### Phase 2 — Extraction quality

**Problem:** Today only the first ~4 KB of a page is extracted via regexes. The existing `extractWithLLM` path is wired but never invoked.

| Change                                                                                                | Location                                                                     | Effort  |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------- |
| Chunk by heading structure; keep top 2–3 sections ranked by relevance to the topic                    | `extractInsights()` (new `chunkSections()` helper)                           | 1 day   |
| Auto-enable LLM extraction when `deps.gateway` is provided — fall back silently to heuristic on error | `learnOnce()` branch: `this.deps.gateway ? extractWithLLM : extractInsights` | 2 hours |
| Accept code-fenced snippets as pattern candidates alongside imperative lines                          | `extractPattern()`                                                           | ½ day   |
| Per-insight `verifiers: number` (count of distinct sources backing the same pattern)                  | `KnowledgeBase.storeInsight()` merge                                         | 1 day   |

**Acceptance:** insights for long technical pages pull out mid-document substance; `verifiers ≥ 2` when two sources agree (measurable in `/learning/insights` output).

### Phase 3 — Persistent dedupe & lifecycle

**Problem:** URLs are deduped only _inside_ one run. The same "LangGraph overview" page can be learned weekly as something new.

| Change                                                                                                                               | Location                                              | Effort |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------ |
| Hash-based dedupe: `contentHash = sha256(markdown + pattern)`; on store, existing entry updates `lastSeen` and increments `hitCount` | `online_learnings` table + `knowledge.storeInsight()` | 1 day  |
| Near-dup simhash over patterns (Hamming ≤ 3 = same pattern)                                                                          | `extractInsights()` → `insights` list hygiene         | 1 day  |
| Periodic "expiry sweep": entries not seen for > 60 days get `tombstone=1`, hidden from retrieval                                     | scheduler + `knowledge.ts` list/query paths           | ½ day  |

**Acceptance:** re-running the same topic twice in a row returns identical `insights[]` and does not grow the stored count.

### Phase 4 — Utility feedback loop (the actual "learning")

**Problem:** Insights get injected into session context (`loadContext` → "Relevant memory" block) but nothing tracks whether they helped.

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

### Phase 5 — Ops hygiene

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

- `learning/online.test.ts`: mock searchFn + fetchFn, assert insights shape + dedupe path
- `learning/utility.test.ts`: simulate multiple sessions per insight, assert ordering flips by success correlation
- `learning/scheduler.cycle.test.ts`: simulated 3-cycle streak of emptiness → finding raised
- E2E: `e2e/learning.e2e.test.ts` against live (local) network with HN API

## References

- `packages/server/src/learning/online.ts` (current implementation)
- `packages/server/src/learning/knowledge.ts` ("mocked vector" cosine — see also pgvector path)
- `docs/KILO_COVERAGE.md` §H2 for learning parity claims
