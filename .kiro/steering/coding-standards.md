---
inclusion: auto
name: coding-standards
description: Mira coding conventions, TypeScript/Bun/Hono/SolidJS patterns, security rules, and architecture principles. Auto-include when editing source files.
---

# Mira — Coding Standards & Architecture Patterns

## Language & module style

- **TypeScript strict mode** everywhere. `"type": "module"` in all `package.json` files.
- Module resolution: `"bundler"` (tsconfig). Use bare specifier imports — no `.js` extensions in TS source.
- `jsxImportSource: solid-js` — all JSX is SolidJS, not React.
- Never use `any`; use `unknown` + narrowing or Zod parse.
- All public function signatures must have explicit return types.

## Bun-specific patterns

- Use **`Bun.file()`** / **`Bun.write()`** for file I/O (not Node `fs`).
- Use **`Bun.sqlite`** for SQLite — native, WAL mode, no ORM for raw queries.
- Use **Drizzle ORM** for schema-managed queries (`packages/server/src/storage/`).
- Test files: `*.test.ts` alongside source or in `e2e/`. Runner: `bun test`.
- Avoid Node-specific APIs (`require`, `__dirname`, `process.env` for module paths); use `import.meta.url` / `import.meta.dir`.

## Hono (server) patterns

- Route handlers live in `packages/server/src/routes/`.
- Always validate request bodies with `@hono/zod-validator` — never trust raw `c.req.json()` without schema.
- Auth middleware checks `Authorization: Bearer <token>` — **never** accept tokens via query params.
- Every mutating route (POST/PUT/PATCH/DELETE) must go through the permission layer.
- Return typed `c.json()` responses; include `{ ok: boolean, error?: string }` shape for errors.

## Zod usage

- Define schemas in `packages/shared/src/` when shared across packages; keep server-only schemas in `packages/server/src/`.
- Always use `.parse()` (throws) or `.safeParse()` (returns result) — never cast with `as`.
- Use `z.infer<typeof Schema>` for derived types.

## SolidJS (web/tui) patterns

- Use signals (`createSignal`) and derived stores (`createMemo`) — avoid prop-drilling.
- Async data: `createResource` for server fetches.
- SSE connections: open in an `onMount`, close in `onCleanup`.
- Never mutate signal values directly; always use the setter.

## Security rules (non-negotiable)

- **MIRA_TOKEN** must never appear in `.env`, committed files, or client bundles. It lives in `~/.mira/mira.env` (0o600).
- `VITE_MIRA_TOKEN` is dev-only — gated to `NODE_ENV !== 'production'` in `vite.config.ts`. Never bake into prod builds.
- All shell executions via the `bash` tool go through BashArity + permission layer — validate arg count and disallow shell metacharacters.
- File paths passed to tools must be validated (no path traversal: `..`, absolute outside workspace).
- Rate limiting is per real socket peer (`Bun.requestIP`). Never use `X-Forwarded-For` unless `MIRA_TRUST_PROXY=1`.
- Every mutating tool call is snapshotted before execution.

## Architecture principles (from `ARCHITECTURE.md`)

1. **Start thin, earn complexity** — the `SessionPrompt` loop is the core; add LangGraph-style orchestration only when needed.
2. **Constraints > prompts** — tool visibility and permission layers beat system-prompt rules.
3. **Fallback > prediction** — 9-layer edit fallback, 3-provider gateway chain (OpenRouter → NVIDIA NIM → stub).
4. **Event-driven, no polling** — `GlobalBus` → WebSocket fan-out.
5. **Plan-first** — Explore → Plan → Implement → Verify before committing changes.
6. **Eval before deploy** — PR eval tier must pass; `MIRA_EVAL_GATE=1` blocks patch application.
7. **Memory-aware planning** — inject episodic/semantic/procedural knowledge at every turn.

## Tool registry patterns

- All tools are Zod-validated at registration (`packages/server/src/tools/`).
- Tool names follow `snake_case`. MCP tools are prefixed `mcp__<server>__<tool>`.
- Adding a tool: define schema → register in registry → add permission profile → write unit test.
- Never call a tool that hasn't been snapshotted if it mutates files or executes shell commands.

## Storage / database

- Schema definitions: `packages/server/src/storage/schema.ts` (Drizzle).
- Migrations: `bun run --cwd packages/server db:generate` then `bun run --cwd packages/server db:migrate`.
- SQLite WAL mode is always on — never change journal mode.
- Knowledge/memory tables: `knowledge`, `episodes`, `findings`. Do not drop or truncate these outside of migrations.

## Observability

- New request handlers must emit an OTel span (`@opentelemetry/api`).
- Add Prometheus counters/histograms in `packages/server/src/metrics.ts` for new tool categories.
- Bounded cardinality: never use free-form strings (user IDs, file paths) as metric label values.
- Correlate HTTP access logs with spans via `X-Request-Id` header.

## Error handling

- Prefer `Result<T, E>` patterns (typed discriminated unions) over throwing in library code.
- Throw only in route handlers (Hono catches and converts to HTTP responses).
- Always log errors with context (`sessionId`, `tool`, `step`) before re-throwing.
- Doom-loop guard: identical tool call sequences ≥5 times → terminate with `DOOM_LOOP_DETECTED`.

## Testing conventions

- Unit tests: `describe` / `it` / `expect` (bun test is Jest-compatible).
- Mock external providers (LLM, MCP, LSP) with local stub servers — never make real network calls in unit tests.
- E2E tests in `packages/server/e2e/` boot the real server on a random port.
- Live-provider tests (real LLM roundtrip, gopls, vision) auto-skip when keys/binaries are absent (`if (!process.env.OPENROUTER_API_KEY) return`).
- **Never** commit tests that require real credentials to pass.

## Prettier config (`.prettierrc`)

```json
{ "semi": false, "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

Run `bun run format` before committing. Lint-staged auto-runs Prettier on staged files.

## What NOT to do

- Do not `npm install` or `yarn` — this is a Bun workspace; always use `bun` or `scripts/install.sh`.
- Do not commit `node_modules` (CI has a hard check: `git ls-files | grep node_modules → exit 1`).
- Do not add `OPENCODE_API_KEY` to any env file or `mira.json` — it will poison every AI tool in the workspace.
- Do not set `MIRA_TOKEN` in `.env` — use `~/.mira/mira.env` (deprecated path triggers a warning and env var wins).
- Do not use `--no-verify` on commits unless explicitly fixing a hook configuration issue.
