# 05 Slowness alerts (BAC-72)

Wave 2. Depends on: foundation (tables `alert_state`, `alert_events`, `startBackgroundJobs`), 2 (slow queries result), 6 (deploy names in messages, optional). Feeds: 10.

## Goal
Alert on what users feel, not only log volume: a route's p95 over a threshold, a route's error rate over a threshold, a query shape that has become slow. Alerts are durable (survive a restart), fire once even with two processes, wait before firing so a blip does not page anyone, and leave a history.

## What exists (notes C section 1, B section 9)
- Kinds today: `error_rate` and `log_rate`, Loki only, checked once a minute. Rule storage is a JSON blob (`alert_rules.data`), so a new kind needs no DDL for the rule itself.
- Firing state is in memory only: a restart loses it and the first tick after boot re-baselines, so a rule that resolved or started firing during the restart never notifies. No cooldown, no pending period, no history, no audit, send errors swallowed. The evaluator starts only after a page render.
- Route p95 and error share are in VictoriaMetrics through `quantileQuery`, `errorRateQueries`, `rateQuery` (no `rate()`, counter-window functions); `vm.scalar` is tenant scoped.
- Slow query shapes only exist through feature 2's cached result.

## Design

### New kinds (`lib/alert-kinds.ts`)
```ts
export const AlertMetric = {
  ErrorRate: "error_rate", LogRate: "log_rate",                 // existing, Loki
  RouteP95: "route_p95",                                        // milliseconds
  RouteErrorRate: "route_error_rate",                           // percent of requests
  SlowQuery: "slow_query"                                       // milliseconds, p95 of a query shape
} as const;
```
`AlertRule` gains optional fields (rules stay one JSON blob; validated on read, never cast):
```ts
route?: { method: string; op: string };   // route kinds
window?: "5m" | "15m" | "1h";              // route kinds, default 15m
minRequests?: number;                      // route kinds, default 20 requests in the window
shape?: { id: string; service: string } | "any";   // slow_query
minCalls?: number;                         // slow_query, default 20 calls
forMinutes?: number;                       // pending period; default 5 for the new kinds, 0 for the log kinds
```

### Evaluation (`lib/alerts-eval.server.ts` + pure builders in `lib/alert-queries.ts`)
- `RouteP95`: `quantileQuery(0.95, "in", scope(service, method, op), window)` via `vm.scalar`; value in ms. noData when the request count in the window is below `minRequests` (`windowIncrease` of `_count`).
- `RouteErrorRate`: the two `errorRateQueries` summed in code divided by the `rateQuery` count, as percent; same floor; windows go through `windowIncrease` (short windows are noisy: the form defaults to 15 m and states why in the field hint).
- `SlowQuery`: reads `slowQueries(tenant, H1)` from the cached store (never triggers more than one fresh compute per org per 5 minutes; the evaluator tick for these rules runs on the 5-minute cadence, others every minute). `shape: "any"` takes the highest p95 among rows with at least `minCalls` calls; a named shape matches by `(service, shapeId)`. The message names the shape (`shapeLabel`) and the slowest sampled example link.
- All kinds keep the tri-state: query failure or below-floor is `noData`, never firing, state unchanged.

### Durable, single-sender state
Pure `lib/alert-decision.ts`:
```ts
export type Observation = { kind: "breach" } | { kind: "ok" } | { kind: "nodata" };
export interface AlertStateRow { firing: boolean; pendingSince: number | null; }
export interface Decision { next: AlertStateRow; notify: "firing" | "resolved" | null; }
export function decide(prev: AlertStateRow | null, obs: Observation, nowMs: number, forMs: number): Decision;
```
- `breach`: if not firing, set `pendingSince` (first time) and fire only when `now - pendingSince >= forMs`; `ok`: clear pending and, if firing, resolve; `nodata`: no change.
- Storage `lib/alert-state.server.ts`: `claimTransition(orgId, ruleId, next, value, now)` runs one conditional `INSERT ... ON CONFLICT (org_id, rule_id) DO UPDATE SET firing = EXCLUDED.firing, since = ..., last_notified_at = ... WHERE alert_state.firing <> EXCLUDED.firing RETURNING *`; only the process that gets a row sends. Pending bookkeeping is a plain update (idempotent).
- `alert_events` row per transition with `delivered` (channel id to `ok` or an error string) so a failed send is visible; send failures are retried once after 30 s.
- No first-tick suppression any more (state is durable); after a deploy the stored state is loaded and nothing is replayed.
- One evaluator in `startBackgroundJobs()`; started from the root loader and the ingest route; timers `.unref()`.

