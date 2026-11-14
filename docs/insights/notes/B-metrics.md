# B. Figures, performance and the Overview (notes for features 2, 5, 6, 7, 12)

Repo: /Users/romario/projects/inkress/backwork-wt/insights. Paths below are relative to it; `lib/` = `dashboard/app/lib/`, `routes/` = `dashboard/app/routes/`.

## 1. Metrics Vector produces from hop records

Source of truth: `lib/agent/vector-config.server.ts` (generates `infra/vector/vector.yaml`; a test fails when stale; regenerate with `cd dashboard && bun ../infra/vector/generate.ts`).

Names (`vector-config.server.ts:37-42`, duplicated as `HopMetric` in `lib/hops/metrics.server.ts:41-46`):

| Metric | Vector type | Prom series | Field | Route (`bw_hop_route`, :451-457) |
|---|---|---|---|---|
| `backwork_hop_duration_seconds` | histogram | `_bucket{le}`, `_sum`, `_count` | `bw_m.duration_s` (= `duration_us`/1e6) | `ends`: `in_end`/`out_end` with a duration |
| `backwork_hop_started_total` | counter (+1 per record) | as is | `bw_hk` | `starts`: `in`/`out` |
| `backwork_hop_store_seconds_total` | counter, `increment_by_value` | as is, `store="db"` and `store="cache"` | `db_s` / `cache_s` (`db_us`/`cache_us` /1e6) | `stores`: `in_end` only, and Stores switch on |
| `backwork_hop_store_calls_total` | counter, `increment_by_value` | as is, `store="db"` / `"cache"` | `db_n` / `cache_n` | same |

Labels per metric (`TAGS`, :422-427), all read from the parsed hop (`METRIC_PREP_VRL`, :181-202):
- duration: `service, dir, via, method, op, peer, outcome, status_class`
- started: `service, dir, via, op`
- store: `service, via, method, op` + static `store` (`db`|`cache`)
- Added at ingest (agent path only): `org_id`, `project` via VM `extra_label` (`routes/ingest.metrics.api.v1.write.tsx:26-29`). Stack collector series (platform org) have neither. Scraped stack series also get `job`, `instance`, `monitor="backwork"` (external label).
- Values: `dir` = `in`|`out` (from hop kind prefix); `status_class` = `2xx|3xx|4xx|5xx|""` from `status`; `outcome`, `via`, `method`, `op`, `peer` raw from the record, kept only if they match `^[\x21-\x7e]{1,200}$` else `""` (`labelVrl`, :173-178; same rule `isLabelValue` in metrics.server.ts:59).
- Note store counters are per INBOUND request totals (`db_us`, `db_n`, `cache_us`, `cache_n` on `in_end`), labelled with the inbound route's `method`/`op`. There is no per-call store metric; outbound `via=db|cache` hops (individual queries) only feed `backwork_hop_duration_seconds{dir="out",via="db"|"cache",peer=...}`.

