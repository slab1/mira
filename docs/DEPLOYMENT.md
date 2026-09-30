# Mira Deployment Guide

## Docker Deployment

### Quick start with docker-compose

```bash
# 1. Clone and enter the repo
git clone https://github.com/slab1/mira.git
cd mira

# 2. Create .env from the example
cp .env.example .env

# 3. Edit .env — set at minimum:
#    HOST=0.0.0.0
#    MIRA_TOKEN=<generate with scripts/gen-mira-token.sh>
#    OPENROUTER_API_KEY=sk-or-...  (or NVIDIA_API_KEY=nvapi-...)

# 4. Build and start
docker compose up -d

# 5. Check health
curl http://localhost:4096/healthz
```

### Docker Compose configuration

The default `docker-compose.yml`:

- Builds from the repo `Dockerfile`
- Binds port `4096` (override via `PORT` env var)
- Mounts `./data` for SQLite persistence
- Mounts `./scripts` read-only
- Runs with `no-new-privileges` and `read_only` root filesystem
- Healthcheck hits `/healthz` every 30s
- Auto-restarts unless stopped

### Manual Docker run

```bash
docker build -t ghcr.io/slab1/mira:latest .

docker run -d \
  --name mira \
  -p 4096:4096 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  ghcr.io/slab1/mira:latest
```

---

## Environment Variables

See `.env.example` for the full annotated list. Key variables:

| Variable                | Required       | Purpose                                                            |
| ----------------------- | -------------- | ------------------------------------------------------------------ |
| `HOST`                  | Yes (prod)     | Bind address — `0.0.0.0` for remote access                         |
| `PORT`                  | No             | Server port (default `4096`)                                       |
| `MIRA_TOKEN`            | Yes (prod)     | Bearer auth token — set via env/secret, fail-closed without it     |
| `OPENROUTER_API_KEY`    | Yes (live LLM) | Primary provider key                                               |
| `NVIDIA_API_KEY`        | Alt            | NVIDIA NIM provider + enables vision model default                 |
| `MIRA_DB`               | No             | SQLite path (default `./data/mira.db`)                             |
| `CORS_ORIGINS`          | No             | Comma-separated allowed origins for browser clients                |
| `MIRA_API_KEYS`         | No             | Multi-tenant keys: `key-alice:alice,key-bob:bob`                   |
| `MIRA_MAX_STEPS`        | No             | Max LLM turns per prompt (default `32`)                            |
| `MIRA_CONTEXT_LIMIT`    | No             | Tokens before compaction (default `128000`)                        |
| `MIRA_DOOM_THRESHOLD`   | No             | Repeated identical tool calls before doom-loop guard (default `5`) |
| `MIRA_TERMINAL_ENABLED` | No             | Set `0` to hard-disable terminal tool                              |
| `MIRA_TERMINAL_SANDBOX` | No             | Enforce allowedCommands allowlist                                  |
| `MIRA_AUTOPILOT`        | No             | Enable autopilot patch loop                                        |
| `MIRA_EVAL_GATE`        | No             | PR eval tier must pass before patches apply                        |

### Auth setup

**Single-tenant (simplest):**

```bash
# Dev: auto-provisions ~/.mira/mira.env on first boot
# Prod: set MIRA_TOKEN via environment or secret
export MIRA_TOKEN=$(openssl rand -hex 32)
```

**Multi-tenant:**

```bash
export MIRA_API_KEYS="key-alice:alice,key-bob:bob"
```

Generate per-owner keys:

```bash
./scripts/gen-mira-token.sh --owner alice --append ~/.mira/mira.env
```

---

## Production Considerations

### Auth

- **Always set `MIRA_TOKEN` in production** — the server fails closed without it
- Use a strong random token: `openssl rand -hex 32`
- Store in a secret manager (Docker Secrets, Kubernetes Secrets, etc.)
- Never commit `.env` or `~/.mira/mira.env` to version control
- For multi-tenant, use `MIRA_API_KEYS` with per-user credentials
- Set `MIRA_STRICT_AUTH=1` to reject any request without an owner

### Network

- Server binds `127.0.0.1` by default — set `HOST=0.0.0.0` explicitly for remote access
- Use a reverse proxy (nginx, Caddy, Traefik) for TLS termination
- Set `MIRA_TRUST_PROXY=1` only when behind a trusted reverse proxy
- Configure `CORS_ORIGINS` to your exact frontend origins (no wildcards in prod)
- Set `MIRA_STRICT_CORS=1` to reject unknown origins

### Guardrails

- `MIRA_READ_GUARD=1` (default on) — require read-before-edit
- `MIRA_DOOM_THRESHOLD=5` — doom-loop detection threshold
- `MIRA_TERMINAL_SANDBOX=1` — enforce command allowlist
- `MIRA_MAX_BODY_BYTES=1048576` — request body cap
- Every mutating tool call is snapshotted; permission layer gates bash/edit/write/MCP

### Cost caps

- `MIRA_MAX_STEPS` — cap LLM turns per prompt
- `MIRA_CONTEXT_LIMIT` — cap context window
- `costCap` in config — per-task/session cost ceiling
- Gateway tracks live spend; `/session/:id/cost` and `/dev/cost` expose it
- `MIRA_AUTOPILOT=1` — enable autopilot (monitors cost before opening PRs)

### Data persistence

- SQLite WAL mode — mount a persistent volume at `/app/data`
- For production memory/knowledge, set `DATABASE_URL` to Postgres+pgvector
- Auto-vacuum available via `MIRA_VACUUM=1`

---

## Monitoring

### Health endpoints

| Endpoint              | Auth   | Purpose                                             |
| --------------------- | ------ | --------------------------------------------------- |
| `GET /healthz`        | None   | Liveness (Docker healthcheck, load balancer)        |
| `GET /health`         | Bearer | Detailed: tools, MCP, providers, memory, uptime     |
| `GET /gateway/health` | Bearer | Per-lane circuit state, latency, failures, cost cap |
| `GET /dev/cost`       | Bearer | Gateway cost, active sessions, requests             |

### Prometheus metrics

`GET /metrics` exposes:

- `http_requests_total{method,route,status}` — request counter
- `http_request_duration_seconds_bucket{method,route,le}` — latency histogram
- `active_sessions` — gauge
- `gateway_cost_total` — cumulative cost USD

### Observability integrations

- **OpenTelemetry:** set `OTEL_EXPORTER_OTLP_ENDPOINT`
- **Langfuse:** set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`
- **CI metrics:** set `MIRA_OTEL_METRICS_URL`

### Log correlation

Every request gets an `X-Request-Id` header. OTel spans correlate with HTTP access logs via this ID.

---

## CI/CD

The repo includes `.github/workflows/cd.yml` which:

1. Builds a multi-arch Docker image
2. Pushes to GHCR (`ghcr.io/slab1/mira:latest`)
3. Deploys when `vars.DEPLOY_ENABLED=true`

---

## Troubleshooting

| Symptom                    | Fix                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `Connection refused`       | Check `HOST`/`PORT`; server binds `127.0.0.1` by default                                     |
| `401 Unauthorized`         | Set `MIRA_TOKEN` or pass `Authorization: Bearer <token>`                                     |
| `403 Forbidden`            | CORS origin not allowed; add to `CORS_ORIGINS`                                               |
| `OpenCode free tier` error | Remove `OPENCODE_API_KEY` from environment                                                   |
| High cost                  | Lower `MIRA_MAX_STEPS`, set `costCap`, check `/dev/cost`                                     |
| Doom-loop detected         | Agent stuck repeating tool calls; increase `MIRA_DOOM_THRESHOLD` or fix the underlying issue |
