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
| Logs | **Loki** | LogQL search, 7-day hot retention (hop records 30 days) |
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
open http://localhost:3000   # BW_LOCAL_PORT=3410 to publish the dashboard elsewhere
```

## Hop records, switches and the sensitive-data filter

Services that use Correlator write hop records (a start and an end log line per
hop) and link lines. The collector and the agent detect them, label them
`kind="hop"` (every other line is `kind="log"`), turn end records into the
`backwork_hop_*` metrics, and replace sensitive values with `[filtered]` before
anything is saved. Hop records are kept 30 days, ordinary lines 7.

- Both Vector configs come from one module,
  `dashboard/app/lib/agent/vector-config.server.ts`. `infra/vector/vector.yaml` is
  generated from it: after a change run `cd dashboard && bun ../infra/vector/generate.ts`
  (a dashboard test fails while the file is stale).
- Vector unit tests: `infra/vector/test.sh` (stack config) and
  `infra/vector/agent/test.sh` (agent config with switches off and an org pattern).
- Switches and filter patterns live in Postgres (`data_controls`, `filter_patterns`,
  `dashboard/app/lib/controls.server.ts`). Everything is on unless switched off;
  off at organisation, project or service level wins. The ingest proxies enforce
  them and filter again; agents read them from `GET /ingest/controls?format=vector`
  every 30 s and reload Vector when they change.
- Agents on hosts that run services under PM2 read PM2's log files too
  (`--pm2-logs <dir>`, found automatically under `~/.pm2/logs`).
- Test fixtures: `qa/fixtures/` (emitters for two sample requests; the local
  compose file runs four of them). Tests only; never on a backwork people use.

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
