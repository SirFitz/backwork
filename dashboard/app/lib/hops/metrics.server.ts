// Performance figures from the hop metrics (backwork rework design, sections 5.3 and 8.1).
//
// Every figure is PromQL over the four series Vector derives from hop records. The query
// builders are pure and exported so they can be unit-tested and run by hand against
// VictoriaMetrics. Queries go through `vm.server.ts`, which scopes them to the viewer's
// organisation (`extra_filters[]`), and are cached for 10 seconds per organisation, range and
// selection (design 13).

import { windowIncrease, windowPerSecond, windowSeconds } from "./counter-window";
import * as vm from "~/lib/vm.server";
import { cached } from "~/lib/cache.server";
import type { Tenant } from "~/lib/tenant.server";
import { Via } from "~/lib/hops/types";
import { HealthChecks, PROM_NOT_HEALTH_CHECK } from "~/lib/hops/health";
export { HealthChecks };

// ---------------------------------------------------------------- fixed sets

import { DEFAULT_RANGE, PERF_RANGES, PeerKind, PerfRange } from "~/lib/hops/figures";
export { DEFAULT_RANGE, PERF_RANGES, PeerKind, PerfRange };

const RANGE_SECONDS: Record<PerfRange, number> = {
  [PerfRange.H1]: 3600,
  [PerfRange.H6]: 6 * 3600,
  [PerfRange.H24]: 24 * 3600,
  [PerfRange.D7]: 7 * 24 * 3600,
};

/** Number of points in a trend sparkline. */
export const TREND_POINTS = 12;

export function parseRange(value: string | null | undefined): PerfRange {
  return (PERF_RANGES as readonly string[]).includes(value ?? "") ? (value as PerfRange) : DEFAULT_RANGE;
}

export function rangeSeconds(range: PerfRange): number {
  return RANGE_SECONDS[range];
}

/** The metric names of design 5.3. */
export const HopMetric = {
  Duration: "backwork_hop_duration_seconds",
  Started: "backwork_hop_started_total",
  StoreSeconds: "backwork_hop_store_seconds_total",
  StoreCalls: "backwork_hop_store_calls_total",
} as const;
export type HopMetric = (typeof HopMetric)[keyof typeof HopMetric];

/** The quantiles shown on the page. */
export const Quantile = { P50: 0.5, P95: 0.95, P99: 0.99 } as const;
export type Quantile = (typeof Quantile)[keyof typeof Quantile];

/** Window for "in progress" (design 8.1): started minus finished over the last 15 minutes. */
export const IN_PROGRESS_WINDOW = "15m";

// ---------------------------------------------------------------- label values

