# 06 Regression compare and deploy markers (BAC-73)

Wave 1. Depends on: foundation (`offset` and lookback parameters, `deploys` table). Feeds: 5, 7, 10.

## Goal
Answer "did it get slower?" and "was it the deploy?": compare a service or route against the same hours last week, show a trend chart with last week overlaid and deploys marked, and surface week-over-week regressions on the Overview.

## What exists (notes B sections 2, 3, 5; C section 5)
- Figures are VictoriaMetrics instant queries over `[range]`, never `rate()`. `windowIncrease` already takes `offset`. The Overview "slower than usual" compares the last 15 minutes with the 3 hours before (`detectJumps`: 1.5x and at least 100 ms, 10 request floor).
- A 7-day offset with the 7-day counter lookback passes the 14-day retention; foundation adds `lookbackSeconds`.
- No chart on Performance (only sparklines), no marker support in `TimeSeries`, and nothing records a deploy.

## Design

### A. Compare with last week
`lib/hops/compare.server.ts`:
```ts
export interface CompareFigures { now: Figures; before: Figures | null; requestsBefore: number }
export interface CompareRow { key: string; service: string; method: string | null; op: string | null; now: Figures; before: Figures | null; p95Ratio: number | null; p95RiseS: number | null; errorRise: number | null; verdict: CompareVerdict }
export const CompareVerdict = { Slower: "slower", MoreErrors: "more_errors", Same: "same", Faster: "faster", NoBaseline: "no_baseline" } as const;
export function compareServices(range: PerfRange, tenant: Tenant, client?, now?): Promise<CompareRow[]>;
export function compareRoutes(service: string, range: PerfRange, tenant: Tenant, client?, now?): Promise<CompareRow[]>;
export function classify(now: Figures, before: Figures | null, reqNow: number, reqBefore: number): CompareVerdict;  // pure
```
- "Before" is the same range ending 7 days ago: the existing builders with `offset: "7d"` and `lookbackSeconds = min(7d, 14d - 7d - range - 1h)`. Ranges 1 h, 6 h and 24 h are supported; **7 d is not** (cannot be exact within 14 days of retention) and the toggle is disabled on 7 d with a tooltip.
- `classify` (thresholds exported, same family as `detectJumps`): `Slower` when `now.p95 >= 1.5 * before.p95` and rise at least 100 ms; `MoreErrors` when error share is at least 5 points higher and at least twice; `Faster` when `now.p95 <= 0.67 * before.p95` and 100 ms lower; both windows need `MIN_REQUESTS = 30`, otherwise `NoBaseline`.
- Cached 30 s per `(org, range, scope)`.

### B. Deploy markers
- **Table** `deploys` (created in the foundation).
- **Ingest** `routes/ingest.deploys.tsx`, `POST /ingest/deploys` (resource route): bearer project ingest token via `resolveIngestToken` exactly like `ingest.errors.tsx`; typed validation, no `any`:
  ```ts
  interface DeployReport { service: string; version?: string; commit?: string; environment?: string; url?: string; actor?: string; at?: string }
  ```
  single object or `{ deploys: DeployReport[] }`, at most 20 per call; `service` mapped to the canonical name (`canonicalName`); `at` defaults to now and may not be more than 5 minutes in the future; duplicates by `(org_id, service, commit_sha)` ignored; rate limit `rateLimit("deploy:<projectId>", 60, 1 h)` returns 429 with `retry-after`; response `{ accepted: n }`. 405 for other methods, 401 `{error:"unauthorized"}`, 400 on bad JSON or fields.
- **Read** `routes/api.v1.deploys.tsx`: `GET /api/v1/deploys?service=&since=&limit=` with `requireApiKey` and `apiJson`, snake_case typed response.
- **Setup on Projects**: a "Report deploys" block under the project's install command with the curl snippet using the project token and a one-line Coolify note ("add as a post-deployment command"); `Recent deploys` (last 5) list for admins with delete (audited `deploy.delete`).
- `lib/deploys.server.ts`: `recordDeploys(tenant, projectId, reports)`, `deploysBetween(orgId, service|null, fromMs, toMs): Promise<Deploy[]>`, `latestDeploy(orgId, service)`.

