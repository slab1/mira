# Trust & Provenance System — Design (MIRA_GAP_PLAN.md P0 #2)

**Status:** design only. Success criteria: *“provenance scores on ALL memories, evidence tracking.”*
**Scope note:** `learning/knowledge.ts` carries an **uncommitted parallel-lane diff** that already adds
`ProvenanceLevel`, `PROVENANCE_CONFIDENCE`, `provenance TEXT` and `confidence REAL` columns. This design
**extends** that work — never reverts or renames it. Re-read every file at implementation time.

---

## 1. Current state (explored, file:line)

There is not one memory store — there are four. “ALL memories” must enumerate them:

| # | Store | Write chokepoint(s) | Provenance today |
|---|-------|--------------------|------------------|
| 1 | `knowledge_entries` (SQLite) — the main KB | `KnowledgeBase.store()` `learning/knowledge.ts:269` → `persist()` `:760` (only SQL writer, `INSERT OR REPLACE` `:770`) | **Partial (lane, uncommitted):** `provenance`+`confidence` columns, 5-level enum, defaults `agent-generated/0.5` (`:285-286`), read default `unverified/0.2` (`:246-247`) |
| 2 | `evolution_memory` (SQLite) — failure/success memory | `EvolutionMemory.remember()` `memory-evolution/evolution-memory.ts:114` | **Compliant already:** `confidence REAL` + `evidence TEXT` with per-type defaults (`defaultConfidence()` `:297`); `MemoryProvenance.explain()` `memory-evolution/provenance.ts:128` exposes §8/§9 |
| 3 | `episodic_memory.jsonl` + `semantic_memory.json` (files) | `MemoryController.store_experience()` `memory/memory_controller.ts:116`, `store_fact()` `:278` | **None** — no source/confidence fields at all |
| 4 | `data/memory_bank/*.md` (markdown) | `appendActiveWork()` `memory_controller.ts:515` | Unstructured side-channel → **non-goal** (documented, not instrumented) |

**Agent-facing surface:** `memory_write` / `memory_search` tools → `sharedKnowledge().store()/retrieve()`
(`tools/memory.ts:44-52`, `:22-27`). There is **no separate MCP server** exposing memory -- these are
native tools, lazily registered at `tools/registry.ts:149`, with zod schemas mirrored in
`shared/src/schemas/tools.ts:201-202`; no other memory tool surface exists in the repo. `ToolContext`
already carries `sessionID` / `messageID` / `agent` (`tools/registry.ts:60-67`), so `sourceRef` and
`createdBy` are derivable with **no new context plumbing**. **`memory_search` currently strips everything but
title/content/tags/tier/score (`:26`) — provenance never reaches the agent.** There is no `GET /knowledge`
list; consumer surfaces are `memory_search`, `buildCognitivePacket` (`knowledge.ts:594`),
`formatCognitivePacket` (`memory_controller.ts:449`), `GET /knowledge/graph` (`learning/index.ts:171`),
`POST /knowledge` (`:204`), `POST /finding/:id/promote` (`:248`).

**Existing scoring that provenance must complement, not duplicate:**
- Retrieval ranking: cosine + tags + entities + `temporalDecay` 30-day half-life (`knowledge.ts:834`) + access bonus + graph bonus + `metadata.utility` (±20, `bumpUtility` `:388`).
- Aging/retirement: `sweepExpired()` 60-day tombstone (`:404`); `storage/db.ts:264-275` prunes >30d when table >5000 rows.
- Outcome quality (parallel lane, untracked): `MemoryQualityTracker` `learning/quality.ts` — success/failure per memory → keep/review/retire.
- **Division of labor:** *provenance = where it came from + what backs it (mostly static)*; *quality/utility = whether it helped (dynamic, already exists)*; *temporal decay = freshness (ranking)*. Provenance adds **none** of these three again.

---

## 2. Provenance schema

### 2.1 Fields (per memory record)

Lane-owned (keep as-is): `provenance: ProvenanceLevel`, `confidence: number`.
New fields (optional on input, defaulted at the chokepoint — keeps `StoreInput` backward compatible so cast-site callers like `prompt.ts:437` `store(storeInput as never)` don’t break):

