# Mira API Reference

Base URL: `http://127.0.0.1:4096` (default; configure via `HOST`/`PORT`)

All endpoints except `/healthz` require Bearer auth: `Authorization: Bearer <token>`

---

## Sessions

### `POST /session`

Create a new session.

**Body:**

```json
{
  "model": "openrouter/anthropic/claude-sonnet-4",
  "title": "My session",
  "agent": "code",
  "cwd": "/path/to/project",
  "projectId": "my-project"
}
```

All fields optional. Returns `201` with the session object.

**Response:**

```json
{
  "id": "uuid",
  "title": "My session",
  "model": "openrouter/anthropic/claude-sonnet-4",
  "provider": "openrouter",
  "createdAt": 1696000000000,
  "updatedAt": 1696000000000,
  "parentID": null,
  "agent": "code",
  "ownerID": null,
  "tokensIn": null,
  "tokensOut": null,
  "costUsd": null,
  "cwd": "/path/to/project",
  "projectId": "my-project"
}
```

---

### `GET /session`

List all sessions (owner-scoped when multi-tenant auth is enabled).

**Response:** Array of session objects, ordered by `updatedAt` descending.

---

### `GET /session/:id`

Get a single session by ID. Returns `404` if the session does not exist or belongs to another owner.

---

### `DELETE /session/:id`

Delete a session. Auto-exports before deletion for cross-device recovery. Returns `{ "ok": true }`.

---

### `POST /session/:id/prompt`

Send a prompt to the agent. Returns an SSE stream.

**Body:**

```json
{
  "prompt": "Refactor the auth module",
  "model": "openrouter/anthropic/claude-sonnet-4",
  "agent": "code",
  "maxSteps": 32
}
```

`prompt` is required. All other fields optional.

**Response:** SSE stream with events:

```
data: {"type":"text","text":"..."}
data: {"type":"tool-call","tool":"bash","args":{...}}
data: {"type":"tool-result","isError":false,"result":{...}}
data: {"type":"done","costUsd":0.002}
```

---

### `GET /session/:id/cost`

Get cost data for a session.

**Response:**

```json
{
  "sessionID": "uuid",
  "tokensIn": 1500,
  "tokensOut": 800,
  "costUSD": 0.002,
  "requests": 3,
  "persisted": {
    "tokensIn": 1500,
    "tokensOut": 800,
    "costUSD": 0.002
  }
}
```

---

### `GET /session/:id/messages`

Get all messages (with parts) for a session.

---

### `GET /session/:id/export`

Export a session transcript. Query params:

- `format=md` (default) — markdown transcript
- `format=json` — versioned JSON envelope with messages, todos, and snapshots

---

### `POST /session/import`

Import a session from a JSON export. Accepts both the versioned envelope (`version: 1`) and legacy bodies.

---

### `GET /session/:id/todo` / `POST /session/:id/todo`

Get or set todos for a session.

---

### `GET /session/:id/jobs`

List background subagent jobs for a session.

---

### `GET /session/:id/queue` / `POST /session/:id/queue` / `DELETE /session/:id/queue`

Manage the message queue (type while the agent streams).

---

### `GET /session/:id/snapshots` / `POST /session/:id/revert`

List file snapshots or revert to a previous state.

---

## Health & Monitoring

### `GET /healthz`

Unauthenticated liveness check. Used by Docker/compose healthcheck.

**Response:**

```json
{
  "ok": true,
  "version": "0.1.0",
  "sha": "abc123",
  "startedAt": "2026-09-30T00:00:00.000Z",
  "uptime": 3600.5
}
```

---

### `GET /health`

Detailed health check (authenticated). Returns tool count, MCP count, provider count, colibri status, terminal config, WS auth status, memory usage, and uptime.

---

### `GET /metrics`

Prometheus-compatible metrics endpoint. Exposes:

- `http_requests_total` — request counter by method/route/status
- `http_request_duration_seconds` — per-route latency histogram
- `active_sessions` — gauge
- `gateway_cost_total` — cumulative cost in USD

---

### `GET /gateway/health`

Lane-aware gateway health: per-lane circuit state, latency, failure count, cooldown, rate limit, and cost cap.

---

## Configuration

### `GET /config`

Get the current configuration (API keys redacted). Query params:

- `cwd=<path>` — resolve config for a specific working directory
- `health=1` or `include=health` — include gateway health snapshot

---

### `PATCH /config`

Update configuration. Accepts either a flat `Partial<MiraConfig>` or `{ "patch": {...}, "layer": "local" | "project" }`.

**Body example:**

```json
{
  "model": "openrouter/anthropic/claude-sonnet-4",
  "loop": { "maxSteps": 48 }
}
```

Returns the merged config (redacted).

---

### `GET /config/layers`

Get the full config layer breakdown (global, project, local) with redacted values.

---

### `GET /config/schema`

Get a JSON-schema description of the config surface.

---

### `GET /permission`

Get the permission matrix for the current config.

---

## WebSocket

### `WS /`

Live event bus. Requires Bearer auth (or first-message auth). Events are owner-scoped.

**Event types:** `session.created`, `session.updated`, `session.deleted`, `session.abort`, `message.updated`, `todo.updated`, `job.updated`, `job.cancelled`, `config.updated`, `learning.updated`

---

## Multi-tenancy

Set `MIRA_API_KEYS=key-alice:alice,key-bob:bob` to enable per-user credentials. Sessions are stamped with an `ownerID`; all session routes and WS events are owner-scoped. Foreign resources return `404`.

Single-token mode (`MIRA_TOKEN` only) maps everything to an implicit `"default"` owner.
