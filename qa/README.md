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
| `GET /search` | shop-api | the cache-miss-heavy route (BAC-79): 10 one-key cache gets with `hit`, about one in five a hit; `cache_hit_n` and `cache_miss_n` on its end record |
| `POST /refunds` | commerce-payments | the pool-starved route (BAC-79): 3 updates with `wait_us` (55 to 85 percent of each call spent waiting for a connection) and `db_wait_us` on its end record |

`GET /orders/:id` also reports `hit` on its 3 gets (about three in four). The commerce-api routes and
`GET /feed` report no hits or waits, so they show "no data" in the Cache hits and Conn. wait columns.
These fields are the proposed Correlator HOP-25 and HOP-26 (docs/insights/12-cache-and-pool.md).

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
