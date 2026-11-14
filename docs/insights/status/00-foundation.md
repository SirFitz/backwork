# 00 Foundation: status

Branch `bac-67-insights-foundation`, worktree `backwork-wt/insights-foundation`, cut from origin/main 96e5b06.
Baseline before changes: `tsc --noEmit` exit 0; `bun test` 400 pass, 2 skip, 0 fail.

## 1. Pure helpers: done
- `lib/hops/stmt-shape.ts` + tests (19).
- `lib/hops/tree.ts`: `mergeIntervals`, `subtractIntervals`, `lengthUs`, `IntervalMs` exported; `storeCallCounts` indexes hops by id.
- `lib/hops/time-format.ts` (`fmtUs`, `plural`); request route imports and re-exports `fmtUs`.
- `path-rows.ts`: `GROUP_MIN`, `SLOW_SHARE`, `rowUs` were already exported on main; nothing to change.

## 2. Server helpers: done
- `cachedStale` + tests (7), `invalidateStale`.
- `metricInstant` + tests (2), `METRIC_INSTANT_TIMEOUT_MS`, `TimeWindowMs`, `MetricSample`.
- `WindowResult.truncated` (+ exported `HOP_LIMIT`), `RequestListRow.totals`, tests.
- metrics: `offset`/`lookbackSeconds` on `rateQuery`, `errorRateQueries`, `quantileQuery`, `windowIncrease`, `windowPerSecond`; `allRoutesScope`; `windowQueries(window, offset, by, health?, lookbackSeconds?)` + `WindowQueries` in metrics.server.ts; attention's `windowQueries(offset)` delegates to it.
- Byte-identity: `lib/hops/query-defaults.snapshot.json` captured from main's builders before the change; `metrics-compare.server.test.ts` asserts the defaults equal it (cmp of before/after dumps: identical).
- Full suite after item 2: 443 pass, 2 skip, 0 fail; tsc 0.

## 3. Database: done
- Seven tables in DDL + schema.ts; `org_billing` and `billing_events` restored from 1790524 (BAC-66 still open on main).
- `db/ddl.server.test.ts` (2 tests) on fresh `bw_ins_found`: pass. Negative check: with `billing_events` removed from the DDL the test fails ("Expected: true, Received: false").
- Deviations written into 00-foundation.md ("As built").

## 4. Jobs: done
- `lib/jobs.server.ts` (`startBackgroundJobs`, `startJobs`, `JobName`, `BACKGROUND_JOBS`), called from `root.tsx` loader and the Loki push route; evaluator timers now `unref()`ed.
- Tests (3). Full suite: 446 pass, 4 skip, 0 fail, exit 0; tsc 0.

## 5. UI shell: done
- `routes/insights.tsx` (tab strip in the title row, `INSIGHT_TABS` with `ready`; only Fix first shows), `routes/insights._index.tsx` placeholder, NAV entry at index 4 (`Lightbulb`), org menu as `popover="manual"` (rendered on the server too).
- Dev server on :3481 against `bw_ins_found`, fresh account: `/insights` 200 (title "Insights · backwork", h1, one tab, "Nothing to rank yet."), unauthenticated `/insights` 302 to `/login?next=%2Finsights`; `/`, `/requests`, `/performance`, `/alerts`, `/settings` 200; sidebar order Overview, Requests, Performance, Logs, Insights, Errors, ...
- Not run (no browser tool allowed here): UI_ISSUES 2 menu check at 1280/1024/768/390, 1440/390 screenshots. Left as a note in the PR.

## 6. Fixtures: done
- `SCENARIO=insights`, `shop-api`, `compose.insights.yml`, `deploy.sh`, README sections.
- Local stack `-p bwinsfound` (Loki 127.0.0.1:3191, VM 127.0.0.1:8491): Loki services `commerce-payments, commerce-risk, shop-api`; through the dashboard's own parser and tree: GET /shop 22 db calls, top shape `select plans.id, plans.name, plans.price from plans where plans.number = ?` x14 (shapeId 5bcb6030); GET /orders/:id slow shape 222 ms + 3 cache gets; GET /feed 12 cache calls; POST /checkout 3 services. VM `backwork_hop_duration_seconds_count` by route lists all four shop-api routes and the two checkout receivers. Regression: GET /shop 36 ms before, 66.6 ms after `deploy.sh`; deploy report answered 404 (endpoint arrives with feature 6).

## Final
- `npx tsc --noEmit` exit 0; `npx bun test` exit 0 (449 pass, 4 skip, 0 fail); with `DATABASE_URL`/`USAGE_TEST_DATABASE_URL` on a fresh `bw_ins_found`: exit 0 (452 pass, 1 skip, 0 fail).
- `bun ../infra/vector/generate.ts --check`: up to date (no infra changes).
- Cleanup: dev server stopped, `bwinsfound` containers, volumes and images removed, `bw_ins_found` dropped.
