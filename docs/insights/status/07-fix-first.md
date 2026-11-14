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

## 3. Tests: done
- `lib/insights/fix-first.test.ts` (19), `lib/insights/fix-first.server.test.ts` (9: query strings, row join, failing and off sources, stale cache refreshing once), `components/insights/fix-list.test.ts` (4: skeleton, empty, full, partial).
- `npx tsc --noEmit` exit 0; `npx bun test` exit 0 (661 pass, 7 skip, 0 fail; one earlier run had the existing 5000-call timing test in `repeated.test.ts` at 115 ms against its 100 ms bound, passed on rerun twice); `npx remix vite:build` exit 0, `build/` removed.

## 4. Dev server on the shared stack: done
- :3505 on `bw_ins_74`, seeded org as platform org. `/insights` 200, unauthenticated 302 to `/login?next=%2Finsights`; 15 rows, "Show more" absent at 1 h (exactly 15 items within the first page plus more below 30 not reached), sampled note shown, "as of 06:22 UTC, from 3 minutes ago" on a stale serve; `?window=6h` 200 with the 6 h links.
- Loki unreachable (script with a closed Loki port): queries and repeats unavailable with the reason, routes and regressions still ranked.
- First cold load on the dev server took 45 s (Vite optimising dependencies and reloading); one cold `?window=6h` hit the 5 s SSR abort (`entry.server.tsx`) and returned 500 to curl. Each source alone: 1 h routes 0.5 s, queries 2.6 s, repeats 2.4 s, regressions 0.5 s.
