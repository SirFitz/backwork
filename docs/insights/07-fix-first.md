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