| Field | Type | Meaning |
|-------|------|---------|
| `sourceKind` | `'agent-authored' \| 'tool-output' \| 'user-stated' \| 'imported' \| 'derived' \| 'unknown'` | origin class of the memory |
| `sourceRef` | `string \| null` | primary origin pointer: `session:<id>`, `msg:<id>`, `tool:<name>#<callId>`, `finding:<id>`, or URL |
| `createdBy` | `string` | actor: `agent:<name>`, `user`, `scheduler:online`, `system`, `legacy` |
| `evidence` | `EvidenceRef[]` | links backing the claim (see §4) |
| `derivedFrom` | `string[]` | parent memory ids for synthesized memories (chain, cap 5) |
| `lastVerifiedAt` | `number` | `createdAt` unless corroborated/verified later (staleness input) |

```ts
export interface EvidenceRef {
  kind: 'url' | 'ci' | 'benchmark' | 'session' | 'finding' | 'file' | 'message'
  ref: string       // URL, run id, session id, finding id, "path:line"
  at: number        // ms epoch
}
```

### 2.2 SQLite DDL (match `storage/db.ts` / `knowledge.ts` style: `addColumn(table,col,type)` + `ALTER TABLE … ADD COLUMN`)

```sql
-- storage/db.ts addColumn block (after line 254) + knowledge.ts load() addCol (after :222):
addColumn('knowledge_entries', 'provenance',       "TEXT NOT NULL DEFAULT 'unverified'") -- only if lane's nullable col absent
addColumn('knowledge_entries', 'confidence',       'REAL NOT NULL DEFAULT 0.2')
addColumn('knowledge_entries', 'source_kind',      "TEXT NOT NULL DEFAULT 'unknown'")
addColumn('knowledge_entries', 'source_ref',       'TEXT')          -- nullable by nature
addColumn('knowledge_entries', 'created_by',       "TEXT NOT NULL DEFAULT 'legacy'")
addColumn('knowledge_entries', 'evidence',         "TEXT NOT NULL DEFAULT '[]'")
addColumn('knowledge_entries', 'derived_from',     "TEXT NOT NULL DEFAULT '[]'")
addColumn('knowledge_entries', 'last_verified_at', 'INTEGER')       -- nullable → created_at on read
```

For DBs where the lane already added a **nullable** `provenance`/`confidence` (addCol raises
`duplicate column name`), follow with backfill:

```sql
UPDATE knowledge_entries SET provenance='unverified' WHERE provenance IS NULL;
UPDATE knowledge_entries SET confidence=0.2          WHERE confidence IS NULL;
UPDATE knowledge_entries SET source_kind='unknown'   WHERE source_kind IS NULL;
UPDATE knowledge_entries SET created_by='legacy'     WHERE created_by IS NULL;
UPDATE knowledge_entries SET evidence='[]'           WHERE evidence IS NULL;
UPDATE knowledge_entries SET derived_from='[]'       WHERE derived_from IS NULL;
```

### 2.3 TypeScript interface (extends lane’s `MemoryEntry`, `knowledge.ts:55-75`)

```ts
export interface MemoryEntry {           // added fields only
  provenance: ProvenanceLevel            // lane-owned, already present
  confidence: number                     // lane-owned, already present
  sourceKind: SourceKind                 // new
  sourceRef: string | null               // new
  createdBy: string                      // new
  evidence: EvidenceRef[]                // new
  derivedFrom: string[]                  // new
  lastVerifiedAt: number                 // new
}
```

### 2.4 Migration / backfill policy for existing rows — **“unknown → the lowest honest rung”**

- `provenance='unverified'`, `confidence=0.2` (the lane already does exactly this at read time, `knowledge.ts:246-247` — the SQL backfill just makes it durable and bypass-proof).
- `source_kind='unknown'`, `created_by='legacy'`, `source_ref=NULL`, `derived_from=[]`.
- **Evidence backfill at read time:** in `load()`, if `evidence` is empty and `metadata.sourceUrls`/`metadata.url` exists (the `storeInsight` merge counters, `knowledge.ts:338-351`), derive `evidence = sourceUrls.map(u => ({kind:'url', ref:u, at:createdAt}))` and set `source_kind='imported'`. Persisted lazily on next write — no bulk rewrite (table is retention-pruned at 5000 rows, `db.ts:264-275`).
- **Why not guess higher?** Legacy rows have unknown origins; overstating trust is the failure mode this P0 exists to prevent. They stay fully retrievable — just flagged (§4).

---

## 3. Confidence levels

