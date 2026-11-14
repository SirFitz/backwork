# Insights: tickets

Epic: BAC-67 (Insights: slow queries, N+1 and more)

| # | Feature | Ticket | Plan | Merged as |
|---|---|---|---|---|
| 1 | N+1 and repeated-call detector | BAC-68 | 01-repeated-calls.md | #32 |
| 2 | Slow queries board | BAC-69 | 02-slow-queries.md | #34 |
| 3 | Why was this slow? verdict | BAC-70 | 03-why-slow.md | #39 |
| 4 | Chatty-request and could-run-in-parallel flags | BAC-71 | 04-chatty-and-parallel.md | #40 |
| 5 | Slowness alerts | BAC-72 | 05-slowness-alerts.md | #42 |
| 6 | Regression compare and deploy markers | BAC-73 | 06-regressions-and-deploys.md | #37 |
| 7 | Fix-first list | BAC-74 | 07-fix-first.md | #44 |
| 8 | Request diff | BAC-75 | 08-request-diff.md | #43 |
| 9 | Service map | BAC-76 | 09-service-map.md | #33, #36 |
| 10 | Weekly digest | BAC-77 | 10-weekly-digest.md | #48 |
| 11 | Pin the worst requests | BAC-78 | 11-pin-worst-requests.md | #41 |
| 12 | Cache hit ratio and connection-wait insight | BAC-79 | 12-cache-and-pool.md | #46 (backwork); Correlator half is COR-25 |

Foundation: #31. Fixes found while building: #35 (production build), #36 (service map cold start), #38 (phone spacing), #45 (timing tests). Correlator half of 12: COR-25, a pull request in the Correlator repository for Romario's review (spec choices are his). Deployed to backwork.dev on 2026-11-14 (main a1b0010).
