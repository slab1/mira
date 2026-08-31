# Mira Ops — Monitoring

## Prometheus scrape

`/metrics` is exposed unauthenticated (in the server's public-path set) and returns Prometheus text format `0.0.4`.

```yaml
scrape_configs:
  - job_name: mira
    metrics_path: /metrics
    static_configs:
      - targets: ["mira-host:4096"]
```

Behind a reverse proxy that enforces auth, either route `/metrics` to the app unauthenticated, or protect it at the proxy and let Prometheus present the credential.

## Exposed metrics

| Metric | Type | Labels | Notes |
|--------|------|--------|-------|
| `http_requests_total` | counter | method, route, status | per-route request counts (LRU-capped, true-evicted at max cardinality) |
| `http_request_duration_seconds_bucket` | histogram | method, route, `le` | cumulative per-route latency buckets `[0.05, 0.1, 0.5, 1, 5]` (+Inf) |
| `http_request_duration_seconds_sum` / `_count` | histogram | method, route | per-route latency sum/count (strict-synced with buckets) |
| `active_sessions` | gauge | — | in-memory; resets on restart |
| `gateway_cost_total` | counter | — | cumulative LLM spend USD since process start |

Latency is a **real histogram**: query percentiles with `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))`. SSE prompt streams dominate the slow end of the distribution.

## Rate limiting

The server applies token-bucket rate limiting per client (default 100 req/min, skip-list
for `/health`, `/healthz`, `/dev/health`, `/metrics`). Keying is secure by default:

- **Default key = Bun `server.requestIP()`** — the real socket peer address (unforgeable;
  immune to spoofed `X-Real-IP` / `X-Forwarded-For`).
- **Proxy headers are only honored when `MIRA_TRUST_PROXY=1`** is set. Only set this when
  the server is behind a trusted reverse proxy that strips/overwrites client-supplied
  forwarded headers.
- **Per-route SSE bucket** for the expensive streaming endpoints (`POST /session/:id/prompt`,
  `POST /session/:id/queue`) — capped at 30/min independent of the global bucket.

Limits are returned as `Retry-After` + `X-RateLimit-*` headers on 429. Buckets are
in-memory and single-node (reset on restart; no Redis).

## Grafana dashboard

Import `ops/grafana-mira-dashboard.json` (Dashboards → Import). Panels:

- **Traffic**: request rate by status class (2xx/4xx/5xx), top routes
- **Latency & load**: average latency with thresholds, active sessions stat, 5xx error-ratio stat
- **LLM spend**: cumulative gateway cost, USD/hour burn rate (spike = runaway agent)

Set the Prometheus datasource when prompted. The `instance` template variable filters multi-instance deployments.

## Suggested alerts

```yaml
groups:
  - name: mira
    rules:
      - alert: MiraHighErrorRatio
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m]))
            / sum(rate(http_requests_total[5m])) > 0.01
        for: 5m
        annotations:
          summary: "Mira 5xx ratio above 1% for 5m"
      - alert: MiraSpendSpike
        expr: derivative(max(gateway_cost_total)[10m:1m]) * 3600 > 10
        for: 10m
        annotations:
          summary: "Mira LLM spend exceeding $10/hr — check for runaway agents"
      - alert: MiraDown
        expr: up{job="mira"} == 0
        for: 2m
        annotations:
          summary: "Prometheus cannot reach Mira /metrics"
```

## Backups

SQLite WAL lives in the mounted data dir (`./data/mira.db` in compose). Cron the bundled script off-host:

```
0 3 * * * docker exec mira scripts/backup-db.sh && rsync -a data/backups/ backup-host:/srv/mira-backups/
```
