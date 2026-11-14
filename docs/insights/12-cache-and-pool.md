# 12 Cache hit ratio and connection-wait insight (BAC-79)

Wave 3. Two halves in two repositories. Depends on: foundation (Vector and parse hotspots are owned here), 3 (the request line can mention waiting). Source: `notes/D-correlator.md` (read it first; it holds the field tables, rule numbers and adapter file references).

## Goal
- **Cache hit ratio per route** on Performance ("this route misses the cache 40 percent of the time").
- **Pool wait**: how much of a database call was spent waiting for a connection rather than running, on the request view and as a share per route.

Neither can be known from today's records: nothing in the Correlator spec carries a hit, a miss or a pool wait. This feature adds them end to end.

## Decisions that are Romario's (everything below is **Proposed** until confirmed)
The Correlator spec is his: the library's own decisions file marks every drafting choice "Proposed" until he confirms. I build the proposal below as pull requests; nothing is rolled out to any service, and the numbering and names can change at his word. Open choices, each with the default used:

| # | Choice | Default in this plan | Alternative |
|---|---|---|---|
| 1 | Field names | `hit` (cache end record), `wait_us` (database end record); inbound totals `cache_hit_n`, `cache_miss_n`, `db_wait_us` | `found`, `queue_us`, `cache_hits`/`cache_reads` |
| 2 | Which reads carry `hit` | One-key reads only: Redis `get`, `getex`, `getdel`, `hget` (and Memcached `get`); `mget`, `hgetall`, `exists`, `json.get` carry none | count per element for `mget` |
| 3 | Does `duration_us` include the wait | Yes: `wait_us` is the part of `duration_us` spent waiting, so `db_us` keeps meaning "time the request spent on its database calls" (Ecto already includes queue time; pg does not today) | wait outside the duration (changes Ecto's `db_us`, conflicts with VER-2) |
| 4 | Switch | Follows `store_hops` and backwork's Database and cache switch | a dedicated `store_details` switch (CFG-5 says every feature has one) |
| 5 | Result privacy | The spec is amended (SEC-15, ADP-16) so an adapter may read only "was the reply empty", never the value | none: required for `hit` |

## Half A: Correlator (repository `/Users/romario/projects/inkress/correlator`, its own ticket and PR)
First: the local checkout is 40 commits behind `origin/main` (spec 0.9 locally, 0.11 on main). Pull before anything else; new rule ids start at HOP-25 and new choice rows at 52 (note D).

1. **Spec 0.12** (`spec/SPEC.md`, mirrored where the decisions file requires): HOP-25 (`hit`, `cache_hit_n`, `cache_miss_n`) and HOP-26 (`wait_us`, `db_wait_us`), amendments to HOP-8 (field table), HOP-9, HOP-20 (cross reference), ADP-16, SEC-15, new test-kit rows TK-STORE-5 and TK-STORE-6, choice rows 52 and 53 marked Proposed, NOTES entries (which commands count; pg's wait includes a new connection's handshake). Rule text is in note D section 5.
2. **Vectors**: new cases in `vectors/reference/cases/hop.py` (valid, boundary and invalid for each rule, as `check.py` requires), reference implementation updates in `correlator_ref/hops.py` (FIELD_ORDER, `InboundState`, `hop_end`), `python3 vectors/reference/generate.py`, `python3 vectors/check.py` exit 0, spec version bump.
3. **Cores**: JavaScript (`HopEndInfo`, `InboundState`, FIELD_ORDER, `endFields`), Erlang (`store_hop/3`, `finish/4`, `totals/1`, new atomics cells and `CELL_SIZE`), Elixir test kit `@hop_fields`.
4. **Adapters, in this order**: `correlator_ecto` (`wait_us` from the telemetry `queue_time`, zero risk), `correlator-ioredis` (`hit` from the resolved reply for the one-key read set; BullMQ traffic stays hit-less), `correlator-pg` (wrap `Pool.prototype.connect` for callback and promise forms, a `WeakMap<client, waitUs>`, consumed by the next `Client.query`; a bare `Client` leaves `wait_us` out). `correlator-postgres` and `correlator_redix` are deliberately not done (note D: internal API trap; Redix reply not available from telemetry) and the gap is documented.
5. Tests per note D section 7 (vectors check, JS workspace tests against the local Postgres and Redis, Elixir `mix test` per package). Exit codes reported.
6. **Not included**: re-vendoring into Inkress, FleekSite, Courier Portal, Auditors or ACMS (his decided rollout order, separate tickets). Until a service is re-vendored it emits no new fields and backwork shows "no data".

## Half B: backwork (this repository, no dependency on A being merged)
Everything degrades to "no data" until records carry the fields, so this half ships first and safely.
1. **Parse** (`lib/hops/parse.ts`, `types.ts`): `StoreTotals` gains `cacheHits`, `cacheMisses`, `dbWaitUs`; `HopRecord` gains `hit: boolean | null` (cache `out_end`) and `waitUs: number | null` (db `out_end`); `totalsOf` keeps its null rule. Tests for kv and JSON, out of range values give null.
2. **Ingest pass-through** (`lib/ingest/enforce.server.ts`): add the three totals to `STORE_TOTALS` and widen the kv regex to `(?:db|cache)_(?:n|us|hit_n|miss_n|wait_us)` so the Database and cache switch removes them; tests with Stores off. (Loki keeps unknown fields already; this only keeps the switch honest.)
3. **Vector** (`lib/agent/vector-config.server.ts`, regenerated `infra/vector/vector.yaml`, `tests.yaml`): the same strip list and regex in `bw_controls`; `METRIC_PREP_VRL` adds `cache_hit_n`, `cache_miss_n`, `db_wait_s`; three more `storeMetric` entries into the existing counters as `backwork_hop_store_calls_total{store="cache_hit"|"cache_miss"}` and `backwork_hop_store_seconds_total{store="db_wait"}` (no new label key, cardinality unchanged). **The existing share queries must stop double counting**: `storeShareQuery` and `storeCallsPerRequestQuery` gain `store=~"db|cache"` in the same change, with tests proving the old "DB + cache" figures are unchanged. The agent configuration is static, so existing agents need a reinstall to produce the new series (noted in the PR and on the Projects page).
4. **Queries** (`lib/hops/metrics.server.ts`): `cacheHitRatioQuery(scope, range)` = hits over hits plus misses by route; `dbWaitShareQuery(scope, range)` = wait seconds over database seconds; `RouteRow` gains `cacheHitRatio` and `dbWaitShare` (null when the denominator is zero).
5. **UI**:
   - Performance Routes table: one column **Cache hits** (`fmtShare`, "no data" tone-neutral dash when null, with a tooltip "This route's services do not report cache hits yet"), and **Conn. wait** (hidden below `sm`).
   - Request view: on database rows with `waitUs > 0` a detail fact "Waited for a connection" and a muted suffix in the row text ("waited 4.1 ms"); on cache rows "hit" or "miss"; the inbound hop's store chip gains "n hits, m misses" and "x ms waiting for connections". The feature 3 verdict gains a clause "waiting for a database connection" when wait is at least 30 percent of database time. The time split bar is unchanged in v1.
6. **Fixtures**: the insights scenario emitter writes `hit`, `wait_us` and the totals on some requests so everything can be exercised locally; a 10-row cache-miss-heavy route and a pool-starved route.

## Files (backwork)
Changed: `lib/hops/parse.ts`, `lib/hops/types.ts`, `lib/ingest/enforce.server.ts`, `lib/agent/vector-config.server.ts`, `infra/vector/vector.yaml` (generated), `infra/vector/tests.yaml`, `lib/hops/metrics.server.ts`, `routes/performance.tsx`, `routes/requests_.$id.tsx` (facts only), `lib/hops/verdict.ts` (clause), `qa/fixtures`. New: tests beside each.

## Tests (backwork)
Parse cases; enforce cases with the switch on and off for each new field in kv and JSON; vector config staleness test plus `tests.yaml` cases (and the Docker `infra/vector/test.sh` run where Docker is available); query strings including `store=~"db|cache"` regression tests; route row nulls; component rendering for no-data, ratio, and wait states.

## Verification
Local stack: with the fixtures writing the fields, the Performance column shows a ratio that matches a hand count of the emitted hits and misses; the Stores switch off removes the totals from Loki lines and series; "DB + cache" shares are identical before and after the change; the request view shows hit, miss and wait; a route from a service without the fields shows "no data". Half A: the vectors check, JS and Elixir suites pass. Real data needs a re-vendor and dev deploy of one Elixir service (pool wait) and one ioredis service (hit ratio): proposed as follow-up tickets in his rollout order, not done here.

## Risks
Wait semantics differ per adapter (note D): the UI says "waited for a connection" only where reported and never infers it. `cache_n` counts writes too, so the ratio uses hits over hits plus misses, not over `cache_n`. Services on Redix or postgres.js never report these fields: the UI must not read as a zero ratio. Agent reinstall is required for the new series on customer hosts.

## Out of scope
Per-call histograms of wait, Memcached and node-redis adapters (none exist), changing `db_us` semantics.