/** A label value placed in a query must satisfy spec HOP-12: 1 to 200 bytes in 0x21..0x7E. */
export function isLabelValue(value: string): boolean {
  if (value.length < 1 || value.length > 200) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

/** A PromQL double-quoted string. Only printable ASCII reaches here, so escaping `\` and `"`
 *  is complete. */
export function promString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A route of one service, as recorded: `method` may be empty (jobs, RPC). */
export interface RouteKey {
  service: string;
  method: string;
  op: string;
}

type Matchers = Record<string, string>;

/** Health-check operations are left out of inbound figures unless shown (`health.ts`). */
function healthMatchers(dir: "in" | "out" | null, health: HealthChecks): string[] {
  return dir !== "out" && health === HealthChecks.Hidden ? [PROM_NOT_HEALTH_CHECK] : [];
}

function selector(metric: string, matchers: Matchers, raw: readonly string[] = []): string {
  const parts = [...Object.entries(matchers).map(([k, v]) => `${k}=${promString(v)}`), ...raw];
  return parts.length ? `${metric}{${parts.join(",")}}` : metric;
}

function windowOf(range: PerfRange): string {
  return range;
}

/** Per second over a window: see counter-window.ts for why this is not `rate()` or a bare `increase()`. */
function perSecond(sel: string, window: string, labels: readonly string[]): string {
  return windowPerSecond(sel, window, labels);
}

// ---------------------------------------------------------------- query builders (pure)

/** What a table groups by and filters on. */
export interface Scope {
  /** Labels to group by, e.g. ["service"] or ["service","method","op"]. */
  by: readonly string[];
  /** Extra exact matchers, e.g. { service: "commerce-api" }. */
  where: Matchers;
  /** Inbound health-check hops hidden (the default) or shown. */
  health: HealthChecks;
}

export function servicesScope(health: HealthChecks = HealthChecks.Hidden): Scope {
  return { by: ["service"], where: {}, health };
}

export function routesScope(service: string, health: HealthChecks = HealthChecks.Hidden): Scope {
  return { by: ["service", "method", "op"], where: { service }, health };
}

export function connectionsScope(): Scope {
  return { by: ["service", "peer", "via"], where: {}, health: HealthChecks.Shown };
}

function by(labels: readonly string[], extra: readonly string[] = []): string {
  return `by (${[...labels, ...extra].join(", ")})`;
}

/** Requests (or calls) per second over the range. */
export function rateQuery(dir: "in" | "out", scope: Scope, range: PerfRange): string {
  const sel = selector(`${HopMetric.Duration}_count`, { dir, ...scope.where }, healthMatchers(dir, scope.health));
  return perSecond(sel, windowOf(range), scope.by);
}

/** Failed requests per second, as two queries whose results are added in code:
 *  `outcome="error"`, and `status_class="5xx"` on records whose outcome is not error. The two
 *  selectors are disjoint, so nothing is counted twice. (A PromQL `or` would keep only the left
 *  side for a key present in both, and `+` would drop keys present in one.) */
export function errorRateQueries(dir: "in" | "out", scope: Scope, range: PerfRange): [string, string] {
  const w = windowOf(range);
  const hm = healthMatchers(dir, scope.health);
  const failed = selector(`${HopMetric.Duration}_count`, { dir, ...scope.where, outcome: "error" }, hm);
  const fivexx = `${HopMetric.Duration}_count{${[
    `dir=${promString(dir)}`,
    ...Object.entries(scope.where).map(([k, v]) => `${k}=${promString(v)}`),
    `outcome!="error"`,
    `status_class="5xx"`,
    ...hm,
  ].join(",")}}`;
  return [perSecond(failed, w, scope.by), perSecond(fivexx, w, scope.by)];
}

/** Latency quantile in seconds over the range. */
export function quantileQuery(q: Quantile, dir: "in" | "out", scope: Scope, range: PerfRange, window?: string): string {
  const sel = selector(`${HopMetric.Duration}_bucket`, { dir, ...scope.where }, healthMatchers(dir, scope.health));
  return `histogram_quantile(${q}, ${windowIncrease(sel, window ?? windowOf(range), [...scope.by, "le"])})`;
}

/** Share of inbound time spent in databases and caches (0..1). */
export function storeShareQuery(scope: Scope, range: PerfRange): string {
  const w = windowOf(range);
  const hm = healthMatchers("in", scope.health);
  const store = selector(HopMetric.StoreSeconds, scope.where, hm);
  const total = selector(`${HopMetric.Duration}_sum`, { dir: "in", ...scope.where }, hm);
  return `${windowIncrease(store, w, scope.by)} / ${windowIncrease(total, w, scope.by)}`;
}

/** Data-store calls per inbound request. */
export function storeCallsPerRequestQuery(scope: Scope, range: PerfRange): string {
  const w = windowOf(range);
  const hm = healthMatchers("in", scope.health);
  const calls = selector(HopMetric.StoreCalls, scope.where, hm);
  const reqs = selector(`${HopMetric.Duration}_count`, { dir: "in", ...scope.where }, hm);
  return `${windowIncrease(calls, w, scope.by)} / ${windowIncrease(reqs, w, scope.by)}`;
}

/** Inbound hops started and not yet finished over the last 15 minutes, by service, never
 *  below zero. A service with starts and no finishes keeps its starts (`or`). */
export function inProgressQuery(health: HealthChecks = HealthChecks.Hidden): string {
  const hm = healthMatchers("in", health);
  const started = windowIncrease(selector(HopMetric.Started, { dir: "in" }, hm), IN_PROGRESS_WINDOW, ["service"]);
  const finished = windowIncrease(selector(`${HopMetric.Duration}_count`, { dir: "in" }, hm), IN_PROGRESS_WINDOW, ["service"]);
  return `clamp_min(${started} - ${finished}, 0) or ${started}`;
}

/** Step of the p95 trend: the range split into TREND_POINTS buckets. */
export function trendStep(range: PerfRange): string {
  return `${Math.max(60, Math.floor(RANGE_SECONDS[range] / TREND_POINTS))}s`;
}

/** p95 per service as a range query with one point per trend step. */
export function trendQuery(range: PerfRange, health: HealthChecks = HealthChecks.Hidden): string {
  return quantileQuery(Quantile.P95, "in", servicesScope(health), range, trendStep(range));
}

/** Requests per second by service and `via`, used to know which services serve HTTP. */
export function viaRateQuery(range: PerfRange, health: HealthChecks = HealthChecks.Hidden): string {
  return rateQuery("in", { by: ["service", "via"], where: {}, health }, range);
}

// ---------------------------------------------------------------- result shapes

export interface Figures {
  /** per second */
  rate: number;
  /** 0..1 share of `rate` that failed */
  errorShare: number;
  /** seconds, null when there is no sample */
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface ServiceRow extends Figures {
  service: string;
  /** 0..1, null when no store counters exist for the service */
  storeShare: number | null;
  storeCallsPerRequest: number | null;
  inProgress: number;
  /** p95 seconds per trend step, oldest first; NaN-free (missing points are dropped) */
  trend: number[];
  /** The `via` with the most inbound traffic. */
  mainVia: Via | null;
}

export interface RouteRow extends Figures {
  service: string;
  method: string;
  op: string;
  storeShare: number | null;
}


export interface ConnectionRow extends Figures {
  service: string;
  peer: string;
  via: Via | null;
  peerKind: PeerKind;
}

/** What the page needs from VictoriaMetrics: an instant and a range query. */
export interface PromClient {
  instant(query: string, tenant?: Tenant): Promise<Array<{ metric: Record<string, string>; value: number }>>;
  range(query: string, opts: { start: number; end: number; step: string }, tenant?: Tenant): Promise<vm.Series[]>;
}

export const vmClient: PromClient = {
  instant: (q, t) => vm.instant(q, undefined, t),
  range: (q, opts, t) => vm.range(q, opts, t),
};

// ---------------------------------------------------------------- reading results

type Sample = { metric: Record<string, string>; value: number };

function keyOf(metric: Record<string, string>, labels: readonly string[]): string {
  return labels.map((l) => metric[l] ?? "").join("\u0000");
}

function toMap(samples: Sample[], labels: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of samples) {
    if (!Number.isFinite(s.value)) continue;
    const k = keyOf(s.metric, labels);
    m.set(k, (m.get(k) ?? 0) + s.value);
  }
  return m;
}

function finiteOrNull(v: number | undefined): number | null {
  return v !== undefined && Number.isFinite(v) ? v : null;
}

const VIA_SET: ReadonlySet<string> = new Set(Object.values(Via));

function asVia(value: string | undefined): Via | null {
  return value && VIA_SET.has(value) ? (value as Via) : null;
}

/** Combine the five figure queries of one scope into rows keyed by the scope's labels. */
export function combineFigures(
  labels: readonly string[],
  parts: { rate: Sample[]; errA: Sample[]; errB: Sample[]; p50: Sample[]; p95: Sample[]; p99: Sample[] }
): Array<{ metric: Record<string, string>; figures: Figures }> {
  const rate = toMap(parts.rate, labels);
  const errA = toMap(parts.errA, labels);
  const errB = toMap(parts.errB, labels);
  const p50 = toMap(parts.p50, labels);
  const p95 = toMap(parts.p95, labels);
  const p99 = toMap(parts.p99, labels);
  const metricByKey = new Map<string, Record<string, string>>();
  for (const s of parts.rate) metricByKey.set(keyOf(s.metric, labels), s.metric);
  const out: Array<{ metric: Record<string, string>; figures: Figures }> = [];
  for (const [k, r] of rate) {
    if (r <= 0) continue;
    const failed = (errA.get(k) ?? 0) + (errB.get(k) ?? 0);
    out.push({
      metric: metricByKey.get(k) ?? {},
      figures: {
        rate: r,
        errorShare: Math.min(1, failed / r),
        p50: finiteOrNull(p50.get(k)),
        p95: finiteOrNull(p95.get(k)),
        p99: finiteOrNull(p99.get(k)),
      },
    });
  }
  return out;
}

async function figuresFor(
  client: PromClient,
  dir: "in" | "out",
  scope: Scope,
  range: PerfRange,
  tenant: Tenant
): Promise<Array<{ metric: Record<string, string>; figures: Figures }>> {
  const [errQA, errQB] = errorRateQueries(dir, scope, range);
  const [rate, errA, errB, p50, p95, p99] = await Promise.all([
    client.instant(rateQuery(dir, scope, range), tenant),
    client.instant(errQA, tenant),
    client.instant(errQB, tenant),
    client.instant(quantileQuery(Quantile.P50, dir, scope, range), tenant),
    client.instant(quantileQuery(Quantile.P95, dir, scope, range), tenant),
    client.instant(quantileQuery(Quantile.P99, dir, scope, range), tenant),
  ]);
  return combineFigures(scope.by, { rate, errA, errB, p50, p95, p99 });
}

const TTL_MS = 10_000;

function cacheKey(tenant: Tenant, range: PerfRange, table: string, selection = "", health: HealthChecks = HealthChecks.Hidden): string {
  return `perf:${tenant.platform ? "platform" : tenant.orgId}:${range}:${table}:${selection}:${health}`;
}

// ---------------------------------------------------------------- tables

/** Services table, busiest first. */
export function servicesTable(
  range: PerfRange,
  tenant: Tenant,
  client: PromClient = vmClient,
  now = Date.now(),
  health: HealthChecks = HealthChecks.Hidden
): Promise<ServiceRow[]> {
  return cached(cacheKey(tenant, range, "services", "", health), TTL_MS, async () => {
    const scope = servicesScope(health);
    const end = Math.floor(now / 1000) * 1000;
    const start = end - RANGE_SECONDS[range] * 1000;
    const [base, share, calls, inflight, vias, trend] = await Promise.all([
      figuresFor(client, "in", scope, range, tenant),
      client.instant(storeShareQuery(scope, range), tenant),
      client.instant(storeCallsPerRequestQuery(scope, range), tenant),
      client.instant(inProgressQuery(health), tenant),
      client.instant(viaRateQuery(range, health), tenant),
      client.range(trendQuery(range, health), { start, end, step: trendStep(range) }, tenant),
    ]);
    const shareM = toMap(share, scope.by);
    const callsM = toMap(calls, scope.by);
    const inflightM = toMap(inflight, scope.by);
    const mainVia = new Map<string, { via: Via; rate: number }>();
    for (const s of vias) {
      const via = asVia(s.metric.via);
      const svc = s.metric.service ?? "";
      if (!via || !Number.isFinite(s.value)) continue;
      const cur = mainVia.get(svc);
      if (!cur || s.value > cur.rate) mainVia.set(svc, { via, rate: s.value });
    }
    const trendM = new Map<string, number[]>();
    for (const s of trend) trendM.set(s.metric.service ?? "", s.points.map((p) => p.v).filter((v) => Number.isFinite(v)));
    return base
      .map(({ metric, figures }): ServiceRow => {
        const service = metric.service ?? "";
        return {
          service,
          ...figures,
          storeShare: finiteOrNull(shareM.get(service)),
          storeCallsPerRequest: finiteOrNull(callsM.get(service)),
          inProgress: Math.max(0, Math.round(inflightM.get(service) ?? 0)),
          trend: trendM.get(service) ?? [],
          mainVia: mainVia.get(service)?.via ?? null,
        };
      })
      .filter((r) => r.service !== "")
      .sort((a, b) => b.rate - a.rate || a.service.localeCompare(b.service));
  });
}

/** Routes of one service, slowest (p95) first. */
export function routesTable(
  service: string,
  range: PerfRange,
  tenant: Tenant,
  client: PromClient = vmClient,
  health: HealthChecks = HealthChecks.Hidden
): Promise<RouteRow[]> {
  if (!isLabelValue(service)) return Promise.resolve([]);
  return cached(cacheKey(tenant, range, "routes", service, health), TTL_MS, async () => {
    const scope = routesScope(service, health);
    const [base, share] = await Promise.all([
      figuresFor(client, "in", scope, range, tenant),
      client.instant(storeShareQuery(scope, range), tenant),
    ]);
    const shareM = toMap(share, scope.by);
    return base
      .map(({ metric, figures }): RouteRow => ({
        service,
        method: metric.method ?? "",
        op: metric.op ?? "",
        ...figures,
        storeShare: finiteOrNull(shareM.get(keyOf(metric, scope.by))),
      }))
      .sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1) || b.rate - a.rate);
  });
}

