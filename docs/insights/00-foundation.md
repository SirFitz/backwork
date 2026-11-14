# 00 Foundation (BAC-67)

Wave 0. One PR that holds every edit to a shared hotspot file, so the twelve features can be built in parallel without conflicts. Nothing here is user-visible except an empty **Insights** nav item with its tab strip.

## Contents

### Pure helpers (client-safe, with tests)
| File | What |
|---|---|
| `dashboard/app/lib/hops/stmt-shape.ts` (new) | `statementShape(stmt: string): string`: lowercase, collapse whitespace, `in (?, ?, ...)` and `values (?, ?)` lists to one `?`, bare numbers to `?`, strip a trailing `;`. `shapeId(shape: string): string`: 8-hex FNV-1a, stable across client and server, for URLs and alert targets. `shapeLabel(shape, maxChars)`: head cut at a word boundary. |
| `lib/hops/tree.ts` | Export `mergeIntervals`, `subtractIntervals`, `lengthUs` (used by feature 4) and index store calls by hop id in `storeCallCounts` (the existing `find` per hop is O(n squared)). |
| `lib/hops/time-format.ts` (new) | Move `fmtUs` (and a `plural` helper) out of the request route so pure modules can build sentences with it; the route re-exports it. |
| `lib/hops/path-rows.ts` | Export `GROUP_MIN`, `SLOW_SHARE`, `rowUs`. (The grouping change itself belongs to feature 1.) |

