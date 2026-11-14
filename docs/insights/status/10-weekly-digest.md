# 10 Weekly digest: status

Branch `bac-77-weekly-digest`, worktree `backwork-wt/ins-digest`, cut from origin/main 793acec.
Database `bw_ins_77` (local socket). Dev server port 3508.

## 1. Read and plan: done
- Plan, README, foundation status, As built of 00, 01, 02, 05, 06, 07, notes C 1/2/4/7, UI_ISSUES, PRODUCT, DESIGN, `routes/alerts.tsx`, `lib/jobs.server.ts` read.

## 2. Pure content and schedule maths: done
- `lib/digest/build.ts` + test (13), `lib/digest/schedule.ts` (pure maths and labels, so the card can use them) + test (13), `lib/digest/settings.ts` (intents, form parser), `lib/digest/delivery.ts` (per-destination outcomes).

## 3. Store, inputs, job: in progress
- `store.server.ts`, `inputs.server.ts`, `schedule.server.ts` written; `startDigestJobs` registered in `lib/jobs.server.ts` (+ jobs test updated). tsc 0.
