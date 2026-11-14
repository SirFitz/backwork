# C. Platform plumbing (alerts, jobs, peers, DB bootstrap, ingest/auth, retention, UI, tests)

Paths relative to `dashboard/app/` unless absolute. Line numbers from the `insights` worktree, 2026-11-13.

## 1. Alerts

### Files
- `lib/alert-kinds.ts` (13 lines, pure): the kind enum.
- `lib/alerts.server.ts` (202): rule type, storage, LogQL, evaluate.
- `lib/evaluator.server.ts` (78): background loop + notify.
- `lib/channels.server.ts` (226): channel type, storage (secrets encrypted), SSRF guard, `send`.
- `routes/alerts.tsx` (289): page + action (rules and channels in one route, `intent` switch).
- `lib/alerts.server.test.ts` (39): the only alert test. **There is no test for `evaluator.server.ts`** (no transition/dedupe test exists).

### Kind enum (`lib/alert-kinds.ts:4-13`, verbatim)
```ts
export const AlertMetric = {
  ErrorRate: "error_rate",
  LogRate: "log_rate",
} as const;
export type AlertMetric = (typeof AlertMetric)[keyof typeof AlertMetric];
const ALERT_METRICS: ReadonlySet<string> = new Set(Object.values(AlertMetric));
export function isAlertMetric(value: string): value is AlertMetric { return ALERT_METRICS.has(value); }
```
Retired kinds: `RETIRED_METRICS = ["cpu", "memory_mb", "restarts"]` (`alerts.server.ts:18`), `normalizeRule` (:47) returns unknown kinds disabled with `retired: RETIRED_NOTE`. One-time migration `retireContainerRules()` (:59) guarded by `migrations` row `alerts_retire_container_v1`.

### Rule schema (`alerts.server.ts:21-35`, verbatim)
```ts
export type AlertRule = {
  id: string; name: string;
  metric: AlertMetric | string;   // stored rule may hold a retired kind
  service: string;                // "*" = any service
  comparator: ">" | "<";
  threshold: number;
  channelIds: string[];
  enabled: boolean;
  retired?: string;
};
export type AlertState = AlertRule & { firing: boolean; value: number; noData: boolean };
```
`METRIC_META: Record<AlertMetric, { label; hint; unit }>` (:37) drives the form `<select>` and the list unit. `DEFAULT_RULES` (:42) seeds platform org.

Storage: table `alert_rules (id text PK, org_id FK orgs cascade, data jsonb NOT NULL, created_at, updated_at)`, index `alert_rules_org_idx` (`db/index.server.ts:91-96`, `db/schema.ts:107-112`). **The whole rule is a JSON blob in `data`**; no columns per field, so a new rule kind needs no DDL, only new fields in `AlertRule` (make kind-specific fields optional or move to a discriminated union). Channels: `alert_channels` same shape (:98-103).

CRUD (`alerts.server.ts`): `loadRules(orgId)` :52, `saveRules` :76 (delete-all/insert, legacy), `insertRule(orgId, rule)` :136, `toggleRule(orgId,id)` :140, `deleteRule(orgId,id)` :149, `orgsWithRules()` :155. Ids are `"r" + Date.now().toString(36)` (route :72), not ulid.

### Evaluation
- `ruleQuery(metric, service, names = EMPTY_NAMES): string` (:96) switch over `AlertMetric`:
  - ErrorRate: `sum(rate({kind!="hop",level="error",<svc>}[5m]))`
  - LogRate: `sum(rate({kind!="hop",<svc>}[5m]))`
  - service matcher via `lokiSel` (:88) using `serviceMatcher(canonicalName(service, names.bySource), names)` from `lib/service-names.ts` (BAC-51 one service one name).
- `evalRule` (:105): `loki.scalar(query, 0, tenant)` with `serviceNamesWithin(tenant, 3000)` (3 s timeout falls back to EMPTY_NAMES). `loki.scalar` is org-scoped by `loki.scoped`.
- `evaluate(tenant: Tenant): Promise<AlertState[]>` (:109): per rule, tri-state: exception or non-finite => `noData: true`, value 0, never firing. `firing = !noData && enabled && (cmp ">" ? v > thr : v < thr)`. Retired kinds return `noData: true, firing:false` without querying.
- Loader of `/alerts` calls `evaluate` live on every page view (route :20), so page shows current values not stored state.

### Evaluator loop / state (`evaluator.server.ts`)
- `ensureEvaluator()` (:71) called from `root.tsx:79` in the root loader (every request). Guard `globalThis.__bwEvaluatorStarted` (:13, :72). Starts `seedPlatformDefaults().then(retireContainerRules)`, `setTimeout(tick, 8000)` (baseline), `setInterval(tick, 60000)` (every minute). Timers are **not** `.unref()`ed (plan jobs are).
- State: **in-memory only** `const lastFiring = new Map<string, boolean>()` keyed `${orgId}:${ruleId}` (:16) and module `let seeded = false` (:17). First tick only records current firing (no notify) so a deploy does not replay. Lost on restart; nothing stored in Postgres.
- Transitions (:39-46): `noData` => skip (no transition). ok->firing => `notify(s, byId, "firing")`; firing->ok => `"resolved"`. That is the only dedupe. **No cooldown, no "for N minutes" pending period, no repeat/reminder, no history of firings, no per-channel delivery result stored** (send errors swallowed `.catch(() => {})`). Orgs run sequentially; rules within an org in parallel.
- Message (:57-62): `title = "FIRING: <name>" | "RESOLVED: <name>"`, `body = "<scope> — <label> <cmp> <thr><unit> (currently <v.toFixed(2)><unit>)"`, `severity: "critical" | "ok"`. Note body uses an em dash (DESIGN.md bans em dashes in copy).
- Multi-process: with >1 dashboard process each would evaluate and notify independently (double sends). Today one container.

