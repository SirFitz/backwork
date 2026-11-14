# D: Correlator hop records for feature 12 (cache hit ratio, DB pool wait)

Read-only map, 2026-11-13. Correlator = `/Users/romario/projects/inkress/correlator` (C/), backwork = `/Users/romario/projects/inkress/backwork-wt/insights` (B/).
**WARNING: the local checkout of C/ is on `main` 40 commits behind `origin/main` (2c4367d, 2026-11-12 12:20).** Local spec/SPEC.md is Draft 0.9; `origin/main:spec/SPEC.md` and `/Users/romario/projects/correlation-id-library/SPEC.md` are **Draft 0.11** (vectors.json `"spec": "0.11.0"`). Line numbers below are from the local 0.9 file unless marked `0.11:`; rule texts of HOP-8..21 are unchanged in 0.11 except HOP-11 (4xx-answered failures are `ok`) and HOP-15. 0.11 adds `handoff` (HOP-23, outbound, "A call with `handoff` `true` is left out of the totals of HOP-20"), `path` (HOP-24), health checks (HOP-22). **Next free HOP rule ID is HOP-25.** origin/main also adds adapters nodemailer (JS), ex_aws, stripe, swoosh (Elixir); pg, ioredis, ecto lib code unchanged vs local; postgres.js changed (peer, factory.ts). Pull before planning code.

## 1. Hop record spec (C/spec/SPEC.md §13.1, lines 382-448; §13.2 lines 450-485)

### HOP-8 field table (SPEC.md:393-419), verbatim, in record order
| Field | Records | Value |
|---|---|---|
| `trace_id` | All | The trace ID (LOG-1). |
| `hop` | All | `in`, `in_end`, `out` or `out_end`. |
| `hop_id` | All | The hop's ID (HOP-3). |
| `parent_hop` | All, when the hop has a parent | The parent's hop ID (HOP-4). |
| `hop_sent` | Outbound | `true` when the hop ID was written to the carrier, otherwise `false`. |
| `tracer` | Outbound, when the OpenTelemetry bridge is active | `true` (OTEL-11). |
| `parent_id` | All | The context's `parent_id`: the value read from, and written to, the tracer format. |
| `service` | All, when configured | CFG `service`. |
| `adapter` | All | The adapter's name (ADP-6). |
| `via` | All | `http`, `rpc`, `job`, `message`, `db`, `cache` or `other`. |
| `method` | HTTP hops | The request method. |
| `op` | When known | What was asked for: the route template (inbound HTTP), the RPC method, the job or worker name (HOP-13), or the command word of a data-store call (HOP-18). |
| `table` | Data-store end records of SQL calls, when known | The table the statement acts on (STM-5). |
| `peer` | Outbound | Where it went: ... the server's host or the connection's name (data stores). |
| `attempt` | Inbound jobs, when the job system reports it | The attempt number, starting at 1. |
| `outcome` | End records | `ok` or `error` (HOP-11). |
| `status` | End records of HTTP and RPC hops that got a response | The response status code, as a number. |
| `error` | End records with `outcome` `error` | The type name of the failure (HOP-11). |
| `duration_us` | End records | HOP-10. |
| `db_n`, `db_us` | Inbound end records, when a database call was made | HOP-20. |
| `cache_n`, `cache_us` | Inbound end records, when a cache call was made | HOP-20. |
| `f_{name}` | Inbound end records, one per named field | HOP-21. |
| `stmt` | Data-store end records of SQL calls, when the statement has a shape | ... Always the last field. |

NB: `status` is HTTP/RPC only; data-store hops have no status. Reference impl FIELD_ORDER: C/vectors/reference/correlator_ref/hops.py:24-28 (note: it omits `table` from FIELD_ORDER list; table/stmt appended by `_with_statement`).

