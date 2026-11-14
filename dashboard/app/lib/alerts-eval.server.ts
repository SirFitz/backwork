// Reading alert rules (BAC-72): log kinds from Loki, route kinds from VictoriaMetrics, slow query
// rules from the slow queries board's cached result. Every reader is injectable so tests use fakes.
// The tri-state holds for every kind: a failed query or a reading below its floor is no data,
// which never fires and never resolves.

import { cached } from "./cache.server";
import * as loki from "./loki.server";
import type { Tenant } from "./tenant.server";
import { allRoutesScope, rateQuery, vmClient, PerfRange, type PromClient } from "./hops/metrics.server";
import { slowQueries, SlowWindow } from "./hops/slow-queries.server";
import type { QueryRow } from "./hops/slow-queries";
import { shapeLabel } from "./hops/stmt-shape";
import { serviceNamesWithin } from "./service-names.server";
import type { ServiceNames } from "./service-names";
import { AlertMetric, isAlertMetric, isLogMetric, isRouteMetric, type AlertRule } from "./alert-kinds";
import { NO_DATA, firstValue, isBreach, routeQueries, routeReading, ruleWindow, slowQueryReading, type AlertTargets, type RuleReading, type TargetRoute, type TargetShape } from "./alert-queries";
export type { AlertTargets, TargetRoute, TargetShape };
import { loadRules, ruleQuery } from "./alerts.server";

/** How long the service-name map may take before a log rule reads with the names as stored. */
export const NAMES_WAIT_MS = 3000;
/** The New rule form's route and query lists are kept this long (60 seconds). */
export const TARGETS_TTL_MS = 60_000;
/** Routes offered in the form: those with traffic in the last 24 hours. */
export const TARGETS_RANGE: PerfRange = PerfRange.H24;

/** The readers a rule evaluation uses. */
export interface EvalDeps {
  prom: Pick<PromClient, "instant">;
  /** A Loki metric query reduced to one number. */
  logScalar: (query: string, tenant: Tenant) => Promise<number>;
  names: (tenant: Tenant) => Promise<ServiceNames>;
  /** Rows of the slow queries board (last hour), from its stale-while-revalidate cache. */
  slowRows: (tenant: Tenant) => Promise<readonly QueryRow[]>;
}

export const evalDeps: EvalDeps = {
  prom: vmClient,
  logScalar: (q, t) => loki.scalar(q, 0, t),
  names: (t) => serviceNamesWithin(t, NAMES_WAIT_MS),
  slowRows: async (t) => (await slowQueries(t, SlowWindow.H1)).rows,
};

async function readRoute(rule: AlertRule, tenant: Tenant, deps: EvalDeps): Promise<RuleReading> {
  if (!rule.route) return NO_DATA;
  const q = routeQueries(rule.service, rule.route.method, rule.route.op, ruleWindow(rule));
  if (!q) return NO_DATA;
  const run = async (query: string): Promise<number | null> => firstValue(await deps.prom.instant(query, tenant));
  const needErrors = rule.metric === AlertMetric.RouteErrorRate;
  const [requests, p95S, errA, errB] = await Promise.all([
    run(q.requests),
    needErrors ? Promise.resolve(null) : run(q.p95),
    needErrors ? run(q.errA) : Promise.resolve(null),
    needErrors ? run(q.errB) : Promise.resolve(null),
  ]);
  return routeReading(rule, { requests, p95S, errA, errB });
}

/** One reading of one rule. Retired kinds and failures read as no data. */
export async function evaluateRule(rule: AlertRule, tenant: Tenant, deps: EvalDeps = evalDeps): Promise<RuleReading> {
  if (!isAlertMetric(rule.metric)) return NO_DATA;
  const metric = rule.metric;
  try {
    if (isLogMetric(metric)) {
      const v = await deps.logScalar(ruleQuery(metric, rule.service, await deps.names(tenant)), tenant);
      return Number.isFinite(v) ? { value: v, noData: false } : NO_DATA;
    }
    if (isRouteMetric(metric)) return await readRoute(rule, tenant, deps);
    return slowQueryReading(rule, await deps.slowRows(tenant));
  } catch {
    return NO_DATA;
  }
}

/** A rule with its live reading, as the page shows it. */
export type AlertState = AlertRule & RuleReading & { firing: boolean };

/** Every rule of an organisation with a live reading (the page's Value column). */
export async function evaluate(tenant: Tenant, deps: EvalDeps = evalDeps, rules?: readonly AlertRule[]): Promise<AlertState[]> {
  const list = rules ?? (await loadRules(tenant.orgId));
  return Promise.all(
    list.map(async (rule) => {
      const reading = await evaluateRule(rule, tenant, deps);
      return { ...rule, ...reading, firing: rule.enabled && isBreach(rule, reading) };
    }),
  );
}

// ---------------------------------------------------------------- form targets

/** Routes with traffic in the last 24 hours, every service in one query, by service then route. */
export async function targetRoutes(tenant: Tenant, prom: Pick<PromClient, "instant"> = vmClient): Promise<TargetRoute[]> {
  const scope = allRoutesScope();
  const rows = await prom.instant(rateQuery("in", scope, TARGETS_RANGE), tenant);
  const seen = new Set<string>();
  const out: TargetRoute[] = [];
  for (const r of rows) {
    const service = r.metric.service;
    const op = r.metric.op;
    if (!service || !op || !(r.value > 0)) continue;
    const route = { service, method: r.metric.method ?? "", op };
    const key = `${route.service}\u0000${route.method}\u0000${route.op}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(route);
  }
  return out.sort((a, b) => a.service.localeCompare(b.service) || a.op.localeCompare(b.op) || a.method.localeCompare(b.method));
}

/** Query shapes of the board, slowest first. */
export function targetShapes(rows: readonly QueryRow[]): TargetShape[] {
  return [...rows]
    .sort((a, b) => (b.p95S ?? -1) - (a.p95S ?? -1))
    .map((r) => ({ service: r.service, shapeId: r.shapeId, label: shapeLabel(r.shape, 60), p95Ms: r.p95S === null ? null : r.p95S * 1000, calls: r.calls }));
}

/** What the New rule form offers, cached per organisation. A failing half comes back empty. */
export function alertTargets(tenant: Tenant, deps: EvalDeps = evalDeps): Promise<AlertTargets> {
  return cached(`alert-targets:${tenant.orgId}`, TARGETS_TTL_MS, async () => {
    const [routes, rows] = await Promise.all([
      targetRoutes(tenant, deps.prom).catch((): TargetRoute[] => []),
      deps.slowRows(tenant).catch((): readonly QueryRow[] => []),
    ]);
    return { routes, shapes: targetShapes(rows) };
  });
}
