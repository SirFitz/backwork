# 02 Slow queries board (BAC-69)

Wave 1. Depends on: foundation (`statementShape`, `metricInstant`, `cachedStale`). Feeds: 5, 7, 10.

## Goal
**Insights > Slow queries**: query shapes ranked by total time and by p95, per service, with the routes that call them and a way to open a slow example. "Which query is costing us the most?" answered in one screen.

## What exists (notes B section 4)
`stmt` and `table` are only inside stored hop lines (outbound `via=db` `out_end`, microsecond `duration_us`); not a metric label anywhere. Lines are JSON envelopes whose `message` holds a JSON or `key=value` record, or bare key=value. Loki 3.3 (query timeout 1 m, `max_query_series` 5000); the dashboard client times out at 12 s. The Statements switch removes `stmt` and `table` before storage when off.

## Design

### Data: on-demand LogQL, merged by shape in TypeScript
`lib/hops/slow-queries.server.ts`:
```ts
export const SlowWindow = { H1: "1h", H6: "6h" } as const;
export type SlowWindow = (typeof SlowWindow)[keyof typeof SlowWindow];

export interface QueryRow {
  shapeId: string;          // shapeId(shape)
  shape: string;            // statementShape(stmt)
  sample: string;           // one raw stmt text, for display and the routes lookup
  service: string;
  peer: string | null;
  table: string | null;
  calls: number;
  totalS: number;           // seconds spent in it over the window
  p95S: number | null;      // call-weighted mean of the merged groups' p95 (approximate when merged)
  p95Approx: boolean;
  shareOfDb: number;        // totalS over all rows of this service
}
export interface SlowQueries {
  rows: QueryRow[]; window: SlowWindow; computedAt: number;
  statementsOff: boolean;   // Statements switch off for the org
  groupLimited: boolean;    // Loki returned the group cap; the list is the top of a longer one
}
export function slowQueries(tenant: Tenant, window: SlowWindow, now = Date.now(), run: MetricRunner = loki.metricInstant): Promise<SlowQueries>;
```
Queries (per record format, run in parallel; three measures: calls, total, p95):
- JSON envelope: `{kind="hop"} |= "out_end" |~ "via\\W{1,6}db" | json rec="message" | line_format "{{.rec}}" | json | unwrap duration_us` then `count_over_time` / `sum_over_time` / `quantile_over_time(0.95, ...)` `by (service, table, stmt)` wrapped in `topk(200, ...)`.
- key=value record: `| regexp "\\sstmt=(?P<stmt>.*)$" | regexp "\\btable=(?P<table>\\S+)" | regexp "\\bduration_us=(?P<duration_us>\\d+)"` (anchored, as note B warns an unanchored `op=` matched `hop=in_end`).
- Exact LogQL builders are pure and unit-tested by string equality; the two formats are merged before ranking.
- `statementShape` merges raw statements that differ only by lists, numbers or case; calls and totals add; p95 is the call-weighted mean and flagged `p95Approx` when more than one raw group merged.
- Cached with `cachedStale("slowq:<org>:<window>", fresh 2 min, stale 15 min)`; the loader returns the stored result at once and refreshes behind it. 24 h is not offered until measured on the reference deployment (README risks).
- Failure: Loki timeout or error returns `{ ok:false }` so the card shows its own error; a stale value is still shown with "from 6 minutes ago".

### Routes that call a statement (on demand, when a row is expanded)
`routesFor(tenant, row, now)`: one Loki log query for up to 200 `out_end` `via=db` records containing the row's `sample` text (escaped line filter), collect their `parent_hop` ids, one second query for the matching `in_end` records using an alternation on `hop_id` (batches of 50), group by `(service, method, op)`. Returns `{ routes: {service, method, op, calls}[], exampleTraceId: string | null }`. Cached 5 minutes per `(org, shapeId)`. `exampleTraceId` is the slowest sampled call (link "Open a slow example").

## UI (`routes/insights.queries.tsx`, flips the tab on)
- Title row: "Slow queries" with controls on the same row: service select ("All services"), window segmented control (1 h, 6 h), sort select (Total time, p95, Calls).
- One card, one-row head "Queries" with inline "last hour, as of 14:02" and a "from N minutes ago" note when stale.
- Table (scrolls inside its own container on phone; low-priority columns `hidden sm:table-cell`): Query (mono, shape cut with `shapeLabel`, full text in a title), Service, Calls, Total, p95, Share of database time (thin bar). Rows 38 px.
- Row expands inline: full `sample`, `Called by` list (service, method, route, calls; link to `/requests?service=&method=&route=`), "Open a slow example" link, the table name and peer. p95 shown with "about" when approximate.
- States: skeleton rows while loading; `Empty` "No database queries recorded in the last hour." ; statements off: "Query text is switched off for this organisation, so queries are not recorded. Turn it on in Settings."; error: `ErrorNote` with Retry link; group-limited note: "Showing the 200 queries that took the most time."
- Copy has no em dashes; all durations via `fmtLatency`.

## Files
New: `lib/hops/slow-queries.server.ts` (+ test), `lib/hops/slow-queries.ts` (pure LogQL builders, merge, types, + test), `routes/insights.queries.tsx`, `components/insights/query-table.tsx`. Changed: `routes/insights.tsx` (flip tab). No change to Vector, VictoriaMetrics, the request view or alerts.

## Tests
- Builders: exact strings for JSON and kv, window ranges, `topk`, escaping of a service name containing a quote; the regexes are anchored (a test string `hop=in_end ... op=GET` must not match the `table` regexp).
- Merge: `where id = 1` and `where id = 2` merge; `in (?, ?)` and `in (?)` merge; different tables stay apart; `p95Approx` set only when merged; `shareOfDb` sums to 1 per service.
- Server function with an injected `MetricRunner` returning canned vectors for both formats; statements-off detection through an injected controls reader; group-limited flag at 200; stale-while-revalidate serves old value and refreshes once.
- `routesFor`: injected log query returns kv and json lines; parent ids batched by 50; unknown parent skipped; example is the slowest.

## Verification
Local stack, insights scenario: the `orders` shape tops the list with the 180 to 420 ms calls; the N+1 `plans` shape tops by calls; merging verified by the scenario emitting the same query from two adapters' formats; Called-by shows `GET /orders/:id`; Statements switch off shows the message. Time the 1 h query against the local Loki with the scenario running at its generated rate and record the number in the PR; do the same on the reference deployment after deploy before any longer window is considered. 1440 and 390 screenshots; no sideways scroll; top gap at most 64 px.

## Risks
The 12 s client timeout is raised only for `metricInstant` (25 s, no retry); a slow Loki returns the stale value or the error card, never a blank page. Statement text cut at 300 bytes by emitters may merge different long queries (noted in the row detail when `sample` length is 300). p95 across merged groups is approximate and says so.

## Out of scope
Per-query alerts (feature 5 reads this module's cached result), a per-statement Vector metric, EXPLAIN plans.
