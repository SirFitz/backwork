# backwork.dev

Self-hosted **log aggregation + APM** in one box. Deploys onto the Docker host
it monitors and surfaces what's broken right now: crashes, OOM kills, restart
loops, error spikes, resource pressure. All telemetry is real container data,
never synthetic. Designed to stay under ~$50/mo by running everything on a
single VPS.

**Live:** https://backwork.dev

## How it works

It runs as a docker-compose stack on the host and reads that host's real
telemetry directly:

| Component | Tool | Role |
|---|---|---|
| Logs | **Loki** | LogQL search, 7-day hot retention |
| Metrics | **VictoriaMetrics** | PromQL time-series store |
| Container metrics | **cAdvisor** | real per-container CPU / memory / network / disk |
| Traces | **Jaeger** | OTLP ingest (for apps that emit spans) |
| Collector | **Vector** | tails every container's logs into Loki |
| Dashboard | **backwork** (Remix) | queries all of it; also reads the Docker Engine API for true container state |

Service names come from each container's `coolify.resourceName` / compose
labels, so the dashboard speaks in app names, not container hashes.

## Dashboard

- **Overview** — host vitals, what needs attention (worst first), the service table, log-volume trend
- **Containers** — every service with live CPU / memory / network, restarts, log + error rate, sortable and filterable, inline sparklines
- **Logs** — full-text + structured LogQL search across all sources, live tail
- **Metrics** — CPU / memory / network charts and the heaviest consumers, from cAdvisor
- **Incidents** — auto-detected OOM kills, failing healthchecks, stopped containers, restart loops and error spikes, with the error log evidence
- **Alerts** — thresholds on real metrics and log rates, evaluated live
- **Traces** — distributed traces for any app that emits OpenTelemetry spans

Light by default, with a persisted dark mode toggle.

## Run it on your host

```bash
git clone https://github.com/SirFitz/backwork && cd backwork
docker compose up -d --build
# dashboard on :3000 (put it behind your proxy / TLS)
```

For local inspection with published ports:

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yml up -d --build
open http://localhost:3000
```

## Config

The dashboard reads backend URLs from env (defaults target the compose network):

| Var | Default |
|---|---|
| `LOKI_URL` | `http://loki:3100` |
| `VM_URL` | `http://victoriametrics:8428` |
| `JAEGER_URL` | `http://jaeger:16686` |
| `DOCKER_SOCKET` | `/var/run/docker.sock` (read-only, for container state) |
| `DATA_DIR` | `/data` (alert-rule persistence) |

## Notes for busy hosts

- cAdvisor needs a recent image on Docker 28+ hosts (API ≥ 1.44); this ships
  `v0.52.1` with `DOCKER_API_VERSION` pinned.
- Many containers can exhaust `fs.inotify.max_user_instances`; raise it
  (`sysctl fs.inotify.max_user_instances=8192`) if cAdvisor crash-loops.
