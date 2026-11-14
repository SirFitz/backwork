# 01 Repeated calls: status

Branch `bac-68-repeated-calls`, worktree `backwork-wt/ins-repeated`, cut from origin/main 95a4b10.

## 0. Setup: done
- Worktree, `npm ci` in `dashboard/`, database `bw_ins_68` created.

## 1. Pure detector: done
- `lib/hops/repeated.ts` (`detectRepeats`, `classifyRepetition`, `wastedUsOf`, `qualifies`, `callShapeKey`, sentences, hint, chip) + `repeated.test.ts` (19).
- `path-rows.ts` folds by `callShapeKey`; `pathKeysTo` added; 3 tests.
- Deviation: cache calls run one after another qualify from 5 (`REPEAT_MIN_CACHE_SEQUENTIAL`), so the live 7-set request is reported; written into the plan.

## 2. Server scan: done
- `lib/hops/repeats.server.ts` (`scanRepeats`, `aggregateRepeats`, `cachedStale` 30 s / 5 min) + tests (7).

## 3. UI: done
- `routes/insights.repeats.tsx` (Repeated calls tab flipped on), `components/insights/repeat-chip.tsx`; request view mounts: header fact (opens and scrolls to the first group), chip and note on Path rows, phone note line, `Repeated` and `Suggestion` detail facts; `Found.truncated` passed through.
- Dev server :3491 as the platform org: `/insights/repeats` 200 lists `select plans` x14, 24 requests, 359 ms wasted; `/requests/<GET /shop>` SSR shows "14 repeated calls" and the N+1 chip ("select plans ran 14 times, one after another, 16.7 ms in all."); `/requests/<GET /feed>` shows neither.

## 4. Evidence on stored records: done
- Real hop lines from the shared Loki through `parseHopRecord`, `splitRequests`, `buildRequestTree`, `detectRepeats`: 16 of 16 `GET /shop` requests give one N+1 group (plans lookup, 14, sequential, shapeId 5bcb6030); 16 of 16 `GET /feed` give no group.
