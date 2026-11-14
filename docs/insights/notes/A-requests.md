# A. Request data model and request screens

Scope: `dashboard/app/lib/hops/*`, `dashboard/app/routes/requests.tsx`, `dashboard/app/routes/requests_.$id.tsx`.
All paths below relative to `/Users/romario/projects/inkress/backwork-wt/insights/dashboard/app/`.

## 1. Fetch and parse

### Fetch (lib/hops/query.server.ts)
- Query: `{kind="hop"} |= "${traceId}"` (line 63). Line filter on the 32-hex trace ID; no service/label narrowing. Parsed lines are kept only if `rec.traceId === traceId` (69) or a link line with that trace id (74).
- Limit: `HOP_LIMIT = 5000` (16), Loki's default cap per query. **No paging**: a request with >5000 hop lines (start + end each = 2 lines per in/out hop, 1 line per store hop) is silently truncated. Nothing flags truncation.
- Windows (`bounds`, 30-39), non-overlapping: `Hour` = now-1h..now; `Day` = now-24h..now-1h; `Retention` = now-30d..now-24h (`HOP_RETENTION_DAYS = 30`, types.ts 280).
- `progressiveLookup(traceId, tenant, now, query?)` (86) returns `{hour, day, retention}` promises; a later window runs only if the earlier found nothing. So a trace straddling the 1h boundary only gets its in-window records (gotcha).
- Org scoping: every query passes `tenant: Tenant` to `loki.queryRange` (scoped Loki client, lib/loki.server.ts). `assertTraceId` (46) re-validates before LogQL.
- Times: `toRaw` (41) uses `e.tsExactMs ?? e.ts` (sub-ms precision from Loki ns timestamp), epoch **ms** (float).
- Log lines: `logLinesFor(traceId, result, tenant, now, query?)` (100): `{service=~".+", kind!="hop"} |= "<id>"`, window min(record times)-5s .. max+5s (`LOG_PAD_MS = 5000`), extended to `now` if any hop is open; limit `LOG_PAGE = 1000`. Names lines after hop service via `serviceBySource` (120).
- Injectable query fn for tests: `export type HopQueryFn = (query: string, opts: { start: number; end: number; limit: number }, tenant: Tenant) => Promise<loki.LogEntry[]>;` (51).
- `export interface WindowResult { window: SearchWindow; found: boolean; records: HopRecord[]; links: LinkedId[]; searchedFromMs: number; }` (20-27).

### Parse (lib/hops/parse.ts) — the only module reading untyped log content
- `export function parseHopRecord(entry: RawLogEntry): HopRecord | null` (285). `export function parseLinkLine(entry: RawLogEntry): LinkedId | null` (338).
- `export interface RawLogEntry { ts: number; line: string; labels: Readonly<Record<string, string>>; }` (22) — ts epoch ms.
- Line formats: JSON (top-level scalars, then one level under `metadata|fields|data|context|attributes`, first wins; envelopes `message|log|msg` holding JSON or key=value) or plain `key=value` (`fieldsOf`, 151). Lines >8192 chars rejected (`MAX_RECORD_LINE`).
- Plain text: `stmt` is always last; everything after ` stmt=` is the statement verbatim (`splitStatement`, stmt.ts 31). `recordPairs` (stmt.ts 46) starts reading at the first `trace_id=<32hex> hop=` so a logger prefix with a duplicate trace_id is ignored.

Fields read (record line -> HopRecord field). Required: `trace_id`, `hop_id`, `hop`, `via`; invalid `parent_hop` or `outcome` rejects the line.

