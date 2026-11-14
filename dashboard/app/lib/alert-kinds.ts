// Alert rule kinds, shared by the server (alerts.server.ts, alerts-eval.server.ts) and the Alerts
// page. Pure: no Remix, database, Loki or VictoriaMetrics imports.
//
// Log kinds (BAC-49) read Loki; the slowness kinds (BAC-72) read the route figures in
// VictoriaMetrics and the slow queries board. Rules are stored as one JSON blob, so `parseRule`
// validates what comes back from the database instead of casting it.

export const AlertMetric = {
  /** Error-level log lines per second (Loki). */
  ErrorRate: "error_rate",
  /** All log lines per second (Loki). */
  LogRate: "log_rate",
  /** p95 of one route, in milliseconds. */
  RouteP95: "route_p95",
  /** Failed requests of one route, in percent of its requests. */
  RouteErrorRate: "route_error_rate",
  /** p95 of one query shape (or the slowest one), in milliseconds. */
  SlowQuery: "slow_query",
} as const;
export type AlertMetric = (typeof AlertMetric)[keyof typeof AlertMetric];
const ALERT_METRICS: ReadonlySet<string> = new Set(Object.values(AlertMetric));

export function isAlertMetric(value: string): value is AlertMetric {
  return ALERT_METRICS.has(value);
}

/** The kinds that count log lines in Loki. */
export type LogMetric = typeof AlertMetric.ErrorRate | typeof AlertMetric.LogRate;

export function isLogMetric(metric: AlertMetric): metric is LogMetric {
  return metric === AlertMetric.ErrorRate || metric === AlertMetric.LogRate;
}

/** The kinds that read one route of one service. */
export const ROUTE_METRICS: readonly AlertMetric[] = [AlertMetric.RouteP95, AlertMetric.RouteErrorRate];

export function isRouteMetric(metric: AlertMetric): metric is typeof AlertMetric.RouteP95 | typeof AlertMetric.RouteErrorRate {
  return metric === AlertMetric.RouteP95 || metric === AlertMetric.RouteErrorRate;
}

/** The kinds added in BAC-72: they wait `forMinutes` before firing and only fire above. */
export function isSlownessMetric(metric: AlertMetric): boolean {
  return isRouteMetric(metric) || metric === AlertMetric.SlowQuery;
}

export const Comparator = { Above: ">", Below: "<" } as const;
export type Comparator = (typeof Comparator)[keyof typeof Comparator];

export function isComparator(value: unknown): value is Comparator {
  return value === Comparator.Above || value === Comparator.Below;
}

/** The window a route figure is read over. */
export const RouteWindow = { M5: "5m", M15: "15m", H1: "1h" } as const;
export type RouteWindow = (typeof RouteWindow)[keyof typeof RouteWindow];
export const ROUTE_WINDOWS: readonly RouteWindow[] = Object.values(RouteWindow);

export function isRouteWindow(value: unknown): value is RouteWindow {
  return typeof value === "string" && (ROUTE_WINDOWS as readonly string[]).includes(value);
}

/** How a window reads in a message: "over the last 15 minutes". */
export const ROUTE_WINDOW_TEXT: Record<RouteWindow, string> = {
  [RouteWindow.M5]: "the last 5 minutes",
  [RouteWindow.M15]: "the last 15 minutes",
  [RouteWindow.H1]: "the last hour",
};

/** Route kinds read 15 minutes unless the rule says otherwise: shorter windows are noisy. */
export const DEFAULT_ROUTE_WINDOW: RouteWindow = RouteWindow.M15;
/** Below this many requests in the window a route rule has no data (never fires). */
export const DEFAULT_MIN_REQUESTS = 20;
/** Below this many calls in the board's hour a query shape is not considered. */
export const DEFAULT_MIN_CALLS = 20;
/** Pending period of the slowness kinds: a breach must hold this long before it fires. */
export const DEFAULT_SLOWNESS_FOR_MINUTES = 5;
/** Log kinds fire on the first breach, as before BAC-72. */
export const DEFAULT_LOG_FOR_MINUTES = 0;
/** Longest pending period a rule may ask for. */
export const MAX_FOR_MINUTES = 60;
/** Largest request or call floor a rule may ask for. */
export const MAX_FLOOR = 1_000_000;

/** One route of one service, as recorded in the hop metrics (`method` may be empty). */
export interface RouteTarget {
  method: string;
  op: string;
}

/** One query shape of one service, as on the slow queries board. */
export interface ShapeTarget {
  id: string;
  service: string;
}

/** `shape: "any"` watches the slowest shape with enough calls. */
export const ANY_SHAPE = "any";

