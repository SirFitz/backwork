# 01 N+1 and repeated-call detector (BAC-68)

Wave 1. Depends on: foundation. Feeds: 3, 4, 7, 8.

## Goal
Inside one request, flag the same database query or cache command issued many times, say whether it ran one after another (the N+1 shape) or together, say what it cost, and mark it on the Path view. Across requests, list the worst offenders on **Insights > Repeated calls**.

Example, from the live `GET /shop` trace: 8 selects, 7 Redis `set` calls (2.10 s) and 4 `multi` calls (828 ms) inside one request. After this feature the request says "set redis ran 7 times, one after another, 2.10 s in all".

## What exists (notes A)
- Store calls are `Hop`s with `isStore`, one `out_end` record each, `table` and `stmt` for `via=db`, `op` and `peer` for cache. No normalisation exists (`stmt.ts`); the only "same shape" test is the private exact-string `shapeKey` in `path-rows.ts`, which already folds 3 or more identical store calls under one parent into a "xN" row.
- Calls past the per-request record limit (HOP-19) survive only as `unrecorded` counts and totals on the inbound hop.
- MULTI blocks are already one hop (`pipeline.ts`); plain pipelines are not marked.
- The tree is built in the browser; analysis must be pure and cheap.

## Design

### Pure module `lib/hops/repeated.ts`
```ts
export const Repetition = { Sequential: "sequential", Concurrent: "concurrent", Batched: "batched" } as const;
export type Repetition = (typeof Repetition)[keyof typeof Repetition];

export interface RepeatGroup {
  key: string;                 // `${parentHopId}|${shapeKey}`
  parentHopId: HopId;
  service: string;
  kind: StoreKind;             // Db | Cache
  label: string;               // "select plans", "set redis.internal"
  table: string | null;
  shape: string | null;        // statementShape(stmt); null when Query text is off or cache
  peer: string | null;
  op: string | null;
  count: number;
  totalUs: number;             // sum of the calls' durations
  wastedUs: number;            // totalUs minus the first call (what batching could save), clamped at 0
  repetition: Repetition;
  hopIds: HopId[];
  atLeast: boolean;            // true when the fetch was truncated or unrecorded calls exist for this parent
  statementKnown: boolean;     // false: grouped by (peer, op, table) because stmt was absent
}

export interface RepeatReport { groups: RepeatGroup[]; repeatedCalls: number; wastedUs: number; truncated: boolean; }

export function detectRepeats(tree: RequestTree, truncated: boolean): RepeatReport;
export function repeatSentence(g: RepeatGroup): string;   // plain English, uses fmtUs
export function repeatHint(g: RepeatGroup): string | null; // only for sequential db groups
```

### Algorithm
1. For each inbound hop, take its direct store children that are not `afterResponse` or `handoff` (they are not request time).
2. Key = `kind | peer | table | shape` for db (shape from `statementShape(stmt)`; when `stmt` is null the key uses `op`, and `statementKnown` is false); `kind | peer | op` for cache.
3. A group qualifies at `REPEAT_MIN_DB = 5` or `REPEAT_MIN_CACHE = 10` calls. (The Path view still folds from 3; qualifying is stricter so the badge is a finding, not noise.)
4. **Repetition**: sort by start; calls are *sequential* when at least 80 percent of consecutive pairs satisfy `next.start >= prev.end - SLACK_MS` (`SLACK_MS = 1`), *concurrent* when most calls overlap another. A cache group of at least 5 calls whose starts all fall within `BATCH_WINDOW_MS = 2` of each other, on one client, is `Batched` (a plain pipeline) and is **not** reported.
5. `wastedUs = totalUs - firstCallUs` for sequential, `totalUs - maxCallUs` for concurrent.
6. `atLeast` when `truncated`, or when the inbound hop's `unrecorded` store shortfall is above zero.
7. Groups sorted by `wastedUs` descending; `repeatedCalls` = sum of counts; MULTI pipeline hops count as one call each (`commandCount` is for display only).

Copy (via `repeatSentence`): "select plans ran 14 times, one after another, 62 ms in all." / "set redis.internal ran 7 times, one after another, 2.10 s in all." / "get redis.internal ran 12 times together (about 3 ms each)." With `atLeast`: "at least 14 times". Hint for a sequential db group: "Fetch them together with one query that takes a list of IDs." For cache sequential: "Use one multi-key command or a pipeline." Hints are suggestions, labelled as such in the detail row.

### Path view grouping
`path-rows.ts` `shapeKey` switches to `statementShape` so the folded group and the detector agree. `GROUP_MIN` stays 3 for folding.

