# mira-cli-ts

Mira CLI — a thin, zero-dependency wrapper around the Mira agent server.

> Mira is an open, provider-agnostic AI agent platform: hierarchical memory, tool-layer
> guardrails, file snapshots with undo, real LSP + MCP, and a cost-tracking gateway.

## Install

```bash
# npm — the `mira` binary lands on your PATH
npm install -g mira-cli-ts

# or run without installing
npx mira-cli-ts --help
```

Requires a running Mira server (`mira serve`). Point the CLI at it with `MIRA_API_URL`
(default `http://127.0.0.1:4096`):

```bash
export MIRA_API_URL=http://127.0.0.1:4096
export MIRA_API_KEY=...   # only if the server requires auth (MIRA_TOKEN / MIRA_API_KEYS)
```

## Commands

```
mira serve [--port 4096] [--host 127.0.0.1]   Start the daemon
mira session list                              List sessions
mira session create [--title ...] [--agent code|ask|plan] [--model ...]
mira session prompt --id <id> --prompt "..."   Prompt a session (SSE stream)
mira session import --file ./export.json
mira session export --id <id> [--format json|md]
mira agent list / agent preview <name>
mira skill list
mira command list
mira tool list
mira mcp list
mira config get [key] / config set <key> <value>
mira finding list [--status open] / finding resolve <id>
mira manager
mira health
mira complete --prefix "..." [--suffix "..."] [--file path]   Ghost-text completion
mira --help | --version
```

### Examples

```bash
mira serve
mira session create --agent ask --title "Q&A"
mira session prompt --id abc --prompt "explain ./src/index.ts"
mira skill list
mira complete --prefix "function add(a,b) {"
```

## Server

Run the full server (bundled tool registry, LSP, MCP, memory, gateway) from the monorepo:

```bash
git clone https://github.com/slab1/mira && cd mira
bun install
bun run dev          # server :4096 · web :3000 · tui :3001
```

## License

MIT
