// Compare with last week and the p95 trend (BAC-73, insights plan 06 sections A and C).
//
// "Last week" is the same range ending 7 days ago: the figure builders with `offset 7d` and a
// counter lookback short enough to stay inside VictoriaMetrics' 14-day retention
// (`compareLookbackSeconds`). The current window uses the builders' defaults, so its queries are
// the ones the Performance tables send. The verdict rules are pure (`compare.ts`).

import { cached } from "~/lib/cache.server";
import type { Tenant } from "~/lib/tenant.server";
import { HealthChecks } from "~/lib/hops/health";
import {
  COMPARE_OFFSET,
  CompareVerdict,
  canCompare,
  compareLookbackSeconds,
  compareRow,
  regressions,
  type CompareRow,
} from "~/lib/hops/compare";
import { REGRESSION_DEPLOY_LOOKBACK_MS, type ServiceRegression } from "~/lib/hops/attention";
import { deploysBetween } from "~/lib/deploys.server";
import { markerLabel, type Deploy } from "~/lib/deploys";
import {
  PerfRange,
  Quantile,
  isLabelValue,
  quantileQuery,
  rangeSeconds,
  routesScope,
  scopeFigures,
  servicesScope,
  vmClient,
  type Figures,
  type PromClient,
  type Scope,
} from "~/lib/hops/metrics.server";
export * from "~/lib/hops/compare";

/** Compare results are cached this long per organisation, range and scope. */
export const COMPARE_TTL_MS = 30_000;

function keyOf(metric: Record<string, string>, labels: readonly string[]): string {
  return labels.map((l) => metric[l] ?? "").join("\u0000");
}

/** Read both windows of one scope and join them into rows, in the order of the current window. */
async function compareScope(client: PromClient, scope: Scope, range: PerfRange, tenant: Tenant): Promise<CompareRow[]> {
  const lookback = compareLookbackSeconds(range);
  if (lookback === null) return [];
  const seconds = rangeSeconds(range);
  const [now, before] = await Promise.all([
    scopeFigures(client, "in", scope, range, tenant),
    scopeFigures(client, "in", scope, range, tenant, COMPARE_OFFSET, lookback),
  ]);
  const beforeBy = new Map<string, Figures>();
  for (const b of before) beforeBy.set(keyOf(b.metric, scope.by), b.figures);
  return now
    .filter(({ metric }) => (metric.service ?? "") !== "")
    .map(({ metric, figures }) => {
      const was = beforeBy.get(keyOf(metric, scope.by)) ?? null;
      const grouped = scope.by.includes("op");
      return compareRow(
        metric.service ?? "",
        grouped ? metric.method ?? "" : null,
        grouped ? metric.op ?? "" : null,
        figures,
        was,
        figures.rate * seconds,
        was ? was.rate * seconds : 0,
      );
    });
}

function cacheKey(tenant: Tenant, range: PerfRange, scope: string, health: HealthChecks): string {
  return `compare:${tenant.platform ? "platform" : tenant.orgId}:${range}:${scope}:${health}`;
}

/** Every service against the same hours last week. Empty for a range that cannot be compared. */
export function compareServices(
  range: PerfRange,
  tenant: Tenant,
  client: PromClient = vmClient,
  health: HealthChecks = HealthChecks.Hidden,
): Promise<CompareRow[]> {
  if (!canCompare(range)) return Promise.resolve([]);
  return cached(cacheKey(tenant, range, "services", health), COMPARE_TTL_MS, () => compareScope(client, servicesScope(health), range, tenant));
}

/** The routes of one service against the same hours last week. */
export function compareRoutes(
  service: string,
  range: PerfRange,
  tenant: Tenant,
  client: PromClient = vmClient,
  health: HealthChecks = HealthChecks.Hidden,
): Promise<CompareRow[]> {
  if (!canCompare(range) || !isLabelValue(service)) return Promise.resolve([]);
  return cached(cacheKey(tenant, range, `routes:${service}`, health), COMPARE_TTL_MS, () => compareScope(client, routesScope(service, health), range, tenant));
}

// ---------------------------------------------------------------- trend

/** Points on the Trend chart over any range. */
export const TREND_CHART_POINTS = 48;
/** The shortest step of the Trend chart. */
export const TREND_CHART_MIN_STEP_SECONDS = 60;

/** The Trend chart's end is rounded down to this, ms. */
export const TREND_END_ROUND_MS = 60_000;

export function trendChartStepSeconds(range: PerfRange): number {
  return Math.max(TREND_CHART_MIN_STEP_SECONDS, Math.floor(rangeSeconds(range) / TREND_CHART_POINTS));
}