| record key | HopRecord field | on which kinds | meaning / unit |
|---|---|---|---|
| `trace_id` | traceId | all | 32 lowercase hex, not all zero |
| `hop` | hop | all | `in` / `in_end` / `out` / `out_end` |
| `hop_id` | hopId | all | 16 hex, the hop's own id (start and end share it) |
| `parent_hop` | parentHop | all | hop_id of the caller hop (in: the outbound call that sent it; out: the inbound hop that made the call) |
| `hop_sent` | hopSent | out, out_end | header propagated to the callee; default false on out kinds, null on in kinds |
| `tracer` | tracer | out kinds | OTel bridge active |
| `handoff` | handoff | out kinds | made off the request path (background) |
| `parent_id` | parentId | all | OTel/W3C parent span id (16 hex) else null |
| `service` (field, else label `service`) | service | all | service name; "unknown" fallback |
| label `source` / JSON `source` / label `service` | source | all | collector container name |
| `adapter` | adapter | all | instrumentation lib (e.g. ioredis, prisma) |
| `via` | via | all | http, rpc, job, message, db, cache, other |
| `method` | method | all | HTTP method or command verb |
| `op` | op | all | route template (in http), command name (cache: `get`, `multi`, `exec`), op name |
| `path` | path | in http only | requested path, long segments masked; must start `/` |
| `peer` | peer | out kinds only | destination host/server |
| `table` | table | via=db AND out kinds | SQL table (1..200 printable, no space) |
| `stmt` | stmt | via=db AND out kinds | statement shape, values as `?`, 1..300 bytes 0x20-0x7E |
| `attempt` | attempt | in kinds only | 1..1e6, retry number |
| `outcome` | outcome | end kinds | ok / error |
| `status` | status | end kinds | 100..999 |
| `error` | error | end kinds | printable, <=200 bytes (no spaces allowed: isPrintableValue is 0x21-0x7E) |
| `duration_us` | durationUs | end kinds | **microseconds** integer |
| `db_n`,`db_us`,`cache_n`,`cache_us` | totals: StoreTotals | `in_end` only | per-inbound-hop store call counts and **microsecond** totals (HOP-20) incl. calls past record limit |
| `f_<name>` | fields: NamedField[] | `in_end` only | named fields, max 8, name `[a-z0-9_]{1,32}`, value <=200 |
| entry ts | timeMs | all | epoch **ms** (float, sub-ms) |

Link lines: `trace_id`, `link_name` (`[a-z0-9_.-]{1,64}`), `link_value` (string or number), optional `hop_id`, `service` -> `LinkedId`.

**Units rule**: record durations and totals are microseconds (`durationUs`, `dbUs`, `cacheUs`, every `TimeSplit` field `*Us`); timestamps (`timeMs`, `startMs`, `endMs`, `skewMs`) are epoch milliseconds as floats. Convert with `/1000` (tree.ts 59-60).

Data-store hops (via db/cache) have an **end record only** (`out_end`, HOP-19), so `startMs = end.timeMs - durationUs/1000` (tree.ts 59). Note `table`/`stmt` are only parsed for via=db; cache hops have no stmt, only `op` (command) and `peer`.

## 2. Types (lib/hops/types.ts) and how stores appear

Fixed sets are `as const` maps + same-name union type (types.ts 1-78): `HopKind {In,InEnd,Out,OutEnd}`, `HopDir {In,Out}`, `Via {Http,Rpc,Job,Message,Db,Cache,Other}`, `Outcome {Ok,Error}`, `HopState {Finished,Open,Stalled}`, `GapKind {Stopped,NoReceiver,NotInstrumented,NotLinked,OutsideCaller,TracerBetween,Retry}`, `StoreKind {Db,Cache}`, `BlockOp {Multi,Exec,Discard}` (179). Branded ids: `type TraceId = string & { readonly __brand: "TraceId" }`, `type HopId = string & { readonly __brand: "HopId" }` (81-83).

Verbatim key shapes:
```ts
export interface StoreTotals { dbCalls: number; dbUs: number; cacheCalls: number; cacheUs: number; }      // 92
export interface Gap { kind: GapKind; hopId: HopId; label: string; detail: string | null; }              // 161
export interface UnrecordedStoreCalls { store: StoreKind; calls: number; us: number; }                   // 172
export interface StorePipeline { ops: readonly string[]; commandUs: number; }                            // 187
export interface LinkedId { traceId: TraceId; name: string; value: string; hopId: HopId | null; service: string; timeMs: number; } // 144
```
`Hop` (194-241): hopId, dir, via, service, adapter, method, op, path, peer, table, stmt, parentHop, parentId, hopSent, tracer, handoff, attempt, state, outcome, status, error, `startMs: number`, `endMs: number | null`, `durationUs: number | null`, totals, fields, linkedIds, logs, gaps, unrecorded, `isStore: boolean`, `pipeline: StorePipeline | null`, `afterResponse: boolean`, `skewMs: number`, `children: Hop[]`.
`TimeSplit` (244-262): totalUs, dbUs (union of db intervals), cacheUs (beyond db), waitingUs (non-store out calls beyond db+cache), ownUs (rest, >=0, parts sum to totalUs), dbCalls, dbSumUs, cacheCalls, cacheSumUs, backgroundCalls, backgroundUs. All µs. Computed for the **first inbound hop only** and only over its **direct children** (tree.ts 176-214).
`RequestTree` (264-277): `traceId; roots: Hop[]; hops: Hop[]` (flat, start order, after pipeline collapse) `; linkedIds; gaps; unplacedLogs: Record<string, TraceLogLine[]>; split: TimeSplit | null; startMs: number | null; endMs: number | null; services: string[]`.