Buckets (seconds), `HOP_BUCKETS` :32: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900]` (16 + `+Inf`). Set on the sink (`buckets:` in `prometheus` exporter :580 and `hop_metrics` remote write :655). p95 resolution is coarse: between 0.1 and 0.25 and between 0.25 and 0.5 VM interpolates linearly.

Cardinality guard: `bw_hop_cardinality` `tag_cardinality_limit`, `mode: exact`, `value_limit: 2000` (`LABEL_VALUE_LIMIT` :35), `limit_exceeded_action: drop_tag` (:488-493). Per label, per collector process, not per org. Past 2000 distinct values the tag is dropped (series merges into an unlabelled one), not the event.

High-cardinality labels: `op` (route/path/job name; whatever the service records, may contain raw paths if the service does not template them) and `peer` (hosts, queue names, db names). `service`, `method`, `via`, `outcome`, `status_class`, `dir`, `store` are low. Histogram multiplies: 17 `le` x labels.

Delivery / interval:
- Stack collector: `prometheus_exporter` on `0.0.0.0:9598`, `flush_period_secs: 900` (idle series kept 15 min) (:576-582); VM scrapes `vector:9598` every `scrape_interval: 15s` (`infra/victoriametrics/scrape.yml:4`), `honor_labels: true`.
- Agent: `prometheus_remote_write` to `__ENDPOINT__/metrics/api/v1/write?kind=hop` (:645-655), Vector default batching (about 1 s). Counters appear only while records arrive: bursts then silence (see `counter-window.ts` header).
- VM retention `-retentionPeriod=14d` (`docker-compose.yaml:32`), image `victoriametrics/victoria-metrics:v1.106.1`.

`stmt` / `table`: NOT a label or metric dimension anywhere. They exist only inside the stored Loki line. VRL touches them only in `bw_detect` (kv `stmt=` split, :134-151) and `bw_controls` (dropped when the Statements switch is off, :292, :300, :312-315). `METRIC_PREP_VRL` never reads them.

## 2. PromQL builders, tenant scoping, caching, cost

### Builders (`lib/hops/metrics.server.ts`, all pure and exported)
- `type Scope = { by: readonly string[]; where: Record<string,string>; health: HealthChecks }` (:105-112). Presets: `servicesScope(health)` by `["service"]` (:114); `routesScope(service, health)` by `["service","method","op"]`, where `{service}` (:118); `connectionsScope()` by `["service","peer","via"]`, health Shown (:122).
- `selector(metric, matchers, raw)` (:88, private) builds `m{k="v",...raw}`; values via `promString` (:70, escapes `\` and `"`); callers must gate user values with `isLabelValue` (:59).
- `rateQuery(dir: "in"|"out", scope, range): string` (:131) = `windowPerSecond(<dur>_count{dir,...}, range, by)`.
- `errorRateQueries(dir, scope, range): [string, string]` (:140): A = `outcome="error"`, B = `outcome!="error",status_class="5xx"`; disjoint, summed in code (never PromQL `or`/`+`).
- `quantileQuery(q: Quantile, dir, scope, range, window?)` (:155) = `histogram_quantile(q, windowIncrease(<dur>_bucket{...}, window ?? range, [...by, "le"]))`.
- `storeShareQuery(scope, range)` (:161) = increase(store_seconds) / increase(duration_sum{dir="in"}); `storeCallsPerRequestQuery` (:170) = increase(store_calls) / increase(duration_count{dir="in"}). Both sum `store="db"` and `"cache"` together (no `store` in `by`).
- `inProgressQuery(health)` (:180): `clamp_min(started - finished, 0) or started` over `IN_PROGRESS_WINDOW = "15m"`.
- `trendQuery(range, health)` (:193): p95 by service, inner window = `trendStep(range)` = `max(60, floor(rangeSeconds/12))s` (`TREND_POINTS = 12`, :30), run as a range query with that step.
- `viaRateQuery` (:198), `httpTotalsQuery(range: string, service, health)` (:468, by `status_class, outcome`), `httpP95Query` (:473), `inboundServicesQuery()` (:511) = `count by (service) (last_over_time(backwork_hop_started_total{dir="in"}[14d]))`.
- Health: `PROM_NOT_HEALTH_CHECK = op!~"(?i)/(?:healthz|health|ready|live|livez|readyz|ping)"` (`lib/hops/health.ts:42`), added to `dir!="out"` selectors when `HealthChecks.Hidden` (`healthMatchers`, :84).
- Enums: `HopMetric` (:41), `Quantile = {P50:0.5,P95:0.95,P99:0.99}` (:50), `PerfRange`/`PERF_RANGES`/`DEFAULT_RANGE` and `PeerKind` (pure, `lib/hops/figures.ts`), `HealthChecks` (`health.ts:17`).

### Windows: never `rate()` (`lib/hops/counter-window.ts`)
- `windowIncrease(selector, window, labels, offset: string | null = null): string` (:36) = `clamp_min((sum by(L)(increase(sel[w+LB s] offset o)) - sum by(L)(increase(sel[LB s] offset o+w))) or <first>, 0)`, `COUNTER_LOOKBACK_SECONDS = 7*86400` (:17). Reason: bursty counters with long silences make bare `increase()` extrapolate wrongly.
- `windowPerSecond(sel, window, labels)` (:48) = windowIncrease / `windowSeconds(window)`. `windowSeconds("15m")` parses `\d+[smhdw]` (:22).
- `offset` already exists and is used by the Overview baseline. Every query scans `window + 7d` of samples: a 7d range scans 14d (the whole VM retention). An offset of 7d (last week) makes the lookback reach `7d + w + 7d` > 14d retention: the "before" term finds nothing and falls back to the first term alone (`or`), i.e. the old extrapolation problem returns for last-week windows unless the lookback is shortened for them (feature 6: pass a smaller lookback, e.g. 6d, or add a `lookbackSeconds` param).
- `windowOf(range)` (:93) returns the range string itself (`"1h"|"6h"|"24h"|"7d"`); quantiles are over the whole range, not a rate window.

### Result reading
- `PromClient { instant(query, tenant?): Promise<Array<{metric: Record<string,string>; value: number}>>; range(query, {start,end,step}, tenant?): Promise<vm.Series[]> }` (:243); default `vmClient` (:248). Every table function takes `client: PromClient = vmClient` for injection.
- `combineFigures(labels, {rate, errA, errB, p50, p95, p99})` (:282) joins by label key, drops `rate <= 0`, `errorShare = min(1, failed/rate)`.
- Private `figuresFor(client, dir, scope, range, tenant)` (:312) = 6 instant queries in parallel. Exported tables: `servicesTable(range, tenant, client?, now?, health?) : Promise<ServiceRow[]>` (:340, busiest first), `routesTable(service, range, tenant, client?, health?) : Promise<RouteRow[]>` (:391, p95 desc), `connectionsTable(range, tenant, knownServices, selected, client?)` (:428), `inboundHttpTotals(range: string, service, tenant, client?, health?)` (:479), `inboundServices(tenant, client?)` (:515), `defaultService(rows)` (:452), `peerKindOf` (:419), `sortConnections` (:446).
- Row types: `Figures {rate; errorShare; p50|p95|p99: number|null}` (:204), `ServiceRow` (+ `storeShare, storeCallsPerRequest, inProgress, trend: number[], mainVia`) (:215), `RouteRow {service, method, op, storeShare}` (:227), `ConnectionRow {service, peer, via, peerKind}` (:235).
- There is NO cross-service routes query today: `routesTable` is per service (`where {service}`). A fix-first or alerts list over all routes needs `{ by: ["service","method","op"], where: {}, health }` (a Scope literal works with the same builders).

