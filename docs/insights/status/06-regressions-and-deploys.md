# 06 Regressions and deploys: status

Branch `bac-73-regressions-deploys`, worktree `backwork-wt/ins-regress`, cut from origin/main 95a4b10.

## 0. Setup: done
- Worktree created, `npm ci` in `dashboard/` exit 0.
- Baseline: `tsc --noEmit` exit 0, `bun test` 449 pass, 4 skip, 0 fail.

## 1. Compare (A): done
- `lib/hops/compare.ts` (pure: `CompareVerdict`, `classify`, `compareLookbackSeconds`, chips, `regressions`), `compare.server.ts` (`compareServices`, `compareRoutes`, `serviceTrend`, `serviceRegressions`), `scopeFigures` exported from metrics.server.ts (defaults unchanged). Tests 13 + 12.

## 2. Deploys (B): done
- `lib/deploys.ts` (validation, marker label), `lib/deploys.server.ts` (table, `handleDeployIngest`), routes `ingest.deploys.tsx`, `api.v1.deploys.tsx`. Tests 12 + 2 DB (pass on `bw_ins_73`).

## 3. Chart (C) and pages (D): done
- `TimeSeries` markers + overlay (3 tests), Trend card, compare chip, Performance toggle + column, Overview group, Projects setup + recent deploys.
- Full suite: 489 pass, 6 skip, 0 fail (exit 0); with DB: 494 pass, 1 skip (exit 0); tsc 0.

## 4. Shared stack evidence (in progress)
- Backfill: `bun qa/fixtures/backfill-last-week.ts --vm http://localhost:8491 --latency-scale 0.5`: 477 series, 315297 samples, 2026-11-06T21:27Z to 2026-11-07T08:27Z. A second run refused ("samples already exist").
- Dev server :3493 on `bw_ins_73`, org "Fixture Org" as platform org.
- Ingest: wrong token 401 `{"error":"unauthorized"}`; 21 deploys 400 `deploys: at most 20 per call, got 21`; bad JSON 400; GET 405; `deploy.sh bwinsshared` with the project token: "deploy v-fixture-73 reported (200)"; 3 reports with a repeated commit: `{"accepted":2}`.
- `GET /api/v1/deploys` with a bwk_ key: 3 deploys newest first; `?service=shop-api&since=2026-11-14T05:00:00Z&limit=5`: 1; no key 401.
- Performance 1h shop-api compare=1 (before regression took effect): shop-api 2.0x slower (p95 433 ms vs 214 ms); GET /shop "about the same" p95 50 ms vs 24 ms; Trend card heading, `now` and `lastWeek` points and the deploys in the HTML.
- Overview: "Slower than last week" lists commerce-worker and shop-api ("p95 434 ms, last week 214 ms (about 2.0x), 164 requests, deploy v-fixture-73").
- 7d: toggle disabled with the tooltip, no column, `lastWeek: null`, 2 shop-api markers (after fixing the end rounding).
