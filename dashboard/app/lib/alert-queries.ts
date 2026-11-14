// Queries and readings of the slowness alert kinds (BAC-72). Pure.
//
// Route kinds read the hop metrics in VictoriaMetrics with the same counter-window builders the
// Performance page uses (`counter-window.ts`, never `rate()`); the strings match what
// `quantileQuery` and `errorRateQueries` in `metrics.server.ts` build for the same scope (the test
// holds them together). The slow query kind reads rows of the slow queries board.

import { windowIncrease } from "./hops/counter-window";
import type { QueryRow } from "./hops/slow-queries";
import { ANY_SHAPE, AlertMetric, Comparator, DEFAULT_MIN_CALLS, DEFAULT_MIN_REQUESTS, DEFAULT_ROUTE_WINDOW, type AlertRule, type RouteWindow } from "./alert-kinds";
import { ObservationKind, type Observation } from "./alert-decision";

const DURATION = "backwork_hop_duration_seconds";

/** A label value placed in a query: 1 to 200 bytes of 0x21..0x7E (spec HOP-12, as `isLabelValue`). */
export function isAlertLabelValue(value: string): boolean {
  if (value.length < 1 || value.length > 200) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

/** A PromQL string; only printable ASCII reaches here, so escaping `\` and `"` is complete. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The four instant queries of one route over one window. */
export interface RouteQueries {
  /** Requests in the window. */
  requests: string;
  /** Requests whose outcome is error. */
  errA: string;
  /** 5xx requests whose outcome is not error (disjoint from errA, added in code). */
  errB: string;
  /** p95 in seconds. */
  p95: string;
}

/**
 * The queries of one route, or null when a label value cannot be placed in a query. An empty
 * method (jobs, RPC) matches the series without one. Health checks are not filtered: the rule
 * names its route exactly.
 */
export function routeQueries(service: string, method: string, op: string, window: RouteWindow): RouteQueries | null {
  if (!isAlertLabelValue(service) || !isAlertLabelValue(op) || (method !== "" && !isAlertLabelValue(method))) return null;
  const where = `service=${quote(service)},method=${quote(method)},op=${quote(op)}`;
  const count = `${DURATION}_count`;
  return {
    requests: windowIncrease(`${count}{dir="in",${where}}`, window, []),
    errA: windowIncrease(`${count}{dir="in",${where},outcome="error"}`, window, []),
    errB: windowIncrease(`${count}{dir="in",${where},outcome!="error",status_class="5xx"}`, window, []),
    p95: `histogram_quantile(0.95, ${windowIncrease(`${DURATION}_bucket{dir="in",${where}}`, window, ["le"])})`,
  };
}

/** What one evaluation of a rule found. `value` is in the rule's unit (ms, percent, lines/s). */
export interface RuleReading {
  value: number;
  noData: boolean;
  /** Route kinds: requests in the window. */
  requests?: number;
  /** Slow query: the matched row. */
  query?: QueryRow;
}

export const NO_DATA: RuleReading = { value: 0, noData: true };

/** First value of an instant result, or null when empty or not a number. */
export function firstValue(samples: ReadonlyArray<{ value: number }>): number | null {
  const v = samples[0]?.value;
  return v !== undefined && Number.isFinite(v) ? v : null;
}

/** The raw answers of `routeQueries` (first value of each, or null). */
export interface RouteSamples {
  requests: number | null;
  errA: number | null;
  errB: number | null;
  p95S: number | null;
}

/** A route reading from its answers: no data below the request floor or without a p95. */
export function routeReading(rule: AlertRule, s: RouteSamples): RuleReading {
  const requests = s.requests ?? 0;
  if (requests < Math.max(1, rule.minRequests ?? DEFAULT_MIN_REQUESTS)) return { ...NO_DATA, requests };
  if (rule.metric === AlertMetric.RouteP95) {
    if (s.p95S === null) return { ...NO_DATA, requests };
    return { value: s.p95S * 1000, noData: false, requests };
  }
  const failed = (s.errA ?? 0) + (s.errB ?? 0);
  return { value: Math.min(100, (failed / requests) * 100), noData: false, requests };
}

/**
 * The board row a slow query rule watches: a named shape by service and shape id, or with
 * `shape: "any"` the highest p95 among rows (of the rule's service, unless "*") with at least
 * `minCalls` calls. Null when nothing qualifies.
 */
export function pickSlowQuery(rule: AlertRule, rows: readonly QueryRow[]): QueryRow | null {
  const minCalls = rule.minCalls ?? DEFAULT_MIN_CALLS;
  const enough = rows.filter((r) => r.calls >= minCalls && r.p95S !== null);
  const shape = rule.shape ?? ANY_SHAPE;
  if (shape !== ANY_SHAPE) return enough.find((r) => r.service === shape.service && r.shapeId === shape.id) ?? null;
  const pool = rule.service === "*" ? enough : enough.filter((r) => r.service === rule.service);
  let best: QueryRow | null = null;
  for (const r of pool) if (best === null || (r.p95S ?? 0) > (best.p95S ?? 0)) best = r;
  return best;
}

/** A slow query reading from the board's rows. */
export function slowQueryReading(rule: AlertRule, rows: readonly QueryRow[]): RuleReading {
  const row = pickSlowQuery(rule, rows);
  if (!row || row.p95S === null) return NO_DATA;
  return { value: row.p95S * 1000, noData: false, query: row };
}

/** Whether a reading is over (or under, for `<`) the rule's threshold. */
export function isBreach(rule: AlertRule, reading: RuleReading): boolean {
  if (reading.noData) return false;
  return rule.comparator === Comparator.Below ? reading.value < rule.threshold : reading.value > rule.threshold;
}

/** The observation `decide` takes. */
export function observe(rule: AlertRule, reading: RuleReading): Observation {
  if (reading.noData) return { kind: ObservationKind.NoData };
  return { kind: isBreach(rule, reading) ? ObservationKind.Breach : ObservationKind.Ok };
}

/** The window a route rule reads. */
export function ruleWindow(rule: AlertRule): RouteWindow {
  return rule.window ?? DEFAULT_ROUTE_WINDOW;
}

// ---------------------------------------------------------------- what the New rule form offers

/** A route with traffic, offered in the route select. */
export interface TargetRoute {
  service: string;
  method: string;
  op: string;
}

/** A query shape of the slow queries board, offered in the query select. */
export interface TargetShape {
  service: string;
  shapeId: string;
  label: string;
  /** ms, null when unknown */
  p95Ms: number | null;
  calls: number;
}

export interface AlertTargets {
  routes: TargetRoute[];
  shapes: TargetShape[];
}
