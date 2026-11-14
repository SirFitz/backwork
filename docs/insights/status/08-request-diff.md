# 08 Request diff: status

Branch `bac-75-request-diff`, worktree `backwork-wt/ins-diff`, cut from origin/main 27a295e.
Dev server :3506 on `bw_ins_75`, signed-in test organisation seeded.

## 1. Setup: done
- Worktree, `npm ci`, database `bw_ins_75`, dev server, test organisation.
## 2. Route filter + typicalRequest: done
- `inboundEndQuery(..., route)` + 3 tests; `lib/hops/typical.server.ts` (`pickTypical` pure, `typicalRequest`) + 10 tests, pass.