### Rules relevant to data-store hops (verbatim)
- **HOP-9** (SPEC.md:421) An end record repeats every field of its start record and adds `outcome`, `duration_us` and, where they apply, `status`, `error`, the data-store totals (HOP-20) and the named fields (HOP-21).
- **HOP-10** (423) `duration_us` is the whole number of microseconds from the start record to the end record, read from the runtime's monotonic clock. Each core provides a test-only way to replace that clock...
- **HOP-11** (423) `outcome` is `error` when the unit of work or the call failed in the runtime's sense: an exception, an error return, a timeout or a cancellation. Otherwise it is `ok`. ... `error` holds the type name of the failure and never its message.
- **HOP-12** (424) `service` and every value an adapter supplies (`adapter`, `method`, `op`, `peer`, `error`) is 1 to 200 bytes with every byte in `0x21`–`0x7E`. A value outside that limit is left out of the record.
- **HOP-14** (426) one log line per record; structured logger gets fields + message `hop`; plain-text logger gets `key=value` pairs "in the order of the table in HOP-8. `stmt`, where present, is the last pair".
- **HOP-18** (430) "A call to a database or a cache is an outbound hop with `via` `db` or `cache`, made with `hop_out` and no carrier. Nothing is sent and `hop_sent` is `false`. `peer` is the server's host, with `:port` when the port is not the default, or the name the host gives the connection. `op` is the command word in lowercase (for example `select`, `insert`, `commit`, `get`), taken from the driver where it reports one and otherwise from the first word of the statement. Nothing else of the statement is read or kept, except to form the `table` and `stmt` fields under section 13.2. With no current context nothing is recorded and no `missing_context` event is emitted. With CFG `store_hops` off, nothing is recorded for a data-store call."
- **HOP-19** (431) "A data-store hop writes its end record only, with no start record. At most CFG `store_hop_limit` data-store end records are written under one inbound hop. Later data-store calls under that hop write no record and emit no `hop` event."
- **HOP-20** (432) "When data-store calls were made under an inbound hop, its end record carries their totals: `db_n` and `db_us` for databases, `cache_n` and `cache_us` for caches. `_n` is the number of calls and `_us` the sum of their durations in microseconds. Every call counts, whether or not HOP-19 recorded it. A pair with no calls is left out."
- **HOP-21** (433) `annotate(name, value)` -> `f_{name}` on inbound end record; name 1-32 bytes `a-z 0-9 _`; max 8; never on a carrier.
- **ADP-16** (550) "A data-store adapter ... MUST NOT read, store or log the parameters, keys, values or results of a call." <- matters: hit/miss is derived from the *result*; spec change must carve out "whether a read returned a value" explicitly.
- **ADP-5** (539) adapter MUST NOT read/store/log content "other than the headers named in this specification and the values listed in HOP-8".
- STM-1..7 (454-473): `table`/`stmt` only for `via` `db` SQL calls; cache adapters pass none of `statement`/`table`/`ansi_quotes` (STM-2).
- Config (SPEC.md:326-348): `store_hop_limit` default `32`; `store_hops` `on`; `statements` `on`; `named_fields` `on`. CFG-5 (353): "Every feature of Correlator has a switch and is on unless it is switched off."
- §23 row 29/30 (951-952): DB/cache calls are outbound hops; "a cache call records the command word only"; one end line each, max 32, inbound totals. §23 "Not specified" (969): "Data-store hops record no row counts, and no table or statement shape for a cache or key-value call".

### Store totals on the inbound end record
Only `db_n`,`db_us`,`cache_n`,`cache_us` (HOP-20). Reference: hops.py:211-226 increments per call at `hop_end` regardless of store_hop_limit; emits pair only when `_n` > 0. Vectors: `hop-store-hops-and-totals` (cases/hop.py:132), `hop-store-limit` (139), `store-limit-zero`, `store-after-inbound-end` (cases/extra.py:156,159).

### Unknown fields / extensibility
- No reader-side rule. The spec never says readers ignore unknown fields. It constrains *writers*: TK-HOP-7 (SPEC.md:716) "Records hold only the fields of HOP-8." So a new field = a spec change to HOP-8 before any adapter may write it.
- VER-2 (767): "Within one major version, the headers written on the wire, the `trace_id` log field and the hop record fields of HOP-8 do not change meaning." -> adding an optional field is a minor bump (0.9 -> 0.10 pre-1.0); changing meaning of existing ones is not allowed.
- VER-3: package versions independent of spec version; each package states spec versions it conforms to.
- Plain-text order: a new field slots into the HOP-8 table position; readers in backwork parse key=value so order is irrelevant there except `stmt` last (see §3).

### Do hit/miss or pool-wait fields exist anywhere? NO.
`grep -i 'hit|miss|pool|wait|acquire|checkout|queue_time'` over SPEC.md/NOTES.md: only unrelated matches (missing_context, PROC-7 pooled threads). None in reference impl.

### How a new optional field is added (process, from vectors/README.md + check.py)
1. Add rule(s) in SPEC.md §13.1 with next free IDs (HOP-21 is last -> HOP-22, HOP-23...); add row(s) to HOP-8 table; amend HOP-9 ("adds ...") and HOP-20/ADP-16 as needed; add TK-STORE-n row in §19.3 (TK-STORE-4 is last); add §23 row (choices table, "Proposed"); add NOTES.md N-xx for ambiguities.
2. `check.py` (C/vectors/check.py:32,71-79) extracts every `**XXX-n**` in §3-14 and FAILS unless each appears in a vector with valid, boundary AND invalid cases (VEC-3), except listed in NOT_VECTOR_TESTABLE / NO_INVALID_INPUT.
3. Inputs go in C/vectors/reference/cases/hop.py (or extra.py) via `hop(id, rules, case, steps, random, clock, config, note)`; expectations are generated by the Python reference C/vectors/reference/correlator_ref/hops.py -> extend FIELD_ORDER, InboundState, `hop_end` info handling there.
4. `python3 vectors/reference/generate.py` rebuilds vectors.json (never hand-edit); `python3 vectors/check.py` must exit 0; bump `SPEC_VERSION` in generate.py and `"spec"` in vectors.json (currently "0.9.0", 527 vectors: hop 73, shape 123).
5. Vector `hop_end` step `info` today carries `status`, `error`, statement keys (README "hop" op table) -> new info keys (e.g. `hit`, `wait_us`) need README row update too.
6. Each core re-runs vectors.json unchanged (VEC-4) + adapter test kit.

