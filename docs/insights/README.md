# Insights: slow queries, N+1 and more

Epic BAC-67. Twelve features that find slow queries, repeated calls and regressions from the hop records backwork already stores. One plan per feature (`01-` to `12-`), this file for what they share, `TICKETS.md` for the tickets, `RUN-LOG.md` for progress, `notes/` for the code maps the plans were written from (A requests, B metrics, C platform, D Correlator).

## Principles (every plan follows these)

1. **No new collection first.** Statement text, per-call timing, store totals, route figures and peers are already stored. Only feature 12 needs new data from the Correlator adapters.
2. **Pure analysis, thin routes.** Detection and ranking live in pure modules (`lib/hops/*.ts`, no Loki, Remix or database imports, "Pure." in the header comment) so they run in the browser on the request view and are tested with plain objects. Anything that touches Loki, VictoriaMetrics or Postgres is `*.server.ts`, takes a `Tenant`, and takes its client as a trailing defaulted parameter so tests inject a fake.
3. **Render first, load progressively.** Every new card is `Deferred` with its own skeleton and its own error state. Slow Loki aggregates go through the stale-while-revalidate cache (foundation adds `cachedStale`), never awaited when a value exists.
4. **Typed, enumerated.** Explicit types on every exported function, no `any`, fixed value sets as `as const` maps with a same-name union type, thresholds as exported documented constants with units in the name (`...Us`, `...Ms`).
5. **UI rules** (`/Users/romario/projects/UI_ISSUES.md`): page title one line, no explainer paragraph (put it behind the info tip), first card within 64 px of the header (56 px on a phone), card headers one row and at most 48 px, menus in the top layer, nothing scrolls sideways at 390 px. Status colours (green, amber, red) mean status only; a finding such as "repeated 14 times" is neutral or amber at most, never red. No em dashes, units always shown, British spelling, no emoji.
6. **Nothing is invented.** Every number comes from stored records. When a figure is an estimate or a sample it says so ("about", "at least", "last hour, sampled").
7. **Copy is plain.** Findings read like a colleague: "select plans ran 14 times, one after another, 62 ms in all."

## Shared decisions

