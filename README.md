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
| `INKRESS_BILLING_MERCHANT` | `backwork` (username of the Inkress merchant that sells the plans) |
| `INKRESS_BILLING_API_MODE` | `test` (Inkress dev API); `live` = api.inkress.com |
| `INKRESS_BILLING_PLATFORM_KEY` | key for plan reads and checkout links; billing is off while unset |
| `INKRESS_BILLING_SECRET_KEY` | merchant-bound key for plan changes (defaults to the platform key) |
| `INKRESS_BILLING_WEBHOOK_SECRET` | the merchant's client secret, which signs webhook tokens |

## Billing (BAC-57)

Customers pay for plans through Inkress; backwork stores no card data.

- **Model.** An organisation is a customer of the `backwork` Inkress merchant with at most one subscription. Plans are the four USD plans there (Team and Business, monthly and yearly), tagged `data.backwork_plan` / `data.backwork_billing`. The pricing page stays the source of the displayed price; checkout is refused if Inkress's price differs.
- **Trial.** 14 days of Team or Business, no card, once per organisation. A trial that ends without a subscription returns the organisation to Free (job runs with the plan jobs, and on page load).
- **Flows (Billing page, owners and admins).** Start trial; Subscribe (Inkress hosted checkout, then the page and the webhook both "look again" at Inkress); Switch plan at renewal (Inkress plan-change); Cancel at period end; Update card (Inkress card-update link); invoices from Inkress periods.
- **Webhook.** `POST /api/webhooks/inkress/billing`: HS256 token signed with the merchant secret, deduped on the event id, and only ever triggers a reconcile from Inkress, so replays and reordering cannot move a plan. The merchant's webhook row must list `subscription`, `card_charge` and `refund`.
- **Plan on the org.** Reconcile writes the plan the organisation earns to `orgs.plan`, which the ingest limits already read. Organisations on `unmetered` (backwork's own and internal apps) are never billed or moved. New customer organisations start on `free`.
- **Decisions.** No-card trial and cancel-at-period-end are the SaaS defaults, picked without asking; the client is ported from FleekSite's platform billing (`docs/platform-billing.md` there) and cut to the contracts backwork uses.
- **Not built.** Usage overage (the pricing page's "more costs X per million") is not charged yet: paid plans do not pause at their allowance and nothing bills the extra.

## Notes

- The stack collector reads only containers labelled `dev.backwork.collect=true`
  (backwork's own). Every other service ships through the agent under its own
  organisation, so nothing is stored twice.
- Stored lines keep only the line, service, host, project, level and kind; Docker's
  label set, container id and image are dropped before Loki.
- Many containers can exhaust `fs.inotify.max_user_instances`; raise it
  (`sysctl fs.inotify.max_user_instances=8192`) if Vector stops tailing.