export interface AlertRule {
  id: string;
  name: string;
  /** A stored rule may hold a retired kind; `retired` is then set. */
  metric: AlertMetric | string;
  /** "*" = any service. Route kinds and named shapes: the service of the target. */
  service: string;
  comparator: Comparator;
  threshold: number;
  /** Notification channels to fire. */
  channelIds: string[];
  enabled: boolean;
  /** Why the rule can no longer run; such a rule stays disabled. */
  retired?: string;
  /** Route kinds: the route watched. */
  route?: RouteTarget;
  /** Route kinds: the window read, default `DEFAULT_ROUTE_WINDOW`. */
  window?: RouteWindow;
  /** Route kinds: request floor in the window, default `DEFAULT_MIN_REQUESTS`. */
  minRequests?: number;
  /** Slow query: a named shape, or the slowest one. */
  shape?: ShapeTarget | typeof ANY_SHAPE;
  /** Slow query: call floor over the board's hour, default `DEFAULT_MIN_CALLS`. */
  minCalls?: number;
  /** Pending period in minutes; default 5 for the slowness kinds, 0 for the log kinds. */
  forMinutes?: number;
}

export interface MetricMeta {
  label: string;
  hint: string;
  unit: string;
}

export const METRIC_META: Record<AlertMetric, MetricMeta> = {
  [AlertMetric.ErrorRate]: { label: "Error log rate (lines/sec)", hint: "error-level log lines per second", unit: "/s" },
  [AlertMetric.LogRate]: { label: "Log volume (lines/sec)", hint: "all log lines per second", unit: "/s" },
  [AlertMetric.RouteP95]: { label: "Route p95 (ms)", hint: "p95 is accurate to about 20 percent between histogram buckets", unit: " ms" },
  [AlertMetric.RouteErrorRate]: { label: "Route error rate (%)", hint: "failed requests in percent; windows under 15 minutes are noisy", unit: "%" },
  [AlertMetric.SlowQuery]: { label: "Slow query p95 (ms)", hint: "read from the slow queries board, refreshed every 5 minutes", unit: " ms" },
};

/** The pending period of a rule in milliseconds. */
export function ruleForMs(rule: AlertRule): number {
  const fallback = isAlertMetric(rule.metric) && isSlownessMetric(rule.metric) ? DEFAULT_SLOWNESS_FOR_MINUTES : DEFAULT_LOG_FOR_MINUTES;
  return (rule.forMinutes ?? fallback) * 60_000;
}

// ---------------------------------------------------------------- validation on read

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function wholeNumber(v: unknown, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

function parseRoute(v: unknown): RouteTarget | null {
  if (!isRecord(v)) return null;
  const method = str(v.method);
  const op = str(v.op);
  return method !== null && op !== null && op !== "" ? { method, op } : null;
}

function parseShape(v: unknown): ShapeTarget | typeof ANY_SHAPE | null {
  if (v === ANY_SHAPE) return ANY_SHAPE;
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const service = str(v.service);
  return id && service ? { id, service } : null;
}

/**
 * A stored rule (the `alert_rules.data` JSON) checked field by field, or null when it is not a
 * rule at all. Unknown kinds are kept (as strings) so `normalizeRule` can retire them; optional
 * fields that are malformed are dropped, so the defaults apply.
 */
export function parseRule(raw: unknown): AlertRule | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const metric = str(raw.metric);
  if (!id || !metric) return null;
  const threshold = typeof raw.threshold === "number" && Number.isFinite(raw.threshold) ? raw.threshold : null;
  if (threshold === null) return null;
  const rule: AlertRule = {
    id,
    name: str(raw.name) ?? "Untitled alert",
    metric,
    service: str(raw.service) || "*",
    comparator: isComparator(raw.comparator) ? raw.comparator : Comparator.Above,
    threshold,
    channelIds: Array.isArray(raw.channelIds) ? raw.channelIds.filter((c): c is string => typeof c === "string") : [],
    enabled: raw.enabled === true,
  };
  const retired = str(raw.retired);
  if (retired) rule.retired = retired;
  const route = parseRoute(raw.route);
  if (route) rule.route = route;
  if (isRouteWindow(raw.window)) rule.window = raw.window;
  const minRequests = wholeNumber(raw.minRequests, MAX_FLOOR);
  if (minRequests !== null) rule.minRequests = minRequests;
  const shape = parseShape(raw.shape);
  if (shape) rule.shape = shape;
  const minCalls = wholeNumber(raw.minCalls, MAX_FLOOR);
  if (minCalls !== null) rule.minCalls = minCalls;
  const forMinutes = wholeNumber(raw.forMinutes, MAX_FOR_MINUTES);
  if (forMinutes !== null) rule.forMinutes = forMinutes;
  return rule;
}

// ---------------------------------------------------------------- validation of the form

/** The fields of the New rule form, as strings (absent fields are null). */
export interface RuleDraftInput {
  name: string | null;
  metric: string | null;
  service: string | null;
  comparator: string | null;
  threshold: string | null;
  channelIds: readonly string[];
  /** "METHOD op", as the route select sends it. */
  route: string | null;
  window: string | null;
  minRequests: string | null;
  /** "any" or "service:shapeId". */
  shape: string | null;
  minCalls: string | null;
  forMinutes: string | null;
}