Reuse the lane’s five-level enum verbatim — one vocabulary, no parallel taxonomy:

| Level | Anchor | Meaning | Initial assignment |
|-------|--------|---------|--------------------|
| `human-verified` | 1.0 | A human explicitly asserted/confirmed it | `sourceKind='user-stated'` (`POST /knowledge`) |
| `ci-verified` | 0.9 | Backed by a passing test/CI artifact | `tool-output` + evidence `kind:'ci'` |
| `benchmark-verified` | 0.85 | Backed by a measured benchmark run | `tool-output` + `kind:'benchmark'`, or `derived` from benchmark parents |
| `agent-generated` | 0.5 | Agent produced, no external artifact | `agent-authored` / `imported` (URL-backed insights) / default |
| `unverified` | 0.2 | No evidence of correctness | backfill / explicit override |

**Default mapping in `normalizeProvenance()` (new module, §6):**

```
user-stated                    → human-verified 1.0
tool-output + ci|benchmark ev. → ci-verified 0.9 / benchmark-verified 0.85
tool-output without evidence   → agent-generated 0.5
agent-authored                 → agent-generated 0.5
imported                       → agent-generated 0.5 (+URL evidence; rises via corroboration)
derived                        → level = min(parent levels) capped at benchmark-verified;
                                 confidence = min(0.7, min(parent confidences))   // weakest-link, max 0.7
unknown (backfill)             → unverified 0.2
```

*Derived memories can never launder trust upward* (cap 0.7 / benchmark-verified) — a chain is only as
strong as its weakest link.

**Lifecycle (simple, explainable, no ML):**
1. **Rise — corroboration only:** each *distinct* additional evidence ref ⇒ `confidence += 0.05`, hard cap `0.95` (never reaches human-verified). The `storeInsight` verifier merge (`verifiers` counter, `knowledge.ts:338-351`) is the existing precedent; `corroborate(entry, ref)` is the shared helper. Level changes only when new evidence *of that class* arrives (write-time), never from arithmetic.
2. **Decay — read-time staleness, no write amplification:** `effective = confidence`; if `now - lastVerifiedAt > 90d` then `effective = min(effective, 0.4)`. Stored value untouched.
3. **No time decay in the stored score** — `temporalDecay` already ages memories in *ranking*; decaying confidence too would double-penalize and contradict (1).

---

## 4. Evidence tracking

**What counts as evidence:** URL (online insight source), CI run id/URL, benchmark run id, session/message/tool-call id, `finding:<id>` (the `findings` table already stores `evidence TEXT`, `db.ts:153`), `file:line` citation, parent memory id (derivation). **Not** evidence: the memory’s own text or bare agent assertion without an artifact.

**Link shape:** `evidence TEXT` column = JSON array of `EvidenceRef`, capped at 8 at write (append via `corroborate()`; read-modify-write, last-writer-wins is acceptable — evidence is append-mostly). `sourceRef` holds the *primary* origin; `derivedFrom` holds parent memory ids separately so chains stay queryable without parsing evidence.

**Consumer return shape (provenance becomes visible):**
- `memory_search` results (`tools/memory.ts:26`) become
  `{ title, content, tags, tier, score, provenance: { level, confidence, caution, sourceKind, sourceRef, createdBy, evidence: EvidenceRef[] } }` — additive, nothing removed.
- `buildCognitivePacket` (`knowledge.ts:594`) one-line prefix:
  `` `- [${tier}/${source} · ${m.provenance} ${eff.toFixed(2)}${caution ? ' ⚠' : ''}] ${title}: …` ``. Same treatment for `formatCognitivePacket` (`memory_controller.ts:449`).
- `caution = effectiveConfidence < 0.5 || level === 'unverified' || stale(lastVerifiedAt > 90d)`.

**Retrieval policy: flag, don’t hide —** low-confidence memories surface **with the ⚠ caution flag**,
never filtered, and confidence is **not** multiplied into rank. Justification:
(a) `temporalDecay` already penalizes age in rank — multiplying confidence double-penalizes;
(b) safety-relevant memories (doom-loop warnings, `prompt.ts:400-436`) are `agent-generated/0.5` and must stay visible — burying them defeats their purpose;
(c) hiding = silent knowledge loss, while the gap plan asks for *scores on all memories*, not culling.
Add `RetrieveOptions.minConfidence?: number` (default `undefined` = off) as a two-line knob for later strict consumers — P0 ships it **unset**.