/** Decide how a connection's destination is shown (design 9, phase 3). */
export function peerKindOf(via: Via | null, peer: string, services: ReadonlySet<string>): PeerKind {
  if (via === Via.Db) return PeerKind.Database;
  if (via === Via.Cache) return PeerKind.Cache;
  if (services.has(peer)) return PeerKind.Service;
  return PeerKind.Unmatched;
}

/** Outbound calls by service and destination. Rows touching `selected` come first, then by
 *  calls per second. */
export function connectionsTable(
  range: PerfRange,
  tenant: Tenant,
  knownServices: ReadonlySet<string>,
  selected: string | null,
  client: PromClient = vmClient
): Promise<ConnectionRow[]> {
  return cached(cacheKey(tenant, range, "connections"), TTL_MS, async () => {
    const scope = connectionsScope();
    const base = await figuresFor(client, "out", scope, range, tenant);
    return base.map(({ metric, figures }): ConnectionRow => {
      const via = asVia(metric.via);
      const peer = metric.peer ?? "";
      return { service: metric.service ?? "", peer, via, peerKind: peerKindOf(via, peer, knownServices), ...figures };
    });
  }).then((rows) => sortConnections(rows, selected));
}

export function sortConnections(rows: ConnectionRow[], selected: string | null): ConnectionRow[] {
  const touches = (r: ConnectionRow): number => (selected && (r.service === selected || r.peer === selected) ? 0 : 1);
  return [...rows].sort((a, b) => touches(a) - touches(b) || b.rate - a.rate || a.service.localeCompare(b.service));
}