| Decision | Choice | Why |
|---|---|---|
| Statement shape | One pure `statementShape(stmt)` (lowercase, collapse whitespace, `in (?, ?, ?)` to `in (?)`, numbers to `?`, drop trailing `;`) and `shapeId(shape)` (8-hex FNV-1a) for URLs. Path view grouping, repeat detector, slow queries board, alerts and digest all use it. | Notes A and B: none exists today; five features must agree on "same query". |
| Slow queries source | On-demand LogQL metric queries over `out_end` `via=db` hop records, merged by shape in TypeScript. Not a new Vector metric. | Statement text is not a metric label; a bounded fingerprint label costs ~20k series and needs every agent reinstalled (note B section 4). |
| Per-statement cache | `cachedStale(key, freshMs, maxStaleMs, fn)`: returns the stored value at once and refreshes in the background. | Global rule: slow calls never block a page that has a value. |
| Route figures | VictoriaMetrics through the existing builders. Compare-with-last-week adds `offset` and a shorter counter lookback (7 days of lookback plus a 7-day offset would pass VictoriaMetrics' 14-day retention). | Note B section 5. |
| New tables | All created once in the foundation PR, in both the `DDL` string in `db/index.server.ts` and `db/schema.ts`: `deploys`, `alert_state`, `alert_events`, `digest_settings`, `digest_runs`, `pinned_requests`, `pin_settings`. | The two files are single-file hotspots; one PR avoids twelve conflicting edits, and putting every table in the DDL string avoids repeating BAC-66. |
| Navigation | One new nav item, **Insights** (index 4, after Logs, so the phone tab bar is unchanged), with a tab strip: Fix first, Slow queries, Repeated calls, Service map. Request-level findings live on the request view; alerts, digest settings and deploy setup live on their existing pages. | One entry, one place to look (design rule: no feature sprawl). |
| Background jobs | A single `startBackgroundJobs()` (evaluator, plan jobs, digest), called from the root loader and the ingest push route. Anything that sends or fires claims a Postgres row first. | Note C section 2: lazy, asymmetric starts and in-memory state today. |
| Test data | Foundation extends `qa/fixtures` with an insights scenario (an N+1 list endpoint, a slow query shape, sequential calls that could be parallel, a regression after a deploy) so every feature has real records locally. | Memory rule: build the conditions and exercise them, never leave a feature "tests only". |

## Waves and ownership

Features are built by background agents, each in its own worktree and branch (`bac-NN-slug`), each ending in a PR. I review and merge in order, deploy once per wave, and verify live before the next wave starts.

| Wave | Features | Why this order |
|---|---|---|
| 0 Foundation (BAC-67) | shared helpers, new tables, nav shell, fixtures | Everything below depends on it; it holds every edit to shared hotspot files. |
| 1 | 1 Repeated calls (BAC-68), 2 Slow queries (BAC-69), 6 Regressions and deploys (BAC-73), 9 Service map (BAC-76) | Four different areas, no shared files except mounts. 2 and 6 feed later waves. |
| 2 | 3 Why slow (BAC-70), 4 Chatty and parallel (BAC-71), 5 Slowness alerts (BAC-72), 11 Pin worst requests (BAC-78) | 3 and 4 build on 1; 5 on 2 and 6; 11 on the request view settled by 1 and 3. |
| 3 | 7 Fix first (BAC-74), 8 Request diff (BAC-75), 10 Weekly digest (BAC-77), 12 Cache and pool (BAC-79) | 7 and 10 combine 1, 2, 5 and 6; 8 reuses the verdict; 12 needs a Correlator decision. |

File ownership (one owner per file inside a wave; mounts in shared routes are one-line imports and are merged in order by me):

| Area | Owner | Others only mount or import |
|---|---|---|
| `lib/hops/stmt-shape.ts`, `cache.server.ts` `cachedStale`, `loki.server.ts` `metricInstant`, DDL and `schema.ts`, `insights.tsx` layout, NAV entry, `qa/fixtures` scenario | Foundation | everyone |
| `lib/hops/repeated.ts`, `path-rows.ts` grouping | 1 | 3, 4, 7, 8 |
| `lib/hops/slow-queries.server.ts`, `routes/insights.queries.tsx` | 2 | 5, 7, 10 |
| `lib/deploys*.ts`, `routes/ingest.deploys.tsx`, `routes/api.v1.deploys.tsx`, compare params in `metrics.server.ts`, `components/charts.tsx` markers | 6 | 5, 7, 10 |
| `lib/hops/service-map.ts`, `routes/insights.map.tsx`, `peers.server.ts` bulk read | 9 | none |
| `lib/hops/verdict.ts`, request header line | 3 | 8 |
| `lib/hops/concurrency.ts`, list "chatty" flag, `requests.server.ts` totals | 4 | none |
| `alerts.server.ts`, `alert-kinds.ts`, `evaluator.server.ts`, `routes/alerts.tsx` | 5 | 10 |
| `pinned_requests` read and write, pin action | 11 | none |
| `lib/insights/fix-first.ts`, `routes/insights._index.tsx` | 7 | none |
| `lib/hops/diff.ts`, `routes/requests_.$id.vs.$other.tsx` | 8 | none |
| `lib/digest/*`, digest card on `/alerts` | 10 | none |

## Definition of done (every feature)

1. Ticket open before work; branch `bac-NN-slug` from `origin/main`; own worktree under `backwork-wt/`.
2. Plan followed; anything that had to change is written back into the plan file in the same PR.
3. `bun run typecheck` exit 0 and `bun test` exit 0, exit codes reported. New pure code has unit tests; new SQL has an opt-in database test (`DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test <file>`); the DDL test proves the new table is created on a fresh database.
4. Exercised in a real browser against the local stack with the insights fixture scenario (or seeded data) at 1440 and 390 wide: loading, empty and error states shown, no sideways scroll, UI_ISSUES checks that apply (top gap, card header height).
5. PR description in plain language (what and why, no activity log, no blame), merged by me; deployed; checked live on backwork.dev as a metered and an unmetered organisation where it differs; ticket closed with the evidence; work log entry.

## Risks that cut across features

- **Truncation.** A request fetch is capped at 5000 lines and silently loses its oldest records; analyses say "at least" when the cap is reached (foundation exposes `truncated`).
- **Statement text switched off** (Query text switch, or older records): every statement feature degrades to `(via, peer, op, table)` and says so, never shows blanks.
- **Plain Redis pipelines** look like N concurrent cache calls: never flagged as N+1 or "could run in parallel".
- **Clock skew** across services: only same-service sibling calls are compared for order and overlap, with a tolerance of 1 ms.
- **Loki cost.** Statement aggregates over 24 hours may exceed the dashboard's 12 s client timeout: windows are 1 hour and 6 hours, behind the stale-while-revalidate cache, and the 24-hour option is only offered after measuring on the reference deployment.
- **Retention.** VictoriaMetrics keeps 14 days, Loki hop records 30 days (Free plan 3), so "last week" works for figures, not for statements on Free.
- **Alert noise.** Every new alert kind has a minimum request floor and a pending period before it fires.
