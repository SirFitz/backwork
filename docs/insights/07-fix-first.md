# 07 Fix-first list (BAC-74)

Wave 3. Depends on: 1 (repeat scan), 2 (slow queries), 6 (compare). Feeds: 10.

## Goal
The **Insights** landing page: one ranked list of the things that cost the most time, whatever kind they are, so someone opening backwork on a Monday knows what to fix first.

## What exists
Routes are ranked inside one service on Performance (p95 descending); there is no cross-service route ranking (`routesTable` is per service; note B suggests an all-routes scope). Features 1, 2 and 6 provide repeated calls, slow queries and week-over-week regressions as separate views.

## Design

### Items and impact
```ts
export const FixKind = { Route: "route", Query: "query", Repeat: "repeat", Regression: "regression" } as const;
export type FixKind = (typeof FixKind)[keyof typeof FixKind];

export interface FixItem {
  id: string;                 // stable: `${kind}:${service}:${key}`
  kind: FixKind;
  title: string;              // "GET /shop", "select plans", "select plans, 14 times per request"
  service: string;
  impactS: number;            // seconds in the window the item accounts for
  impactLabel: string;        // "1.4 min of request time in the last hour" | "could save 38 s" | "added 12 s"
  why: string;                // one clause: "71% of its time is database and cache" | "p95 740 ms, 2.4x last week"
  href: string;               // where to look: request list filtered, slow queries row, repeats, performance
  tone: "neutral" | "warn";   // warn only for regressions and error-heavy routes
}
export function rankFixFirst(input: FixInputs, limit: number): FixItem[];   // pure
```
Impact definitions (stated in each item's label so nothing is implied that is not measured):
- **Route**: total seconds the route took over the window = increase of `backwork_hop_duration_seconds_sum` for `dir="in"`, by `service, method, op`, from the all-routes scope (`allRoutesScope`, foundation) with `topk(15, ...)`; "why" from `storeShareQuery` (share of time in database and cache) and p95.
- **Query**: `totalS` from the slow queries board (top 10).
- **Repeat**: `wastedS` = sum of `wastedUs` across requests in the scan (a saving, labelled "could save").
- **Regression**: `(p95 now - p95 last week) x requests` seconds of extra time in the window (from feature 6 `compareServices`), only `Slower` and `MoreErrors` rows.
Routes and queries overlap (a query's time is inside a route's time); the list says what each number is and the "why" of a route names the dominant store share, so the same cost can legitimately appear at two levels. The ranking uses the common unit (seconds in the last hour) and a filter chip row lets people look at one kind.

### Loading
`lib/insights/fix-first.server.ts`: `fixFirst(tenant, now)`: the four sources run in parallel each wrapped in `safe`; result `{ items: FixItem[]; sources: Record<FixKind, "ok" | "unavailable" | "off"> ; computedAt }`; `cachedStale("fixfirst:<org>", 1 min, 10 min)`. A source that fails or is off (statements off) is listed as a muted line under the table ("Slow queries unavailable"), the rest still ranks.

## UI (`routes/insights._index.tsx`, replaces the placeholder)
- Title row "Fix first" with window control (1 h, 6 h) and filter chips All, Routes, Queries, Repeats, Regressions on the same row.
- One card: `CardHead` "What cost the most" + inline "last hour, as of 14:02". Rows (38 px): rank number, kind chip (neutral), title (mono for queries), service, impact label, why (hidden below `md`, shown as a second line in the row title attribute), chevron link. Top 15; "Show more" reveals 15 more.
- Empty: "Nothing stands out in the last hour." Source notes under the table. Skeleton rows first; per-source unavailable text; stale note "from 4 minutes ago".
- Rows open the right place with filters applied: routes to `/requests?service=&method=&route=&range=`, queries to `/insights/queries?service=&q=<shapeId>` (row expanded), repeats to `/insights/repeats?...`, regressions to `/performance?service=&compare=1`.

## Files
New: `lib/insights/fix-first.ts` (types, `rankFixFirst`, labels, + test), `lib/insights/fix-first.server.ts` (+ test), `routes/insights._index.tsx`, `components/insights/fix-list.tsx`. Changed: `routes/insights.tsx` (nothing; index route), `lib/hops/metrics.server.ts` (a small exported `routesByTotalTime(scope, range, tenant, client)` using the foundation scope).

## Tests
- `rankFixFirst`: sorts by `impactS`; mixes kinds; ties stable by id; filters by kind; limit; labels for each kind; "could save" never summed with "spent"; empty input gives empty list.
- `routesByTotalTime` query string (sum of `_sum` increases, `topk`), with a fake client; `fixFirst` with failing and "off" sources shows source states and still returns the others; cache serves stale and refreshes once.
- Component renders skeleton, empty, partial and full states.

## Verification
Local scenario: the list leads with `GET /shop` (route) and `select plans` (repeat) and the slow `orders` query; links land filtered; regression trigger adds a regression row; statements off shows "Slow queries off". 1440 and 390, top gap at most 64 px, rows 38 px, no sideways scroll.

## Risks
Mixed units invite false precision: labels say what each number is. First page load needs three expensive sources: it is served from the stale cache after the first compute and each source degrades alone; the very first load shows skeletons then rows as the single promise resolves (not per source) so the order never reshuffles.

## Out of scope
Assigning or tracking fixes, snoozing items, per-team ownership.

## As built (deviations and details settled in the BAC-74 PR)
- **Regression impact** is requests x (mean request time now - mean the same hours last week), read as `totalNow - totalBefore x requestsNow / requestsBefore` from the `_sum` increase of both windows (`totalTimeQuery`/`totalTimeBy` in `metrics.server.ts`, last week with `offset 7d` and `compareLookbackSeconds`), never below zero. The planned p95 rise x requests overstated it: on the fixture shop-api came out at 96 s added in an hour in which all its requests took 48 s.
- **Route query**: `routesByTotalTime(scope, range, tenant, client, limit = 15)` sends six instant queries: `topk(limit, <_sum increase>)` and requests, the two error halves, p95 and store share each as `(<q>) and topk(...)`, so every row has all figures and nothing outside the top is read. A route is amber from 5 % failed requests with at least 20 requests (`ROUTE_ERROR_WARN_SHARE`, `ROUTE_ERROR_MIN_REQUESTS`).
- **Inputs** are narrow pure types (`FixRouteInput`, `FixRepeatInput`, `FixRegressionInput`) plus the pure `QueryRow`, so `fix-first.ts` never imports a `.server` module. `FixItem` gains `mono`, `detail` (hover text) and `impactShort` (the figure alone, for narrow screens). At most 10 slow queries and 10 repeats are taken; the list keeps 30 items (two pages of 15), filtered by kind in the browser.
- **Repeats** are scanned over the same window as the list (`scanRepeats(tenant, windowMs)`); when the scan hits its record cap the saving reads "could save at least" and a note says the repeats were sampled. `/insights/repeats` has no filter parameters, so repeat rows link to the board as it is.
- **Query links** use the board's built parameters: `/insights/queries?window=&service=&open=<service>:<shapeId>` (not `q=`).
- **Store share above 100 %** (concurrent cache calls, the plain Redis pipeline on `GET /feed`) reads "its database and cache calls overlap, adding up to more than its own time" instead of "286 %".
- **Layout**: the controls (kind chips, window) sit in the card header, as on the other Insights pages; below `md` the chips become a select, the impact shows as the figure alone below `xl` (full label from `xl`), the why column shows from `lg` (from `md` the row is too narrow beside the 224 px sidebar). The meta ("last hour, as of 06:22 UTC, from 3 minutes ago") hides on a phone like the slow queries board.
- **Off** is shown for slow queries only when the Query text switch is off and the board is empty, and for repeats when database records carry no statements (`RepeatScan.statementsOff`).