### Tenant scope (`lib/vm.server.ts`)
- `applyScope` (:21-29): non-platform adds `extra_filters[]={org_id="<id>"}` (VM applies it to every selector); always `nocache=1` (VM rollup cache gave wrong increase() on bursty counters). `instant(query, time?, tenant?)` (:32; `time` ms, sent as seconds), `range(query, {start?, end?, step?}, tenant?)` (:49; default last 1h, step 30s), `scalar` (:41). `fetchJson` default timeout 15 s, 1 retry after 300 ms (`lib/config.server.ts:29,46`).
- `type Tenant = { orgId: string; platform: boolean }`, `tenantOf(orgId)` (`lib/tenant.server.ts:10,16`). Loki equivalent: `scoped()` injects `org_id` into every `{...}` (`lib/loki.server.ts:12`).

### Cache (`lib/cache.server.ts`)
- `cached<T>(key, ttlMs, fn): Promise<T>` (:10): in-process Map, caches the in-flight promise (coalesces concurrent callers), drops rejections; `invalidate(key)` (:24). No size bound, no eviction except overwrite (keys include selection, so a new key per service/range/health).
- Keys/TTLs: perf tables `perf:<org|platform>:<range>:<table>:<selection>:<health>` 10 s (`TTL_MS`, metrics.server.ts:331-335); `inboundServices` 30 s; attention `attention:<org>:{jumps|inbound|outbound}` 10 s (attention.server.ts:126-127); Overview log volume `ov:logvol:<org>` 12 s; `vm:targets` 20 s.
- Not stale-while-revalidate: after 10 s the next caller waits for the full refresh.

### Query cost today (counted from the code)
- `servicesTable`: 6 (figuresFor) + 5 = 10 instant queries + 1 range query (12 points). Each `windowIncrease` is 2 `increase()` subqueries, so a p95 over `_bucket` touches every bucket series (17 per label set) over `range + 7d`.
- `routesTable`: 6 + 1 = 7 instant. `connectionsTable`: 6 instant. Performance page total: about 23 instant + 1 range, all fired in parallel per load (services first, routes and connections wait for `selectedP`).
- Overview: `servicesTable(1h)` (11, shared via cache with Performance at 1h), `serviceJumps` 8 instant (4 for 15m, 4 for 3h offset 15m), `inboundServices` 1, plus Loki: two hop record scans (limit 3000 each), failed requests (limit 200 over 24h), log volume (1 metric query).
- Not measured on real data here: the local stack (`bwoc-*`, VM :8428, Loki :3100) has no hop series at the moment. VM data is small (design says so; `vm.server.ts:26` "a few milliseconds per query"). The dominant cost is the 7-day lookback per window: series count x 17 buckets x (7d + window) of 15 s samples.

## 3. Performance page, Overview, attention baselines

### `routes/performance.tsx`
- Loader (:34-62): `requireOrg` -> `tenantOf`; `parseRange(?range)` (default `6h`), `?service` (gated by `isLabelValue`), `?health=1` (`HEALTH_PARAM`). Three deferred panels, each `safe(...)` -> `{data, error}`: `services` (servicesTable), `routes` (routesTable of `?service` or `defaultService` = highest error share then slowest p95), `connections` (connectionsTable, selected rows first). `defer({ range, requested, health, services, routes, connections })`.
- UI: `PageTitle title="Performance"` with `sub` (rendered as an InfoTip, not a paragraph: `components/ui.tsx:76-94`), right = health toggle + range (select on phone, segmented links from `sm`). Cards: Services (`ServicesTable`, `components/services-table.tsx:66`, inline `Sparkline` of `trend`), then a 2-column grid (`lg`) of Routes (Route, Req/s, Errors, p95, p99 `sm+`, DB + cache share; row links to `/requests?service&range&method&route`) and Connections (From/to, Calls/s, Errors, p95). Each card: `<Deferred resolve fallback={CardHead + RowsSkeleton}>`; `PanelBody` shows `ErrorNote` or `Empty`.
- No time-series chart on Performance today; only 12-point sparklines. Charts exist in `components/charts.tsx` (`TimeSeries({series, height, unit, fmt})` :84, `AreaSeries` :105, recharts, lazy-loaded on Overview :11). No reference-line / marker support yet (feature 6 must add it).
- Tones: `errorTone(share)` warn >= 1%, err >= 5%; `latencyTone(seconds, waitedOn)` warn >= 1 s for HTTP/RPC only (`services-table.tsx:28-37`).

