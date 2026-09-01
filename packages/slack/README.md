# @mira/slack — Slack bot for Mira

Thin Socket Mode bot that bridges Slack to the Mira HTTP API. **No server changes** — it is just another API client (like the CLI) using the existing bearer-gated `POST /session` + `POST /session/:id/prompt` (SSE) surface.

## Setup

### 1. Create a Slack app (once)

1. https://api.slack.com/apps → **Create New App** → **From scratch**
2. **Socket Mode** → Enable → generate an **App-Level Token** (`xapp-...`) with `connections:write`
3. **OAuth & Permissions** → Scopes (Bot Token):
   - `app_mentions:read`, `chat:write`, `commands`, `channels:history`, `groups:history`, `im:history`
4. **Slash Commands** → Create `/mira` (description: “Ask Mira”, no Request URL needed in Socket Mode)
5. **Event Subscriptions** → Enable → Subscribe to `app_mention`
6. **Install to Workspace** → copy **Bot Token** (`xoxb-...`)

### 2. Mira side

Mira must be running and reachable from the bot host:

```bash
# Terminal A — Mira server
MIRA_TOKEN=$(openssl rand -hex 32)
HOST=127.0.0.1 PORT=4096 MIRA_TOKEN=$MIRA_TOKEN bun run --cwd packages/server dev

# Mint a per-team key (owner = slack team) — used as MIRA_API_KEY for the bot
curl -X POST http://127.0.0.1:4096/admin/api-keys \
  -H "Authorization: Bearer $MIRA_TOKEN" \
  -d '{"owner":"slack-team"}'
# → {"key":"<96-hex>","owner":"slack-team"}
```

### 3. Run the bot

```bash
cp packages/slack/.env.example packages/slack/.env
# edit .env with real tokens
bun run --cwd packages/slack src/bot.ts
# or
MIRA_API_URL=http://127.0.0.1:4096 \
MIRA_API_KEY=<96-hex> \
SLACK_BOT_TOKEN=xoxb-... \
SLACK_APP_TOKEN=xapp-... \
bun run --cwd packages/slack dev
```

No public endpoint or tunnel is required — Socket Mode keeps a WebSocket to Slack.

## Usage

- **Slash command (any channel where the app is installed):**
  `/mira explain ./src/index.ts`

- **Mention fallback:**
  `@Mira refactor this function to be pure`

Replies arrive **in-thread** (the bot posts a placeholder and updates it when the SSE turn completes). On `401/403` it tells the operator to check `MIRA_API_KEY`.

## Env

| Variable | Required | Description |
|----------|----------|-------------|
| `MIRA_API_URL` | yes (default `http://127.0.0.1:4096`) | Mira server URL |
| `MIRA_API_KEY` | yes (prod) | Issued API key (owner `slack-team`) — or `MIRA_TOKEN` in dev |
| `SLACK_BOT_TOKEN` | yes | `xoxb-...` |
| `SLACK_APP_TOKEN` | yes | `xapp-...` (Socket Mode) |
| `MIRA_SLACK_AGENT` | no | Default agent for turns (`code`/`ask`/`plan`, default `code`) |

## How it works

```
Slack (Socket Mode WS) → Bolt App → POST /session (create) → POST /session/:id/prompt (SSE) → parse text-delta frames → chat.update in thread
```

SSE parsing handles Vercel AI SDK framing (`data: {"type":"text-delta","textDelta":"…"}`) and plain text fallbacks. Truncation keeps Slack blocks under ~3000 chars.

## Notes

- **No tunnel needed** — unlike the web client, Socket Mode needs no `trycloudflare`/`zrok` exposure.
- **Owner isolation** — the bot’s `MIRA_API_KEY` maps to one owner (e.g. `slack-team`); all Slack-turn sessions are that owner’s.
- **Blocked for live validation** until the operator creates the Slack app and sets `SLACK_*` tokens. The package still typechecks and `bun test` can run without creds.