/** p95 of one service per step; with `offset`, last week's p95 at the same instants. */
export function serviceTrendQuery(
  service: string,
  range: PerfRange,
  health: HealthChecks = HealthChecks.Hidden,
  offset: string | null = null,
  lookbackSeconds?: number,
): string {
  const scope: Scope = { by: ["service"], where: { service }, health };
  return quantileQuery(Quantile.P95, "in", scope, range, `${trendChartStepSeconds(range)}s`, offset, lookbackSeconds);
}

export interface TrendPoint {
  /** ms */
  t: number;
  /** p95 seconds */
  v: number;
}

export interface ServiceTrend {
  service: string;
  range: PerfRange;
  /** ms */
  start: number;
  end: number;
  now: TrendPoint[];
  /** the same hours last week, at this week's instants; null on a range without last week (7 d) */
  lastWeek: TrendPoint[] | null;
}

function points(series: Array<{ points: Array<{ t: number; v: number }> }>): TrendPoint[] {
  return (series[0]?.points ?? []).filter((p) => Number.isFinite(p.v)).map((p) => ({ t: p.t, v: p.v }));
}

/**
 * The p95 of one service over the range, and last week's over the same hours. The last-week query
 * carries `offset 7d`, so its points already sit at this week's instants: nothing is shifted.
 */
export function serviceTrend(
  service: string,
  range: PerfRange,
  tenant: Tenant,
  client: PromClient = vmClient,
  now: number = Date.now(),
  health: HealthChecks = HealthChecks.Hidden,
): Promise<ServiceTrend> {
  const step = trendChartStepSeconds(range);
  // the end on the minute (a cache key per minute), not on the step: a 7d step is 3.5 hours
  const end = Math.floor(now / TREND_END_ROUND_MS) * TREND_END_ROUND_MS;
  const start = end - rangeSeconds(range) * 1000;
  const empty: ServiceTrend = { service, range, start, end, now: [], lastWeek: canCompare(range) ? [] : null };
  if (!isLabelValue(service)) return Promise.resolve(empty);
  return cached(`${cacheKey(tenant, range, `trend:${service}`, health)}:${end}`, COMPARE_TTL_MS, async () => {
    const lookback = compareLookbackSeconds(range);
    const opts = { start, end, step: `${step}s` };
    const [cur, prev] = await Promise.all([
      client.range(serviceTrendQuery(service, range, health), opts, tenant),
      lookback === null ? Promise.resolve(null) : client.range(serviceTrendQuery(service, range, health, COMPARE_OFFSET, lookback), opts, tenant),
    ]);
    return { ...empty, now: points(cur), lastWeek: prev === null ? null : points(prev) };
  });
}

// ---------------------------------------------------------------- the Overview group

/** The range the Overview compares: the last hour against the same hour last week. */
export const OVERVIEW_COMPARE_RANGE: PerfRange = PerfRange.H1;

export type DeploysBetweenFn = (orgId: string, service: string | null, fromMs: number, toMs: number) => Promise<Deploy[]>;

/**
 * Services slower or failing more than the same hour last week, worst first, each with the newest
 * deploy reported for it in the hour or the 6 hours before it.
 */
export async function serviceRegressions(
  tenant: Tenant,
  client: PromClient = vmClient,
  now: number = Date.now(),
  readDeploys: DeploysBetweenFn = deploysBetween,
): Promise<ServiceRegression[]> {
  const rows = regressions(await compareServices(OVERVIEW_COMPARE_RANGE, tenant, client));
  if (!rows.length) return [];
  const windowStart = now - rangeSeconds(OVERVIEW_COMPARE_RANGE) * 1000;
  const deploys = await readDeploys(tenant.orgId, null, windowStart - REGRESSION_DEPLOY_LOOKBACK_MS, now).catch((): Deploy[] => []);
  const newest = new Map<string, Deploy>();
  for (const d of deploys) {
    const cur = newest.get(d.service);
    if (!cur || d.deployedAt >= cur.deployedAt) newest.set(d.service, d);
  }
  return rows.map((r): ServiceRegression => {
    const d = newest.get(r.service) ?? null;
    return {
      service: r.service,
      verdict: r.verdict === CompareVerdict.MoreErrors ? CompareVerdict.MoreErrors : CompareVerdict.Slower,
      requests: r.requestsNow,
      p95Now: r.now.p95,
      p95Before: r.before?.p95 ?? null,
      p95Ratio: r.p95Ratio,
      errorNow: r.now.errorShare,
      errorBefore: r.before?.errorShare ?? 0,
      deployAt: d ? d.deployedAt : null,
      deployLabel: d ? markerLabel(d) : null,
    };
  });
}