### Channels (`channels.server.ts`)
```ts
export type ChannelType = "webhook" | "slack" | "discord" | "email" | "sms";   // :47 (string union, not const map)
export type Channel = { id: string; name: string; type: ChannelType; enabled: boolean; config: Record<string, string> };
export type FieldDef = { key: string; label: string; placeholder?: string; secret?: boolean };
export const CHANNEL_TYPES: Record<ChannelType, { label: string; hint: string; fields: FieldDef[] }>  // :59
export type Msg = { title: string; body: string; severity: "critical" | "warning" | "ok" };  // :160
export async function send(channel: Channel, msg: Msg): Promise<{ ok: boolean; error?: string }>  // :162
```
- Secret fields (`secret: true`: email `pass`, sms `token`) encrypted at rest via `encryptSecret/decryptSecret` (`lib/crypto.server.ts`), `cryptChannel` :100. `redact(c)` :150 for the client.
- Helpers: `loadChannels(orgId)` :107, `insertChannel` :125, `toggleChannel` :130, `deleteChannel` :138, `getChannel(orgId,id)` :142.
- Delivery:
  - webhook: `assertSafeUrl(url)` (SSRF guard :29, private IP/DNS check), POST JSON `{...msg, source:"backwork.dev", ts}`, `redirect:"manual"`.
  - slack: allowHosts `["slack.com"]`, POST `{ text: "*title*\nbody" }` (incoming webhook, plain text, no blocks).
  - discord: allowHosts discord.com/discordapp.com, `{ content: "**title**\nbody" }`.
  - email: **per-channel SMTP** credentials supplied by the user (nodemailer `createTransport({host, port, secure: port===465, auth})`), `text` only. Does not use the system mailer.
  - sms: Twilio REST `POST /2010-04-01/Accounts/<sid>/Messages.json`, Basic auth sid:token, user-supplied.
