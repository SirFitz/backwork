# 07 Fix first: status

Branch `bac-74-fix-first`, worktree `backwork-wt/ins-fixfirst`, cut from origin/main 27a295e.

## 0. Read and setup: done
- Read README, plan 07, foundation status, As built of 00, 01, 02, 06, 09, notes B sections 2 and 9, UI_ISSUES, PRODUCT, DESIGN.
- Merged names: `scanRepeats(tenant, windowMs)` (rows `RepeatRow`, `truncated`, `statementsOff`), `slowQueries(tenant, SlowWindow)` (`QueryRow.totalS`, `statementsOff`), `compareServices(PerfRange, tenant)` (`CompareRow`), `allRoutesScope`, `windowQueries(window, offset, by, health)`.
- Links that exist: `/requests?service=&method=&route=&range=`, `/insights/queries?service=&open=<service>:<shapeId>&window=`, `/insights/repeats` (no filter parameters), `/performance?service=&compare=1&range=`.

## 1. Pure ranking, server sources, metrics builder: done
- `lib/insights/fix-first.ts` (`FixKind`, `FixWindow`, `SourceState`, `rankFixFirst`, `filterFixItems`, item builders, labels, `FIX_FRESH_MS`).
- `lib/insights/fix-first.server.ts` (`fixFirst`, `computeFixFirst`, `regressionInputs`, `cachedStale` 1 min / 10 min).
- `metrics.server.ts`: `routesByTotalTime` + `routesByTotalTimeQueries` (`topk`, the other five restricted with `and topk(...)`), `totalTimeQuery`, `totalTimeBy`.
- Regression impact changed from p95 rise x requests (came out at 96 s for shop-api, more than the service's 48 s in all) to requests x (mean now - mean last week), from the `_sum` increase of both windows.
- Shared stack, 1 h, platform tenant: all four sources ok; Receipts.SendEmail 38.7 s, GET /orders/:id 35.5 s, shop-api regression 24.9 s, commerce-worker regression 19.4 s, ..., select orders 4.56 s, GET /shop 4.46 s, select plans x14 could save at least 1.83 s (sampled).

## 2. Page and component: done
- `routes/insights._index.tsx`, `components/insights/fix-list.tsx`.
