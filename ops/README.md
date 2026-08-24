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
| `http_requests_total` | counter | method, route, status | per-route request counts |
| `http_request_duration_seconds_sum` / `_count` | summary | — | mean latency = sum/count; SSE prompt streams dominate averages |
| `active_sessions` | gauge | — | in-memory; resets on restart |
| `gateway_cost_total` | counter | — | cumulative LLM spend USD since process start |

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
