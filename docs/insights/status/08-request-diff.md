# 08 Request diff: status

Branch `bac-75-request-diff`, worktree `backwork-wt/ins-diff`, cut from origin/main 27a295e.
Dev server :3506 on `bw_ins_75`, signed-in test organisation seeded.

## 1. Setup: done
- Worktree, `npm ci`, database `bw_ins_75`, dev server, test organisation.
## 2. Route filter + typicalRequest: done
- `inboundEndQuery(..., route)` + 3 tests; `lib/hops/typical.server.ts` (`pickTypical` pure, `typicalRequest`) + 10 tests, pass.
## 3. Pure diff: done
- `lib/hops/diff.ts` (`diffRequests`, `rowKind`, `differingRows`, `callsNote`, `fmtDeltaUs`) + 18 tests, pass; tsc 0.
- Real records (evidence-08/real-diffs.txt, script evidence-08/diff-real.ts): slow vs fast `GET /orders/:id` names select orders (416 ms against 180 ms) as all of the 236 ms; two `GET /shop` requests: about the same, no rows differ.
## 4. Page, table, Compare button: done (checks pending)
- `routes/requests_.$id_.vs.$other.tsx`, `components/insights/diff-table.tsx`, Compare mount in `routes/requests_.$id.tsx`.
- curl (dev :3506, signed in): slow vs fast `GET /orders/:id` 200 with sentences and rows; `/vs/typical` picked a 295 ms request (median about 311 ms); two `GET /shop`: "about the same", 10 rows alike; unknown ID: "Not found" in B's column; `vs/zzz` 404; signed out 302 to login; request view has the Compare link.
- Plan "As built" section written.
## 5. Merge and checks: done
- Merged origin/main (BAC-78 pins and others), no conflicts; `npm ci` 0.
- `npx tsc --noEmit` exit 0; `npx bun test` exit 0 (698 pass, 9 skip, 0 fail); `npx remix vite:build` exit 0 (build/ removed).
- An earlier full run under load average 113 failed the two 5000-call timing tests in repeated.test.ts and concurrency.test.ts (not touched here); they pass alone and in the final run.
- After the merge: `/requests/67ebc987.../vs/typical` 200, "This request took 422 ms and the typical request 306 ms: 116 ms more. Most of the difference, 116 ms, is select orders (416 ms against 300 ms)."
- PR opened (see below). Dev server stopped, /tmp/bw_ins_75* removed, bw_ins_75 dropped.
DONE