### C. Trend chart with last week and deploy markers
- `components/charts.tsx`: `TimeSeries` gains `markers?: Array<{ t: number; label: string }>` (recharts `ReferenceLine`, label shown on hover, vertical dotted line, neutral colour) and `overlay?: Series` (dashed, muted). Backwards compatible; existing callers unchanged.
- Performance page: new card **Trend** under Services for the selected service: p95 line over the range (`trendQuery`-style range query), last week's same range shifted by +7 days as dashed overlay (the query with `offset 7d`, points shifted in TypeScript), markers from `deploysBetween`. One-row head: "p95 of checkout-api, last 6 h" with the legend ("last week" dashed) inline. Range 7 d shows markers but no overlay.
- Marker label: `v1.4.2` or the first 7 characters of the commit, else "deploy". Click a marker (desktop) shows version, actor and time in the tooltip.

### D. Compare toggle on Performance, regressions on Overview
- Performance: a "vs last week" switch in the controls row (`?compare=1`); the Services and Routes tables gain one column "vs last week" with a neutral chip: "2.1x slower", "4 points more errors", "no baseline"; rows sorted unchanged. Chips use text and tone (amber for slower or more errors, neutral otherwise); never red.
- Overview "Needs attention" gets a group **Slower than last week** (new `AttentionGroup` member) from `compareServices(H1)`, listing services with `Slower` or `MoreErrors`, one line each: "checkout-api p95 740 ms, last week 310 ms (about 2.4x), 1,820 requests", with a "deploy 22 minutes ago" tail when a deploy is within 6 hours before the window start. Collapses into the existing "Also clear" line when empty.

## Files
New: `lib/hops/compare.server.ts` (+ test), `lib/hops/compare.ts` (pure `classify`, types, + test), `lib/deploys.server.ts` (+ DB test), `routes/ingest.deploys.tsx`, `routes/api.v1.deploys.tsx`, `components/insights/trend-card.tsx`, `components/insights/compare-chip.tsx`. Changed: `lib/hops/metrics.server.ts` offset use (foundation holds the parameters), `components/charts.tsx` (markers, overlay), `routes/performance.tsx` (card, toggle, column), `routes/_index.tsx` (attention group), `routes/projects.tsx` (setup block, recent deploys), `lib/hops/attention.ts` (new group enum).

## Tests
- `classify` boundaries (1.49x vs 1.5x; 99 ms vs 100 ms rise; 29 vs 30 requests; `before` null).
- Query strings: `offset 7d` with the shortened lookback for 1 h, 6 h and 24 h; 7 d refused; label gating.
- Compare functions with a fake `PromClient` answering now and offset queries; baseline absent gives `NoBaseline`.
- Deploy ingest: auth, bad JSON, bad fields, future `at`, duplicate commit ignored, cap of 20, rate limit 429, canonical service name; DB test for table and `deploysBetween` ordering; `GET /api/v1/deploys` filters.
- Chart: markers and overlay props render without breaking existing `TimeSeries` snapshots; marker label function.

## Verification
Local stack with the regression trigger: `deploy.sh` posts a deploy, then the trigger makes `GET /shop` slower; Performance Trend shows the marker at the right time with the dashed last-week line (seed one week of offset data into the local VictoriaMetrics with a backfill script in `qa/fixtures` so last week exists); `vs last week` chip says about 2x slower; Overview group appears; deploy POST with a wrong token returns 401; 1440 and 390 screenshots; chart height does not change the first-card position. Live: post a real deploy from the CLI for a real service, see its marker.

## Risks
Last week exists only for services reporting for more than 7 days and less than 14 (VictoriaMetrics retention); new services show "no baseline". Histogram buckets make small p95 changes invisible; thresholds are deliberately coarse. Time-of-week effects (weekend traffic) can look like regressions: the chip says "vs the same hours last week", which is the fairest simple baseline.

## Out of scope
Automatic deploy detection from container restarts or Coolify webhooks (the endpoint is the contract), version fields in hop records, per-route trend charts (service level only in v1).