/** The service picked by default: the one with the highest error share, then the slowest p95. */
export function defaultService(rows: readonly ServiceRow[]): string | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => b.errorShare - a.errorShare || (b.p95 ?? 0) - (a.p95 ?? 0));
  return sorted[0].service;
}

// ---------------------------------------------------------------- totals for the Requests page

export interface InboundTotals {
  total: number;
  byClass: Record<"2xx" | "3xx" | "4xx" | "5xx", number>;
  errorShare: number;
  p95: number | null;
}

/** Inbound HTTP hops finished over a window, by status class. */
export function httpTotalsQuery(range: string, service: string | null, health: HealthChecks = HealthChecks.Hidden): string {
  const where: Matchers = { dir: "in", via: Via.Http, ...(service ? { service } : {}) };
  return windowIncrease(selector(`${HopMetric.Duration}_count`, where, healthMatchers("in", health)), range, ["status_class", "outcome"]);
}

export function httpP95Query(range: string, service: string | null, health: HealthChecks = HealthChecks.Hidden): string {
  const where: Matchers = { dir: "in", via: Via.Http, ...(service ? { service } : {}) };
  return `histogram_quantile(0.95, ${windowIncrease(selector(`${HopMetric.Duration}_bucket`, where, healthMatchers("in", health)), range, ["le"])})`;
}