### `routes/_index.tsx` (Overview)
- Loader (:43-76): `reporting` (inboundServices count), `attention = Promise.all([jumps, stalled, unreceived])` created in the loader (never in render: a render-time promise re-suspends forever, :56-60), `services = servicesTable(PerfRange.H1, t)`, `failed` (hopRequestPage onlyFailed, 24 h, limit 200, first 10), `logVolume` (Loki count_over_time 1m, step 120s, cached 12 s).
- Cards in order: onboarding banner (no services), "Needs attention" (one-row CardHead with "all clear"/"N to look at"; groups shown only when non-empty, then one "Also clear:" line, BAC-53), "Services" (compact table, last hour), "Latest failed requests", "Log volume" (AreaSeries).
- `AttentionGroup` enum (:237) + `CLEAR_TEXT` (:245): a new attention group (e.g. regressions vs last week, firing slowness alerts) slots in here with its own SubHead and body.

### Baselines (`lib/hops/attention.server.ts`)
- Current window `WINDOW = "15m"` (`ATTENTION_WINDOW_MS = 15*60_000`), baseline `BASELINE = "3h"` ending where the current window starts (`windowQueries(offset)` with `offset = "15m"`, :90-100). Inbound only, health checks left out, by `service`.
- `detectJumps(current, baseline): ServiceJump[]` (:59), pure:
  - skip when `requests < MIN_REQUESTS = 10`;
  - errors (with baseline): `now >= ERROR_SHARE_FLOOR (0.05)` and `now >= was + 0.05` and `now >= 2 * was`;
  - errors (no baseline traffic): `now >= ERROR_SHARE_NO_BASELINE (0.2)`;
  - latency: both p95 non-null, `b.p95 > 0`, `c.p95 >= LATENCY_FACTOR (1.5) * b.p95` and `c.p95 - b.p95 >= LATENCY_MIN_RISE_S (0.1)`;
  - sort by severity: errors = share delta; latency = relative rise `(now-before)/now`.
- `serviceJumps(tenant, client = vmClient): Promise<ServiceJump[]>` (:129), cached 10 s; `readWindow` (private, :102) -> `ServiceWindow[]`.
- Stalled/unreceived: Loki scans `INBOUND_RECORDS_QUERY` / `OUTBOUND_CALLS_QUERY` (:194-196), `RECORD_LIMIT = 3000`, window 15 min + 5 min, `STALL_AFTER_MS` from `tree.ts`, `RECEIVE_GRACE_MS = 30_000`; `RecordQueryFn` injectable (:198).
- Shared shapes (pure, client-safe) in `lib/hops/attention.ts`: `JumpKind {Errors, Latency}`, `ServiceWindow {service, requests, failed, p95}`, `ServiceJump {service, kind, requests, now, before}`, `RecordScan<T> {rows, total, truncated}`, `LIST_LIMIT = 10`.
- Reusable for regressions (6) and alerts (5): `windowQueries(offset)` is the pattern (but hard-wired to 15m/3h and `by service`; export a generalised `windowQueries(window, offset, by)` rather than copy), `detectJumps` thresholds and its `severity`, `ServiceWindow`, `windowIncrease(..., offset)`.

## 4. Per-statement aggregate: two designs

Facts first:
- `stmt` (<= 300 bytes, 0x20..0x7E, `MAX_STMT_BYTES`, `lib/hops/stmt.ts:17`) and `table` (<= 200, 0x21..0x7E) are on OUTBOUND `via=db` records only (`parse.ts:324-325`). Per-call duration is `duration_us` on that `out_end`. `db_us`/`db_n` are per-request totals on `in_end` (not per statement).
- The emitter already parameterises statements (spec STM / design 21: values become `?`); see `D-correlator.md` for exactly what is guaranteed (whitespace, `IN (?, ?, ?)` lists are not guaranteed to be collapsed).
- The outbound db record carries `service` and `peer` (db name) but not the inbound route. Linking a statement to "the routes that call it" needs the parent: `parent_hop` of the out record = `hop_id` of the in record, whose `op` is the route. Neither Vector nor PromQL can join that today.
- Stored line format: agents and the stack collector use `encoding.codec: json`, so each Loki line is a JSON envelope `{"message":"<original record>","service":...,"source":...,"level":...,"kind":"hop","timestamp":...}` (SLIM_VRL, vector-config.server.ts:396-402). The record inside `message` is either JSON or `key=value` with `stmt=` running to the end of the line. Lines pushed without Vector (the two in the local Loki) are the bare kv record. `parse.ts` `fieldsOf` handles all three (envelope unwrap :157-164).
- Statements switch off (`statements` feature) removes `stmt`/`table` before storage (vector-config :292-315); figures must say "no statements recorded" rather than empty.

