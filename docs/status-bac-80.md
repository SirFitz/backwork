# BAC-80 status: request domain, monitors hidden by default

Branch `bac-80-domain-and-monitors`, worktree `backwork-wt/domain-monitors`, cut from origin/main 66a6a21.
Fields built against (COR-26, spec 0.13): `host` (HOP-27) on inbound HTTP start/end, `synthetic=1` (HOP-28).

## 0. Setup: in progress
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
