# 05 Slowness alerts: status

Branch `bac-72-slowness-alerts`, worktree `backwork-wt/ins-alerts`, cut from origin/main 1be6601.

## 0. Setup: done
- Worktree created, `npm ci` in `dashboard/` exit 0.
- Baseline: `tsc --noEmit` exit 0; `bun test` 581 pass, 7 skip, 0 fail (588 tests, 53 files).
- Fixture VM: about 75 requests an hour per shop-api route, so a 15 minute window holds about 19 requests (below the default floor of 20): the live rules use a 1 hour window or a lower floor.

## 1. Pure modules: done
- `alert-kinds.ts` (five kinds, `parseRule`, `ruleFromDraft`), `alert-decision.ts` (`decide`, `ruleStatus`), `alert-queries.ts` (route queries, readings, slow query pick), `alert-message.ts` (notification and preview wording). Tests pass.

## 2. Server: done
- `alert-state.server.ts` (claim, pending, history, delivery), `alerts-eval.server.ts` (readers, targets), `evaluator.server.ts` (`createEvaluator`, claim before send, 30 s retry, 5 minute slow query cadence), `channels.server.ts` (`link`, dev-only `ALERT_DEV_WEBHOOK_HOSTS`).
- DB test on `bw_ins_72`: pass; with the claim's WHERE removed it fails ("Expected length: 1, Received length: 3").

## 3. Page: done
- `routes/alerts.tsx`, `components/insights/alert-form-fields.tsx`.
- tsc 0; bun test 633 pass, 8 skip, 0 fail; `remix vite:build` exit 0.

## 4. Live evidence: done
Two dev servers (3503 and 3513) on one database `bw_ins_72`, shared fixture Loki and VictoriaMetrics, a local webhook receiver on 4599 (`ALERT_DEV_WEBHOOK_HOSTS=localhost:4599`).
- Rules: route p95 `GET /orders/:id` limit 300 ms (1 h window, wait 2 min); route p95 `GET /feed` limit 300 ms; slow query any limit 300 ms (floor 20 calls) and the same with floor 5 calls; the seeded log rule. Preview: `/orders/:id` "Right now: p95 is 483 ms (111 requests)." (breach), `/feed` "p95 is 4.8 ms (30 requests)" (no breach). A route rule without a route: 400 `{"formError":"Pick a route."}`.
- Rule added 06:05:46 UTC, pending from the next tick, fired 06:08:11 (after the 2 minute wait): one POST with both processes running. `/feed` never got a state row.
- Slow query rules fired 06:16:11 (the 06:11 read was served from a board value that had 19 calls; the next read had 23), one POST each.
- Restart of both servers while three rules fired (06:17 to 06:20): no repeat in the two ticks after.
- Limit raised to 1000 ms while running: one RESOLVED (06:23:41) with both processes.
- Both servers stopped, the firing "Slow orders query" limit raised to 1000 ms while down, both restarted: one RESOLVED at 06:25:49, the still-breaching "Slow query" was not repeated.
- Limit put back to 300 ms: `pending_since` stored and the page shows a "pending" badge titled "over the limit since 14 Nov 06:28 UTC".
- Five webhook POSTs in all, five `alert_events` rows, each `delivered` `{"<channel>": "ok"}`; audit rows `alert.channel_add`, `alert.rule_add`.
- Incident: my first `pkill -f "remix vite:dev --port 35"` also stopped the BAC-74 dev server on 3505 (`ins-fixfirst`); it was back up a minute later. Later stops used exact process ids.

## 5. Final (PR https://github.com/SirFitz/backwork/pull/42)
- After merging origin/main: `npx tsc --noEmit` exit 0; `npx remix vite:build` exit 0; database run 721 pass, 1 skip, 0 fail, exit 0.
- Plain `npx bun test`: exit 1, 711 pass, 10 skip, 1 fail. The failure is the timing budget in `lib/hops/concurrency.test.ts` (and at times `repeated.test.ts`), "5000 calls finish in well under 100 ms", measured 300 to 800 ms while the machine's load average was 95 to 140 (other agents building); both files are unchanged here and passed in isolation at 06:51 UTC. Not marked done until a plain run exits 0.
- Cleanup: dev servers on 3503 and 3513 and the webhook receiver stopped, `/tmp/bw_ins_72*` removed, `bw_ins_72` dropped.