How a DB/cache call appears in a Hop:
- `isStore = via===db||via===cache` (tree.ts 30). `dir = out`. Only an `out_end` record, so `startMs = end.timeMs - durationUs/1000`, `endMs = end.timeMs`, state always Finished.
- `parentHop` = the inbound hop of the service that made the call; store hops are direct `children` of that inbound hop (in practice; a store hop under a non-inbound parent is possible if an adapter nests it, and `storeCallCounts` handles "inbound hop missing" separately, tree.ts 449-456).
- `op` = command verb (`select`, `insert`, `get`, `set`, `multi`...); `peer` = host (db.internal, redis.internal); `table`/`stmt` db only; `outcome`/`error`; `hopSent` false.
- Request-level totals live on the inbound hop's `totals` (from `in_end` `db_n/db_us/cache_n/cache_us`), and count **every command** including ones not recorded individually.
- `unrecorded` (per inbound hop, `storeShortfall`, tree.ts 216-232) = totals minus recorded rows (pipeline-aware via `commandCount`/`commandUs`) -> "N more calls not recorded one by one" (HOP-19 record limit). These have **no stmt, no timing interval**.
- `storeCallCounts(tree): { db: number; cache: number }` (439) = request-wide row count + unrecorded.

Redis MULTI collapse (BAC-63, commit d74e259, lib/hops/pipeline.ts):
- `export function collapsePipelines(parent: Hop): Hop[]` (73) runs per hop inside `buildRequestTree` after `alignToParents` (tree.ts 332-344). Candidates: finished leaf cache hops (`isCommand`, 18). Each `multi` finds the earliest-ending `exec`/`discard` from the same client (`service+adapter+peer`) ending >= multi end - 1 ms; commands between (start >= multi.start-1ms, end within [multi.end-1, closer.end+1]) are folded.
- Merged hop = `{...multi, op: "multi", startMs: min, endMs: max, durationUs: span, outcome: error if any, pipeline: { ops: [...], commandUs: sum }}` (48-67). Folded hops are removed from `byId` and `tree.hops`.
- `commandCount(h)` (102) = ops length or 1; `commandUs(h)` (107) = summed command durations or durationUs.
- Plain pipelines without MULTI leave no marker and stay as separate hops (**a plain ioredis pipeline of N gets will look like N parallel cache calls**, relevant to N+1 and parallel flags).

## 3. Statement normalisation / fingerprint

**None exists.** `stmt.ts` only splits (`splitStatement`), extracts record pairs (`recordPairs`), and validates (`isStatement` 1..300 bytes 0x20-0x7E; `isTableName`). `MAX_STMT_BYTES = 300`, `MAX_TABLE_BYTES = 200`. No lowercasing, whitespace collapse, IN-list collapse or hashing anywhere (grep "fingerprint|normali" finds only alerts/errors/vector code).
The closest thing is `shapeKey` in path-rows.ts 44 (private): `${via}\0${op}\0${table}\0${stmt}\0${pipeline ops}` — exact string equality of the stored stmt.
Also `statementTail(hop)` (store-label.ts 56) strips the `select ... from <table>` head for display only.
Stmt text in tests (values already `?` from the emitter, STM-3):
- `select ... from merchants as m0 where (m0.username = ?) limit ?` (Ecto: column list elided as `...`)
- `insert into charges (id, amount, status) values (?)`
- `update orders set status=? where a = ? and outcome=error and duration_us=? and peer=x`
- `select h0.id from hops as h0 where (h0.trace_id = ?) and hop=in and trace_id=?`
Emitters differ (Ecto vs pg vs prisma), so the same query from two adapters will not string-match; within one adapter in one request, shapes are stable, so exact equality is a sound first fingerprint. A normaliser (lowercase keywords, collapse whitespace, `in (?, ?, ?)` -> `in (?)`, strip trailing `;`) would be new code; keep it pure in `lib/hops/`.