### Messages
`FIRING: checkout p95 over 500 ms` / body: `GET /checkout in checkout-api: p95 is 740 ms (limit 500 ms) over the last 15 minutes, 1,820 requests. Last deploy of checkout-api: 22 minutes ago (v1.4.2).` The deploy clause only when feature 6's table has a deploy in the last 24 hours. A link to `/performance?service=...` for route kinds and to `/insights/queries` for slow queries is added for the channels that render text links (Slack, Discord, email). No em dashes (the existing `notify` body is fixed too).

### UI (`routes/alerts.tsx`)
- Kind select grows to five; kind-specific fields appear: route kinds show a service select and a route select (from `routesTable` of that service, cached), a threshold with its unit (ms or percent), window and "for N minutes"; slow query shows a shape select (from the cached board, plus "Any query") and a threshold in ms.
- "Right now" preview in the form: a fetcher evaluates the draft rule and shows "Right now: p95 is 412 ms (1,240 requests)" before saving.
- Rules table shows the target and current value; a "pending" state label for rules that are breaching but waiting.
- A small history list per rule (last 5 events) from `alert_events`.
- `formError` is finally rendered; ids become ulids; every rule and channel change is audited (`AlertAudit` const map: `alert.rule_add`, `alert.rule_toggle`, `alert.rule_delete`, `alert.channel_add`, ...).
- Layout rules unchanged; no new explainer paragraph (field hints under inputs are one line).

## Files
New: `lib/alert-decision.ts` (+ test), `lib/alert-queries.ts` (+ test), `lib/alerts-eval.server.ts`, `lib/alert-state.server.ts` (+ DB test), `components/insights/alert-form-fields.tsx`. Changed: `lib/alert-kinds.ts`, `lib/alerts.server.ts` (rule validation, meta), `lib/evaluator.server.ts` (use the new pieces), `routes/alerts.tsx`, `lib/audit.server.ts` consumers (action names).

## Tests
- `decide`: breach shorter than `forMs` does not fire; breach held fires once; further breaches do not notify again; ok resolves once; nodata keeps state; `forMs` 0 fires at once; pending cleared by an ok; restart (prev loaded from state) does not re-notify.
- Query builders: exact strings for each route kind and window; label values gated by `isLabelValue`; a quote in a route is escaped.
- Evaluation with a fake `PromClient` and fake slow-query reader: floor gives nodata; slow-query "any" picks the max over rows with enough calls; named shape missing gives nodata.
- DB test (opt-in): two concurrent `claimTransition` calls produce exactly one winner; `alert_events` row written; delivery failure recorded.
- Updated "alert kinds" test lists five kinds and still rejects retired ones.

## Verification
Local stack, insights scenario with the regression trigger: a `route_p95` rule on `GET /shop` with limit 300 ms fires after its pending period, posts to a local webhook receiver once even with two dashboard processes started, resolves when the trigger is removed; kill the dashboard mid-firing and restart: no repeat, no missed resolve; a slow-query rule fires on the `orders` shape; form preview matches the table value; history shows both events. 1440 and 390 screenshots.

## Risks
Cadence: a minute-by-minute VM query per rule per org is cheap; the slow-query kind reads cached data and does not add Loki load. p95 from the 16 histogram buckets is coarse near bucket edges (0.25 s to 0.5 s interpolates linearly): the field hint says "p95 is accurate to about 20 percent between buckets". A rule on a route that no longer exists stays `nodata`.

## Out of scope
Per-rule notification schedules, escalation, anomaly detection, paging integrations beyond the existing channels.
