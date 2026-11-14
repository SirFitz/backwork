# 01 Repeated calls: status

Branch `bac-68-repeated-calls`, worktree `backwork-wt/ins-repeated`, cut from origin/main 95a4b10.

## 0. Setup: done
- Worktree, `npm ci` in `dashboard/`, database `bw_ins_68` created.

## 1. Pure detector: done
- `lib/hops/repeated.ts` (`detectRepeats`, `classifyRepetition`, `wastedUsOf`, `qualifies`, `callShapeKey`, sentences, hint, chip) + `repeated.test.ts` (19).
- `path-rows.ts` folds by `callShapeKey`; `pathKeysTo` added; 3 tests.
- Deviation: cache calls run one after another qualify from 5 (`REPEAT_MIN_CACHE_SEQUENTIAL`), so the live 7-set request is reported; written into the plan.