Fields caveat: `table`/`stmt` are absent when the org/service switched "Query text" off (`bw_drop_q`, agent/vector-config.server.ts 300; ingest/enforce.server.ts 110-141) or on records older than spec 13.2. A detector must fall back to `(via, op, table, peer)` shape and say so.

## 4. Request view route (routes/requests_.$id.tsx, 1049 lines)

Loader (68-94): `requireOrg` -> `tenantOf(org.id)`; `traceIdFromPath` (31) pads <=32 hex to 32; `progressiveLookup`; `defer({ traceId, input, now, hour, day, retention, logs, onlyLogs })`, each a `Settled<T> = { ok: true; value: T } | { ok: false; error: string }` (59) via `settle()` so a backend failure never throws. `Found` (42-48) `{ records: HopRecord[]; links: LinkedId[]; window: SearchWindow; knownPeers: string[] | null }`; `toFound` (51) calls `knownPeersFor(orgId, peerPairs, calledPeers)` (peers.server.ts, Postgres).
**The tree is built in the browser**: raw `HopRecord[]` are serialised to the client; `Tree` (372) runs `splitRequests(found.records, logs, found.links)` in `useMemo`, then `OneRequest` (423) runs `buildRequestTree(part.records, part.logs, d.now, part.links, knownPeers)` in `useMemo`. It runs twice (once with logs `[]` while logs load, then with logs). So any analysis module must be **pure and client-safe** (no `.server` imports, no node APIs), and cheap enough to run per render of `OneRequest` (memoise on `tree`).

Render order in `OneRequest` (439-456):
1. `Header` (481): `Title` (h1 method+path, status Badge, "route <op>" line) + facts row (494-502, `flex flex-wrap gap-x-[18px]`): Started, Took, N services, N hops, N database/cache calls (`storeCallCounts`), N background jobs, N gaps (`faultCount`). Right side `IdList` (trace, request ID, linked IDs). Desktop facts beyond Started/Took are `hidden md:inline`.
2. `Alert` (536): red `role="alert"` box, one row per stopped gap, `requestProblems().failedCalls`, retried jobs, NoReceiver. Returns null when nothing wrong. Red is sacred: a "slow" verdict must not go here unless it is an error.
3. `TimeSplitBar` (603): "Where the time went" label + stacked bar (own/db/cache/wait) + legend with `callsNote` ("21 calls, 128 ms in total" when overlap) + background line. Desktop above PathCard (`hidden md:block`, 443), phone below it (445-448).
4. `PathCard` (675): Card, head row `min-h-11` (44 px) with `CardHeadText title="Path" sub=...` (sub hidden on phone), "Open all/Fold all" button, legend (services, shared db host, open/finished key) in a sideways-scrolling single row (726). Column header grid `GRID` (665): `minmax(0,1fr)_44px_96px_84px_minmax(200px,330px)` = Hop, Via, Status, Took, bar with ticks.
5. Log-cap note when >= LOG_PAGE lines.

Path rows (lib/hops/path-rows.ts, CP-26 commit 318f8ce):
- `buildPathNodes(roots: readonly Hop[]): PathNode[]` (87). `PathNode { key; hop; call: Hop | null; members: Hop[] | null; kids: PathNode[] }` (19). Out call + the single inbound it reached merge into one row (`isMergeable`, 49: non-store, no handoff, no gaps, exactly one child that is inbound). **Store leaf calls with identical `shapeKey` under one parent, >= `GROUP_MIN = 3` (15), become one group row** (`members`, key `group-<firstHopId>`), placed at the first member's position (63-85). This is already a naive repeated-call grouping, by exact shape, per parent, store only.
- `visibleRows(nodes, overrides: ReadonlyMap<string, boolean>, headUs: number): VisibleRow[]` (154). `VisibleRow { node; depth; expandable; expanded; summary: string | null; tail: boolean }` (31). Default open: depth 0; any subtree problem (`hasProblem`: not finished, error outcome, fault gap); else not a group and `rowUs >= SLOW_SHARE(0.25) * headUs` (109-114). Groups default **folded** unless a problem. `tail` rows carry unrecorded calls and NoReceiver notes.
- `rowUs(n)` (100) = group sum of durations or caller-side duration. `summaryOf(n)` (121) "3 database calls · 1 call". `expandableKeys(nodes)` (176).
- In the route: `overrides` state per node key (679); `HopRow` (813) draws a group via `groupSpan(members)` (668: first start to last end) with `×N` (841) and note `"N calls · X in all"` (820).

