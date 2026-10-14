# Mira Ops — Monitoring

## Prometheus scrape

`/metrics` returns Prometheus text format `0.0.4` and **requires a bearer token** whenever
the server has auth enabled. It is not in the server's public-path set: it exposes
per-route request counts, latency histograms, `gateway_cost_total` (cumulative LLM
spend) and `active_sessions`, all of which are operational secrets.

`/healthz` remains public and unauthenticated — point uptime probes there instead.

```yaml
scrape_configs:
  - job_name: mira
    metrics_path: /metrics
    # Required whenever MIRA_TOKEN or MIRA_API_KEYS is configured.
    authorization:
      type: Bearer
      credentials: <MIRA_TOKEN or a dedicated scraper API key>
    static_configs:
      - targets: ['mira-host:4096']
```

Issue a dedicated read-only credential for Prometheus rather than reusing the master
token. A `viewer`-role key is sufficient: `/metrics` is a GET, and viewer is read-only.

If the server has no credentials configured (`MIRA_TOKEN` empty and no `MIRA_API_KEYS`),
the auth gate is not installed at all and `/metrics` is reachable without a token —
the same as every other route on that deployment.

## Exposed metrics

| Metric                                         | Type      | Labels                | Notes                                                                  |
| ---------------------------------------------- | --------- | --------------------- | ---------------------------------------------------------------------- |
| `http_requests_total`                          | counter   | method, route, status | per-route request counts (LRU-capped, true-evicted at max cardinality) |
| `http_request_duration_seconds_bucket`         | histogram | method, route, `le`   | cumulative per-route latency buckets `[0.05, 0.1, 0.5, 1, 5]` (+Inf)   |
| `http_request_duration_seconds_sum` / `_count` | histogram | method, route         | per-route latency sum/count (strict-synced with buckets)               |
| `active_sessions`                              | gauge     | —                     | in-memory; resets on restart                                           |
| `gateway_cost_total`                           | counter   | —                     | cumulative LLM spend USD since process start                           |

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
          summary: 'Mira 5xx ratio above 1% for 5m'
      - alert: MiraSpendSpike
        expr: derivative(max(gateway_cost_total)[10m:1m]) * 3600 > 10
        for: 10m
        annotations:
          summary: 'Mira LLM spend exceeding $10/hr — check for runaway agents'
      - alert: MiraDown
        expr: up{job="mira"} == 0
        for: 2m
        annotations:
          summary: 'Prometheus cannot reach Mira /metrics'
```

## Backups

SQLite WAL lives in the mounted data dir (`./data/mira.db` in compose). Cron the bundled script off-host:

```
0 3 * * * docker exec mira scripts/backup-db.sh && rsync -a data/backups/ backup-host:/srv/mira-backups/
```