### Server helpers
| File | What |
|---|---|
| `lib/cache.server.ts` | `cachedStale<T>(key, freshMs, maxStaleMs, fn): Promise<T>`: fresh value returned as is; stale value returned at once while one background refresh runs; nothing stored yet awaits the first compute; rejections never cached. Same key rules as `cached`. |
| `lib/loki.server.ts` | `metricInstant(query, window: {start, end}, tenant, timeoutMs = 25_000): Promise<Array<{ metric: Record<string, string>; value: number }>>` using `query_range` with `step = end - start` and no retry; the existing 12 s client is too short for statement aggregates. |
| `lib/hops/query.server.ts` | `WindowResult.truncated: boolean` (true when a window returned `HOP_LIMIT` lines); the request view shows "at least" through it. |
| `lib/hops/requests.server.ts` | `RequestListRow.totals: StoreTotals \| null` (already parsed from the `in_end` record, currently dropped). |
| `lib/hops/metrics.server.ts` | `offset: string \| null` parameter on `rateQuery`, `errorRateQueries`, `quantileQuery`; `lookbackSeconds` parameter on `windowIncrease` / `windowPerSecond` (default 7 days) so an offset window can use a shorter lookback; an exported all-routes scope `allRoutesScope(health)`; `windowQueries(window, offset, by)` generalised out of `attention.server.ts`. Existing call sites unchanged (defaults preserve today's strings; tests assert it). |

### Database
All seven tables, in both the `DDL` string in `db/index.server.ts` and `db/schema.ts`, with `org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE` and an `_org_idx`:

| Table | Columns | Used by |
|---|---|---|
| `deploys` | `id text PK`, `org_id`, `project_id text REFERENCES projects ON DELETE SET NULL`, `service`, `version`, `commit_sha`, `environment`, `url`, `actor`, `deployed_at timestamptz`, `created_at`; index `(org_id, service, deployed_at DESC)` | 6, 7, 10 |
| `alert_state` | `(org_id, rule_id)` PK, `firing boolean`, `value double precision`, `since timestamptz`, `last_notified_at timestamptz`, `pending_since timestamptz` | 5 |
| `alert_events` | `id text PK`, `org_id`, `rule_id`, `kind text` (firing or resolved), `value`, `at`, `delivered jsonb` | 5, 10 |
| `digest_settings` | `org_id PK`, `enabled`, `channel_ids jsonb`, `email_roles text`, `weekday smallint`, `hour_utc smallint`, `updated_by`, `updated_at` | 10 |
| `digest_runs` | `(org_id, period_start date)` PK, `claimed_at`, `sent_at`, `error`, `attempts smallint NOT NULL DEFAULT 0` | 10 |
| `pinned_requests` | `(org_id, trace_id)` PK, `title`, `note`, `reason text` (manual, slow or failed), `records jsonb`, `lines jsonb`, `links jsonb`, `bytes integer`, `pinned_by text REFERENCES users ON DELETE SET NULL`, `pinned_at` | 11 |
| `pin_settings` | `org_id` PK, `auto_slow boolean NOT NULL DEFAULT false`, `auto_failed boolean NOT NULL DEFAULT false`, `updated_by`, `updated_at` | 11 |

A database test creates a fresh database, runs `ensureSchema`, and proves all seven exist (this also guards the BAC-66 class of defect: every table must be in the DDL string). Also restores `org_billing` and `billing_events` if BAC-66 has not landed first (coordinate: if BAC-66 is merged, nothing to do).

### Jobs
`lib/jobs.server.ts`: `startBackgroundJobs()` with one `globalThis` guard, starting the alert evaluator, plan jobs and (later) the digest from one place; called from the root loader and the ingest push route (replaces the two lazy starts). Timers `.unref()`ed.

### UI shell
- `routes/insights.tsx`: layout with a one-row tab strip (Fix first, Slow queries, Repeated calls, Service map) using `NavLink`, `<Outlet />`; tabs for features not built yet are hidden until their route exists (a `INSIGHT_TABS` const with a `ready` flag the feature PR flips).
- `routes/insights._index.tsx`: placeholder "Nothing to rank yet." (feature 7 replaces it).
- `root.tsx` NAV: `{ to: "/insights", label: "Insights", icon: Lightbulb }` at index 4.
- Org menu dropdown moved to the top layer (UI_ISSUES 2; it is an existing defect found by note C and the new nav touches that file): copy the `popover="manual"` pattern from `FindRequest`.

### Fixtures
`qa/fixtures/emitter.ts` gains an **insights scenario** (env `SCENARIO=insights`, one more fixture service `shop-api`):
- `GET /shop` loop: 1 request that issues `select plans where plans.number = ?` 14 times one after another, plus 8 distinct selects (the N+1).
- `GET /orders/:id`: a slow query shape (`select ... from orders where customer_id = ? order by created_at desc`) taking 180 to 420 ms, and 3 independent cache gets run one after another that could be concurrent.
- A plain Redis pipeline of 12 gets (must not be flagged).
- `POST /checkout`: two sequential outbound HTTP calls to two different services that do not depend on each other.
- A `regression` mode: after a trigger file appears, `GET /shop` gets 2x slower (to give regression and alert features something to find), plus a `deploy.sh` helper that posts to the deploy endpoint when it exists.
Formats mix json, kv and nested json as the existing emitters do. A README section in `qa/README.md` says how to run it.

## Tests
- `stmt-shape.test.ts`: lists collapse, numbers, whitespace, case, trailing `;`, adapter variants of one query give one shape, two different tables never merge, id stability.
- `cache.server.test.ts`: fresh hit, stale served while refresh runs, one refresh for concurrent callers, rejection not cached, first call awaits.
- metrics builders: default-offset strings unchanged (snapshot against current tests); `offset 7d` with `lookbackSeconds` yields the expected selector.
- DDL fresh-database test (opt-in DB test).
- `bun run typecheck` and `bun test` exit codes reported.

## Verification
Local stack up with `SCENARIO=insights`; Insights item present on desktop and in the phone More menu; tab strip and placeholder render; nothing else changed visually (screenshots of Overview and Requests before and after at 1440 and 390).

## Out of scope
Any feature behaviour. Foundation adds capability only.

## As built (deviations and details settled in the foundation PR)
- `path-rows.ts`: `GROUP_MIN`, `SLOW_SHARE` and `rowUs` were already exported on main; nothing changed there.
- `statementShape` also turns string literals and numbered placeholders (`$1`) into `?`, drops identifier quotes and makes spacing around brackets, commas and comparison operators uniform, so the `pg`, Prisma, MySQL and hand-written spellings of one query share a shape. Column lists are kept (an Ecto `select ... from` and a full column list stay two shapes).
- `cachedStale` takes an optional trailing clock (`now`) for tests; `invalidateStale(key)` is its `invalidate`.
- `metricInstant` takes an optional trailing `fetcher` for tests.
- The offset builders take both `offset` and `lookbackSeconds` as trailing defaulted parameters (`quantileQuery` after its existing `window`), so a caller can shorten the lookback for an offset window. The generalised `windowQueries(window, offset, by, health = Hidden, lookbackSeconds)` lives in `metrics.server.ts` with a `WindowQueries` type; the Overview's `windowQueries(offset)` in `attention.server.ts` keeps its signature and delegates. A snapshot of main's builder output (`lib/hops/query-defaults.snapshot.json`) proves the defaults are unchanged.
- Tables: a separate `<table>_org_idx` is added only where `org_id` is not the leading primary key column (`deploys`, `alert_events`); for the other five the primary key index already starts with `org_id`. Extra indexes for the reads the plans describe: `alert_events (org_id, rule_id, at DESC)` (last events per rule) and `pinned_requests (org_id, pinned_at DESC)` (pinned list). Defaults: `digest_settings` weekday 1 (Monday), hour 8 UTC, disabled, `channel_ids '[]'`; `pinned_requests.lines` and `links` default `'[]'`. The value sets of `alert_events.kind` and `pinned_requests.reason` stay with features 5 and 11.
- The DDL test (`db/ddl.server.test.ts`) checks every table and column declared in `schema.ts` against the database, not only the seven, so a table typed in `schema.ts` but missing from the DDL fails it. BAC-66 was still open on main, so `org_billing` and `billing_events` are restored here as they were in 1790524.