Annotation attach points (layout-safe):
- Request level, one line: a new fact `<span className={fact}>` in Header's facts row (494-502); it wraps (`flex-wrap`), no height risk on desktop. Or a neutral one-line lead above/inside `TimeSplitBar` (it is already "where the time went"; a verdict sentence fits as its first grid row, `md:col-start-2`). Keep it out of `Alert` unless it is a fault.
- Per row: `note` string (820) joined with " · " and shown truncated (842) — append e.g. "repeated ×160" / "could run in parallel"; or a chip like `row.summary` (843, `rounded-full bg-surface-2 text-2xs`) — must use `min-w-0 truncate` to keep the 38 px row and the grid. Phone line at 865 is a `[..].filter(Boolean).join(" · ")` array: add there too.
- Per hop detail: `facts` array in `HopDetail` (874-891), `[label, value]` pairs; push e.g. `["Repeated", "160 times in this request · 412 ms"]`.
- Status Badge tones are `neutral|ok|warn|err` (`Tone`, 158); status colours only for status (PRODUCT.md principle 3), so a "slow" or "N+1" marker should be `warn` at most, or neutral.
- UI rules: card header one row <=48 px (PathCard head is min-h-11 and already crowded: don't add to it on phone); no sideways scroll at 390 px except the legend's own scroller; no explainer paragraph.
- Formatting helpers live in the route and are exported only partly: `export function fmtUs(us: number): string` (99) is exported; `plural`, `fmtGap`, `outLabel`, `statusOf`, `noteOf` are module-private. A new pure module should own its own sentence builders (pattern: `failedCallsSentence` in problems.ts) and the route formats durations with `fmtUs`.

## 5. Request list (routes/requests.tsx + lib/hops/requests.server.ts)

- Row type (requests.server.ts 13-25):
```ts
export interface RequestListRow { traceID: string; service: string; method: string; route: string; path: string | null; status: number | null; durationMs: number; startMs: number; error: boolean; }
```
  One row per **inbound HTTP `in_end` record** (not per request): a request crossing 4 services gives 4 rows, same traceID. Note `durationMs` is ms here (`durationUs/1000`, line 53) and `startMs = timeMs - durationMs`.
- Query: `inboundEndQuery(service, health, onlyFailed)` (32): `{kind="hop"[,service="x"]} |= "in_end" |~ "via\\W{1,6}http"` + optional not-health-check and `LOGQL_FAILED` filters; line filters only narrow, `parseHopRecord` decides.
- `hopRequestPage(tenant, { service, sinceMs, before, health?, onlyFailed?, limit? }): Promise<HopPage>` (76); `PAGE_SIZE = 100` (28); `HopPage { rows; next: number | null }` where `next` = oldest entry ts when the page was full (93-94). Uses `e.ts` (whole ms), not `tsExactMs`.
- Route loader (26-63): range `1h|6h|24h` (`RANGES`, 18), service from `inboundServices(t)` (VictoriaMetrics), health toggle; `?before=` returns `json({kind:"older", page})` for the "Load older requests" fetcher. Main: `defer({ feed, totals })`, `totals = inboundHttpTotals(...)` (VM) for summary tiles and status counts.
- Filters: server side = service, range, health. **Client side, over loaded rows only** = status class, method, route substring or exact `?route=` param, sort (time/status/latency) (182-197). Dedupe key `traceID|service|startMs` (168).
- Cheap per row: anything on the `in_end` record. **`parseHopRecord` already parses `totals` (db_n/db_us/cache_n/cache_us) and `fields` on these records, but `rowsFromRecords` drops them** (48-67). Adding `totals: StoreTotals | null` to the row is free (no extra query) and is the cheap source for a "chatty" flag (db calls per request, db share of duration) on the list. Expensive per row: anything needing the tree (one Loki trace query each, up to 5000 lines) or the outbound records (not in this query). Store totals are per service hop, so a 4-service request has 4 rows each with that service's own totals.
- Other consumer: `_index.tsx` 63 (Overview failed list, `onlyFailed: true, limit: 200`). `lookup.tsx` 59 uses `requestSummary(buildRequestTree(...))`.
- UI note: `requests.tsx` 94 still passes `sub=` to `PageTitle`; `PageTitle` now puts the explainer behind an info icon (components/ui.tsx 70-80), so it is compliant.

## 6. Reusable computations

- `tree.ts`: `buildRequestTree(records, logs, now, links = [], knownPeers = null): RequestTree` (282); `timeSplit(hop: Hop, now: number): TimeSplit` (176, exported, works on **any** hop: run it per inbound hop for per-service splits); `headHop(tree): Hop | null` (430); `faultCount(tree): number` (425); `storeCallCounts(tree): { db: number; cache: number }` (439); `isFailed(hop): boolean` (461); `isStoreVia(via): boolean` (30); `requestSummary(tree): RequestSummary | null` (480; `RequestSummary` 466-478 has traceId, service, method, op, via, status, failed, state, services, durationUs, startMs); `STALL_AFTER_MS = 60_000`; `FAULT_GAPS`. Private but worth exporting rather than copying: `mergeIntervals`, `subtractIntervals`, `lengthUs` (137-166, interval algebra in ms with µs output) and `storeShortfall` (216). For "could run in parallel" you need overlap/sequential detection among siblings: these interval helpers are the right base.
- `pipeline.ts`: `commandCount`, `commandUs` (pipeline-aware call counting).
- `path-rows.ts`: `shapeKey` (private, exact shape), `GROUP_MIN`, `SLOW_SHARE`, `rowUs`, `summaryOf`, `buildPathNodes` (groups already found: a detector can read `PathNode.members`, but it only groups leaf store calls without gaps under one parent, >=3).
- `problems.ts`: `requestProblems(tree): RequestProblems` (40) `{ failedCalls: FailedCalls[]; retried: RetriedJobs | null }`; `callFailed(hop)` (31); destination naming `destinationOf` (private, 35: receiver service else peer/op/via); sentence builders `failedCallsSentence`, `retriedSentence` — the house pattern for verdict text.
- `split.ts`: `splitRequests(records, logs, links): RequestPart[]` (43), `RequestPart { startMs; records; logs; links }`. Every analysis must run per part, never on the raw trace.
- `store-label.ts`: `storeLabel(hop)` ("select merchants" / "get redis.internal"), `statementTail(hop)`, `pipelineOps(hop)`, `hasStatementFields(hop)`, `sharedDatabaseHost(hops)`.
- `paths.ts`: `requestPath`, `routeHint`, `pathTitle`.
- `query.server.ts`: `searchWindow`, `progressiveLookup`, `logLinesFor`, `serviceBySource`; `HopQueryFn` injectable for tests.

## 7. Tests

- Runner: `bun test` (`dashboard/package.json` "test"); `import { describe, expect, test } from "bun:test"`. Typecheck: `bun run typecheck` (`tsc`, `strict: true`). No lint script.
- Tests sit beside the module: `lib/hops/<name>.test.ts`; server modules `<name>.server.test.ts` with injected query fns (`HopQueryFn`).
- Run 2026-11-13 in this worktree: `bun test app/lib/hops` -> 255 pass, 2 fail + 2 errors, all from `Cannot find package 'drizzle-orm'` (peers.server.ts): the worktree has no `node_modules` installed. Pure modules all pass. Run `bun install` in `dashboard/` before relying on the suite.
- No shared fixtures/helpers module: each test file builds its own synthetic requests. Three styles:
  1. **Record builder** (tree.test.ts 1-60): `Spec { id; parent?; svc; via?; method?; op?; peer?; start?; dur?; ... }`, `base(kind, spec, timeMs): HopRecord`, `hop("in"|"out", spec): HopRecord[]` (store hops get the end record only, times in ms from `T0`), `hid(n)` -> 16-hex HopId. `healthy()` = frame-2 POST /orders across 4 services. Note `base` hard-codes `table: null, stmt: null`: an N+1 test needs a `table?`/`stmt?` on `Spec` or its own builder.
  2. **Record builder with overrides** (pipeline.test.ts 20-45): `record(kind, id, parent, timeMs, over: Partial<HopRecord>): HopRecord`, `cache(id, op, endMs, us)`, `request(totals, durMs)`. Best template for repeated db calls: copy `record` and add a `db(id, table, stmt, startMs, us)` helper; build with `buildRequestTree(records, [], NOW)`.
  3. **Real lines through the parser** (problems.test.ts 1-45): `rec(line, ts, service)` = `parseHopRecord({ ts, line, labels: { service } })`, key=value lines like production. Good for end-to-end parse+tree tests.
  4. **Hop literal** (path-rows.test.ts 5-16): `mk(over: Partial<Hop>): Hop` with every field defaulted, `db(table, us)`; for testing pure functions over `Hop`s without the tree (missing `pipeline` default, cast `as Hop`).
- Copy-from example: `lib/hops/problems.test.ts` (`workerJob(calls, failed)` builds a job making N calls; asserts both the structured result and the sentence, `failedCallsSentence(...)` -> "63 of 90 calls to commerce-payments were answered with an error (500)."). Same shape fits "160 calls to `select merchants` ..." for features 1/4.
- Real-shaped fixtures: `qa/fixtures/emitter.ts` (two sample requests, local compose only). Tests quote live trace shapes in comments (pipeline.test.ts header).

## 8. Conventions

- Pure modules: `lib/hops/<name>.ts`, header comment "... Pure." with the ticket id; no Loki/Remix/db imports; may be imported by routes and run in the browser. Anything touching Loki/VM/Postgres is `<name>.server.ts` and takes `Tenant` + injectable client fn.
- Fixed sets: `export const X = { A: "a" } as const; export type X = (typeof X)[keyof typeof X];` plus optional `export const XS: readonly X[] = Object.values(X)` (types.ts 6-13). Shared domain types go in `types.ts`; module-local result types in the module (problems.ts `FailedCalls`, `RequestProblems`).
- Explicit param and return types on every exported function; `readonly` arrays for inputs; `ReadonlyMap`/`ReadonlySet`; `Pick<Hop, ...>` for narrow inputs (problems.ts 31, store-label.ts). No `any`; the only untyped edge is parse.ts.
- Units in names: `...Us` microseconds, `...Ms` epoch/elapsed milliseconds. Exported constants for thresholds with a doc comment (`GROUP_MIN`, `SLOW_SHARE`, `STALL_AFTER_MS`).
- Copy: plain English sentences built in the pure module ("63 of 90 calls to X were answered ..."), no em dashes, units always shown, British spelling ("organisation"). Ticket id in the commit title (`BAC-68 ...`), branch `bac-68-...`.
- Doc comments quote spec/design ids (HOP-19, design 7.3, CP-26, BAC-63).

## 9. Risks and gotchas for analysis over a request's hops

- **Truncation**: `HOP_LIMIT = 5000` lines per window, Loki `direction: "backward"` (loki.server.ts 116): the **newest** 5000 are kept, so a huge request loses its **oldest** records (likely its inbound start record and the early calls). Nothing flags it. An N+1 of 2000 db calls is ~2000 lines alone. A detector should report "at least N" when `records.length` hits the cap; consider exposing a `truncated` flag from `searchWindow` (`entries.length >= HOP_LIMIT`).
- **Record limit (HOP-19)**: adapters stop writing individual store records past a per-request limit; the rest exist only as `unrecorded` counts and µs on the inbound hop (no stmt, no times). N+1 counts from rows undercount; combine with `unrecorded` and say "plus N not recorded one by one".
- **Window split**: the progressive lookup stops at the first window with any record, so a trace spanning the 1 h or 24 h boundary is partial.
- **Several requests per trace**: always analyse a `RequestPart` (split.ts), as the route does.
- **Clock skew**: different services' clocks differ; `alignToParents` (tree.ts 259) shifts a child that starts before its parent and records `skewMs`. Sibling ordering across machines is unreliable; same-service siblings (all store calls of one inbound hop) share one clock and are safe to compare for sequential vs overlapping. Log times are whole ms for some sources (`SLACK_MS = 1` in pipeline.ts, `AFTER_RESPONSE_SLACK_MS = 1`): sub-ms calls can look overlapping or touching. Use a tolerance when deciding "ran one after another".
- **Store start times are derived** (`end - duration`), and ORM queue time inside `duration_us` makes calls appear to overlap or start before the parent (start is clipped then).
- **Missing hops**: missing inbound start -> hop built from end record only; missing end -> Open/Stalled with `durationUs: null` (use `timeSplit`'s `elapsedUs` logic: `now - startMs`). Inbound hops with absent parents become extra roots. Store hops whose inbound hop is missing are roots.
- **afterResponse / handoff** calls are not part of request time: exclude them from "why slow" and parallel analysis (as `timeSplit` does, 183).
- **Plain redis pipelines** (no MULTI) look like N concurrent cache calls: do not flag them as N+1 or "could be parallel" (already parallel) without care; MULTI blocks are already one hop with `pipeline`.
- **Stmt absent** when Query text is off; **stmt shape differs by adapter**; stmt is <=300 bytes so long statements may be cut by the emitter (two different queries sharing a 300-byte prefix would collide).
- **Client cost**: analysis runs in the browser on every `OneRequest` memo; keep it O(n log n) per request. Existing `storeCallCounts` does `tree.hops.find` per store hop (O(n²)); don't copy that pattern, index by `hopId`.
- `tree.hops` excludes pipeline-folded commands; `hop.children` is sorted by start; `tree.split` is for the first inbound hop only.
- Request list rows are per service hop and lack outbound records: request-level flags on the list can use only the row's own `totals` and duration.

## 10. Imports per feature

**1. Repeated-call / N+1 (BAC-68)** — new pure `lib/hops/repeated.ts` (+ optional stmt normaliser in `stmt.ts`).
- types: `Hop`, `RequestTree`, `HopDir`, `Via`, `StoreKind`, `UnrecordedStoreCalls`, `HopId`.
- `buildRequestTree`, `isStoreVia` (tree.ts); `commandCount`, `commandUs` (pipeline.ts); `storeLabel`, `hasStatementFields` (store-label.ts); `GROUP_MIN` and ideally export `shapeKey` from path-rows.ts so the Path group and the detector agree on "same shape"; `splitRequests` (route already does it).
- Test style: pipeline.test.ts `record()` builder or problems.test.ts real lines.

**3. Why was this slow (BAC-70)** — new pure `lib/hops/verdict.ts`.
- `timeSplit`, `headHop`, `storeCallCounts`, `isFailed` (tree.ts); `TimeSplit`, `RequestTree`, `Hop`, `HopDir`, `Via`, `HopState`, `GapKind` (types.ts); `requestProblems`, `callFailed` (problems.ts); `rowUs`, `SLOW_SHARE` (path-rows.ts) for "a single call took X% of it"; feature 1's repeated groups; `storeLabel` for naming the culprit. Duration formatting stays in the route (`fmtUs`), or move `fmtUs` to a pure lib file if the verdict builds full sentences (route currently exports it from the route module, which a lib must not import).

**4. Chatty / could-run-in-parallel (BAC-71)** — new pure `lib/hops/concurrency.ts`.
- `Hop`, `HopDir`, `Via`, `TimeSplit` (dbSumUs vs dbUs shows overlap already); export `mergeIntervals`/`subtractIntervals`/`lengthUs` from tree.ts instead of copying; `timeSplit`; `isStoreVia`; `commandCount`; for the list flag, `StoreTotals` + extend `RequestListRow` in requests.server.ts / `rowsFromRecords` with `totals` (already parsed).

**8. Request diff (BAC-75)** — needs two trees of the same route.
- Server: `searchWindow`/`progressiveLookup`, `logLinesFor` (query.server.ts) once per trace; `hopRequestPage` / `inboundEndQuery` with an exact route to find a fast sibling (route filter is client side today: a LogQL `op` filter would be new; `isLabelValue`/`promString` in metrics.server.ts for escaping); `RequestListRow`.
- Pure: `splitRequests`, `buildRequestTree`, `headHop`, `timeSplit`, `storeCallCounts`, `requestSummary`/`RequestSummary`; `buildPathNodes` + `PathNode` (align rows by `shapeKey`/`storeLabel`/service+op rather than hopId, which differs per request); `storeLabel`, `requestPath`, `routeHint`.

DONE
