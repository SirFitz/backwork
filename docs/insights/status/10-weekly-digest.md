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

## 4. Card and route: in progress
