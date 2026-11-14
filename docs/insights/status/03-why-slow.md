# 03 Why slow: status

Branch `bac-70-why-slow`, worktree `backwork-wt/ins-why`, cut from origin/main 1be6601.

## 1. Setup: done
- Worktree created, `npm ci` in `dashboard/` exit 0. Docs, plan, notes A, merged `repeated.ts` and the request route read.

## 2. Verdict module: done
- `lib/hops/verdict.ts` + `verdict.test.ts` (18 tests). Deviations in 03-why-slow.md "As built".

## 3. UI: done
- `components/insights/why-line.tsx`; mount in `OneRequest` (memoised on the tree; click reuses the repeat focus).
- Server-rendered pages on :3501 (bw_ins_70) show the line for /shop, /orders/:id, /checkout and none for /feed. No browser checks (owner does them; list in the PR).

## 4. Evidence (real fixture records through parser, tree, detectRepeats, whyItWasSlow; verdict identical on a second build)
- GET /shop: repeated_calls, "47 percent of the 37.0 ms went on select plans, run 14 times one after another (17.4 ms in all). The next biggest is shop-api's own code (19 percent, 7.0 ms)."
- GET /orders/:id: slow_call, "One call took 95 percent of the 409 ms: select orders, 388 ms."
- POST /checkout: waiting, "90 percent of the 86.1 ms was spent waiting on other services, the longest on commerce-payments (45.6 ms)."
- GET /feed: fast, hidden.

## Final (PR https://github.com/SirFitz/backwork/pull/39)
- Merged origin/main (already up to date). `npx tsc --noEmit` exit 0; `npx bun test` exit 0 (599 pass, 7 skip, 0 fail); `npx remix vite:build` exit 0, `build/` removed.
- Cleanup: dev server stopped, /tmp/bw_ins_70* removed, bw_ins_70 dropped.
DONE