### (a) New Vector metric with a bounded fingerprint label
- Shape: `backwork_hop_stmt_duration_seconds` histogram (or, cheaper, two counters `backwork_hop_stmt_seconds_total` + `backwork_hop_stmt_calls_total`) from `out_end` with `via=db`, labels `service, peer, table, stmt_fp, outcome`. Add to `METRIC_PREP_VRL` and a new `log_to_metric` + route `stmts`.
- Fingerprint in VRL (Vector 0.43.1, `infra/vector/Dockerfile`): `s = downcase(stmt)`; `s = replace(s, r'\s+', " ")`; `s = replace(s, r'\(\s*\?(?:\s*,\s*\?)*\s*\)', "(?)")`; `s = replace(s, r'\b\d+\b', "?")`; `bw_m.stmt_fp = slice!(md5(s), 0, 12)` (md5/sha2 exist in VRL; `crc32` availability in 0.43 unverified). The dashboard needs fp -> text: also emit `backwork_hop_stmt_info{stmt_fp, stmt="<normalised text>"}` gauge 1 (text has spaces, so it fails this repo's `labelVrl` rule and must bypass it; VM accepts it) or look the text up in Loki per fingerprint by recomputing the same normalisation in TS (two implementations of one hash: must be tested against each other).
- Cardinality: histogram = 17 series per (service, peer, table, fp, outcome). 200 fingerprints x 3 services x 2 outcomes x 17 = about 20k series, versus about 1.5k series in the whole local VM today. The existing `tag_cardinality_limit` is 2000 values per label per collector, far too loose for this. Needs its own `tag_cardinality_limit` with `value_limit` about 200 on `stmt_fp` (and `drop_event`, not `drop_tag`, or the un-tagged remainder merges into a misleading series). With counters only (2 series per key) the same cap is about 2.4k series; p95 is then not available, only mean (seconds/calls).
- Route attribution still missing (no inbound `op` on the out record); would need the adapter to stamp the inbound route on outbound records (Correlator change) or a dashboard-side Loki join.
- Rollout: the metric transforms live in `agent.yaml`, which is written once by `/install.sh`; only `bw_controls` reloads via the poller (`controlsTransformYaml`, :498). So every agent needs a reinstall (or the poller's controls file must grow to carry extra transforms and a sink, untested). Stack collector picks it up on redeploy. History starts at deploy; VM keeps 14 days.

### (b) On-demand LogQL metric query over hop records (recommended for feature 2)
- Works with Loki 3.3.0 (`infra/loki/Dockerfile`). Verified against the local Loki: `quantile_over_time(0.95, {kind="hop"} |= "in_end" | logfmt | unwrap duration_us [30d]) by (op)` returns `{op="/api/v1/public/m/:merchant_username/products"} 27700`. Pipeline for real (enveloped) lines:
  - JSON record: `{kind="hop"} |= "out_end" |~ "via\\W{1,6}db" | json rec="message" | line_format "{{.rec}}" | json | unwrap duration_us`.
  - kv record: `logfmt` is unusable for `stmt` (unquoted, contains spaces: it yields only the first word). Use `| regexp "\\sstmt=(?P<stmt>.*)$"` and `| regexp "\\bduration_us=(?P<duration_us>\\d+)"`. Anchor every field regexp: an unanchored `op=(?P<x>\\S+)` matched `hop=in_end` in the local test.
  - Formats can be mixed in one org; one query per format, or `regexp` that tolerates both (`stmt\\W{1,6}`), then `sum by (service, stmt)` (`quantile_over_time ... by (service, table, stmt)`, `sum_over_time(... unwrap duration_us)` for total time, `count_over_time` for calls).
- Normalisation (collapsing `IN (?, ?)` etc.) happens in TS after the query, merging groups; raw `stmt` text is a Loki group key, bounded by `max_query_series: 5000` (`infra/loki/loki-config.yaml:43`), so the query should be `topk(200, ...)` or sorted and the 5000 limit handled as "too many statements".
- Routes that call a statement: a second, limited log query (sample N `out_end via=db` records with that stmt, collect `parent_hop`, then fetch their `in_end` records), or join in TS from one scan of both inbound end records and db out_end records in a 1 h window (A-requests notes, `tree.ts` / `query.server.ts` for the request view's join).
- Limits and timing: Loki defaults in 3.3 (none overridden here): `query_timeout` 1m, `split_queries_by_interval` 1h, `max_query_length` 721h, `max_entries_limit_per_query` 5000. The dashboard's Loki client times out at 12 s (`fetchJson(..., { timeoutMs: 12000, retries: 1 })`, loki.server.ts:120,158), so a heavy query fails twice (24 s) before the panel errors. The 30-day query over 2 lines took 0.26-0.99 s locally: that is the fixed cost of 720 one-hour splits (`queueTime` about 15-40 s summed), so per-window cost is roughly fixed overhead (about 1 split per hour) plus bytes scanned. Hop envelope lines are about 400-700 bytes; a service at 10 req/s with 5 db calls per request writes about 60 lines/s of hop records, about 2.5 GB/day raw. Line filter `|= "out_end"` + `|~ via db` are fast; `json`/`regexp` run only on matched lines. Estimate (single-binary Loki, 4 querier workers, not measured on real volume): 1 h = 100-200 MB scanned, about 1-3 s; 24 h = 2.5-5 GB, 20-60 s: over the 12 s client timeout, near the 1 min Loki timeout. Measure on the reference deployment before choosing the 24 h option.
- No existing helper runs a LogQL metric query and returns grouped vectors over a whole window: `loki.countOverTime(query, {start,end,step}, tenant)` (:143) returns flattened points with labels (a range query; with `step = window` and `[window]` it gives one point per group, usable), `rateByService` keys by `service` only (:173), `labelSets` instant (:195), `scalar` instant (:204). Add `loki.metricInstant(query, tenant, timeoutMs)` returning `Array<{metric, value}>` (Loki instant API does not return grouped `sum by` reliably per the comment at :170-172; use query_range with `step = end-start`). `requests.server.ts` (`inboundEndQuery`, `hopRequestPage`) and `attention.server.ts` (`readRecords`, `RecordQueryFn`) only do log (stream) queries.

### Recommendation
(b) for the slow queries board: works on data already stored (30 days of hop records), no reinstall, no new series, exact text, and routes can be attached by a join. Default window 1 h, offer 6 h; 24 h only behind a cached background compute (cache key per org/window, TTL 5-10 min, stale-while-revalidate as CLAUDE.md requires for slow calls). Revisit (a) with counters only (no histogram) and a 200-fingerprint cap if alerts on slow statement shapes (feature 5) need a cheap 1-minute evaluation: a LogQL query per org per minute is the expensive part of (b).

Retention: VictoriaMetrics `-retentionPeriod=14d` for every org (plans do not trim VM; `plans/retention.server.ts` deletes only from Loki). Loki: ordinary lines 168h, `{kind="hop"}` 720h (`loki-config.yaml:32-38`). Plan windows (`components/site/plans.ts:52,62,74`): Free requestPathsDays 3 / logLinesDays 3 and a rolling cap of 100k requests / 1 GB; Team 30/14; Business 90/30 (beyond the stack's 30-day hop retention); Enterprise null. So "last week" in Loki is gone for Free orgs; in VM it exists for all orgs.

## 5. Time ranges and "last week at the same time"
- `PerfRange = { H1: "1h", H6: "6h", H24: "24h", D7: "7d" }`, `PERF_RANGES`, `DEFAULT_RANGE = "6h"` (`lib/hops/figures.ts:5-13`); `parseRange` (metrics.server.ts:32), `rangeSeconds` (:36), private `RANGE_SECONDS` (:22). The range string is used directly as the PromQL window. Cache key includes the range.
- Every figure is an instant query at now over `[range]`. Last week = same builder with `offset 7d`: `windowIncrease(sel, range, labels, "7d")` already supports it (all builders except the ones built on `windowOf` must thread an `offset`; `quantileQuery` takes an optional inner `window` but no offset; `rateQuery`/`errorRateQueries`/`storeShareQuery` have neither). Suggested: add `offset: string | null = null` to `rateQuery`, `errorRateQueries`, `quantileQuery`, and a `figuresFor`-like `compareFigures(scope, range, offset)`.
- Retention: VM 14 d. With `COUNTER_LOOKBACK_SECONDS = 7d`, a 7d range with 7d offset reaches 21 d back (outside retention) and even 1h at 7d offset reaches 14d+1h; the `or` fallback keeps a figure but loses the exact-window property. Use a lookback of `min(7d, 14d - offset - range - margin)`; 7d range vs previous 7d is not supportable exactly (would need lookback 0).
- Range queries for charts: `vm.range(q, {start, end, step}, tenant)`; last week's series = same query with `offset 7d` and the same start/end, then shift points by +7 d in TS for overlay.
- Overview fixed windows: 15 min and 3 h baseline; `SERVICES_RANGE = PerfRange.H1` (`_index.tsx:39`); failed requests 24 h.

## 6. Cache hit/miss, connection wait, pool fields
- None today. `parse.ts` reads only `db_n`, `db_us`, `cache_n`, `cache_us` on `in_end` (`totalsOf`, :207-214 -> `StoreTotals {dbCalls, dbUs, cacheCalls, cacheUs}`, `types.ts:92`), and on out records `outcome`, `status`, `error`, `duration_us`, `table`, `stmt`, `peer`, `op`. `METRIC_PREP_VRL` reads the same four totals. No `hit`, `miss`, `pool`, `wait`, `queue` anywhere in `lib/hops`, the Vector config or the Correlator spec (see `D-correlator.md` section "Do hit/miss or pool-wait fields exist anywhere? NO").
- Needed for per-route cache hit ratio (12): a per-request total on `in_end`, e.g. `cache_hits` (count of cache reads that returned a value; `cache_n` already counts all calls). Then: `StoreTotals.cacheHits` in `types.ts` + `totalsOf`; `METRIC_PREP_VRL` `bw_m.cache_hits`; a new counter in `bw_hop_store` (e.g. `backwork_hop_store_calls_total{store="cache_hit"}` reusing TAGS.store, or a new `backwork_hop_cache_hits_total`); add to the controls drop list (`includes(["db_n","db_us","cache_n","cache_us"], k)` at vector-config :300 and the kv regex at :310) so the Stores switch still removes it. Ratio query per route: `windowIncrease(hits{service}, range, [service,method,op]) / windowIncrease(store_calls{store="cache"}, ...)`. Caveat: `cache_n` counts writes too, so the denominator should be cache reads (`cache_reads` total) or the ratio understates.
- Per-call alternative: `hit=true|false` on `out_end via=cache`; gives per-command ratio by `peer`/`op` (cache command), not per inbound route, unless joined in Loki.
- Connection wait: `db_wait_us` (time waiting for a pool connection) on `in_end` -> `backwork_hop_store_seconds_total{store="db_wait"}`; per call `wait_us` on `out_end via=db`. All need a Correlator spec + adapter change first (D notes), then the parse/VRL/metric changes above, then an agent reinstall for the metric part (agent.yaml is static).

## 7. Test conventions for metrics code
- Runner: `bun test` (`dashboard/package.json` `"test": "bun test"`), `import { describe, expect, test } from "bun:test"`. Typecheck: `bun run typecheck` (`tsc`, `strict: true`). No lint script in `dashboard/package.json`; report exit codes.
- Tests sit next to the module: `lib/hops/metrics.server.test.ts`, `attention.server.test.ts`, `counter-window.test.ts`, etc.
- Query builders are asserted as exact strings, usually built from the same helpers (`expect(c.requests).toBe(windowIncrease(sel, "15m", ["service"]))`, attention test :70-76) or with `toContain` on fragments (`[${10800 + COUNTER_LOOKBACK_SECONDS}s] offset 900s`).
- PromQL results are faked with a `PromClient` object, never HTTP: `fakeClient(answers: Array<[RegExp, Sample[]]>, ranges = [])` matches the first regex against the query text and records every query in `seen` (metrics.server.test.ts:52-66); tests then assert `seen.length` (e.g. 11 for servicesTable) and figure joins. Attention test writes an inline `PromClient` that tells current from baseline by `/\] offset 900s\)\) -/` (:78-93).
- Cache isolation: a fresh `Tenant` per test (`org()` with a counter, `{ orgId: "org-test-N", platform: false }`), because `cached` is process-global (metrics test :41-47). Caching itself is tested by calling twice and checking `seen.length` did not grow; a rejected call must not be cached (:307).
- Hop records for Loki-side logic are built from kv strings through `parseHopRecord` (`rec(line, ts, service)`, attention test :34-38; `IN`, `IN_END`, `OUT_END` templates :96-101); Loki is faked with a `RecordQueryFn` / `HopQueryFn` function argument.
- Fixed clock: `NOW = 1_800_000_000_000` passed in (`now` params everywhere).
- Vector config: `lib/agent/vector-config.server.test.ts` (checked-in `infra/vector/vector.yaml` must equal `stackConfigYaml()`), plus VRL unit tests `infra/vector/test.sh` (`infra/vector/tests.yaml`) and `infra/vector/agent/test.sh`. A new metric needs a case in `tests.yaml`.

## 8. Conventions to follow
- Pure vs server: pure fixed sets and shapes in plain `.ts` (`figures.ts`, `attention.ts`, `health.ts`, `stmt.ts`) so route components can import them without pulling server code; anything that queries VM/Loki/Postgres is `.server.ts` and re-exports the pure parts (`metrics.server.ts:19-20`, `attention.server.ts:20-22`). Pure rules (e.g. `detectJumps`, `findStalled`) separate from the query layer and tested alone.
- Enums: `const X = {...} as const; type X = (typeof X)[keyof typeof X]` plus `X_LIST: readonly X[] = Object.values(X)` (PerfRange, PeerKind, JumpKind, HealthChecks, Via, HopMetric, Quantile, MetricName, CollectorKind, AlertMetric, AttentionGroup in `_index.tsx:237`). Display maps as `Record<Enum, string>` (`PEER_TAG`, `CLEAR_TEXT`).
- Explicit types on exported signatures and return types; interfaces for rows (`ServiceRow`, `RouteRow`, `ServiceJump`). No `any` except the isolated `Deferred` cast (`components/defer.tsx:18-20`) and `safe`'s `catch (e: any)`. Untyped input (log lines) is read only in `parse.ts`; label values gated by `isLabelValue` before entering a query; strings into PromQL only via `promString`.
- Dependency injection: `client: PromClient = vmClient`, `read: RecordQueryFn = loki.queryRange`, `now = Date.now()`, `peers: PeerStore = peerStore` as trailing defaulted params.
- Every figure query goes through `windowIncrease`/`windowPerSecond`, never bare `rate()`/`increase()` (`counter-window.ts` header; test "never rate()" metrics test :236).
- Errors: two disjoint selectors summed in code (`errorRateQueries`), never PromQL `or`/`+`.
- Health checks: hidden by default on inbound figures (`HealthChecks.Hidden`, `?health=1`), part of the cache key.
- Caching: `cached(key, ttl, fn)` with keys `<area>:<org|platform>:...`; include every input that changes the answer.
- Render first, load progressively: loader returns `defer({...})` of independent promises, each wrapped in `safe(fn, fallback)` -> `{data, error}`; promises are created in the loader, never in render (`_index.tsx:56-60`); each card is `<Deferred resolve fallback={<CardHead .../><RowsSkeleton rows={n}/>}>` with `ErrorNote` (panel degrades alone) and `Empty` (sentence + reason). A slow Loki aggregate (statements over 24 h) should get its own endpoint or SWR cache that never awaits a refresh when a value exists (global CLAUDE.md).
- UI rules (UI_ISSUES.md #4): `PageTitle` one row with controls (`right`), explainer only as `sub` (InfoTip); `CardHead` one row (`min-h-11`, title + inline muted `sub` + `right`); tables in `overflow-x-auto scroll-thin` with low-priority columns `hidden sm:table-cell` so 390 px never scrolls the page; first card directly under the title (`space-y-4`). No em dashes in copy (DESIGN.md bans; existing `ErrorNote` and "—" cells predate it). Status colours only for status; service colours from `serviceColor`.

## 9. What each feature should import, and what it needs

### 2. Slow queries board
- Import: `isLabelValue`, `PerfRange`/`parseRange`/`rangeSeconds` (`metrics.server.ts`), `HealthChecks` (`health.ts`), `StatementField`, `isStatement`, `MAX_STMT_BYTES`, `splitStatement` (`stmt.ts`), `parseHopRecord`, `HopRecord`, `Via`, `HopKind` (`parse.ts`, `types.ts`), `loki.countOverTime` / `loki.queryRange` (`loki.server.ts`), `cached`, `Tenant`, `safe`, `Deferred`, `RowsSkeleton`, `CardHead`, `fmtLatency`, `fmtRate`, `TD`/`NUM`/`Th`.
- New: LogQL builder(s) for `out_end via=db` grouped by `service, table, stmt` (quantile/sum/count of `duration_us`) for JSON and kv records; a TS normaliser merging statement variants; a Loki grouped-instant helper (step = window) with its own timeout; a route join (stmt -> parent in_end `op`); type `StatementRow {service, peer, table, stmt, calls, totalS, p95S, routes: RouteKey[]}`; empty state when the Statements switch is off.

### 5. Alerts on route p95, error rate, slow statement shapes
- Import: `quantileQuery`, `errorRateQueries`, `rateQuery`, `Quantile`, `Scope`/`routesScope`, `combineFigures`, `vmClient`/`PromClient`, `isLabelValue`, `RouteKey` (`metrics.server.ts`), `windowIncrease` (`counter-window.ts`), `detectJumps` thresholds as defaults (`attention.server.ts`), `AlertMetric`/`isAlertMetric` (`alert-kinds.ts`), `AlertRule`/`AlertState`/`evaluate`/`METRIC_META` (`alerts.server.ts`).
- New: `AlertMetric` values (e.g. `route_p95`, `route_error_share`, `stmt_p95`); rule target beyond `service` (method + op, or stmt fingerprint); evaluation via VM (not `loki.scalar`, which `evalRule` uses today, alerts.server.ts:105-107) over a short window (5m or 15m via `windowIncrease`), with `MIN_REQUESTS`-style floor; `noData` semantics kept. Evaluator ticks every 60 s per org (`evaluator.server.ts:77`): a per-minute LogQL statement query per rule is the costly case (see 4).

### 6. Regression compare and deploy markers
- Import: `windowIncrease(sel, window, labels, offset)`, `servicesScope`/`routesScope`, `quantileQuery`, `rateQuery`, `errorRateQueries`, `trendQuery`/`trendStep`, `PerfRange`, `rangeSeconds`, `PromClient`, `ServiceRow`/`RouteRow`/`Figures`, `vm.range`, `detectJumps` + `ServiceWindow`/`ServiceJump`/`JumpKind` (pattern and thresholds), `TimeSeries`/`Series` (`components/charts.tsx`).
- New: `offset` parameter on `rateQuery`, `errorRateQueries`, `quantileQuery` (and a shorter counter lookback for offset windows, see 5); `compare(range, offset="7d")` returning `{now: Figures, before: Figures | null}` per row; chart markers (recharts `ReferenceLine`) in `TimeSeries`; a deploy source: nothing in hop records or VM marks a deploy today (no version field on records; `app_version` labels in the local VM come from VictoriaMetrics' own metrics). Options: a `version` field on `in`/`in_end` records (Correlator change), or deploy events posted by Coolify/CI into Postgres.

### 7. Fix-first list (wasted time = p95 x request rate)
- Import: `rateQuery`, `quantileQuery`, `errorRateQueries`, `combineFigures`, `Quantile`, `Scope`, `HealthChecks`, `PerfRange`, `RouteRow`, `isLabelValue`, `cached`, `vmClient`; `latencyTone`/`errorTone`/`fmtLatency`/`fmtRate` for display.
- New: an all-routes scope `{ by: ["service","method","op"], where: {}, health }` (no such exported preset; `routesTable` is per service); a pure ranking `wastedSecondsPerSecond = p95 x rate` (or better `sum` of `_sum` increase over the window = real total time, already available as `backwork_hop_duration_seconds_sum`); top-N with `topk` in PromQL to bound rows. Store share per route via `storeShareQuery` for "why".

### 12. Cache hit ratio per route (and connection wait)
- Import: `storeCallsPerRequestQuery`/`storeShareQuery` (pattern), `routesScope`, `windowIncrease`, `HopMetric`, `StoreTotals` (`types.ts`), `totalsOf` path in `parse.ts`, `METRIC_PREP_VRL`/`metricTransformsYaml`/`TAGS` (`vector-config.server.ts`).
- New: Correlator fields (`cache_hits` or `cache_reads`+`cache_hits` on `in_end`; `db_wait_us`), parse + `StoreTotals` fields, VRL prep + counters, controls drop list update, `tests.yaml` cases, regenerated `vector.yaml`, agent reinstall; then a `cacheHitRatioQuery(scope, range)`. Until then the request view can show per-request cache calls only.
DONE