/** Inbound HTTP totals for the Requests page's summary and status counts. */
export function inboundHttpTotals(
  range: string,
  service: string | null,
  tenant: Tenant,
  client: PromClient = vmClient,
  health: HealthChecks = HealthChecks.Hidden
): Promise<InboundTotals> {
  const svc = service && isLabelValue(service) ? service : null;
  return cached(cacheKey(tenant, range as PerfRange, "http-totals", svc ?? "", health), TTL_MS, async () => {
    const [counts, p95] = await Promise.all([
      client.instant(httpTotalsQuery(range, svc, health), tenant),
      client.instant(httpP95Query(range, svc, health), tenant),
    ]);
    const byClass = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
    let total = 0;
    let failed = 0;
    for (const s of counts) {
      if (!Number.isFinite(s.value)) continue;
      const n = Math.round(s.value);
      total += n;
      const cls = s.metric.status_class as keyof typeof byClass;
      if (cls in byClass) byClass[cls] += n;
      if (s.metric.outcome === "error" || cls === "5xx") failed += n;
    }
    return { total, byClass, errorShare: total ? failed / total : 0, p95: finiteOrNull(p95[0]?.value) };
  });
}


// ---------------------------------------------------------------- services that report hops

/** Services with inbound hop metrics in the last 14 days (the metrics retention). */
export function inboundServicesQuery(): string {
  return `count by (service) (last_over_time(${HopMetric.Started}{dir="in"}[14d]))`;
}

export function inboundServices(tenant: Tenant, client: PromClient = vmClient): Promise<string[]> {
  return cached(cacheKey(tenant, PerfRange.D7, "inbound-services"), 30_000, async () => {
    const rows = await client.instant(inboundServicesQuery(), tenant);
    return [...new Set(rows.map((r) => r.metric.service ?? "").filter(isLabelValue))].sort();
  });
}

export { windowSeconds };
