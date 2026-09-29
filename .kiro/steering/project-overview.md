# Mira — Project Overview & Dev Workflow

## What is Mira?

Mira is a next-gen AI agent platform (server + multi-client monorepo).
It ships hierarchical memory, eval-first observability, tool-layer guardrails,
file snapshots with undo, real LSP + MCP integration, HITL questions, and a
cost-tracking model gateway — all backed by a 119-test suite.

## Monorepo layout

```
packages/
  server/       @mira/server      — Core agent engine (Hono, SessionPrompt loop,
                                    Tool Registry, Gateway, LSP, MCP, SQLite, OTel)
  web/          @mira/web         — SolidJS + Vite PWA web client
  tui/          @mira/tui         — SolidJS terminal UI (@opentui/solid)
  cli/          mira-cli-ts       — Thin CLI (npx mira …), published to npm
  shared/       @mira/shared      — Zod schemas, shared types, agent definitions
  slack/        @mira/slack       — Slack Socket Mode bot
  vscode-mira/  vscode-mira       — VS Code extension
```

## Runtime & toolchain

| Tool           | Version                        | Notes                                                                                                 |
| -------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Bun**        | 1.3.14                         | PINNED in `.tool-versions`. 1.4.x has workspace-hoisting regressions — do not upgrade without testing |
| **TypeScript** | 5.9.3 (root) / 5.8.x (per-pkg) | Strict mode, ESNext modules, `bundler` resolution                                                     |
| **Turborepo**  | 2.x                            | Task graph orchestrator across all packages                                                           |
| **Node**       | 22                             | Needed for some toolchain steps (semantic-release, scripts)                                           |

## Key scripts (run from workspace root)

```bash
bun run dev          # server :4096, web :3000, tui :3001 (excludes slack)
bun run dev:all      # includes slack bot
bun run build        # turbo build — all packages
bun run test         # turbo test — bun test across all packages
bun run typecheck    # turbo typecheck — tsc --noEmit across all packages
bun run format       # prettier --write .
bun run format:check # prettier --check .
bun run deps:install # ALWAYS use this instead of bare `bun install`
                     # guards disk space ≥2G, serializes via flock, verifies integrity
bun run deps:check   # node scripts/verify-install.js
```

Per-package (server example):

```bash
bun test                           # from packages/server/
bun run --cwd packages/server src/eval/index.ts --tier pr
bun run --cwd packages/server src/storage/migrate.ts
drizzle-kit generate               # from packages/server/
```

## Dev ports

| Service | Port | Override env var |
| ------- | ---- | ---------------- |
| Server  | 4096 | `PORT`           |
| Web     | 3000 | `MIRA_WEB_PORT`  |
| TUI     | 3001 | `MIRA_TUI_PORT`  |

## Environment setup

1. **Copy** `.env.example` → `.env` (gitignored). Only HOST/PORT/CORS/PROVIDER keys go here.
2. **Token** (`MIRA_TOKEN`) lives in `~/.mira/mira.env` (0o600). First dev boot auto-creates it.
   To opt out: `MIRA_NO_AUTOPROVISION=1`.
3. **Minimum for live LLM:** add `OPENROUTER_API_KEY=sk-or-...` or `NVIDIA_API_KEY=nvapi-...` to `.env`.
4. **mira.json** (per-machine, gitignored): copy `mira.json.example` → `mira.json` and fill in provider API keys.

### Required env vars for production

```
HOST=0.0.0.0
MIRA_TOKEN=<64-hex>           # generate: scripts/gen-mira-token.sh
OPENROUTER_API_KEY=sk-or-...  # or NVIDIA_API_KEY
```

## Multi-machine sync rules (learned the hard way)

- **NEVER** `git add -f node_modules` — symlinks dangle cross-OS and in CI
- **NEVER** run two `bun install` concurrently — leaves half-written packages
- **Always** use `scripts/install.sh` (guarded wrapper) instead of bare `bun install`
- Keep ≥2G disk free; CI enforces bun 1.3.14 strictly

## Docker quick reference

```bash
# Build
docker build -t ghcr.io/slab1/mira:latest .

# Run with persistent data
docker run -d --name mira -p 4096:4096 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  ghcr.io/slab1/mira:latest

# Compose (includes colibri local-LLM sidecar in override)
docker compose up -d
```

Health endpoint: `GET /healthz` (unauthenticated liveness).

## Commit message format (enforced by Husky + commitlint)

```
<type>(<scope>): <subject>     ← max 72 chars total
                               ← blank line
[optional body]                ← max 100 chars/line
```

**Types:** `feat` `fix` `refactor` `perf` `test` `docs` `build` `chore` `style` `revert` `ci` `init`

**Scopes (advisory):** `server` `web` `tui` `cli` `shared` `slack` `vscode` `deps` `ci` `dx`
`eval` `gateway` `memory` `auth` `guardrails` `lsp` `mcp`

**Rules:** no start-case/pascal-case/UPPER subject, header ≤72 chars.

Example: `feat(server): add rate-limit per-tenant endpoint`

## Pre-commit hooks

`pre-commit` → `lint-staged` → Prettier on changed `*.{ts,tsx,json,md,yml,yaml,css}`
`commit-msg` → `commitlint` enforces Conventional Commits format above

## API surface (quick ref)

| Route                      | Auth     | Description       |
| -------------------------- | -------- | ----------------- |
| `GET /healthz`             | none     | liveness          |
| `GET /metrics`             | optional | Prometheus scrape |
| `POST /session/:id/prompt` | bearer   | SSE stream        |
| `WS /`                     | bearer   | live bus events   |
| `GET/POST /session`        | bearer   | list / create     |

Full table in `README.md` and `packages/server/README.md`.
