# 10 Weekly digest: status

Branch `bac-77-weekly-digest`, worktree `backwork-wt/ins-digest`, cut from origin/main 793acec.
Database `bw_ins_77` (local socket). Dev server port 3508.

## 1. Read and plan: done
- Plan, README, foundation status, As built of 00, 01, 02, 05, 06, 07, notes C 1/2/4/7, UI_ISSUES, PRODUCT, DESIGN, `routes/alerts.tsx`, `lib/jobs.server.ts` read.

## 2. Pure content and schedule maths: done
- `lib/digest/build.ts` + test (13), `lib/digest/schedule.ts` (pure maths and labels, so the card can use them) + test (13), `lib/digest/settings.ts` (intents, form parser), `lib/digest/delivery.ts` (per-destination outcomes).

## 3. Store, inputs, job, action: done
- `store.server.ts` + DB test (3: concurrent claims from this process and a second OS process, one winner; retry after an hour up to 3 attempts; sent runs never re-claimed; next week new; settings, recipients, error counts), `inputs.server.ts` + test (3), `schedule.server.ts` + test (8: fan-out, retry only failed, tick due/not due/claimed, failures), `action.server.ts` + test (6: member and viewer 403, admin and owner save and audit, other org's channel refused, test send). `startDigestJobs` in `lib/jobs.server.ts` (+ jobs test). tsc 0; digest tests 46 pass.
- Found while testing: a source answering null (usage of an unmetered org) read as a timeout; values are now boxed inside the budget.

## 4. Card and route: done
- `components/insights/digest-card.tsx` (imports pure modules only), `routes/alerts.tsx`: deferred `digest` part with its own skeleton and error line, `digest_save` / `digest_test` intents before the alert intents. `npx remix vite:build` exit 0.

## 5. Exercised on the local stack: done
- Dev server :3508 (and a second process on :3509) on `bw_ins_77`, shared fixture Loki :3191 / VM :8491, platform org "Fixture Org"; local webhook receiver on 127.0.0.1:4677 (`ALERT_DEV_WEBHOOK_HOSTS`). Deploys and one error reported through `/ingest/deploys` and `/ingest/errors` with a local project token; a route p95 rule fired on `GET /orders/:id`.
- Test send (real data): every section present (fix first, slower than last week: commerce-worker 2.1x, shop-api 2.0x; select plans x14 in 103 requests; TimeoutError new; 1 alert still firing; 2 deploys; usage). Email text through the console mailer printed in full; result line "Email to an owner or admin failed: mailer not configured; sent to Local hook". `digest_runs` stayed at 0 rows after test sends.
- Two processes, digest due now: exactly one webhook delivery; process A logged `sent`, process B `claimed elsewhere or done`; one `digest_runs` row, attempts 1, `sent_at` set.
- Chosen-time ticks (script against the real DB and channels): 21 Nov 07:10 failing hook HTTP 500, row error JSON, attempts 1; 07:40 not retried; 08:11 retried only the failed hook, sent, attempts 2; 09:30 nothing; 22 Nov 07:30 not due (late run skipped). Receiver: /digest 200 once, /fail 500, /fail 200.
- Quiet org (no data): "All quiet this week" message, severity ok, `quiet: true`; another organisation's channel refused; demoted to member: save and test both 403, card shows the summary only. Audit rows `digest.update` and `digest.test` written.
- Fix found while exercising: fix-first lines repeated the service of regression items ("shop-api, slower than last week (shop-api)").
- Not checked here (no browser tool): the card at 1440 and 390, the local-time hint after hydration, the test-send result line layout.

## 6. Final checks (after merging origin/main): done
- `npx tsc --noEmit` exit 0; `npx bun test` exit 0 (891 pass, 13 skip, 0 fail); with `DATABASE_URL`/`USAGE_TEST_DATABASE_URL` on `bw_ins_77`: exit 0 (903 pass, 1 skip, 0 fail); `npx remix vite:build` exit 0 (build directory removed).
## 7. PR and cleanup: done
- PR https://github.com/SirFitz/backwork/pull/48. Dev servers and webhook receiver stopped, /tmp/bw_ins_77* removed, bw_ins_77 dropped.
DONE