## 2. Adapters that exist

JS (C/js/packages/, all `0.1.0`, `"private": true`, peer-dep on lib): core, correlator (meta), express, fastify, hono, nestjs, remix (entry); bullmq (job); pino (logger); opentelemetry (bridge); **pg, postgres, ioredis** (data store). NOT present: mysql/mysql2, drizzle (covered via pg/postgres drivers), knex, prisma, redis (node-redis), memcached.
Elixir (C/elixir/, all `@version "0.1.0"`): correlator, correlator_core (Erlang src), phoenix, plug, oban, quantum, httpoison, tesla, **ecto, redix** (data store). NOT present: Cachex/Nebulex/ETS caches, Memcachex.
SPEC.md:561 "First data-store adapters: `correlator-ecto` and `correlator-redix` for the BEAM core; `correlator-postgres` (postgres.js), `correlator-pg` (node-postgres) and `correlator-ioredis` for the JavaScript core."

Core plumbing a new field must pass through:
- JS: `HopRecord` C/js/packages/core/src/types.ts:166-195; `HopInfo` 198-220; `HopEndInfo` 223-231 (status, error, statement, table, ansiQuotes only); FIELD_ORDER hops.ts:~15-30; `InboundState` hops.ts:37-52 (dbN, dbUs, cacheN, cacheUs, storeRecords); `endFields` hops.ts:140.
- Erlang: `store_hop/3` correlator_hop.erl:154-162; `finish/4` 164-205 (store branch increments atomics cells, writes record if under limit); `totals/1` 248-257; cells in include/correlator.hrl:23-30 (`CELL_SIZE 7`) -> new totals need new cells. Elixir wrapper `Correlator.store_hop/3` lib/correlator.ex:152. Test kit field allow-list `@hop_fields` lib/correlator/test_kit.ex:191 (TK-HOP-7 enforcement) -> must add new names.
- Reference: C/vectors/reference/correlator_ref/hops.py FIELD_ORDER 24-28, InboundState 32-42, hop_end 195-228.

### Per data-store adapter

