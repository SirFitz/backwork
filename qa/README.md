# backwork QA tooling

Checks that don't belong in the app. Kept in `qa/` (its own `package.json`) so it
stays **out of the dashboard's Docker build context** (`build: ./dashboard`) and never
ships in the production image.

## overflow-check

Deterministic horizontal-overflow guard. Loads every authed dashboard page with
deliberately-wide data (long routes, log lines, URLs, tokens) at desktop / laptop /
tablet / mobile widths and asserts the document never scrolls sideways
(`scrollWidth <= clientWidth`). On failure it names the offending element so the layer
that blew out is obvious.

It exists because the original audit signed off the UI by eye + screenshots, which
**mask** horizontal overflow — it scrolls off-frame, so a viewport capture looks clean.
This measures it instead. Run it before shipping any dashboard layout change.

```bash
cd qa
npm run setup                      # install deps + chromium (one time)
BW_BASE_URL=https://backwork.dev npm run overflow
```

Auth (pick one):

- **Existing account** — `BW_EMAIL=you@example.com BW_PASSWORD=… npm run overflow`
- **Self-register** — omit creds; it creates an isolated throwaway org
  (`qa2del-overflow-*@example.com`), seeds wide errors, log lines and hop records, and prints the
  email so you can delete it afterward. Prefer running against a staging instance, or
  clean up the throwaway (it's labeled `qa2del-*`).

`HEADED=1` to watch it run. Exit code is non-zero if any page overflows (CI-friendly).

## Insights scenario (fixtures)

Request patterns for the insights features (BAC-67), from the fixture emitters. Local stack only;
never on a backwork people use. One more fixture service, `shop-api`, and `SCENARIO=insights` on it
and on the two services it calls. Every cycle (`CYCLE_S`, 30 s) it writes:

| Request | Service | What it shows |
|---|---|---|
| `GET /shop` | shop-api | the N+1: `select plans ... where plans.number = ?` 14 times one after another, plus 8 distinct selects (22 database calls) |
| `GET /orders/:id` | shop-api | a slow query shape (`select ... from orders ... where customer_id = ? order by created_at desc`, 180 to 420 ms), then 3 independent cache gets one after another |
| `GET /feed` | shop-api | a plain Redis pipeline of 12 gets in one write (must not be flagged) |
| `POST /checkout` | shop-api, commerce-payments, commerce-risk | two outbound HTTP calls one after the other that do not depend on each other |

Formats differ as in the rest of the fixtures: shop-api `json`, commerce-payments `kv`,
commerce-risk `json-nested`.

Run it on top of the local stack:

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yml -f qa/fixtures/compose.insights.yml up -d --build
```

Check it arrived (the first insights requests land about a minute after start):

```bash
curl -sG http://localhost:3100/loki/api/v1/query_range --data-urlencode 'query={service="shop-api",kind="hop"} |= "in_end"' --data-urlencode limit=10
curl -sG http://localhost:8428/api/v1/query --data-urlencode 'query=sum by (service, op) (backwork_hop_duration_seconds_count{service="shop-api",dir="in"})'
```

Regression mode: `qa/fixtures/deploy.sh <compose project>` creates the trigger file in the shop-api
container (`REGRESSION_FILE`, default `/tmp/bw-regression`) and `GET /shop` takes about twice as
long from the next cycle; with `BW_URL` and `BW_INGEST_TOKEN` set it also reports a deploy of
shop-api to `POST /ingest/deploys` once that endpoint exists (feature 6). `deploy.sh <project> --reset`
ends it.

### Last week for the compare features

A fresh stack has no data from last week, so "vs last week", the Trend card's dashed line and the
Overview's "Slower than last week" have nothing to compare with. `qa/fixtures/backfill-last-week.ts`
writes a week-old copy of the fixture hop series into the stack's VictoriaMetrics through its import
API (`/api/v1/import/prometheus`, explicit timestamps): same names and labels, counters growing at
the rate they grow now, from 8 hours before to 3 hours after the instant exactly 7 days ago. It only
adds samples with old timestamps; nothing current is changed or deleted. Run it once the stack has
run for about 15 minutes (the rates are read from the last 2 hours):

```bash
bun qa/fixtures/backfill-last-week.ts --vm http://localhost:8428                      # a plain copy
bun qa/fixtures/backfill-last-week.ts --vm http://localhost:8428 --latency-scale 0.5  # last week twice as fast
```

`--latency-scale 0.5` stages a regression: last week's latencies at half (bucket counts and `_sum`
moved), so a service's p95 is about twice last week's and the Overview group has something to list.
The plain copy shows "about the same" everywhere until `deploy.sh` slows `GET /shop`, and that
alone stays under the 100 ms rise a "slower" verdict needs. Other options: `--back 26h` to compare
the 24h range, `--ahead`, `--step` (default 60s), `--dry-run`. Run it once per stack: it refuses
when samples already exist 7 days back (`--force` writes a second copy anyway; VictoriaMetrics
shows imported samples about a second after the import). The copy is good for `--ahead` (3 hours)
after it was written; recreate the stack's VictoriaMetrics volume to start over.

Without Docker: `SERVICE=shop-api FORMAT=json SCENARIO=insights CYCLE_S=10 bun qa/fixtures/emitter.ts`
(and the same with `SERVICE=commerce-payments` and `SERVICE=commerce-risk` for the checkout receivers).

## Monitors scenario (fixtures, BAC-80)

Records with the Correlator 0.13 fields `host` (HOP-27) and `synthetic=1` (HOP-28). Every cycle an uptime
monitor's `GET /cart` on shop-api (host `binary.fleeksite.com`, `synthetic=1` on every inbound hop of its
trace: three `GET /api/v1/public/m/:merchant_username/products` on commerce-api and one
`GET /api/v1/discounts/:code` on commerce-payments, all with host `api.dev.example.com`), then a shopper's
`GET /cart` (host `shop.example.com`, the same calls, no marker). The other fixture records carry neither
field (the old-records case). Formats: shop-api and commerce-api `json`, commerce-payments `kv`.

`qa/fixtures/compose.monitors.yml` adds three scenario-only containers (`BASE=0`, nothing written twice), on a
fresh stack or beside one that is already up:

```bash
docker compose -p <project> --project-directory . -f qa/fixtures/compose.monitors.yml up -d --build
cd qa/fixtures && bun test        # the scenario's lines through the dashboard parser, all three formats
```

Browser check (Playwright-launched Chrome, 1440 and 390 wide, screenshots and `results.json` in `OUT`):

```bash
BW_BASE_URL=http://127.0.0.1:3580 BW_COOKIE=<backwork_auth> MONITOR_TRACE=<trace> OLD_TRACE=<trace> OUT=<dir> node qa/bac-80-check.mjs
```
