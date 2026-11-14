# 04 Chatty and parallel: status

Branch `bac-71-chatty-parallel`, worktree `backwork-wt/ins-chatty`, cut from origin/main 1be6601.

## 1. Setup: done
- Worktree created, plan, README, foundation and feature 1 notes read; `npm ci` running.
- Fixture timings read from `qa/fixtures/emitter.ts`: `GET /orders/:id` = slow select (180 to 420 ms) then 3 gets of 0.5 to 0.8 ms with 0.3 ms between them (a saving of about 2 ms, below the 20 ms floor); `POST /checkout` = 38 to 58 ms then 24 to 40 ms with 0.8 ms between (saving 24 to 40 ms); `GET /feed` = 12 gets all starting at 1.0 ms; `GET /shop` = 22 db calls on every request (route median 22: never chatty by either test).

## 2. Pure modules: done
- `lib/hops/chatty.ts` + 12 tests, `lib/hops/concurrency.ts` + 18 tests; `tsc --noEmit` exit 0. Committed.

## 3. Mounts: done
- Request view: `parallelOf` in the row context, `ParallelChip` on chained rows (desktop) and "could run together" in the phone meta line, `["Could run together", sentence]` detail fact; chatty badge on the "N database and cache calls" fact.
- List: neutral `chatty` badge in the Method cell (desktop) and after the service on the phone meta line, `py-0` so the row height stays; "Chatty only" and "Most calls" toggles in both control layouts.
- `tsc` 0, `bun test` exit 0 (611 pass, 7 skip, 0 fail), `remix vite:build` exit 0 (build/ deleted). Committed.

## 4. Real records: done
- `evidence-04/real-requests.txt`: 3 requests each of `GET /orders/:id`, `GET /feed`, `POST /checkout`, `GET /shop` from the shared Loki, through `parseHopRecord`, `splitRequests`, `buildRequestTree`, `detectRepeats`, `parallelChains`, `parallelCandidates`, `chattyRequest`, and the list rows through `rowsFromRecords` and `chattyRows`.
- `/orders/:id`: one 4-call chain (select orders + 3 gets), saved 0.1 to 0.6 ms, not reported. `/feed`: no chain. `/checkout`: reported, 30.3 / 35.1 / 37.8 ms saved. `/shop`: chains of distinct selects saving 2 to 8.5 ms, not reported; no row chatty.
- Signed-in dev server on :3502 (`bw_ins_71`): `/requests` 200 with the "Chatty only" and "Most calls" controls; a checkout request page renders "could run together" on both call rows; a feed request page has none.
- Plan "As built" section written.

## 5. PR
- After `git merge origin/main` (already up to date): tsc 0; bun test 0 (611 pass, 7 skip, 0 fail); vite:build 0.