- System mailer, separate: `lib/mailer.server.ts:5 sendMail(to, subject, text): Promise<boolean>` order: AWS SES (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`, from `SES_FROM_EMAIL` default `backwork.dev@ms.mailtrooper.com`) -> SMTP env (`SMTP_HOST/PORT/USER/PASS/FROM`) -> console log, returns false. Used for resets/invites. Text only, no HTML. A digest email to members (not a channel) would use this.
- `send` does not take HTML/blocks/attachments; a digest with richer layout needs either a `Msg` extension (e.g. optional `lines`/`fields`) or Slack-specific formatting inside `send`.

### Audit trail for alerts
**None.** `routes/alerts.tsx` action never calls `logAudit` (grep: logAudit only in controls.server.ts, projects, account, members, errors.$id, billing, login, api-keys). Firings are not logged anywhere persistent either.

### Route `/alerts` (`routes/alerts.tsx`)
- loader :16 `requireOrg`, `defer({ data: Promise.all([evaluate, loadChannels]).then(...redact).catch(()=>empty), meta: METRIC_META, channelTypes: CHANNEL_TYPES })`.
- action :28 `assertSameOrigin(request)`; `requireOrg`; `requireRole(ctx, "member")` (viewers read-only); intents `add_channel|toggle_channel|delete_channel|test_channel` (test returns `json({test})` for a `useFetcher`), `add|toggle|delete`. Validation for `add` :65-70 (`isAlertMetric`, comparator, finite threshold) -> `json({formError}, 400)` (the page never renders `formError`).
- UI: `PageTitle` with `sub` (rendered as an InfoTip icon, not a paragraph: OK), then 4 identical stat cards (DESIGN.md anti-reference "identical card grid"), rules table, New rule form (`lg:grid-cols-12`), Channels list, New channel form. CardHead `sub` strings contain em dashes / long text (truncate, fine).

### Add a new rule kind end to end (recipe)
1. `lib/alert-kinds.ts`: add key to `AlertMetric` (e.g. `RouteP95: "route_p95"`, `RouteErrorRate: "route_error_rate"`, `SlowQuery: "slow_query"`). `isAlertMetric` picks it up.
2. `alerts.server.ts`: add to `METRIC_META` (Record forces it; tsc fails otherwise). Extend `AlertRule` with optional kind-specific fields (`route?: string`, `window?: "5m"|"15m"`, `shape?: string`) or a discriminated union keyed by `metric`. Data is jsonb, no DDL.
3. Evaluation: `evalRule` is Loki-only. p95 / route error rate live in VictoriaMetrics (`backwork_hop_*`; see `lib/vm.server.ts`, `lib/hops/metrics.server.ts`). Branch in `evalRule` by kind: Loki kinds keep `ruleQuery`; metric kinds build PromQL and call the VM scalar helper with the tenant's `org_id` label. Keep the query builder pure + exported (like `ruleQuery`) so it is unit-tested by string equality. Keep the tri-state (`undefined`/NaN => noData).
4. `ruleQuery`'s `switch` has no default: adding a kind without a case is a tsc error (return type `string`). Good guard; keep exhaustive switches.
5. Route action :64: accept and validate the new fields per kind (route must be a known route, threshold units ms vs ratio).
6. Form :228-253: metric select is generated from `d.meta`; kind-specific inputs (route picker) must be added; condition column :204 renders `label cmp threshold unit`, add route.
7. Evaluator `notify` :51 builds body from META; add route/shape to `scope`.
8. Tests: extend `alerts.server.test.ts` "alert kinds" test `expect(Object.keys(METRIC_META).sort()).toEqual(["error_rate","log_rate"])` (:8) will FAIL by design; update it. Add query-string tests. Add a pure transition test by extracting the tick decision into a pure function (none exists today).

### Existing alert tests (verbatim, `lib/alerts.server.test.ts`)
```ts
const base: AlertRule = { id: "r1", name: "x", metric: AlertMetric.ErrorRate, service: "*", comparator: ">", threshold: 2, channelIds: [], enabled: true };
describe("alert kinds", () => {
  test("only log-based kinds remain", () => {
    expect(Object.keys(METRIC_META).sort()).toEqual(["error_rate", "log_rate"]);
    for (const k of RETIRED_METRICS) expect(isAlertMetric(k)).toBe(false);
  });
  test("a stored container rule comes back disabled with the note", () => { /* normalizeRule => enabled false, retired RETIRED_NOTE */ });
  test("a log rule is unchanged", () => { expect(normalizeRule(base)).toEqual(base); });
  test("rules count ordinary log lines, never hop records", () => {
    expect(ruleQuery(AlertMetric.ErrorRate, "*")).toBe('sum(rate({kind!="hop",level="error",service=~".+"}[5m]))');
    expect(ruleQuery(AlertMetric.LogRate, 'a"b')).toBe('sum(rate({kind!="hop",service="a\\"b"}[5m]))');
  });
});
describe("one service, one name (BAC-51)", () => {
  // buildServiceNames([{ source: "dev-commerce-api-dserve", service: "commerce-api" }])
  // ruleQuery(ErrorRate, "commerce-api", names) === 'sum(rate({kind!="hop",level="error",source=~"dev-commerce-api-dserve"}[5m]))'
  // ruleQuery(LogRate, "worker", names) === 'sum(rate({kind!="hop",service="worker"}[5m]))'
  // a rule saved under the container name still matches after relabel
});
```
No evaluator test, no channel test.

## 2. Scheduled work

Two in-process schedulers, both started lazily from request handlers with a `globalThis` flag (survives Vite HMR re-import; does NOT coordinate across processes):

| Job | Started from | Guard | First run | Interval | unref |
|---|---|---|---|---|---|
| Alert evaluator `tick` | `root.tsx:79` root loader -> `ensureEvaluator()` (`lib/evaluator.server.ts:71`) | `globalThis.__bwEvaluatorStarted` | `setTimeout(tick, 8000)` (baseline only) | `setInterval(tick, 60000)` | no |
| Plan trim `runPlanTrim` | `routes/ingest.loki.api.v1.push.tsx:25` -> `startPlanJobs()` (`lib/plans/retention.server.ts:131`) | `globalThis.__bwPlanJobs` | `FIRST_RUN_AFTER_MS = 2*60_000` | `TRIM_EVERY_MS = 10*60_000` | yes |
| Trial settle `billing().settleTrials()` | same `startPlanJobs()` | same | 2 min | `TRIALS_EVERY_MS = 6h` | yes |

- Consequence: the evaluator starts only after someone loads a page (any route rendered under root); plan jobs only after the first agent push. A process that only serves ingest never runs alerts; one that only serves pages never trims.
- Other globals: `__bwSchemaReady` (`db/index.server.ts:193`), `__bwRate` rate-limit map (`lib/auth/security.server.ts:22`). `cached()` in `lib/cache.server.ts:10` (in-memory TTL map, per process).
- One-time jobs use the `migrations` table as a "done" marker: `INSERT INTO migrations (name) ... ON CONFLICT DO NOTHING` (`alerts.server.ts:61/72`, `:177/196`).
- Deployment today: one dashboard container (`docker-compose.yaml`), so single-process is assumed throughout (rate limiter comment `security.server.ts:17` "single server process").

### Where a weekly job (digest, feature 10) should live
- New module e.g. `lib/digest/schedule.server.ts` exporting `startDigestJobs()` with `globalThis.__bwDigestJobs` guard, called from both `root.tsx` loader (next to `ensureEvaluator()`) and `startPlanJobs()`, or better: one `lib/jobs.server.ts` `startBackgroundJobs()` that starts evaluator + plan jobs + digest, called from both places (fixes the "only after first push" asymmetry). Timer: `setInterval(check, 15*60_000).unref()`; on each check compute "is a digest due" from stored state, never from timer cadence (restarts would otherwise skip or repeat).
- Double-send protection must be in Postgres, not memory: a `digest_runs` row keyed `(org_id, period_start)` PRIMARY KEY, claimed with `INSERT ... ON CONFLICT DO NOTHING RETURNING` before sending; only the process that got the row sends. Mark `sent_at`/`error` after. Same idea for alert firings if >1 process: `alert_state (org_id, rule_id) PK, firing bool, since, last_notified_at` updated with a conditional `UPDATE ... WHERE firing <> $new RETURNING` so exactly one process wins the transition. `pg_try_advisory_lock(hashtext('bw:digest'))` per tick is an alternative single-leader lock (pool `max: 8`, lock is per connection: use a dedicated client from the pool and release it).

## 3. Peers (`lib/hops/peers.ts`, `lib/hops/peers.server.ts`, table `peer_services`)

- Table (`db/index.server.ts:108-111`, `db/schema.ts:124-129`): `peer_services (org_id text NOT NULL, peer text NOT NULL, service text NOT NULL, last_seen timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org_id, peer, service))`. No FK to orgs, no counts, no latency, no errors, no caller service.
- Meaning: "calls addressed to host/queue `peer` were answered by service `service`". Pure builder `peerPairs(records: readonly HopRecord[]): PeerPair[]` (`peers.ts:15`): outbound (`HopKind.Out|OutEnd`, not a store via, with `peer`) hop whose `hopId` is the `parentHop` of an inbound (`HopKind.In|InEnd`) hop -> `{ peer, service: inbound.service }`. `calledPeers(records): string[]` (:31).
- `interface PeerStore { known(orgId, peers): Promise<Set<string>>; save(orgId, pairs): Promise<void> }` (`peers.server.ts:12`); `peerStore` upserts `last_seen = now()`, skips pairs written in-process in the last 10 min (`REWRITE_AFTER_MS`), `known` cached 30 s. `knownPeersFor(orgId, pairs, called, store = peerStore): Promise<string[] | null>` (:46) never throws (null = unknown).
- Filled **only as a side effect of reads**: `routes/requests_.$id.tsx:54` (request view) and `lib/hops/attention.server.ts:240` (Overview "calls never received"). Ingest does not write it. So it only knows pairs seen in requests someone opened or in the attention scan.
- Used to decide `PeerKind` "known service that didn't report" vs "not instrumented yet".

### What already exists for a service map (feature 9)
VictoriaMetrics already holds edges with figures. `backwork_hop_duration_seconds` (histogram, `_count`/`_bucket`) has tags `service, dir, via, method, op, peer, outcome, status_class` (`infra/vector/vector.yaml:384-393`, generated from `lib/agent/vector-config.server.ts`; `HopMetric` names at :38-41 there). Outbound (`dir="out"`) series give caller `service` -> `peer` per `via`.
- `connectionsTable(range: PerfRange, tenant: Tenant, knownServices: ReadonlySet<string>, selected: string | null, client: PromClient = vmClient): Promise<ConnectionRow[]>` (`lib/hops/metrics.server.ts:428`), scope `connectionsScope()` = `by ["service","peer","via"]`, health shown (:122). Cached 10 s.
- `interface ConnectionRow extends Figures { service; peer; via: Via | null; peerKind: PeerKind }` (:236); `interface Figures { rate; errorShare; p50|p95|p99: number | null }` (:204). `peerKindOf(via, peer, services)` (:419): Db/Cache/Service/Unmatched. `inboundServices(tenant)` (:515) = services reporting inbound hops in 14 d (pass as `knownServices`).
- Gap for a map: `peer` is a host/queue name, not a service name. Map edge target = `peer_services` lookup (peer -> service) when known, else render the peer as an external node. Needed beyond today: (a) a bulk read `peerServicesFor(orgId): Promise<PeerPair[]>` (no such function; `known` only returns peer names), (b) fill `peer_services` at ingest or from a periodic scan so the map does not depend on someone having opened requests, (c) optionally the inbound side of the same edge (callee's view) by joining `dir="in"` figures of the resolved service. No new table strictly needed for counts/latency/errors (VM has them over its 14 d retention).

## 4. Postgres bootstrap (`db/index.server.ts`, `db/schema.ts`)

- `db = drizzle(pool, { schema })`, `pg.Pool({ connectionString: DATABASE_URL || "postgresql://backwork:backwork_dev_pw@postgres:5432/backwork", max: 8 })` wrapped in `survivePoolErrors` (:6-13).
- `const DDL = \`...\`` (:17-189): one string of idempotent statements: `CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `DROP TABLE IF EXISTS` for removed tables. `ensureSchema(): Promise<void>` (:196) runs it once per process (memoised promise in `globalThis.__bwSchemaReady`, reset on failure). Every data function calls `await ensureSchema()` first. No migration tool, no drizzle-kit; `schema.ts` is the typed mirror used by queries only, it does NOT create anything.
- **Known defect (BAC-66, not ours)**: `orgBilling` (`schema.ts:222`) and `billingEvents` (:242) exist in schema.ts but have no `CREATE TABLE` in DDL, so they do not exist on a fresh DB.
- **Rule for new tables (every feature):** add BOTH (1) the `CREATE TABLE IF NOT EXISTS` + indexes to the DDL string in `db/index.server.ts` and (2) the `pgTable` definition in `db/schema.ts`, with identical column names/types. New columns on existing tables: `ALTER TABLE x ADD COLUMN IF NOT EXISTS ...` appended after the table's CREATE (pattern :24, :32-34). Never edit an existing CREATE to add a column (prod already has the table; IF NOT EXISTS skips it). Data backfills: one-time function gated by a `migrations` row name. Prod gets the change on the next boot because DDL runs on first `ensureSchema()`. FK `org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE` + `<table>_org_idx` is the house pattern. Ids are `text` (ulid via `ulid()` in newer code).
- Raw SQL is fine where drizzle is awkward: `db.execute(sql\`...\`)` (`plans/usage.server.ts:36`).

## 5. Ingest endpoints and machine auth

Two machine credentials:
1. **Project ingest token** (write path, agents). `resolveIngestToken(token): Promise<{ orgId: string; projectId: string | null; project: string } | null>` (`lib/tenant.server.ts:26`): sha256 `hashToken` (:20) looked up in `projects.ingest_token_hash`; legacy `INGEST_TOKEN` env -> platform org. Header `Authorization: Bearer <token>`, parsed inline in each route.
   - `POST /ingest/loki/api/v1/push` (`routes/ingest.loki.api.v1.push.tsx`): JSON only (415 otherwise), gzip ok, `enforceStreams` (switches + filter), stamps `org_id` + `project` labels, forwards to Loki, counts usage (`addToDaily`, `addToBucket` when capped), calls `startPlanJobs()`.
   - `POST /ingest/metrics/api/v1/write` (VM remote write proxy), `GET /ingest/controls` (agent poll 30 s), `GET /ingest/ready`.
   - `POST /ingest/errors` (`routes/ingest.errors.tsx`): the cleanest JSON template. 405 non-POST, bearer -> `resolveIngestToken`, 401 `{error:"unauthorized"}`, parse JSON (400), accept single object / `{errors:[...]}` / array, cap 100 per request, per-item try/catch, returns `{accepted, groups}`. Local `json(body,status)` helper. Errors already carry `release` and `environment` in `sample` (`lib/errors.server.ts:59-60`) but nothing groups by release.
2. **Read API key** `bwk_…` (`lib/apikey.server.ts`): `requireApiKey(request): Promise<{ orgId: string }>` (:53) throws JSON 401; `apiJson(body, status=200)` (:45) sets `cache-control: no-store`, `access-control-allow-origin: *`. Keys in `api_keys` (hashed), created on `/api-keys` (audited `apikey.create/revoke`). Routes `api.v1.me.tsx`, `api.v1.services.tsx` (typed `ServiceFigures` snake_case response), `api.v1.errors.tsx`. Read-only by convention.

### Report-a-deploy endpoint (feature 6) should copy
- Route file `routes/ingest.deploys.tsx` (`POST /ingest/deploys`), auth with project ingest token exactly like `ingest.errors.tsx:11-14` (CI already holds the project token used by the agent; deploy is a write into a project). Tenant gives `orgId`, `projectId`, `project` slug. Optional: also accept `bwk_` keys via `resolveApiKey` for org-level reporters, but then project is unknown.
- Body (typed, validated, not `as any` like ingest.errors): `{ service: string; version?: string; commit?: string; environment?: string; at?: ISO string; url?: string; actor?: string }`, single or `{deploys:[...]}`, cap N. Return `{accepted}`.
- Rate limit: ingest routes have none today. Use `rateLimit(\`deploy:${projectId}\`, 60, 60*60_000)` from `lib/auth/security.server.ts:28` (in-memory, per process) -> 429 with `retry-after`.
- No `assertSameOrigin` on machine endpoints (it only checks requests carrying an `Origin` header; agents/curl send none, `security.server.ts:44-46`). Every browser form action must call `assertSameOrigin(request)` first (alerts.tsx:29 pattern), then `requireOrg`, then `requireRole`.
- Read side: `GET /api/v1/deploys` with `requireApiKey` + `apiJson` for symmetry.

## 6. Plan trim, retention, usage counters

### Stack retention (all orgs, Loki compactor, `infra/loki/loki-config.yaml`, image `grafana/loki:3.3.0`)
- `retention_period: 168h` (7 d ordinary lines); `retention_stream: [{ selector: '{kind="hop"}', priority: 1, period: 720h }]` (hops 30 d). `compactor.retention_enabled: true`, `delete_request_store: filesystem`, `delete_request_cancel_period: 10m` (deleted range hidden/applied 10 min after request; default 24 h). Compaction interval is Loki's default (10m).
- VictoriaMetrics keeps the `backwork_hop_*` series 14 d (`inboundServicesQuery` comment, `metrics.server.ts:510`).

### Plan trim (`lib/plans/retention.server.ts`)
- `limitsFor(row: OrgPlanRow): Limits | null` (`plans/limits.ts:45`); `interface Limits { plan; maxRequests: number|null; maxBytes: number|null; hopDays: number|null; logDays: number|null }` (:24). `isCapped(l)` = has maxRequests or maxBytes (only Free, or overrides). Plan retention (`components/site/plans.ts`): Free 3 d/3 d, Team hops 30 d / logs 14 d, Business 90/30, Enterprise null. Unmetered orgs skipped (`ne(orgs.plan, "unmetered")`, :109).
- `trimOrg(orgId, limits, loki: LokiOps, store: BucketStore, nowMs, lastCutS = new Map()): Promise<TrimReport>` (:52):
  1. Age expiry, every limited org (paid too): `loki.remove('{org_id="<id>",kind="hop"}', fullStartS, expiryEnd(now, hopDays))` and same for `kind="log"`. `fullStartS` = now-30 d rounded to the day; `expiryEnd` rounds down to the hour (repeat runs send identical ranges).
  2. Capped only: `windowCutoff(buckets, maxRequests, maxBytes)` (`plans/window.ts:24`, 5-min buckets, bytes target 0.9) -> `loki.remove('{org_id="<id>"}', startS, cutoffS)` (ALL kinds), then `store.prune(orgId, cutoffS)` deletes `org_buckets` rows. `lastCutS` in-memory map so later runs only re-ask from `previous - OVERLAP_S (2h)`.
- `interface LokiOps { remove(query: string, startSeconds: number, endSeconds: number): Promise<void> }` (:26). Real impl `lokiOps` (:88): `POST ${LOKI_URL}/loki/api/v1/delete?query=&start=&end=`; 400 treated as "already queued". `selector(orgId, kind?)` (:42) is the only query shape used: **deletes by stream labels only (`org_id`, optional `kind`), never by line content.**
- `runPlanTrim(loki = lokiOps, store = dbStore, nowMs = Date.now()): Promise<TrimReport[]>` (:104), per-org try/catch, logs JSON `{"msg":"plan trim",...}`.

### Loki delete API: can / cannot (3.3)
- Can: a LogQL **stream selector plus optional line-filter pipeline** (`|=`, `!=`, `|~`, `!~`), and a `[start, end]` range; cancel within `delete_request_cancel_period`; list requests `GET /loki/api/v1/delete`; cancel `DELETE /loki/api/v1/delete?request_id=`. So "delete org X's lines except those containing trace id A or B" is expressible as `{org_id="X"} != "A" != "B"`.
- Cannot: parsers / label-filter stages on parsed fields (`| json | trace_id!="A"`), metric queries, a "keep" list as a set, or more than a modest number of filters per request (each `!=` is a full-chunk scan; line-filter deletes rewrite chunks, much costlier than whole-stream deletes). Cannot exempt lines from `retention_period` / `retention_stream` (compactor retention is per stream, not per line): **nothing in Loki survives beyond 30 d (hops) / 7 d (lines) regardless of plan or pins.**
- Delete is asynchronous: compactor applies it after the cancel period; queries hide the range once the period passed.

### What a pin (feature 11) must do
- Only a copy survives. Pinning must snapshot the request into Postgres at pin time: hop records (`HopRecord[]` from `progressiveLookup(traceId, tenant, now)` in `lib/hops/query.server.ts:86`, as the request view uses it) and log lines (`logLinesFor(traceId, windowResult, tenant, now)` :100 / `logsOnly` :145), plus links. Store raw lines (the request view rebuilds the tree with `buildRequestTree` etc. from records), so the view can render from the snapshot when Loki no longer has it.
- Optionally make the trim job skip pinned trace ids for capped orgs by adding `!= "<traceId>"` filters to the window delete (bounded count, e.g. ≤ 20 pins per org), but that still fails at the stack retention, so the snapshot is the real mechanism; the filter is not worth its cost.
- The request view loader (`routes/requests_.$id.tsx:67`) would check `pinned_requests` first and fall back to Loki, or merge.
- Pinned bytes should count against the plan (or be capped per plan, e.g. Free N pins).

### Usage counters (`lib/plans/usage.server.ts`)
- `org_daily (org_id, day date, requests, bytes) PK(org_id, day)`: every metered org (any plan except unmetered), never trimmed; `addToDaily(orgId, {requests, bytes}, atMs)` :54, `loadDaily(orgId, fromDay)` :62, `firstCountedDay(orgId)` :73.
- `org_buckets (org_id, bucket bigint unix s, requests, bytes) PK(org_id, bucket)`: capped orgs only; `addToBucket` :35, `loadBuckets(orgId, sinceS)` :43, `pruneBuckets(orgId, beforeS)` :79, `bucketsSince(nowMs)` :84 (31 d).
- `orgLimits(orgId)` :16 cached 30 s (`cached("plan:<id>")`); `isWindowed(orgId)` :29. Called from the Loki push proxy after a successful forward (`ingest.loki.api.v1.push.tsx:66-72`). "requests" counted by `enforceStreams` = inbound hop end records.

## 7. UI plumbing

- **Nav** `root.tsx:110-120` (verbatim shape): `const NAV = [{ to: "/", label: "Overview", icon: LayoutDashboard, end: true }, { to: "/requests", ... Network }, { to: "/performance", ... Gauge }, { to: "/logs", ... ScrollText }, { to: "/errors", ... Bug }, { to: "/alerts", ... BellRing }, { to: "/projects", ... FolderKanban }, { to: "/billing", ... CreditCard }, { to: "/settings", ... Cog }]`. Untyped array literal; icons from `lucide-react`. Desktop sidebar maps it (`root.tsx:489`, `prefetch="intent"`). Phone `MobileNav` (:530): `primary = NAV.slice(0, 4)` tabs + "More" button; `rest = NAV.slice(4)` in a bottom sheet grid of 3 columns (fixed overlay z-40, not top layer, but it is full-screen fixed so not clipped). Adding a nav item = one entry in NAV at the right index (position < 4 changes the phone tabs). 9 items now; a 10th makes "More" a 6-item 3x2 grid (fine) . Secondary pages (Members, Teams, Audit, API keys, Account) live in the org menu `AuthMenu` (:442-463), absolutely positioned dropdown `z-40` inside the sticky header (UI_ISSUES 2 says menus belong in the top layer; FindRequest already uses `popover="manual"` + `showPopover()` at :245-257: copy that).
- **Root loader** (:78): calls `ensureEvaluator()`, public/marketing path sets render bare, otherwise `requireOrg`. `shouldRevalidate` (:104) skips root on same-path polls (LiveStatus revalidates every 10 s).
- **Page shell**: `<main className="mx-auto w-full max-w-[1440px] flex-1 px-4 pt-3 pb-24 sm:px-6 sm:pt-4 lg:pb-6">` (:520). Pages start with `<div className="space-y-5 animate-fade-in">` then `PageTitle`.
- **Primitives** `components/ui.tsx`:
  - `Card({ className, children })` :5 `<section class="rounded-xl border border-border bg-surface">`.
  - `CardHead({ title, sub?, subTitle?, right?, className? })` :13, one row, `min-h-11`, `data-card-head`, sub inline truncated (≤48 px, BAC-53). `CardHeadText({ title, sub?, subTitle?, level?: 2|3 })` :36 for custom headers.
  - `PageTitle({ title: string, sub?: string, right?: ReactNode, growRight?: boolean })` :76: one row h1 17 px, `sub` goes into `InfoTip` (icon + title attr), never a paragraph; controls `right` must be h-8. `data-page-head` gives 12 px gap to first section.
  - `Badge({ children, tone?: "neutral"|"ok"|"warn"|"err"|"info"|"brand"|"accent", className? })` :131. Status tones only for status (PRODUCT.md).
  - Also `InfoTip` :63, `StatusDot/StatusPill` (Status = "up"|"degraded"|"down"|"stopped") :109/121, `KeyStat` :156, `Empty({icon?, title?, children?, cta?})` :176, `ErrorNote({error})` :187, `Skeleton` :196, `Sparkline` :201, `Meter` :237.
- **Deferred** `components/defer.tsx:7` `Deferred<T>({ resolve: Promise<T>, fallback, children: (v: T) => ReactNode })` = Suspense + Await with errorElement "data source unavailable"; `RowsSkeleton({rows?})` :27, `ChartSkeleton({height?})` :37. Loader pattern: `return defer({ part: promise.catch(...) })` per section (render first, load progressively). The request view wraps parts in `settle()` -> `{ok,value}|{ok:false,error}` (`requests_.$id.tsx:56`) so each part shows its own error.
- **New page**: add `routes/<name>.tsx` (Remix flat routes: `a.b.tsx` = `/a/b`, `a_.$id.tsx` = `/a/:id` without parent layout), export `meta` (`[{ title: "X · backwork.dev" }]`), `loader` with `requireOrg` + `defer`, optional `action` with `assertSameOrigin` -> `requireOrg` -> `requireRole`, default component. Add to `NAV` or the org menu. Resource routes (no default export) skip the root loader (machine endpoints).
- **Roles** (`db/schema.ts:4-5`): `type Role = "owner" | "admin" | "member" | "viewer"`, `ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 }`. `lib/auth/context.server.ts`: `requireOrg(request): Promise<OrgContext>` :49 (`{ user, memberships, org: {id,name,slug}, role }`), `hasRole(role, min)` :63, `requireRole(ctx, min)` :67 throws 403. Patterns: alerts `requireRole(ctx, "member")` (viewers read-only); audit / api-keys / controls `admin` (`canManageControls(ctx) = hasRole(ctx.role, "admin")`, `lib/controls-view.server.ts:215`); UI flags computed inline `d.role === "owner" || d.role === "admin"` (projects.tsx:172, members.tsx:99, billing.tsx:104) - prefer `hasRole` passed from loader.
- **Audit** `lib/audit.server.ts`: `logAudit({ request?, orgId?, actorUserId?, action: string, target?: Record<string, unknown> }): Promise<void>` :9 best-effort, called `void logAudit(...)`; `recentAudit(orgId, limit=100): Promise<AuditRow[]>` :41; page `/audit` (admin). Table `audit_log (id, org_id, actor_user_id, action text, target jsonb, ip, created_at)`. Action names are free strings `<area>.<verb>` (no enum): `project.create`, `apikey.revoke`, `member.role_change`, `billing.cancelled`, `filter_pattern.delete`, `error.<intent>`, `auth.login`. New features should add a const map (e.g. `AuditAction`) for their own names. **Should be audited (not today):** alert rule add/toggle/delete, channel add/toggle/delete (destinations and credentials), digest subscription changes, pin/unpin, deploy-marker deletes, any new token. Machine events (deploy reported) go to their own table, not audit.

## 8. Tests

- Runner `bun test` (`dashboard/package.json` "test"); `import { describe, expect, test } from "bun:test"`. Tests live beside code as `*.test.ts` / `*.server.test.ts`; excluded from `tsc` (`tsconfig.json` exclude `**/*.test.ts`). `npm run typecheck` = `tsc`. **No lint script** in package.json.
- Pure tests by string equality on query builders (`alerts.server.test.ts`, `metrics.server.test.ts`, `requests.server.test.ts`) and pure functions (`controls.server.test.ts` imports `resolveEffective`, `applyFilter`, `validatePattern` from a `.server.ts` file and uses a `row()` factory with `Partial<ControlRow>`; no DB).
- Side effects injected through narrow interfaces with real defaults: `LokiOps`/`BucketStore` (retention), `PeerStore` (`knownPeersFor(..., store)`), `PromClient` (metrics), `HopQueryFn` (query.server), `BillingStore`/`InkressBilling` with in-memory `MemoryStore` in `lib/billing/testkit.ts`. Fakes are inline objects pushing calls into arrays (`retention.test.ts:11-19`).
- **DB-backed test pattern** (`lib/plans/daily.server.test.ts`): opt-in, skipped unless env set:
  ```ts
  const url = process.env.USAGE_TEST_DATABASE_URL;
  const ready = !!url && process.env.DATABASE_URL === url;
  test.skipIf(!ready)("...", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");   // dynamic import AFTER env check (db reads DATABASE_URL on import)
    await ensureSchema();
    const org = `usage-test-${Date.now()}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'Usage test', ${org})`);
    try { /* exercise, expect */ } finally { await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`); }  // cascade cleans child rows
  });
  ```
  Run: `DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test <file>`. New tables with `REFERENCES orgs ON DELETE CASCADE` get cleanup for free. This also proves the DDL creates the table on a fresh DB (would have caught BAC-66).

## 9. Conventions

- `.server.ts` = touches DB/network/env (never imported by client code); pure logic in plain `.ts` that components can import (`alert-kinds.ts`, `hops/figures.ts`, `hops/peers.ts`, `plans/limits.ts`, `plans/window.ts`, `service-names.ts`). Pure files say "Pure." in the header comment.
- Enums: `export const X = { A: "a" } as const; export type X = (typeof X)[keyof typeof X];` plus `X_LIST = Object.values(X)` / `isX()` guard (`alert-kinds.ts`, `hops/types.ts`, `hops/figures.ts`). Exhaustive `switch` without default so tsc catches a new member. Older code still has string unions (`ChannelType`, `Msg.severity`, notify `kind`); new code uses const maps.
- Explicit types on exports, `interface` for shapes, branded ids (`TraceId`, `HopId`). No `any` in new code; existing `any` at boundaries: nodemailer/SES dynamic imports, `ingest.errors.tsx` body, `readJsonArray`, `catch (e: any)` in channels.send, `Deferred` Await cast. JSONB `data` cast `as unknown as AlertRule` (should be validated on read in new code).
- Header comment on each module citing design section / ticket (BAC-xx). Plain copy, no em dashes, units always shown.
- Ids: `ulid()` (audit, api keys) vs `"r"+Date.now().toString(36)` (alerts). Use `ulid()`.
- Best-effort writes that must not break a request: `void fn().catch(() => {})`. JSON log lines: `console.log(JSON.stringify({ msg, ... }))`.
- Caching: `cached(key, ttlMs, fn)` per process; key includes org id.
- Tenant scoping: every Loki/VM read passes `tenant` (`tenantOf(orgId)`), the backends add `org_id` filter (platform org unfiltered). Never hand-build `org_id` matchers in reads (retention deletes are the exception).

## 10. Per feature: what to import, what to add

### Feature 5: slowness alerts (route p95, route error rate, slow query shapes)
- Import: `AlertMetric`, `isAlertMetric` (`lib/alert-kinds.ts`); `AlertRule`, `AlertState`, `METRIC_META`, `evaluate`, `insertRule`, `loadRules`, `ruleQuery` (`lib/alerts.server.ts`); `quantileQuery`, `errorRateQueries`, `routesScope(service, health)`, `parseRange`, `isLabelValue`, `promString`, `type Scope`, `HealthChecks` (`lib/hops/metrics.server.ts`); `windowIncrease`/`windowPerSecond` (`lib/hops/counter-window.ts`); `vm.instant` / `vm.scalar(query, fallback, tenant)` (`lib/vm.server.ts:32/41`, tenant-scoped by `extra_filters[]`); `Channel`, `send`, `loadChannels` (`lib/channels.server.ts`); `logAudit`.
- Route = VM labels `service, method, op` on `backwork_hop_duration_seconds{dir="in"}`. p95: `quantileQuery(0.95, "in", { by: [], where: { service, method, op }, health: HealthChecks.Hidden }, range, "5m")` style (window param exists :155). Error rate: the two `errorRateQueries` results added in code divided by `rateQuery` (cannot be one PromQL; see comment :136). Check the window functions handle short windows (they are tuned for bursty counters: `counter-window.ts`).
- Slow query shapes: SQL text (`stmt`, `table`) is NOT a VM label (store metrics carry only service/via/method/op/store). Needs Loki over hop records (`kind="hop"`, `| json`/logfmt + `stmt`), see `lib/hops/stmt.ts` `splitStatement`; or a new VM series. Coordinate with the area that owns query shapes.
- Storage: no new table for rules (jsonb). Recommended new table to make state durable + single-sender: `alert_state (org_id text FK orgs cascade, rule_id text, firing boolean NOT NULL, value double precision, since timestamptz, last_notified_at timestamptz, PRIMARY KEY (org_id, rule_id))`; optional `alert_events (id, org_id, rule_id, kind 'firing'|'resolved', value, at, delivered jsonb)` for history and the digest. Add a "for N minutes" field if p95 flaps (rule field `forMinutes?`).
- Extract tick decision into a pure function `transition(prev: boolean | undefined, s: AlertState): "firing" | "resolved" | null` and test it; today untested.
- Audit alert/channel changes.

### Feature 6: deploy markers
- Import: `resolveIngestToken` (`lib/tenant.server.ts:26`), `rateLimit` (`lib/auth/security.server.ts:28`), `requireApiKey`, `apiJson` (`lib/apikey.server.ts`), `ensureSchema`, `db`, `ulid`, `canonicalName` / `serviceNamesWithin` to map the reported service name to the canonical one (`lib/service-names(.server).ts`).
- Endpoint: `routes/ingest.deploys.tsx` `POST /ingest/deploys` (bearer project token; copy `ingest.errors.tsx` structure, typed validation, 405/401/400/429). Read: `GET /api/v1/deploys?service=&since=` (`requireApiKey`). Optional `/install.sh`-style curl snippet on the project page.
- Table: `deploys (id text PK, org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, project_id text REFERENCES projects(id) ON DELETE SET NULL, service text NOT NULL, version text, commit_sha text, environment text, url text, actor text, deployed_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())` + `CREATE INDEX IF NOT EXISTS deploys_org_service_at_idx ON deploys (org_id, service, deployed_at DESC)`. Optional dedupe `UNIQUE (org_id, service, commit_sha)`. Add to both DDL and schema.ts.
- Consumers: Performance trend charts (marker x positions), alert/digest text ("since deploy v1.2"). Error groups already carry `release` in sample (`lib/errors.server.ts:59`).

### Feature 9: service map
- Import: `connectionsTable`, `ConnectionRow`, `Figures`, `inboundServices`, `servicesTable`, `peerKindOf`, `PeerKind`, `PerfRange`, `parseRange`, `vmClient`/`PromClient` (`lib/hops/metrics.server.ts`); `peerServices` table and `PeerPair` (`lib/hops/peers.ts`); `cached`.
- Edges with rate / errorShare / p50/p95/p99 already come from `connectionsTable` (VM, 14 d). Nodes: `inboundServices` + peers. Needed: new read `peerServicesFor(orgId): Promise<PeerPair[]>` in `peers.server.ts` (bulk peer -> service resolution; `PeerStore` interface gains it) so an edge `service -> peer` becomes `service -> service`. Optional: write `peer_services` during ingest or a periodic scan so resolution does not depend on page views; add `ALTER TABLE peer_services ADD COLUMN IF NOT EXISTS ...` only if counts are wanted (not needed: VM has them). Layout pure in a `.ts` file (graph + layout), page `routes/map.tsx` or a tab of Performance; no new table required.

### Feature 10: weekly digest (Slack or email)
- Import: `Channel`, `send`, `loadChannels`, `CHANNEL_TYPES` (`lib/channels.server.ts`) for Slack/Discord/webhook/email-channel delivery; `sendMail(to, subject, text)` (`lib/mailer.server.ts:5`) for member email (SES/SMTP env, text only); `servicesTable`, `routesTable`, `inboundHttpTotals` (metrics), `listErrorGroups` (`lib/errors.server.ts`), `loadDaily` (usage), `recentAudit` optional; `memberships`/`users` for recipients; `tenantOf`.
- `Msg` is `{title, body, severity}`, plain text; Slack sends `*title*\nbody`. A digest body is multi-line text; extending `Msg` with optional structured sections is an option but keep `send` backward compatible.
- Tables: `digest_settings (org_id text PK FK cascade, enabled boolean NOT NULL DEFAULT false, channel_ids jsonb NOT NULL DEFAULT '[]', email_member_roles text, weekday smallint NOT NULL DEFAULT 1, hour_utc smallint NOT NULL DEFAULT 8, updated_by text, updated_at)` and `digest_runs (org_id text FK cascade, period_start date, claimed_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, error text, PRIMARY KEY (org_id, period_start))`. Claim with `INSERT ... ON CONFLICT DO NOTHING RETURNING` before sending (no double send across processes or restarts).
- Scheduler: `startDigestJobs()` with `globalThis.__bwDigestJobs`, `setInterval(..., 15*60_000).unref()`, started from root loader and `startPlanJobs()` (see section 2). VM history is 14 d, enough for "this week vs last week".
- Settings UI: card on `/alerts` or `/settings`, `requireRole(ctx, "admin")`, audited (`digest.update`).

### Feature 11: pin worst requests
- Import: `progressiveLookup`, `logLinesFor`, `logsOnly`, `type WindowResult` (`lib/hops/query.server.ts`); `HopRecord`, `TraceId`, `LinkedId`, `TraceLogLine` (`lib/hops/types.ts`); `requireOrg`, `requireRole(ctx, "member")`, `assertSameOrigin`, `logAudit`; `orgLimits`/`limitsFor` to cap pins per plan.
- Table: `pinned_requests (org_id text NOT NULL FK orgs cascade, trace_id text NOT NULL, title text, note text, records jsonb NOT NULL, lines jsonb NOT NULL DEFAULT '[]', links jsonb NOT NULL DEFAULT '[]', bytes integer NOT NULL, pinned_by text REFERENCES users(id) ON DELETE SET NULL, pinned_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org_id, trace_id))`. Snapshot at pin time; Loki retention cannot be bypassed (section 6).
- Request view (`routes/requests_.$id.tsx` loader :67): read the pin first, render from it when Loki has nothing; show "pinned" Badge and Pin/Unpin action (POST intent). List of pins on `/requests` (filter) or its own page. Auto-pin of "worst" requests would be a job (section 2 pattern) picking from VM/Loki, with per-org cap.
- Trim job needs no change if snapshots are used. Do not add `!=` filters to Loki deletes.

## Known defects found in my area (record only, not fixed)
- Alert state is in-memory: restart loses firing state and the first tick after boot only re-baselines, so an alert that resolved during the restart never sends "resolved", and one that started firing during it never sends "firing" until it toggles again.
- Evaluator starts only on a page render; plan jobs only after an agent push (`startPlanJobs` called only from the Loki push route).
- Alert/channel changes are not audited; `formError` from the alerts action is never shown; evaluator notify body uses an em dash; channel/rule ids are timestamp-based (`"c"+Date.now()`), can collide on two quick adds.
- `org_billing`, `billing_events` missing from DDL (BAC-66, known).
- `peer_services` has no FK to orgs (not cleaned on org delete) and is only filled from reads.
- Org menu dropdown (`root.tsx:442`) is absolute `z-40` inside the sticky header, not the top layer (UI_ISSUES 2).
DONE
