# Aether Architecture — Better Than All

## 6-Layer 2026 Stack (O'Reilly)

| Layer | 2026 Reality | Tech |
|-------|--------------|------|
| 1. Models & Inference | Reasoning models (o1/o3, R1, Claude thinking), open-weight close gap | API vs self-host |
| 2. Protocols & Tools | MCP won (97M downloads, Linux Foundation), Browser Use 78K | MCP, Browser automation |
| 3. Memory & Knowledge | 3 tiers: in-context → vector → persistent cross-session | Postgres+pgvector, Mem0, Zep |
| 4. Frameworks & SDKs | 3 camps: Provider SDKs vs Graph (LangGraph) vs No-framework | Vercel AI SDK, LangGraph |
| 5. Eval & Observability | 89% observability, 52% evals — biggest gap | Langfuse, Braintrust |
| 6. Guardrails & Safety | Tool execution layer, not output | NeMo, custom policy |

## Detailed Blueprint

| Layer | Recommendation | Why |
|-------|---------------|-----|
| Shell | Next.js 16.2 + TypeScript | One language |
| Runtime | Bun (native SQLite) | proven, fast |
| Monorepo | Turborepo | Multi-package |
| UI | SolidJS + Tauri v2 | Fine-grained reactivity |
| LLM | Model Gateway (OpenRouter) | 75% multi-model |
| Orchestration | Vercel AI SDK v5 → LangGraph v1.0 | Thin by default |
| Tools | Native + MCP | Neutral standard |
| Memory | Postgres+Drizzle+pgvector → Zep/Mem0 | Keep vectors in DB |
| Instructions | AGENTS.md + Skills | 29% faster |
| Observability | OTel + Langfuse | 89% prod have it |
| Eval | 3 tiers: PR → nightly → prod | 52% gap |
| Guardrails | Tool-layer auth | Least mature |
| Storage | SQLite (WAL) + Postgres | Pragmatic |
| Auth | Clerk + Stripe | Commodity |
| Validation | Zod v4 | Runtime schema |

## Orchestration Patterns

- **Sequential Pipeline:** Fixed sequence, simplest
- **Concurrent / Fan-Out:** Parallel subtasks
- **Router:** Diverse requests → specialist
- **Supervisor:** Central coordinator (2-5x cost)
- **Handoff:** Agent-to-agent transfer
- **Group Chat:** Conversational collaboration

**Rule:** Start thin (Vercel AI SDK loop), add LangGraph only when needed.

## Memory Architecture

- **Taxonomy:** Episodic (events) → Semantic (facts) → Procedural (skills)
- **Benchmarks:** LoCoMo, LongMemEval, BEAM, AMB
- **Hybrid Retrieval:** Vector → graph → rerank → assembly
- **Multi-Agent:** Shared global vs hierarchical vs isolated
- **Security:** MINJA 95% injection, need guardrails

## Mira Patterns Worth Copying

- Layered fallback > perfect prediction (9 edit replacers)
- Constraints are security (tool visibility, not prompt)
- Event-driven glue (BusEvent → GlobalBus → Worker)
- Pragmatism (SQLite over Postgres, Drizzle over Prisma)

## Implemented State (2026-08)

The blueprint above is now **built and verified** in this repo:

| Layer | Implementation | Verified by |
|-------|---------------|-------------|
| Models & Inference | Gateway: OpenRouter + NVIDIA NIM, OpenAI-compatible wire, prompt caching for Claude, cost tracking per request + per session | Live LLM E2E (gated) |
| Protocols & Tools | 24 native tools; **real MCP stdio client** (initialize/tools/list/tools/call); **real LSP 3.17 client** (gopls) with heuristic fallback | Mock-server protocol tests + live gopls test |
| Memory & Knowledge | KnowledgeBase singleton: episodic/semantic/procedural, cosine+tag+graph retrieval, auto-injected into every turn; `memory_search`/`memory_write` tools | Unit tests + live roundtrip |
| Frameworks | Thin custom loop (`SessionPrompt`): stream → tools → permission → snapshot → doom-loop → compaction → usage learning | E2E server tests |
| Eval & Observability | 3-tier eval runner gating CI; gateway cost stats at `/dev/health` + UI headers; per-session spend columns | eval pr tier PASS |
| Guardrails & Safety | Permission 5-layer + BashArity at tool layer; audit log; **file snapshots before every mutation** with undo/rewind REST | Snapshot unit + E2E tests |

Additional shipped systems:

- **Doom-loop detector** — 3x identical / A-B cycle / no-progress edit detection (unit-tested; fixed first-call false positive)
- **Compaction** — hierarchical summarize via small model (abstractive when key present, extractive fallback otherwise)
- **HITL** — `question` tool pauses the loop; `question.ask`/`question.reply` over WS; web + TUI renderers
- **Queueing** — durable SQLite message queue; chained-turn drain after finalize
- **Subagents** — `task` tool spawns persistent child sessions (`parentID`), personas via agent templates
- **Self-improvement** — pain-point detector → patcher → shadow verifier → applier; opt-in autopilot opens PRs via `gh`
- **Security defaults** — loopback bind, optional bearer token, env-var secrets only

## Design Principles

1. Start thin, earn complexity
2. Constraints > prompts
3. Fallback > prediction
4. Event-driven (no polling)
5. Plan-first (Explore→Plan→Implement→Verify)
6. Eval before deploy
7. Memory-aware planning

## Sources

- zengineer.blog (Mira deep-dive)
- arxiv.org/abs/2604.14228 (Claude Code)
- oreilly.com/radar/the-ai-agents-stack-2026-edition
- vibeready.sh/blog/ai-agent-tech-stack-2026
- zylos.ai/research/2026-04-05-ai-agent-memory-architectures
