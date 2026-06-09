# backwork.dev

Self-hosted **log aggregation + APM** in one box. Your logs already contain the
answers — crash causes, bottlenecks, anomalies — backwork surfaces them so you
spend less time debugging and more time building. Designed to stay under
~$50/mo in infra by running everything on a single VPS.

## Stack

| Component | Tool | Purpose |
|---|---|---|
| Logs | **Loki** | Log storage + LogQL search, 7-day hot retention |
| Metrics | **VictoriaMetrics** | Time-series metrics (PromQL), 10× compression |
| Traces | **Jaeger** | Distributed tracing (OTLP ingest) |
| Collector | **Vector** | Tails every container's stdout/stderr → Loki, exports host metrics |
| Dashboard | **backwork** (Remix) | Queries all three backends; health, search, APM, incidents, alerts |

The stack ships with three **instrumented demo services** (`api → payments →
worker`) that continuously emit real logs, metrics and distributed traces, so
the dashboard shows live data the moment it boots.

## Data flow

```
demo services ──logs──▶ vector ──▶ loki ─┐
      │      ──metrics─────────────────────┼─▶ VictoriaMetrics ─┐
      └──────traces (OTLP)──▶ jaeger ──────┘                    ├─▶ backwork dashboard
                                                                ┘
```

## Run it

```bash
# local (publishes ports for inspection)
docker compose -f docker-compose.yaml -f docker-compose.local.yml up -d --build
open http://localhost:3000      # dashboard
```

In production (Coolify) only the `backwork` service is exposed; everything else
talks over the internal compose network.

## Dashboard

- **Overview** — service health board (up/degraded/down), global req rate, error rate, p95, log volume, active incidents
- **Logs** — full-text + structured LogQL search across every source, live tail
- **Metrics** — throughput, latency percentiles (p50/p95/p99), errors, memory, top endpoints, service dependency map
- **Traces** — recent traces + per-request span waterfall
- **Incidents** — auto-detected crashes, restarts, error spikes, anomalies, with correlated error logs
- **Alerts** — configurable thresholds evaluated live against VictoriaMetrics

## Config

The dashboard reads backend URLs from env (defaults target the compose network):

| Var | Default |
|---|---|
| `LOKI_URL` | `http://loki:3100` |
| `VM_URL` | `http://victoriametrics:8428` |
| `JAEGER_URL` | `http://jaeger:16686` |
| `DATA_DIR` | `/data` (alert-rule persistence) |