---

## 5. Enforcement — “provenance on ALL memories”

**Chokepoints (every write flows through these):**
1. `KnowledgeBase.store()` `learning/knowledge.ts:269` — **THE** normalization point: spreads `normalizeProvenance(input, ctx)` so `provenance/confidence/sourceKind/sourceRef/createdBy/evidence/derivedFrom` are never `undefined`. All KB writers funnel here: `storeInsight` `:355`, `storeUsageAnalysis` `:426/:438`, `seedDefaultKnowledge` `:998`, `memory_write` `tools/memory.ts:45`, `POST /knowledge` `learning/index.ts:216`, finding promote `:261`, doom-loop `session/prompt.ts:440`, improvement `learning/improvement.ts:306`, patch applier `patching/applier.ts:94`.
2. `KnowledgeBase.persist()` `knowledge.ts:760` — sole SQL writer; **both** INSERT variants must list the provenance columns.
3. `EvolutionMemory.remember()` `evolution-memory.ts:114` — already compliant (confidence+evidence always set).
4. `MemoryController.store_experience()` `memory_controller.ts:116` / `store_fact()` `:278` — fill defaults from `normalizeProvenance` (`memory_controller.ts` already imports from `learning/knowledge.js` at `:26`, so the import direction is fine).

**Bypass paths to close:**
- `persist()` **fallback INSERT** `knowledge.ts:799` omits provenance columns → add them (or delete the fallback — primary INSERT works once `storage/db.ts` added the columns).
- `storage/db.ts` `addColumn` block `:244-254` lacks provenance/confidence → add all 8 columns + backfill UPDATEs there (authoritative boot migration; `migrate(db)` runs before routes).
- Raw `INSERT INTO knowledge_entries …` in `memory-evolution.test.ts:148` → harmless **only if** column `DEFAULT`s are set: the DB-level `DEFAULT 'unverified'/0.2/'unknown'/…` backstop makes even uncontrolled inserts provenance-complete.
- `MemoryController` file stores (zero today) → closed by chokepoint 4.
- `appendActiveWork` markdown → accepted, documented non-goal.

**Enforcement test:** one test sweeps every public write API (funnel list above) against a `:memory:` DB, then asserts
`SELECT COUNT(*) FROM knowledge_entries WHERE provenance IS NULL OR confidence IS NULL OR source_kind IS NULL OR created_by IS NULL` **=== 0**, plus a raw-SQL insert inheriting defaults. This is the executable form of “provenance on ALL memories”.

---

## 6. Implementation plan (ordered, small diffs for the fixer)

1. **NEW `packages/server/src/memory/provenance.ts`** (~120 lines): `SourceKind`, `EvidenceRef`,
   `normalizeProvenance(input, ctx)` (all defaults + derived weakest-link rule), `effectiveConfidence(entry, now)`
   (staleness cap), `cautionFlag(entry, now)`, `corroborate(entry, ref)` (cap 8, +0.05, cap 0.95), `backfillEvidence(entry)`.
   Does **not** redefine `ProvenanceLevel`/`PROVENANCE_CONFIDENCE` — imports them from `learning/knowledge.js`.
2. **`packages/server/src/storage/db.ts`**: the 8 `addColumn` lines + 6 backfill `UPDATE`s (§2.2) after line 254.
3. **`packages/server/src/learning/knowledge.ts`** (⚠ dirty — lane diff; re-read first, extend adjacent to its lines):
   - `MemoryEntry`/`StoreInput`/`KnowledgeRow`: +6 optional fields;
   - `CREATE TABLE` `:193-194` + `addCol` `:221-222`: +6 columns;
   - `store()` `:285`: replace inline defaults with `...normalizeProvenance(input, ctx)` (lane defaults remain the fallback);
   - `load()` `:246`: read new fields, apply `backfillEvidence`;
   - `persist()` `:771/:799`: extend **both** INSERTs;
   - `buildCognitivePacket()` `:594`: caution prefix (1 line); optional `minConfidence` filter (2 lines, unset).
