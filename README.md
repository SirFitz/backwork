# backwork.dev

Self-hosted **request tracing, performance figures and log search** for services
that use Correlator. Paste any ID (trace ID, request ID, UUID or `traceparent`)
and see the whole request: every service it crossed, database and cache time,
where it stopped, and the log lines it wrote. Every number comes from real hop
records and log lines, never synthetic data. Light: five containers.

**Live:** https://backwork.dev

## How it works

Services write Correlator hop records (one log line when a request, job or call
starts and one when it ends) beside their ordinary log lines. Vector reads them,
VictoriaMetrics keeps the figures, Loki keeps the lines.

| Container | Tool | Role |
|---|---|---|
| Collector | **Vector** | reads backwork's own containers; other hosts run the agent (`/install.sh`, Vector only) |
| Logs | **Loki** | LogQL search; hop records 30 days, other lines 7 |
| Metrics | **VictoriaMetrics** | the `backwork_hop_*` figures (rate, errors, latency, database and cache time) |
| Accounts | **Postgres** | users, organisations, projects, tokens, switches, filter patterns, alert rules |
| Dashboard | **backwork** (Remix) | the pages below |

Service names come from each container's `coolify.resourceName` / compose
labels (or the PM2 process name), so the dashboard speaks in app names.

## Dashboard

- **Overview**: what needs attention in the last 15 minutes (services failing or slower than usual, requests that stopped, calls never received), the services table, the latest failed requests, log volume
- **Requests**: every inbound HTTP request from hop records, filters by service, status, method and route, older pages on demand
- **Request view** (`/requests/<id>`, also the header search): the path through each service with time bars, database and cache calls, gaps, linked IDs, named fields and the log lines under each hop
- **Performance**: services, routes and connections with request rate, errors, p50/p95/p99 and time in databases and caches
- **Logs**: full-text and LogQL search, live tail, a link to the request from every line that carries a trace ID
- **Errors**: grouped exceptions from the error ingest endpoint
- **Alerts**: thresholds on error and log rates, delivered to webhook, Slack, Discord, email or SMS
- **Projects / Settings**: ingest tokens, the switches and the sensitive-data filter

Health checks (`/healthz`, `/health`, `/ready`, `/live`, `/livez`, `/readyz`,
`/ping`) are left out of the Overview, Requests and Performance figures unless
"Show health checks" is on; the request view and Logs always show everything.

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
| `DATABASE_URL` | the compose Postgres |
| `DATA_DIR` | `/data` (legacy alert-rule import) |
| `PUBLIC_URL` | `https://backwork.dev` (used by the agent installer) |

## Notes

- The stack collector reads only containers labelled `dev.backwork.collect=true`
  (backwork's own). Every other service ships through the agent under its own
  organisation, so nothing is stored twice.
- Stored lines keep only the line, service, host, project, level and kind; Docker's
  label set, container id and image are dropped before Loki.
- Many containers can exhaust `fs.inotify.max_user_instances`; raise it
  (`sysctl fs.inotify.max_user_instances=8192`) if Vector stops tailing.
