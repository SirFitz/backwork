# 09 Service map: status

Branch `bac-76-service-map`, worktree `backwork-wt/ins-map`, cut from origin/main 95a4b10.

## 0. Fixture peers: checked
- VictoriaMetrics `backwork_hop_duration_seconds_count{dir="out"}` by `service, peer, via` on the shared stack:
  shop-api -> payments.internal (http), risk.internal (http), shop-db (db), redis.internal (cache);
  commerce-api -> payments.internal, risk.internal (http), orders-db (db), notifications, receipts (job);
  commerce-payments -> acquirer.example (http), payments-db (db); commerce-risk -> redis.internal (cache).
- `peerPairs` over a 15 minute Loki scan (inbound + outbound non-store records, the attention queries) learns
  payments.internal -> commerce-payments, risk.internal -> commerce-risk, receipts -> commerce-worker.
  acquirer.example, notifications, bank-gw.internal stay unresolved (External). No fixture change needed.

## 1. Pure graph: done
- `lib/hops/service-map.ts` (`buildMap`, `layout`, `edgeTone`, `edgeWidthPx`, `mergeFigures`, `neighbourEdges`, `listRows`, `boxesOverlap`) + 16 tests.

## 2. Peers: done
- `PeerStore.all` (bulk read, newest first, `PEER_READ_LIMIT` 5000), `peerServicesFor` (cached 30 s), `scanPeers` / `learnPeers`
  (one Loki read of inbound and non-store outbound records over 15 min, saves new pairs only, `cachedStale` 5 min per org).
- Tests: realistic Vector-envelope checkout records learn payments.internal and risk.internal; new pairs only; once per 5 min.
  DB test `peers.server.test.ts` on `bw_ins_76`: pass.
