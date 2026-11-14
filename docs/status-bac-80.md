# BAC-80 status: request domain, monitors hidden by default

Branch `bac-80-domain-and-monitors`, worktree `backwork-wt/domain-monitors`, cut from origin/main 66a6a21.
Fields built against (COR-26, spec 0.13): `host` (HOP-27) on inbound HTTP start/end, `synthetic=1` (HOP-28).

## 0. Setup: done
- Worktree created off origin/main 66a6a21. `npm ci` running.
- `npm ci` exit 0. Baseline on 66a6a21: `npx tsc --noEmit` exit 0; `npx bun test` exit 0 (669 tests, 9 skip, 0 fail).

## 1. health.ts rule: done
- `MonitorField`, `isHealthOrMonitor`, `shownUnder`, `PROM_NOT_SYNTHETIC` (`synthetic!="1"`), `PROM_NOT_HEALTH_OR_MONITOR`, `LOGQL_NOT_SYNTHETIC`, `LOGQL_NOT_HEALTH_OR_MONITOR`.

## 2. Parse, rows, tree, figures: done
- `parse.ts` reads `host` (lower case, trailing port and dot dropped, HOP-12 bounds) and `synthetic` (1, "1", true, "true") on inbound records; outbound never. `host` is read only from the object holding the record, so a logger's or Vector's own `host` (container name) beside it is never taken (found on the shared stack: the stored envelope carries `"host":"06872f263378"`).
- `HopRecord`/`Hop`/`RequestListRow` gain optional `host`, `synthetic`. `rowsFromRecords` and `findStalled` use the one rule; LogQL for Requests/Overview and every inbound PromQL matcher add the monitor filter.
- Vector: `synthetic` tag ("1" or "", empty = no label) on duration, started and store metrics; `infra/vector/vector.yaml` regenerated; `infra/vector/test.sh` exit 0, 24 tests passed incl. the new monitor case.
- `query-defaults.snapshot.json`: the only change is `,synthetic!="1"` after each of the 48 health-check matchers.

## 3. UI: done
- Requests: Domain column (only when a loaded row has a host), phone card shows the host after the service, box matches the domain (`request-filter.ts`), toggle "Show health checks and monitors" (param `health`), "Monitor" badge on monitor rows. Performance toggle label too.
- Request view: "Monitor" chip in the title, domain beside the route line.

## 4. Fixtures: done
- `emitter.ts`: `host`, `synthetic` fields, `SCENARIO` comma list, scenario `monitors` (`cartRender`, `monitorsCycle`), `BASE=0`. `compose.monitors.yml`: three scenario-only containers. `qa/fixtures/monitors.test.ts` (4 tests, all three formats through the dashboard parser): exit 0.
- Added to the shared stack: `docker compose -p bwinsshared --project-directory . -f qa/fixtures/compose.monitors.yml up -d --build`.

## 5. Browser check: done
- Dev server :3580 on `bw_bac80` against the shared Loki :3191 and VM :8491, org "Fixture Org" as platform org. `qa/bac-80-check.mjs` in Playwright-launched Chrome (pipe, no debugging port), 1440x900 and 390x844 at DPR 2: 29 passed, 0 failed (`docs/bac-80/check-output.txt`, screenshots `docs/bac-80/*.webp`). Header to first card 60 px (1440) and 56 px (390).
- Fixed on the way: phone card truncated the service name to "shop-…"/"comme…"; now the service keeps its width and the host truncates.

## 6. Merge and final gate: done
- Merged origin/main (793acec: BAC-72 alerts, BAC-74 fix-first, BAC-75 request diff): no conflicts. The request diff's typical-request pick (`typical.server.ts`) used the health-check rule; now a monitor's request is compared with its own kind (`isHealthOrMonitor`), with a test.
- `npx tsc --noEmit` exit 0. `npx bun test` exit 0 (804 pass, 10 skip, 0 fail); with `DATABASE_URL`/`USAGE_TEST_DATABASE_URL` on `bw_bac80` exit 0 (813 pass, 1 skip, 0 fail). `npx remix vite:build` exit 0 (`build/` removed). `qa/fixtures` `bun test` exit 0 (4 pass). `infra/vector/test.sh` exit 0. `bun infra/vector/generate.ts --check`: up to date.
- Browser check re-run after the merge: 29 passed, 0 failed; `/requests/<monitor>/vs/typical` 200.

## 7. Second merge (coordinator review): done
- origin/main ec194b4 (BAC-79 cache hits and connection wait) conflicted in `metrics.server.ts`, `parse.ts` (imports only: main's new hit/miss/wait reading and store-share matcher kept beside `MonitorField` and `PROM_NOT_HEALTH_OR_MONITOR`; main's new hit-ratio and wait-share queries already go through `healthMatchers`, so they leave monitors out too), `qa/fixtures/emitter.ts` (field order: both sides' fields) and `infra/vector/tests.yaml` (main's three BAC-79 tests and the monitor test both kept; main's exact-tag assertion on `cache_hit` gains `synthetic: ""`, since the new counters use the store tag list). `vector.yaml` regenerated. `metrics-cache-pool.server.test.ts` (from main) expects the monitor matcher after the health one.
- `npx tsc --noEmit` 0; `npx bun test` 0 (847 pass, 10 skip, 0 fail); with the database on `bw_bac80` 0 (856 pass, 1 skip, 0 fail); `npx remix vite:build` 0; `infra/vector/test.sh` 0 (28 passed); `qa/fixtures` `bun test` 0 (4 pass); `generate.ts --check` up to date. Browser check 29 passed, 0 failed (first attempt hit Vite's dependency reload on a cold dev server; re-run clean); `/requests/<monitor>/vs/typical` 200. Screenshots replaced.
- Cleanup: the three `bwinsshared-monitors-*` containers removed (none existed in `bwins79`, whose collector only read them); dev server stopped; `bw_bac80` dropped.
