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
