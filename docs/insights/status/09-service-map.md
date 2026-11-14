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
