# 12 Cache and pool, backwork half: status

Branch `bac-79-cache-and-pool`, worktree `backwork-wt/ins-cache`, cut from origin/main 27a295e.
Baseline before changes: `tsc --noEmit` exit 0; `bun test` 636 tests (629 pass, 7 skip, 0 fail).

## 1. Parse and types: done
- `StoreTotals` + `cacheHits`, `cacheMisses`, `dbWaitUs` (null when not reported); `HopRecord`/`Hop` + `hit`, `waitUs`.
- Field names in new pure `lib/hops/store-fields.ts`. Tests `parse-cache-pool.test.ts` (12).

## 2. Ingest: done
- `STORE_TOTALS` and kv regex from `store-fields.ts`. Tests `enforce-cache-pool.server.test.ts`; negative check with the old regex: 2 fail.

## 3. Vector: done
- Strip list and kv regex in `bw_controls` from the same constants; `METRIC_PREP_VRL` sets `cache_hit_n`, `cache_miss_n`, `db_wait_s` only when present.
- Deviation: the three counters are their own routes and log_to_metric transforms (log_to_metric drops the whole event when one field is missing, which dropped the existing db/cache counters in `tests.yaml`).
- `infra/vector/test.sh`: 27 passed, 0 failed. `generate.ts --check` up to date.

## 4. Queries: done
- `store=~"db|cache"` on both share queries; `cacheHitRatioQuery` (hits and reads, ratio in code), `dbWaitShareQuery`; `RouteRow.cacheHitRatio`, `dbWaitShare`.

## 5. UI: done (code), visual check left to the owner
- Performance: Cache hits, Conn. wait (hidden below sm). Request view: wait suffix, facts, chips; verdict clause. Projects: reinstall note.

## 6. Fixtures: done
- `GET /search` (10 gets, about 1 in 5 hits), `POST /refunds` (3 updates, 55 to 85 percent wait), `hit` on `GET /orders/:id`.

## 7. Local stack verification: in progress
- Stack `-p bwins79` up (Loki 3192, VM 8492, Vector 9592), own collect label `bw79.collect` so the shared collector never reads it.
- Phase A: main's collector config.
- Phase A (main's collector, emitter already writing the new fields), evaluated at one instant: all 29 "DB + cache" share and calls-per-request figures (services and routes of shop-api, commerce-payments, commerce-api) identical between main's query and this branch's query, at 17 significant digits. VM held only `store="db"` and `store="cache"` series.
- Ingest proxy through the dev server (project "Stores check"): switch on, kv and JSON in_end lines stored with `cache_hit_n`, `cache_miss_n`, `db_wait_us`, and the cache (`hit=false`) and db (`wait_us`) lines stored; switch off, both in_end lines stored without any total (`... duration_us=90000` end of line), data-store lines dropped.
- Phase B: branch collector from 1794638852.
- Phase B (branch collector, 1794638852 to 1794639250, emitters then stopped): new series in VM: `backwork_hop_store_calls_total{store="cache_hit"|"cache_miss"}` for shop-api `/search` and `/orders/:id` only, `backwork_hop_store_seconds_total{store="db_wait"}` for commerce-payments `/refunds` only.
- Hand count from the stored Loki lines (in_end totals and per-call `hit`/`wait_us` agree) against the Performance loader (`/performance?range=1h`, platform org):
  - GET /search: 27 hits, 103 misses = 0.2077; VM 27 and 103; page `cacheHitRatio` 0.2076923 ("21%").
  - GET /orders/:id: 32 hits, 10 misses = 0.7619; VM 32 and 10; page 0.7619048 ("76%").
  - POST /refunds: wait 670086 us (phase B) over db 2044000 us in the hour (phase A db time has no wait reported) = 0.32783; VM 0.670086 s and 2.044 s; page `dbWaitShare` 0.3278307 ("33%").
  - commerce-api routes, GET /feed, GET /shop: `cacheHitRatio` and `dbWaitShare` null, cells render the "no data" dash.
- Found and fixed: a grouped row of database calls showed the first call's wait; it now shows the group's total ("waited 37.8 ms in all").
- Phase C (fixture with one long refund update): verdict on a real request "One call took 73 percent of the 68.2 ms: update refunds, 49.7 ms. Of the database time, 58 percent (37.8 ms) was spent waiting for a database connection." (in the request page HTML).
- Phase D (collector with the Database and cache switch off, from 1794639985): 69 hop lines stored, 25 in_end, 0 data-store lines, 0 in_end lines with any store total; collector exporter has 11 duration series and 0 store series; VM store counters increase over 90 s: no series.
- Stack, volumes and images removed.
