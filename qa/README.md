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

Without Docker: `SERVICE=shop-api FORMAT=json SCENARIO=insights CYCLE_S=10 bun qa/fixtures/emitter.ts`
(and the same with `SERVICE=commerce-payments` and `SERVICE=commerce-risk` for the checkout receivers).