export type DraftResult = { ok: true; rule: Omit<AlertRule, "id" | "enabled"> } | { ok: false; error: string };

/** The route select's value for a route: method and op separated by one space. */
export function routeValue(route: RouteTarget): string {
  return `${route.method} ${route.op}`;
}

/** The route select's value read back; a route without a method starts with the space. */
export function parseRouteValue(value: string): RouteTarget | null {
  const i = value.indexOf(" ");
  if (i < 0) return null;
  const route = { method: value.slice(0, i), op: value.slice(i + 1) };
  return route.op ? route : null;
}

/** The shape select's value: "any" or "service:shapeId" (a shape id is 8 hex characters). */
export function shapeValue(shape: ShapeTarget | typeof ANY_SHAPE): string {
  return shape === ANY_SHAPE ? ANY_SHAPE : `${shape.service}:${shape.id}`;
}

export function parseShapeValue(value: string): ShapeTarget | typeof ANY_SHAPE | null {
  if (value === ANY_SHAPE) return ANY_SHAPE;
  const m = /^(.+):([0-9a-f]{8})$/.exec(value);
  return m ? { service: m[1], id: m[2] } : null;
}

function optionalWhole(v: string | null, max: number, what: string): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (v === null || v.trim() === "") return { ok: true, value: undefined };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) return { ok: false, error: `${what} must be a whole number from 0 to ${max.toLocaleString("en-GB")}.` };
  return { ok: true, value: n };
}

/** The New rule form checked and turned into a rule (without id), or the message to show. */
export function ruleFromDraft(input: RuleDraftInput): DraftResult {
  const metric = input.metric ?? "";
  if (!isAlertMetric(metric)) return { ok: false, error: "Pick a valid metric." };
  const threshold = Number(input.threshold);
  if (input.threshold === null || input.threshold.trim() === "" || !Number.isFinite(threshold)) return { ok: false, error: "Threshold must be a number." };
  const name = (input.name ?? "").trim().slice(0, 80) || "Untitled alert";
  const forMinutes = optionalWhole(input.forMinutes, MAX_FOR_MINUTES, "Wait");
  if (!forMinutes.ok) return forMinutes;
  const channelIds = [...input.channelIds];
  if (!isSlownessMetric(metric)) {
    const comparator = input.comparator ?? "";
    if (!isComparator(comparator)) return { ok: false, error: "Pick a valid comparator." };
    const service = (input.service ?? "*").trim().slice(0, 120) || "*";
    const rule: Omit<AlertRule, "id" | "enabled"> = { name, metric, service, comparator, threshold, channelIds };
    if (forMinutes.value !== undefined) rule.forMinutes = forMinutes.value;
    return { ok: true, rule };
  }
  if (threshold <= 0) return { ok: false, error: "Threshold must be above 0." };
  if (metric === AlertMetric.RouteErrorRate && threshold > 100) return { ok: false, error: "An error rate threshold is a percent, from 0 to 100." };
  const base = { name, metric, comparator: Comparator.Above, threshold, channelIds, forMinutes: forMinutes.value ?? DEFAULT_SLOWNESS_FOR_MINUTES };
  if (isRouteMetric(metric)) {
    const service = (input.service ?? "").trim();
    if (!service || service === "*") return { ok: false, error: "Pick a service." };
    const route = input.route ? parseRouteValue(input.route) : null;
    if (!route) return { ok: false, error: "Pick a route." };
    const window = input.window && input.window !== "" ? input.window : DEFAULT_ROUTE_WINDOW;
    if (!isRouteWindow(window)) return { ok: false, error: "Pick a window of 5 minutes, 15 minutes or 1 hour." };
    const minRequests = optionalWhole(input.minRequests, MAX_FLOOR, "Minimum requests");
    if (!minRequests.ok) return minRequests;
    return { ok: true, rule: { ...base, service, route, window, minRequests: minRequests.value ?? DEFAULT_MIN_REQUESTS } };
  }
  const shape = input.shape ? parseShapeValue(input.shape) : null;
  if (!shape) return { ok: false, error: "Pick a query, or Any query." };
  const minCalls = optionalWhole(input.minCalls, MAX_FLOOR, "Minimum calls");
  if (!minCalls.ok) return minCalls;
  const service = shape === ANY_SHAPE ? (input.service ?? "*").trim().slice(0, 120) || "*" : shape.service;
  return { ok: true, rule: { ...base, service, shape, minCalls: minCalls.value ?? DEFAULT_MIN_CALLS } };
}

/** Where the rule looks, in one line: "shop-api GET /orders/:id", "any service". */
export function ruleTarget(rule: AlertRule): string {
  const service = rule.service === "*" ? "any service" : rule.service;
  if (rule.route) return `${service} ${rule.route.method ? rule.route.method + " " : ""}${rule.route.op}`;
  if (rule.metric === AlertMetric.SlowQuery) return rule.shape && rule.shape !== ANY_SHAPE ? `${service}, query ${rule.shape.id}` : `${service}, slowest query`;
  return service;
}
