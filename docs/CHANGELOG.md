# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — 2026-09-04

- **H2-3 Orchestrator v2** (`f262fa68`): `orchestrate` tool gains inferDAG planner (E1,
  cheap-model `openrouter/deepseek/deepseek-v3.2-exp`, fail-closed), wave-context + jobs
  persistence (E2, one `jobs` row per node, `contextFrom` summary forwarding, 600-char previews),
  and skill-synthesis hook (E3, fail-open candidate to `findings` + `message.updated` event).
  Guards: ≤12 tasks, `budgetSteps` ≤25, 8-wide wave cap, cycle → reject, dense → single wave,
  one retry then skip dependents. See `docs/H2-3-ORCHESTRATOR-V2.md`.
- **H2-2 Mira Score GA** (`d69725d0`): per-session `{score,cost,doomLoops,toolErrors,memoryHits}` +
  trace (`traceId`, `spanId`, `durationMs`, `model`, `toolCalls`) via `GET /learning/score`;
  `format=badge|svg` and `format=markdown` variants for PR comments / README.
- **Memory graph wiring** (H2-1 `48c4ea6d` + canvas `f7827968`): `KnowledgeBase.getGraph(limit)`
  → `GET /knowledge/graph?limit=N` (alias `GET /learning/graph`) → `client.getKnowledgeGraph()` →
  read-only `<MemoryGraph/>` SVG canvas. Contract: `{ nodes: GraphNode[], edges: GraphEdge[] }`
  with `related` (graphLinks), `entity` (shared-entity star, groups of 2–8), and `finding` edges;
  limit clamped to 500. See `docs/H2-3-ORCHESTRATOR-V2.md` §7.
