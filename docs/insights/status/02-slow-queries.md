# 02 Slow queries: status

Branch `bac-69-slow-queries`, worktree `backwork-wt/ins-slowq`, cut from origin/main 95a4b10.

## 1. LogQL validated on the shared fixture Loki (127.0.0.1:3191, Loki 3.3): done
- Six queries (JSON and key=value formats by calls, total, p95), built by `slowQueryLogql` in
  `lib/hops/slow-queries.ts`; exact strings are in `slow-queries.test.ts`.
- 1 h window, about 920 hop lines in range (stack about 15 minutes old): every query 0.016 to 0.043 s
  wall, Loki exec 0.012 to 0.037 s. 6 h total (same lines): 0.010 s. The `and`-restricted calls
  query: 0.029 s.
- JSON calls 1 h: 12 groups; `select plans.id, plans.name, plans.price from plans where plans.number = ?`
  168 calls (top by calls), orders shape 12 calls. JSON total 1 h: orders 3 685 715 us (top by time),
  plans 194 101 us. JSON p95: orders 400 086 us, plans 1 382 us.
- kv (commerce-payments) 1 h: 3 groups (charges insert 11, charges select 11, transfers 1).
- Cross-check: shop-api raw `out_end via=db` lines 276 = 168 + 9 x 12 from the grouped query.
- Nested JSON (commerce-risk, fields under `metadata`): no database calls on the stack, so checked
  with the same JSON pipeline on its cache calls: peer, hop, duration came out of `metadata_*`.
- Deviations from the plan's query sketch (written into 02-slow-queries.md): one JSON query covers
  top-level and nested records; kv cuts `stmt=` first and reads fields from the head only; grouped
  by peer too; `keep` before aggregating.

## 2. Code: done
- `lib/hops/slow-queries.ts` (pure), `lib/hops/slow-queries.server.ts`, `routes/insights.queries.tsx`,
  `components/insights/query-table.tsx`, tab flipped in `routes/insights.tsx`, tab test made
  independent of which tabs are on.
- `npx tsc --noEmit` exit 0; `npx bun test` exit 0 (475 pass, 4 skip, 0 fail).
