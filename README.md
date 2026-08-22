# Mira — AI Agent Platform Better Than All

> **OpenCode's openness + Claude's reasoning + Cursor's polish + Windsurf's autonomy + Cline's transparency, minus weaknesses, plus memory/eval/guardrails as first-class.**

Mira is a next-gen AI agent platform that combines the best of all worlds and solves what none have fully solved: **hierarchical hybrid memory, eval-first observability, tool-layer guardrails, and a model gateway that makes you future-proof.**

## Why Mira?

| Feature | OpenCode | Claude Code | Cursor | Windsurf | Cline | **Mira** |
|---------|----------|-------------|--------|----------|-------|------------|
| Provider-agnostic | ✅ 25+ | ❌ Claude-only | ⚠️ Limited | ⚠️ Limited | ✅ BYO-key | ✅ **Gateway + 75+** |
| LSP Intelligence | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ **LSP + 9-layer edit** |
| Hierarchical Memory | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **Episodic/Semantic/Procedural** |
| Eval-first | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ✅ **3-tier eval** |
| Tool-layer Guardrails | ❌ | ⚠️ | ❌ | ❌ | ❌ | ✅ **Enforced** |
| Parallel Sessions | ✅ | ✅ | ❌ | ⚠️ | ✅ | ✅ **Unlimited** |
| Cost Control | ✅ Free | $20-200 | $20-200 | $15-35 | Free | ✅ **Free + local** |

## Architecture

```
[Clients] TUI (SolidJS) | Desktop (Tauri) | VS Code | Web | Mobile
         ↕ RPC / WebSocket
[Server] Agent Engine → Tool Registry (22+ tools) → Permission (5 layers)
         ↕ Vercel AI SDK v5 → Model Gateway → 25+ Providers
         ↕ MCP (HTTP/SSE/Stdio) → External Tools
         ↕ Event Bus (no polling)
         ↕ Storage: SQLite + Postgres+pgvector
         ↕ Memory: Episodic + Semantic + Procedural (hybrid)
         ↕ Observability: OTel → Langfuse → Evals → Guardrails
```

## Stack

- **Shell:** Next.js 16.2 + TypeScript
- **Runtime:** Bun (native SQLite, fast)
- **Monorepo:** Turborepo
- **UI:** SolidJS + Tauri v2
- **LLM:** Model Gateway (OpenRouter) + Vercel AI SDK v5
- **Tools:** Native + MCP (Linux Foundation standard)
- **Memory:** Postgres + Drizzle + pgvector → Zep/Mem0
- **Instructions:** AGENTS.md + Skills (29% faster, 17% fewer tokens)
- **Observability:** OpenTelemetry + Langfuse
- **Eval:** 3 tiers (PR → nightly → prod)
- **Guardrails:** Tool-layer authorization

## 10 Differentiators

1. **Provider-Agnostic + Model Gateway** — 75% teams use multiple models, future-proof
2. **LSP Intelligence + 9-Layer Edit** — Symbol-aware, fixes non-determinism
3. **Hierarchical Memory** — 15-point accuracy gaps, hybrid vector+graph
4. **Eval-First + Tool-Layer Guardrails** — Quality #1 barrier, guard at tool call
5. **AGENTS.md + Plan-First** — 29% faster, 17% fewer tokens
6. **Client/Server + Parallel Sessions** — No polling, unlimited delegation
7. **Doom-Loop + Compaction + HITL** — Prevent infinite loops, handle arbitrary length
8. **MCP-Native** — Linux Foundation standard, 30% vendors by end 2026
9. **Cost Control + Local Models** — Free + Ollama, frontier planner + cheap executor
10. **Security by Design** — 82% MCP vuln, memory injection 95% — centralized guardrails

## Quick Start

```bash
# Install
curl -fsSL https://mira.ai/install | bash

# Run
mira

# With free models
mira --model deepseek/deepseek-chat --provider openrouter
```

## Research

Based on 2026 SOTA research:
- OpenCode architecture deep-dive (zengineer.blog)
- Claude Code reverse-engineer (arXiv:2604.14228)
- O'Reilly 6-layer 2026 stack
- Memory architectures (Zep, Mem0, Letta)
- 30+ verified sources

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full details.

## License

MIT — Open source, provider-agnostic, community-driven.

---

**Built to be better than all — not another Cursor clone.**
