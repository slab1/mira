<div align="center">

# Mira

**A self-hostable AI coding agent with hierarchical memory, eval-gated changes, and a wrong-edit defense stack.**

[![Tests](https://img.shields.io/badge/server%20tests-[1152]-passing-brightgreen)](#status)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%201.4.0-black)](https://bun.sh)
[![Status: beta](https://img.shields.io/badge/status-beta-orange)](#status)

[Quickstart](#quickstart) · [Why Mira](#why-mira) · [Architecture](#architecture) · [Contributing](CONTRIBUTING.md) · [Docs](docs/)

<!-- TODO before launch: replace with the auto-rollback demo GIF -->
![Mira refusing an ambiguous edit and rolling back a failed change](docs/assets/demo.gif)

</div>

---

## Why Mira

Every coding agent I used had the same failure mode: it would occasionally
mangle a file. It would take the "first match" of an ambiguous search string,
or make a change that passed its own check but broke something downstream,
and I'd find out an hour later.

Mira is built around fixing that. Edits are **refused when the target is
ambiguous**, a **snapshot is taken before every mutation**, and a **failed
verification triggers automatic rollback** to the last good state. Every
mutating tool call is logged so you can audit what the agent actually did.

The secondary goals came from the same place — wanting a tool I could trust
and inspect:

- **Eval-first development.** A 3-tier eval pipeline (PR → nightly → prod).
  The PR tier blocks CI. Behavior changes get validated before they ship.
- **Hierarchical memory.** Episodic / semantic / procedural memory, retrieved
  per turn, instead of stuffing the entire context window.
- **Provider-agnostic.** A gateway over OpenRouter and NVIDIA NIM (25+
  providers) with cost tracking. Bring your own key, or run fully local.
- **Self-hostable.** Bun + SQLite, no cloud dependency, `docker run` or
  `bun run dev`. MIT licensed.

Mira is a solo-maintained project. See [Status](#status) before you depend on it.

---

## Status

- **[1152]** server tests passing as of [DATE]
- Actively developed — last commit [DATE]
- **Solo-maintained.** Issues triaged weekly. PRs welcome, expect review latency
  (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- **Beta.** Not yet deployed in production by anyone but the author.
  Treat it as such.

If you hit something broken, please [open an issue](https://github.com/slab1/mira/issues) —
that's how this gets better.

---

## Quickstart

Requires **Bun 1.4.0** (pinned in `.tool-versions`).

```bash
git clone https://github.com/slab1/mira
cd mira
bun install
bun run dev
```

That starts:

| Service | URL |
|---|---|
| Server | http://127.0.0.1:4096 |
| Web UI | http://127.0.0.1:3000 |
| TUI | http://127.0.0.1:3001 |

**No API key required to try it.** The gateway serves a stub stream, so the
full pipeline — tools, permissions, snapshots, SSE, persistence — runs offline.
Add a key when you want real inference:

```bash
export OPENROUTER_API_KEY=sk-or-...
# or
export NVIDIA_API_KEY=nvapi-...
```

### Docker

```bash
docker build -t mira .

docker run -d \
  --name mira \
  -p 4096:4096 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  mira
```

For production, set `HOST=0.0.0.0`, `MIRA_TOKEN`, and a provider key.
Health probes: `GET /healthz` (unauthenticated), `GET /health` (behind auth).

### CLI

```bash
npx mira-cli-ts --help

mira session list
mira agent list
mira complete --prefix "function add(a,b) {" --file src/math.ts
```

Point `$MIRA_API_URL` at your server.

---

## The wrong-edit defense stack

This is the part of Mira that matters most. Each layer is independent and
can fail without taking the others down.

| Layer | What it does |
|---|---|
| **Ambiguity gate** | Refuses edits whose `oldString` matches more than one location. Never "first match." |
| **Intent anchors** | Tracks what the agent said it was going to do and flags edits that drift from it. |
| **Symbol binding** | Warns when an edit touches symbols other than the one under discussion. |
| **Edit critic** | Optional second-model review of every edit before it lands. |
| **Blast-radius analysis** | In strict mode, blocks edits affecting more than [N] dependents. |
| **Snapshot** | Every mutation is snapshotted to SQLite first. |
| **Verification** | Post-edit checks run automatically (tests, typecheck, configurable). |
| **Auto-rollback** | Failed verification restores the last good snapshot. |
| **Agent-callable `revert`** | The agent can undo its own work mid-session. |

The full design is documented in [`docs/GUARDRAILS_SUMMARY.md`](docs/GUARDRAILS_SUMMARY.md).

---

## Features

**Agent loop**
- 42 native tools plus dynamic MCP tools (stdio, Streamable HTTP, legacy HTTP+SSE)
- Real LSP servers over JSON-RPC 3.17 (e.g. `gopls`) with a 9-layer edit fallback
- 5-layer permission system, enforced at the tool layer
- Durable message queue (SQLite) so you can queue prompts while streaming
- Inspectable subagents — persistent child sessions with full transcripts
- Human-in-the-loop questions mid-session

**Memory & learning**
- Hierarchical memory: episodic / semantic / procedural
- Hybrid retrieval (cosine similarity + tag boost + graph expansion)
- Per-turn injection of relevant memories
- Online usage analysis

**Observability**
- Prometheus `/metrics` with bounded cardinality
- OpenTelemetry spans correlated to access logs via `X-Request-Id`
- Full audit trail of every mutating tool call (CSV/JSON export)

**Safety & compliance**
- Bearer token auth, `0o600` storage, query-param tokens rejected
- Multi-tenancy with RBAC (`viewer` / `operator` / `admin`), owner-scoped resources
- Per-socket rate limiting; proxy headers only honored when `MIRA_TRUST_PROXY=1`
- Secret and PII redaction before persistence
- Configurable retention sweeps (`MIRA_COMPLIANCE_RETENTION_DAYS`, default 90)
- Guardrails fail-open in dev, **fail-closed in production** by default

**Interfaces**
- Web UI (SolidJS + Vite, PWA)
- TUI (SolidJS)
- CLI (`mira-cli-ts` via `npx`)
- Slack bot (Socket Mode — no public tunnel needed)
- VS Code extension

---

## How Mira differs

This table reflects my design goals, not independent benchmarks. Where a
checkmark appears, the linked section explains the mechanism — judge the
mechanism, not the checkmark.

| Capability | Typical proprietary agent | Mira |
|---|---|---|
| Provider choice | Vendor-locked or limited | **25+ via gateway** (OpenRouter, NVIDIA NIM) |
| Real LSP | Rare | **JSON-RPC 3.17** + 9-layer fallback |
| Hierarchical memory | Rare | **Episodic/semantic/procedural**, hybrid retrieval |
| Eval gating in CI | Rare | **3-tier pipeline**, PR tier blocks CI |
| Tool-layer guardrails | Partial, opaque | **Enforced + auditable log** |
| Ambiguity-gated edits | Rare | **Refuse, never guess** |
| Auto-rollback on failed verification | Rare | **Default behavior** |
| Self-hosted | No | **Yes** — Bun + SQLite |
| Cost visibility | Vendor dashboard only | **Live spend, per-task caps** |
| License | Proprietary | **MIT** |

---

## Architecture

Mira is a Turborepo monorepo: `server`, `web`, `tui`, `cli`, `shared`, `slack`,
`vscode-mira`.

```
SessionPrompt.loop
  → context = system + skills + memory-retrieval + history
  → LLM.stream → tool-call → permission → guardrail snapshot → execute
  → doom-loop detect → compaction → usage learning → SSE events
```

- **Storage:** SQLite in WAL mode — sessions, messages, parts, todos, snapshots,
  queue, knowledge.
- **Protocols:** MCP (stdio / Streamable HTTP / legacy SSE) and LSP 3.17.
- **Frontends:** SolidJS throughout (web, TUI).
- **Runtime:** Bun 1.4.0, native SQLite.

Deeper detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Repository layout

| Path | What lives here |
|---|---|
| `packages/server/src/session/` | The agent loop (`SessionPrompt.loop`) |
| `packages/server/src/tools/` | Tool registry — start here to add a tool |
| `packages/server/src/guardrails/` | Permissions and audit layer |
| `packages/web/` | SolidJS web UI |
| `packages/slack/` | Slack bot |
| `docs/` | Architecture, guardrails, evolution specs |

---

## API

REST + SSE + WebSocket. Selected routes:

| Route | Auth | Description |
|---|---|---|
| `GET /healthz` | None | Liveness probe |
| `GET /metrics` | See [docs](docs/) | Prometheus scrape |
| `GET/POST /session` | Bearer | List (owner-scoped) / create |
| `POST /session/:id/prompt` | Bearer | SSE stream for agent turn |
| `GET /session/:id/message` | Bearer | History |
| `GET/POST/DELETE /session/:id/queue` | Bearer | Message queue |
| `GET /session/:id/snapshots` | Bearer | File snapshots |
| `POST /session/:id/revert` | Bearer | Rewind to a message |
| `WS /` | Bearer | Live event bus |

Full surface documented in [`docs/`](docs/).

---

## Community registry

Installable skills, agents, knowledge packs, and vertical bundles (agent +
skills + knowledge, atomically) without restarting the server:

```bash
POST /community/verticals/[NAME]
POST /community/skills/[NAME]
```

Browse with `GET /community/registry?kind=…&q=…`, or via
**Settings → Community** in the web UI.

The registry is thin right now — contributions very welcome.

---

## Development

```bash
bun install
bun test              # full suite, no API keys needed
bun run typecheck
bun run dev           # server + web + tui
```

CI runs typecheck, affected-filtered tests, CodeQL, Gitleaks, dependency audit
(fail on high/critical), and nightly evals. Third-party actions are SHA-pinned
and kept current by Dependabot.

See [CONTRIBUTING.md](CONTRIBUTING.md) for where to start, review expectations,
and PR conventions.

---

## License

[MIT](LICENSE).

---

<div align="center">

Built by [@slab1](https://github.com/slab1). Issues and PRs welcome.

</div>