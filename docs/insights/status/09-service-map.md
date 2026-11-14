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

## 3. Server, page, components: done
- `service-map.server.ts` (`serviceMap`, `computeServiceMap`, `parseMapRange`, `MAP_RANGES`) + 4 tests with a fake `PromClient` and `PeerStore`.
- `routes/insights.map.tsx`, `components/insights/map-graph.tsx` (graph + side panel), `map-list.tsx`; tab flipped.
- Render test (9): every node and drawn edge in the SVG, no overlapping boxes, all inside the viewBox, nodes and edges are tab-stop buttons, tones, list equals graph edges.

## 4. Real figures (shared stack, platform tenant, 1 h, empty `peer_services`)
- One page load of `/insights/map` filled `peer_services`: payments.internal -> commerce-payments, receipts -> commerce-worker, risk.internal -> commerce-risk.
- Layers: 0 commerce-api, shop-api; 1 commerce-worker, commerce-payments, notifications (external), commerce-risk; 2 acquirer.example (external); 3 orders-db, shop-db, payments-db, redis.internal (stores).
- 12 edges: shop-api -> commerce-payments, commerce-risk, shop-db, redis.internal; commerce-api -> commerce-payments (err, 6.7 % in 1 h), commerce-risk, commerce-worker, orders-db, notifications; commerce-payments -> acquirer.example, payments-db; commerce-risk -> redis.internal. Drawing 1072 x 376, 2 unresolved peers.
- SSR: `/insights/map` 200 with 11 nodes and the 12 edges; `?view=list&range=24h` list only, same 12 rows; unauthenticated 302 to login; tab shown on `/insights`; non-platform org (no data) shows "No calls between services recorded in this range."; VM unreachable shows "The figures could not be read: fetch failed".

## Final
- `npx tsc --noEmit` exit 0; `npx bun test` exit 0 (482 pass, 5 skip, 0 fail); with the database URLs on `bw_ins_76`: exit 0 (486 pass, 1 skip, 0 fail).
- Not run here (no browser tool): 1440 and 390 visual checks, top gap, card header height. Listed in the PR.

- PR https://github.com/SirFitz/backwork/pull/33. Cleanup: dev server stopped, /tmp/bw_ins_76* removed, bw_ins_76 dropped.
DONE