4. **`packages/server/src/memory/memory_controller.ts`**: `EpisodicEntry` `:30` / `SemanticRelation` `:39` gain optional `provenance? confidence? sourceKind? sourceRef? evidence?`; `store_experience` `:116` and `store_fact` `:278` fill them via `normalizeProvenance`.
5. **`packages/server/src/tools/memory.ts`**: `memory_write` passes `sourceKind:'agent-authored'`, `sourceRef:'session:'+ctx.sessionID`, `createdBy:'agent:…'`; `memory_search` `:26` returns the `provenance` block.
6. **`packages/server/src/learning/index.ts`**: `POST /knowledge` `:216` → `sourceKind:'user-stated'`, `createdBy:'user'`; finding promote `:261` → `sourceKind:'derived'`, `derivedFrom:['finding:'+id]`, `sourceRef:'finding:'+id`.
7. **Tests** (below), then `bun test` + `tsc --noEmit`.

**Test plan:**
- **NEW `packages/server/src/memory/provenance.test.ts`**: normalize defaults per `sourceKind`; derived cap (≤0.7 / ≤benchmark); corroboration rise (+0.05×n, cap 0.95); staleness cap (90d → ≤0.4); caution rule; `memory_write`/`memory_search` round-trip shows provenance (call tool `execute` with a fake ctx); `MemoryController.store_experience`/`store_fact` defaults with a tmp `memoryDir`.
- **EXTEND `packages/server/src/learning/knowledge.test.ts`**: (a) bare `store()` → all provenance columns non-null on the row; (b) §5 sweep assertion across write APIs + raw-SQL bypass inheriting DEFAULTs; (c) `POST /knowledge` sets `user-stated`/`human-verified` (route tests already live here, `:119`); (d) read-time evidence backfill from `metadata.sourceUrls`.
- **RUN unchanged:** `memory-evolution/memory-evolution.test.ts` (raw INSERT `:148` must still pass — proves the DEFAULT backstop), `learning/utility.test.ts`, `learning/online.test.ts`.

**NON-goals (keep P0 minimal):** no knowledge-graph edges for provenance; no UI badges beyond a trivial one-liner; no confidence multiplier in ranking; no schema changes to `evolution_memory` (already compliant) or `findings`; no `memory_bank` md instrumentation; no agent-reliability metrics (separate P1 item); no replacing the existing `MemorySource` field (pipeline ≠ origin); no ML/learned scoring.

---

## 7. Risks & edge cases

- **Parallel-lane collision (highest risk):** `learning/knowledge.ts` is dirty with the lane’s provenance diff; `learning/quality.ts`, `agents/metrics.ts`, `policy/`, `repo/`, `sandbox/` are untracked lane files. Rule for the fixer: **never revert the lane’s `ProvenanceLevel`/`PROVENANCE_CONFIDENCE`/columns; add new fields adjacent to them; re-read the file (hash-anchored edits) before every edit; stay out of `quality.ts`** — provenance (origin/evidence) and `memory_quality` (outcome utility) are complementary by design.
- **Concurrent writes:** SQLite single-writer; `storeInsight` dedupe does read-modify-write on the same id (existing behavior) — a concurrent append to the evidence array may be lost (acceptable, append-mostly); no new locking introduced.
- **Existing data volume:** retention prunes >5000 rows / 30d (`db.ts:264-275`), `load()` caps 2000 → backfill is SQL `UPDATE` (covers unloaded rows) + read-time evidence derivation, not a bulk TS rewrite.
- **Nullable-lane-column case:** if the lane’s `provenance TEXT` already exists, `ADD COLUMN … NOT NULL DEFAULT` fails `duplicate column name` → the `UPDATE … WHERE NULL` backfill (§2.2) is mandatory, not optional.
- **`store(storeInput as never)` callers** (`session/prompt.ts:437-443`): safe only because new `StoreInput` fields are optional; making them required would break the cast sites — keep optional.
- **Windows:** evidence `ref`s are opaque strings — never require fs paths, so path-separator issues can’t corrupt evidence.

---

**Report-back summary:** chokepoints = `KnowledgeBase.store()` (`knowledge.ts:269`) for normalization + `KnowledgeBase.persist()` (`:760`) as sole SQL writer, with `EvolutionMemory.remember()` (`evolution-memory.ts:114`) and `MemoryController.store_experience/store_fact` (`memory_controller.ts:116/:278`) as secondary funnels. Migration policy = *unknown → `unverified`/0.2/`source_kind:'unknown'`/`created_by:'legacy'`*, evidence backfilled from `metadata.sourceUrls` at read time, enforced by column `DEFAULT`s so raw bypass inserts inherit safe values.