### Insights > Repeated calls (cross-request list)
`lib/hops/repeats.server.ts`: `scanRepeats(tenant, windowMs, read: RecordQueryFn = loki.queryRange, now = Date.now()): Promise<RepeatScan>`:
- one Loki log query for `out_end` `via=db` records in the last 15 minutes (`RECORD_LIMIT = 3000`, the same bound the Overview attention scans use), parsed with `parseHopRecord`;
- group by `(trace_id, parent_hop, service, shape)` in TypeScript; keep groups with `count >= REPEAT_MIN_DB`; aggregate by `(service, table, shape)`: requests affected, typical repeat count (median), total time, plus the most recent trace id as an example link;
- `RepeatScan { rows: RepeatRow[]; recordsRead: number; truncated: boolean; windowMs: number }`; `truncated` shown as "sampled: the last N records".
- cached with `cachedStale("repeats:<org>", 30 s, 5 min)`.
Route `routes/insights.repeats.tsx` (flips the tab on): table columns Query, Service, Repeats per request (median), Requests, Time wasted, Example (link to the request). Empty: "No repeated queries in the last 15 minutes." Statements off: "Query text is switched off for this organisation, so repeats cannot be matched. Cache repeats are still shown inside each request."

## UI on the request view
- Header facts row: one fact "N repeated calls" (hidden when 0), linking to the first group (scroll and expand).
- Path rows: a neutral chip on a group row or a repeated-call row, "N+1" for sequential db groups of 5 or more, "repeated" otherwise; row note appended with " · repeated 14 times"; `HopDetail` facts gain `["Repeated", sentence]` and `["Suggestion", hint]`.
- Nothing is added to the red `Alert` box.
- Phone: chip goes into the existing note line (865), no new row height.

## Files
New: `lib/hops/repeated.ts`, `repeated.test.ts`, `lib/hops/repeats.server.ts`, `repeats.server.test.ts`, `routes/insights.repeats.tsx`, `components/insights/repeat-chip.tsx`. Changed: `lib/hops/path-rows.ts` (+ its test), `routes/requests_.$id.tsx` (mount only: facts fact, chip, detail rows), `routes/insights.tsx` (flip tab).

## Tests
- Pure: 14 sequential identical selects give one `Sequential` group with `wastedUs` = total minus first; same 14 started together are `Concurrent`; 12 cache gets within 1 ms are `Batched` and absent; 4 repeats (below the minimum) are absent; different tables never merge; whitespace and `IN` list variants merge; `stmt` null groups by `(peer, op, table)` with `statementKnown` false; a store call under a `handoff` is ignored; `atLeast` true with truncation and with an unrecorded shortfall; the live-shaped `/shop` request (7 sets, 4 multis) reports the set group; sentence and hint strings for each case; large tree (5000 hops) finishes in well under 100 ms.
- Server: `scanRepeats` with an injected `RecordQueryFn` returning kv and json lines; truncation flag; grouping by trace; median; cache called twice reads once.
- Path-rows tests updated for the shared shape.

## Verification
Local stack with the insights scenario: `GET /shop` shows the N+1 chip, header fact and detail row; the 12-get pipeline shows nothing; `/insights/repeats` lists `select plans` with about 14 repeats per request; statements switched off shows the degraded text; 1440 and 390 screenshots; rows keep their 38 px height. Live: open a real request that repeats and check the figure against its Path rows by hand.

## Risks
Different adapters emit different text for one query, so a cross-adapter merge may under-count (documented, not solved). Calls beyond the record limit are invisible to detail but counted in `atLeast`. The chip must not make the Path card header taller on a phone.

## Out of scope
Fixing the query for the user; suggesting an index (that is feature 2's detail panel at most).

## As built (deviations settled in the BAC-68 PR)
- **Cache minimum.** Cache calls that ran one after another qualify from 5 (`REPEAT_MIN_CACHE_SEQUENTIAL`); cache calls that ran together still need `REPEAT_MIN_CACHE = 10`. With 10 for both, the live `/shop` example above (7 sequential `set` calls, 2.10 s) would never be reported, although each of those calls waited a round trip.
- **Sequential, robustly.** Besides the 80 percent pair rule, a group is sequential when on average at most `SEQUENTIAL_MAX_IN_FLIGHT = 1.5` calls were in flight (summed durations over first start to last end); otherwise concurrent. Stored lines are written in bursts: in the fixture's real `GET /shop` records, 5 of the 13 pairs of plans lookups end a few microseconds apart and look overlapped, so the pair rule alone read the N+1 as "together". Over the group, 14 calls of about 1.1 ms spread over 13 ms.
- **`atLeast`** uses the shortfall of the group's own store kind (a cache shortfall does not make a database count a floor).
- **Shape key** is one exported function, `callShapeKey`, in `repeated.ts`: host, table and statement shape (or command when the statement is absent) for the database; host and command (and MULTI commands) for the cache. `path-rows.ts` folds by it, so the same statement to two database hosts is now two rows.
- `repeatHint` gives a suggestion for sequential cache groups too ("Use one multi-key command or a pipeline."), as the copy section says; null for concurrent groups.
- Not-recorded statements: the sentence ends "(matched by command and table: the query text was not recorded)".
- `path-rows.ts` gains `pathKeysTo(nodes, hopId)` so the header fact can open and scroll to the first group.