| Adapter | File | How it times | Hit/miss knowable? | Pool wait knowable? |
|---|---|---|---|---|
| pg (node-postgres) | C/js/packages/pg/src/index.ts | patches `Client.prototype.query` (187); `begin` (94-112) -> `api.beginExit`; ends on callback/promise/emitter (122-168). Hop = Client.query call to result. **Pool wait NOT in duration today** (Pool#query does connect then client.query). | n/a (db) | YES. `Pool.prototype.connect` already patched (188-196, only to bind callback context). pg-pool `query()` calls `this.connect((err, client)=>...)` (pg-pool 3.13 index.js:431,449); `connect(cb)` queues in `_pendingQueue` (190-231). Time connect-call -> callback = acquire wait (includes new-connection handshake when pool not full). Promise form (`await pool.connect()`) passes no cb: today unwrapped -> must also wrap the returned promise. Attach wait to client via WeakMap<client, waitUs>, consumed by the first `Client.query` on that client (pool.query path: exactly one). |
| postgres (postgres.js) | C/js/packages/postgres/src/index.ts | patches `Query.prototype.handle` (180-187); `begin` 189-221; end on promise settle (216-220). `handle()` runs `handler(q)` which queues in postgres.js `queries` or dispatches `go(conn,q)` (postgres 3.4.9 src/index.js:329-348). So **duration today already includes internal queue wait + connection open**. | n/a | PARTLY. Dispatch moment = `connection.execute(q)` sets `q.state = backend` (src/connection.js:156-167). Not exposed; would need an own-property setter trap on the Query instance in `handle` (hacky, internal API). Also pipelining: a "busy" connection takes queries (index.js:338) so wait = queue behind in-flight queries, not only pool. Flag: knowable only via internals; lower priority. |
| ioredis | C/js/packages/ioredis/src/index.ts | patches `Redis.prototype.sendCommand` (69-86); `begin` 89-107; end on `command.promise` settle (74-79). | YES. Resolve value at line 77 `() => scope.end(Outcome.Ok)` -> change to `(reply) => ...` and classify by `command.name`: `get/getex/getdel/hget/lindex/json.get` -> hit iff reply !== null; `mget/hmget` -> partial (skip or count per element); `hgetall` -> `{}` = miss; `exists` -> reply>0. Must never store/log the reply (ADP-16): only a boolean derived. BullMQ traffic (evalsha etc.) is ioredis too -> non-read commands must carry no hit field. | n/a (ioredis has no pool; offline queue only). |
| ecto | C/elixir/correlator_ecto/lib/correlator/ecto.ex | telemetry `[prefix, :query]` handler `handle_query` (89-110) -> `Correlator.store_hop(info, duration_us, outcome)`. `duration_us/1` (208-221) uses `total_time` = queue_time + query_time + decode_time. **db_us today includes pool wait.** | n/a | YES, free: Ecto measurements already carry `queue_time` (DBConnection pool checkout wait), `query_time`, `decode_time`, `idle_time` (native units, optional keys). Just read `measurements[:queue_time]`. |
| redix | C/elixir/correlator_redix/lib/correlator/redix.ex | telemetry `[:redix,:pipeline,:stop]` (1.x) / `[:redix,:pipeline]` (0.10) `handle_pipeline`; `duration`/`elapsed_time`. One hop per pipeline, `op` = word or `pipeline` (command.ex). | **NO** via telemetry: metadata has `commands`, `connection`, `connection_name`, `kind`, `reason`; no reply. Would need a wrapper around `Redix.command/3` (host code, breaks DX-2 "no code") or app `annotate`. | **NO**: Redix is a single connection process; any pool is host-built (poolboy/NimblePool etc.). |

Consistency issue to note: `db_us` means different things today: Ecto includes queue wait, pg excludes it, postgres.js includes internal queue. A pool-wait field fixes interpretation only if the spec also says whether `duration_us`/`db_us` include it (proposal §5: they do, and the new field is the part of it spent waiting).

### Rules a hit/miss field collides with (0.11 text, /Users/romario/projects/correlation-id-library/SPEC.md)
- **SEC-15** (0.11:625) "A hop record holds only the fields of HOP-8. ... It never holds a parameter or result of a database call, a literal or comment from a statement, or a cache key or value." -> a `hit` boolean is derived from the result; the spec must say explicitly it is allowed (whether a read returned a value, never the value).
- **ADP-16** (0.9:550) "MUST NOT read, store or log the parameters, keys, values or results of a call" -> amend: "except whether a read command found its key (HOP-25)".
- **HOP-23** (0.11:445) handed-off calls are left out of HOP-20 totals -> new totals must follow the same exclusion.
- §23 last row is 51 (0.11:992) -> new choices start at row 52. TK-STORE-4 is the last TK-STORE (0.11:746) -> TK-STORE-5/6.

## 4. Versioning, publishing, rollout, deployed state

- Packages: JS `correlator`, `correlator-core`, `correlator-<lib>` (pg, postgres, ioredis, bullmq, express, fastify, hono, nestjs, remix, pino, opentelemetry, nodemailer); Elixir `:correlator`, `correlator_core`, `correlator_<lib>` (ecto, redix, oban, phoenix, plug, quantum, httpoison, tesla, ex_aws, stripe, swoosh). All version `0.1.0`, JS `"private": true`.
- **Nothing is published.** C/README.md: "Status: under construction. Nothing here is released." C/docs/consuming-before-release.md:3 "Nothing is published to npm or Hex yet. A service gets Correlator as a **built copy committed to its own repository**, under `vendor/correlator/`, refreshed by one command" (`node <correlator>/js/packages/correlator/scripts/vendor.mjs <service-dir>`). JS tarball version `0.1.0-dev.g<commit>`; `vendor/correlator/MANIFEST.json` names the commit. Elixir: sources copied, `{:correlator, path: "vendor/correlator/correlator"}`.
- No CHANGELOG file. Change history = git log of inkress/correlator (`git log <old>..<new> -- js elixir`, docs line ~190) + DECISIONS.md "Change log" (/Users/romario/projects/correlation-id-library/DECISIONS.md:579-609) + spec "Changed in 0.11" line. Spec semver: VER-1..VER-5 (0.9:766-770). Release pipeline (REL-1..5, COR-19) not built.
- Rollout order, **Decided** (DECISIONS.md:284): "the library is rolled out to Inkress, then FleekSite, then Courier Portal, then Auditors, then ACMS." Image Foundry added (KAI-189, DECISIONS.md:573). Tickets: INK-1571 (Inkress rollout), FS-668 (FleekSite rollout), CP-24 (Courier Portal rollout), COR-20 (Auditors+ACMS rollout) (DECISIONS.md:561-565).
- Deployed today (run folder /Users/romario/projects/correlation-id-library/run-2026-11-12/agents/*/STATUS.md, 2026-11-12 ~19:20Z): every instrumented service vendors **2c4367d** (= origin/main tip):
  - Inkress (t28-ink): commerce-payments (JS/Hono) dev + **prod** (promoted c1eba44, pserve); commerce-api + commerce-worker (Elixir, Ecto/Redix/Oban) vendored, PRs merged (capi #559, worker #163) - dev; dashboards (5 Remix apps: accounts/admin/merchant/developer/portal) dev+prod promoted (fc9a9e2). Inkress prod otherwise not covered ("Inkress production is not covered at all", INSTRUMENTED.md:46) - payments/dashboards prod promotions happened anyway per t28 STATUS; check before relying.
  - FleekSite (t27-fs): fs-web dev+prod (717a2e82, prod/2026-11-12-4), revamp PR #335, fs-hono (queue tracing off where dev/prod share a queue).
  - Courier Portal (t29-cp): api/client/admin (Node, `pg`) merged.
  - Image Foundry (t26-if): prod (b35a569, dserve).
  - Auditors, ACMS: not started (COR-20).
- **To see feature-12 data**, each service needs a re-vendor + deploy: the field is written by the core + the data-store adapter inside the vendored bundle. Minimum to see both halves: commerce-api (Ecto queue_time = pool wait; Redix cache, but Redix can't give hit/miss) + one ioredis service for hit/miss (fs-web/fs-hono/BullMQ-heavy; which of them do app-level `GET` caching is unverified) + CP api (pg Pool). Count: 1 Elixir service gives pool wait with zero adapter difficulty; hit ratio needs a JS ioredis service.

## 3. Backwork side (B/ = /Users/romario/projects/inkress/backwork-wt/insights, HEAD d2c750b)

### Ingest proxy: B/dashboard/app/lib/ingest/enforce.server.ts + B/dashboard/app/routes/ingest.loki.api.v1.push.tsx
- **Deny-list, not allow-list.** Hop lines are kept whole; only named fields are removed by switch. `STORE_TOTALS = new Set(["db_n","db_us","cache_n","cache_us"])` (enforce.server.ts:30). `HopStrip {named, stores, statements, paths}` (105-114). `stripHopFields` (119-142): JSON: deletes keys where `drop(k)` (122-123); kv: regexes `/ f_[a-z0-9_]+=\S*/g` (137), `/ (?:db|cache)_(?:n|us)=\S*/g` (138), ` table=` (139), ` path=` (140), stmt kept/removed whole (141).
- Whole data-store lines (`via` db/cache) are dropped when Stores is off (`isDataStore` 169-171, `off` 205-209); so a per-call field on `out_end` (e.g. `hit`, `wait_us`) needs no strip rule. A new **inbound total** does: add to `STORE_TOTALS` and widen the kv regex (note `cache_hit_n` / `db_wait_us` do NOT match `(?:db|cache)_(?:n|us)`).
- Push route (ingest.loki.api.v1.push.tsx:49-59): loads controls rows + filter + names, `enforceStreams`, forwards to `${config.lokiUrl}/loki/api/v1/push`. **An unknown new field survives into Loki unchanged** (no field allow-list anywhere on the hop line). The sensitive-data filter (`applyFilter`) runs on the whole line; numeric/boolean values like `cache_hit_n=3`, `hit=true`, `wait_us=812` match none of its patterns (password/token/card/email/phone) - check the phone regex `\b\d{3}[.-]\d{3}[.-]\d{4}\b` cannot hit plain integers (it can't: needs separators).

### Collector: B/dashboard/app/lib/agent/vector-config.server.ts (source) -> B/infra/vector/vector.yaml (generated by `bun infra/vector/generate.ts`, `--check` for staleness)
- `bw_detect` / `bw_controls` parse the line into `%bw_hop` (vector.yaml:78-142, 144-215): kv via `parse_key_value` after splitting off ` stmt=` (109-124). All fields kept in metadata; `.message` (raw line) stored as is.
- Switch stripping duplicated in VRL: JSON filter list `includes(["db_n", "db_us", "cache_n", "cache_us"], k)` (vector.yaml:256 = vector-config.server.ts:300); kv regex `r' (?:db|cache)_(?:n|us)=\S*'` (vector.yaml:266, .ts ~310). Must change in lockstep with enforce.server.ts.
- Stored event: `STORED_FIELDS` = message, display, service, source, host, project, level, kind, timestamp (.ts:393; vector.yaml:322-326). Hop fields live only inside `message` -> survive.
- Agents on customer hosts get a static agent.yaml rendered from the same .ts (B notes: "agent.yaml is static") -> **a new metric needs every agent re-rendered/reinstalled**; Loki pass-through needs nothing.
- Metrics (vector.yaml:328-458; .ts `METRIC_PREP_VRL` 181-200, `metricTransformsYaml` 437, `MetricName` 38-41, `storeMetric` ~485):
  - `bw_metric_prep`: labels `service, dir(in|out), via, method, op, peer, outcome, status_class`; `duration_s`; on `in_end` with Stores on: `db_s, db_n, cache_s, cache_n` from the totals (361-367).
  - `backwork_hop_duration_seconds` histogram, tags service/dir/via/method/op/peer/outcome/status_class (378-393). Data-store `out_end` lines land here with via=db|cache, op=select|get..., peer=host.
  - `backwork_hop_started_total` counter (service/dir/via/op).
  - `backwork_hop_store_seconds_total` and `backwork_hop_store_calls_total` counters, `increment_by_value`, tags `service, via, method, op, store=db|cache` (408-451) - per inbound route.
  - `bw_hop_cardinality` `tag_cardinality_limit` exact, `value_limit: 2000`, `drop_tag` (453-458). Prometheus exporter buckets 0.005..900 s, flush 900 s.
- **Adding hit/miss**: two more `storeMetric` entries on `bw_hop_route.stores`: `backwork_hop_store_calls_total{store="cache_hit"}` / `{store="cache_miss"}` from `bw_m.cache_hit_n` / `bw_m.cache_miss_n` (no new label key, +2 values of `store`, series = routes x 2). **Pool wait**: `backwork_hop_store_seconds_total{store="db_wait"}` from `bw_m.db_wait_s` (= `db_wait_us`/1e6). Cardinality unchanged in label keys; series per route +3. Optional per-call histogram of `wait_us` on db `out_end` (`backwork_hop_store_wait_seconds`, tags service/peer only) - skip in v1.

### Parse: B/dashboard/app/lib/hops/parse.ts
- `fieldsOf` (151-168) builds a bag of every scalar field (JSON top level + nested keys, or kv with key `isNameOf(key,64,"")`, i.e. `[a-z0-9_]{1,64}`). Unknown keys sit in the bag and are ignored -> **readers ignore unknown fields** in practice.
- `totalsOf` (207-214) reads the 4 totals -> `StoreTotals {dbCalls, dbUs, cacheCalls, cacheUs}` (B/dashboard/app/lib/hops/types.ts:92-97); `parseHopRecord` (285-335): `totals: hop === "in_end" ? totalsOf(bag) : null` (331); store hops get `peer`, `table`, `stmt` (323-325).
- New fields: `totalsOf` += `cacheHits = int(bag,"cache_hit_n",...)`, `cacheMisses`, `dbWaitUs`; `HopRecord` += `hit: boolean | null` (via cache, out_end: `bool(bag,"hit")`) and `waitUs: number | null` (via db, out_end: `int(bag,"wait_us",0,MAX)`); `totalsOf` null-check must also accept a line with only new fields (keep current rule: null when both `_n` absent).
- Downstream consumers of totals: B/dashboard/app/lib/hops/tree.ts:208-221 (TimeSplit), B/dashboard/app/routes/requests_.$id.tsx:609 (split bar note), 893-896 (`storeChip` text on the inbound hop's details).

### Queries / UI today
- Performance: B/dashboard/app/routes/performance.tsx loader uses `defer` (61) + `Deferred`/`RowsSkeleton` per panel (render-first rule OK). Routes table columns Route / Req/s / Errors / p95 / p99 / "DB + cache" (`storeShare`, 201-222). `routesTable` B/dashboard/app/lib/hops/metrics.server.ts:391-417 (scope `routesScope(service)`, by method+op; 10 s `cached`); `storeShareQuery` 161-167, `storeCallsPerRequestQuery` 170-176; `RouteRow` 227-233.
- Request view: B/dashboard/app/routes/requests_.$id.tsx: `HopText` 767-786 (row label, `storeLabel`, inline `statementTail`); details panel facts 875-900: for `isStore && via === Via.Db` pushes "Database" (peer) and "Table" (882-885); statement block 910-915. `storeLabel`/`statementTail` in B/dashboard/app/lib/hops/store-label.ts.

## 5. Proposal: minimal spec addition (target spec 0.12, minor bump under VER-2)

Everything here is **Proposed (Claude)**; items marked **[R]** are Romario's to confirm. Written against 0.11 numbering.

### Fields
| Field | Records | Value |
|---|---|---|
| `hit` | Cache end records of a call that reads one key, when the client reports it | `true` when the server returned a value for the key, `false` when it returned none (HOP-25). |
| `wait_us` | Database end records, when the client reports it | Microseconds of `duration_us` spent waiting for a connection before the statement was sent (HOP-26). |
| `cache_hit_n`, `cache_miss_n` | Inbound end records, when a cache read reported `hit` | HOP-25. |
| `db_wait_us` | Inbound end records, when a database call reported `wait_us` | HOP-26. |
HOP-8 placement: `hit` and `wait_us` after `duration_us`; `cache_hit_n`, `cache_miss_n` after `cache_us`; `db_wait_us` after `db_us`. `stmt` stays last.

Names **[R]**: `_n` suffix follows `db_n`/`cache_n`; alternatives `cache_hits`/`cache_reads`, `found`, `queue_us` (Ecto's word). Units: whole microseconds (as HOP-10), counts as integers, `hit` as boolean (`true`/`false`, like `hop_sent`).

### Rule text (spec style)
- **HOP-25** A cache adapter whose call reads the value of one key (for Redis `get`, `getex`, `getdel`, `hget`; for Memcached `get`) passes `hit` to `hop_end`: `true` when the reply held a value and `false` when it held none. It reads nothing of the reply but whether it is empty, and keeps nothing of it. For every other call, and where the client does not hand the reply to the adapter, `hit` is left out. When cache calls with `hit` were made under an inbound hop, its end record carries `cache_hit_n` and `cache_miss_n`: the number of such calls with `hit` `true` and with `hit` `false`. Every such call counts, whether or not HOP-19 recorded it, except a call with `handoff` `true` (HOP-23). A field with no calls is left out. `hit` is never written on a record whose `via` is not `cache`.
- **HOP-26** A database adapter whose client takes connections from a pool passes `wait_us` to `hop_end` when the client reports the time the call waited for a connection, or the adapter can measure it: from the moment the call asked the pool for a connection to the moment it had one. `wait_us` is part of `duration_us`: the adapter starts the hop where the call asked for the connection, or adds the wait it measured before the hop started. A value larger than `duration_us` is written as `duration_us`. Where nothing waited for a pool (a connection the host holds, a transaction already open) `wait_us` is `0`; where the wait cannot be known it is left out. When database calls with `wait_us` were made under an inbound hop, its end record carries `db_wait_us`, their sum, under the same counting as HOP-20. `wait_us` is never written on a record whose `via` is not `db`.
- Amend **HOP-9**: "...the data-store totals (HOP-20, HOP-25, HOP-26)...". Amend **HOP-20**: no text change; add "See HOP-25 and HOP-26 for the cache read and connection wait totals."
- Amend **ADP-16**: after "MUST NOT read, store or log the parameters, keys, values or results of a call" add "; of a cache read it reads only whether the reply was empty (HOP-25)".
- Amend **SEC-15**: "...or a cache key or value. Of a cache reply it holds only whether it was empty (HOP-25)."
- New **TK-STORE-5** (exit, cache): a read of a missing key gives `hit` `false`, of a present key `hit` `true`, a write gives no `hit`; the inbound end record's `cache_hit_n`/`cache_miss_n` count them, past `store_hop_limit` too; the marker in the value appears nowhere (extends TK-STORE-2).
- New **TK-STORE-6** (exit, SQL data store with a pool): with the pool exhausted by a held connection, a call's `wait_us` is at least the hold time, at most `duration_us`, and `db_wait_us` on the inbound end record is their sum; with a free connection `wait_us` is below 1 ms or 0.
- §23 rows **52** (hit/miss on one-key reads only; multi-key reads such as `mget` carry no `hit` **[R]**), **53** (connection wait is part of the duration, so `db_us` keeps meaning "time the request spent on its database calls" **[R]** - the alternative is `wait_us` outside `duration_us`, which changes Ecto's `db_us` today and conflicts with VER-2).
- Switch: none new; both follow `store_hops` (and backwork's Database and cache switch). **[R]**: CFG-5 says "Every feature of Correlator has a switch" - a dedicated `store_details` switch is the alternative.
- NOTES.md entries: which Redis commands count (case-insensitive command name; `json.get`, `hgetall` excluded since `{}`-vs-missing is ambiguous) **[R]**; `wait_us` for pg includes a new connection's handshake when the pool grows.

### Test vectors (C/vectors/reference/cases/hop.py, generated by C/vectors/reference/generate.py; reference C/vectors/reference/correlator_ref/hops.py)
README "hop" op table: `hop_end` info gains `hit` (bool) and `wait_us` (int). Reference: FIELD_ORDER + InboundState `cache_hit_n, cache_miss_n, db_wait_us` + `hop_end` handling.
- `hop-store-cache-hit-miss` valid [HOP-25, HOP-8, HOP-9]: get hit, get miss, set (no hit) under one inbound hop -> out_end lines with `hit=true`, `hit=false`, none; in_end `cache_n=3 ... cache_hit_n=1 cache_miss_n=1`.
- `hop-store-hit-past-limit` boundary [HOP-25, HOP-19]: `store_hop_limit: 1`, two reads -> one line, totals count both.
- `hop-store-hit-on-db-dropped` invalid [HOP-25]: `hit` passed on via db -> left out, no totals.
- `hop-store-hit-handoff` boundary [HOP-25, HOP-23]: read in a handoff step -> `hit` on the line, not in totals.
- `hop-store-db-wait` valid [HOP-26, HOP-20]: two db calls `wait_us` 1200 and 0 -> lines carry them, in_end `db_wait_us=1200`.
- `hop-store-wait-capped` boundary [HOP-26]: `wait_us` > duration -> written as `duration_us`.
- `hop-store-wait-invalid` invalid [HOP-26]: `wait_us` -1, "12", 1.5, on via cache -> left out.
- check.py then requires valid+boundary+invalid for HOP-25 and HOP-26 (VEC-3); bump `SPEC_VERSION` in generate.py and `"spec"`.

### Adapters to change first (by value / effort)
1. **correlator_ecto**: `wait_us = queue_time` from measurements (already in `total_time`; ecto.ex `duration_us/1` 208-221). Zero risk; covers commerce-api + commerce-worker. Core: Erlang `store_hop/3` info `wait_us`, new atomics cell (hrl `CELL_SIZE` 8 -> 11 with CELL_DB_WAIT_US, CELL_CACHE_HIT_N, CELL_CACHE_MISS_N), `finish/4` + `totals/1`; test_kit `@hop_fields`.
2. **correlator-ioredis**: `hit` from the resolved reply for the one-key read set (index.ts:76-78). Covers JS services on ioredis (incl. BullMQ traffic, which stays hit-less). JS core: `HopEndInfo` + `InboundState` + FIELD_ORDER + `endFields`.
3. **correlator-pg**: wrap `Pool.prototype.connect` (index.ts:188-196) for both callback and promise forms, WeakMap<client, waitUs>, consumed by the next `Client.query` on that client and passed as `wait_us` (core adds it to duration). `Client` used directly -> `wait_us` left out (not 0: no pool known).
4. Later: **correlator-postgres** wait (internal `q.state` trap; fragile, leave out first); **correlator_redix** hit (not knowable from telemetry: leave out; document).
Coverage gap to state in the UI: Elixir services on Redix show no hit ratio; route rows with no `hit` data show "—", not 0 %.

## 6. Backwork work list (after the spec + adapters ship and services re-vendor)
1. **Parse** (B/dashboard/app/lib/hops/parse.ts, types.ts): `StoreTotals += cacheHits, cacheMisses, dbWaitUs` (0 default, keep `null` rule); `HopRecord += hit: boolean|null` (via cache, out_end) and `waitUs: number|null` (via db, out_end). Tests in parse.test.ts (kv + JSON, out-of-range values -> null).
2. **Ingest pass-through** (enforce.server.ts:30, 138): add the three totals to `STORE_TOTALS` and widen the kv regex to `/ (?:db|cache)_(?:n|us|hit_n|miss_n|wait_us)=\S*/g`; enforce.server.test.ts case with Stores off. Without this, Loki already keeps them (deny-list) but the Stores switch would leak them.
3. **Vector** (vector-config.server.ts, regenerate vector.yaml, tests.yaml): same strip list + kv regex in `bw_controls`; `METRIC_PREP_VRL` add `bw_m.cache_hit_n`, `bw_m.cache_miss_n`, `bw_m.db_wait_s`; `storeMetric` x3 into existing `backwork_hop_store_calls_total{store="cache_hit"|"cache_miss"}` and `backwork_hop_store_seconds_total{store="db_wait"}` (no new label key; `bw_hop_cardinality` unchanged). Re-render agents (static agent.yaml). Vector unit tests can't see metric values (tests.yaml:3-4): verify against VictoriaMetrics locally.
   - Caveat: existing `storeShareQuery` sums `backwork_hop_store_seconds_total` without a `store` matcher -> adding `store="db_wait"` would **double count** wait in "DB + cache" share. Add `store=~"db|cache"` to that selector (metrics.server.ts:164) and to `storeCallsPerRequestQuery` (173) in the same change.
4. **Query** (metrics.server.ts): `cacheHitRatioQuery(scope, range)` = `increase(calls{store="cache_hit"}) / (increase(calls{store="cache_hit"}) + increase(calls{store="cache_miss"}))` by method,op; `dbWaitShareQuery` = `increase(seconds{store="db_wait"}) / increase(seconds{store="db"})`. Add `cacheHitRatio`, `dbWaitShare` to `RouteRow` (227-233) and `routesTable` (391-417) via the same `Promise.all`; null when denominator 0. Tests in metrics.server.test.ts.
5. **UI, Performance** (routes/performance.tsx 201-222): one column "Cache hits" (`fmtShare`, "—" when null) after "DB + cache"; optionally a "Conn. wait" share (hide below sm). Panel stays deferred with its skeleton.
6. **UI, request view** (routes/requests_.$id.tsx): on db store rows, when `waitUs > 0`, a fact "Waited for a connection" `fmtUs(waitUs)` in the details (next to Database/Table, 882-885) and a muted inline suffix in `HopText` (767-786) e.g. "waited 4.1 ms"; on cache rows a "hit"/"miss" fact; inbound `storeChip` (893-896) gains "n hits · m misses" and "x ms waiting for connections". TimeSplit (tree.ts:208-213) unchanged in v1.
7. Verify on real data: commerce-api (Ecto wait) and one ioredis service, after re-vendor + dev deploy; read the in_end line in Loki and the series in VictoriaMetrics.

## 7. Test conventions
- Correlator vectors: `python3 vectors/reference/generate.py` then `python3 vectors/check.py` (exit 0 = valid, every rule covered with valid/boundary/invalid, every expect reproduced, self-test). Inputs only in `vectors/reference/cases/*.py`; never hand-edit vectors.json.
- Correlator JS: workspace `cd js && npm test` (or `npm run test:bun`); per package `npm test` = tsc build + tsc test build + `node test-dist/test/run.js`. Core tests: js/packages/core/test/{unit,vectors,runtime,harness,shape}.ts. Adapter tests hit real servers: pg/postgres on `127.0.0.1:55439` (user t09/t09pass, `T09_PG_PORT`, `T09_PG_URL`), ioredis on `56389` (`T09_REDIS_PORT`); `T09_ONLY=high|low` picks one library version of the matrix.
- Correlator Elixir: `mix test` per package; core test kit `Correlator.TestKit` (correlator_core/lib/correlator/test_kit.ex, scenarios incl. TK-STORE-*, field allow-list `@hop_fields`); adapter `test/kit_test.exs` + `test/support/driver.ex` (real Postgres `CORRELATOR_PG_URL` default `ecto://postgres:postgres@127.0.0.1:5432/postgres`; Redis `CORRELATOR_REDIS_HOST/PORT`); `CORRELATOR_MATRIX=low|high` (ecto_sql 3.11 vs 3.13). BEAM vector runner in correlator_core tests.
- Backwork: `cd dashboard && bun test` (co-located `*.test.ts`, e.g. lib/hops/parse.test.ts, metrics.server.test.ts, lib/ingest/enforce.server.test.ts, lib/agent/vector-config.server.test.ts); `bun run typecheck` (tsc); `bun infra/vector/generate.ts --check` (vector.yaml stale check, run from repo root); `infra/vector/test.sh` (Docker, `timberio/vector:0.43.1-alpine test vector.yaml tests.yaml`).
DONE
