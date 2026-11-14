// Health checks and monitors: one definition of the hops the summary pages leave out by default.
//
// Health-check hops (decision taken in Romario's absence, 2026-11-12, run t18).
//
// Platform probes call `/healthz` and friends every few seconds, so without a rule the
// Requests list, the Overview and the Performance figures would be a wall of health checks.
// By default those pages leave out INBOUND hops whose operation is exactly one of the paths
// below (case-insensitive). "Show health checks" on Requests and Performance brings them back.
// The request view and Logs always show everything, and nothing is dropped at ingest.
//
// One definition, three renderings: a predicate for parsed records, a PromQL matcher for the
// hop metrics, and a LogQL line filter that only narrows a Loki scan (the predicate decides).
// Pure: usable from server and client code.
//
// Monitors (BAC-80, Correlator spec 0.13 HOP-28): an uptime monitor's request, and every
// downstream request of its trace, carries `synthetic=1` on its inbound hop records. Those hops
// are left out wherever health checks are, by the same toggle ("Show health checks and
// monitors", query parameter still `health`). A record without the field is not a monitor.

/** The operations treated as health checks, lower case, exact path. */
export const HEALTH_CHECK_PATHS: readonly string[] = ["/healthz", "/health", "/ready", "/live", "/livez", "/readyz", "/ping"];

/** Whether health-check hops are shown. */
export const HealthChecks = {
  Hidden: "hidden",
  Shown: "shown",
} as const;
export type HealthChecks = (typeof HealthChecks)[keyof typeof HealthChecks];

/** The query-string parameter of the "Show health checks" control. */
export const HEALTH_PARAM = "health";

/** `?health=1` shows them; anything else hides them. */
export function healthChecksFrom(value: string | null | undefined): HealthChecks {
  return value === "1" ? HealthChecks.Shown : HealthChecks.Hidden;
}

const PATH_SET: ReadonlySet<string> = new Set(HEALTH_CHECK_PATHS);

/** True when `op` is exactly a health-check path, ignoring case. */
export function isHealthCheckOp(op: string | null | undefined): boolean {
  return typeof op === "string" && PATH_SET.has(op.toLowerCase());
}

/** The path names without the slash, as one regex alternation. Only [a-z] in them, so no escaping. */
const ALTERNATION = HEALTH_CHECK_PATHS.map((p) => p.slice(1)).join("|");

/** PromQL matcher leaving out health-check operations. PromQL regexes are fully anchored. */
export const PROM_NOT_HEALTH_CHECK = `op!~"(?i)/(?:${ALTERNATION})"`;

/**
 * LogQL line filter dropping lines whose `op` is a health-check path, in JSON (`"op":"/healthz"`)
 * and key=value (`op=/healthz`) records. The path must be followed by a quote, a space or the
 * end of the line, so `/health/db` is kept. Written for a LogQL double-quoted string.
 */
export const LOGQL_NOT_HEALTH_CHECK = `!~ "\\\\bop\\\\W{1,6}/(?i:${ALTERNATION})(?:\\\\\\\\?\\"|\\\\s|$)"`;

// ---------------------------------------------------------------- monitors (HOP-28)

/** The hop-record field names read for BAC-80 (spec 0.13). */
export const MonitorField = {
  /** HOP-28: `synthetic=1` on inbound hops of an uptime monitor's request and its downstream requests. */
  Synthetic: "synthetic",
  /** HOP-27: the inbound HTTP request's host, lower case, no port. */
  Host: "host",
} as const;
export type MonitorField = (typeof MonitorField)[keyof typeof MonitorField];

/** The parts of a hop record or row the rule reads. */
export interface HealthOrMonitorFacts {
  op: string | null;
  /** Missing means unknown, which is not a monitor (old records). */
  synthetic?: boolean;
}

/** True for a hop the summary pages leave out by default: a health check or a monitor's request. */
export function isHealthOrMonitor(r: HealthOrMonitorFacts): boolean {
  return r.synthetic === true || isHealthCheckOp(r.op);
}

/** Whether a hop is shown under the given toggle state. */
export function shownUnder(health: HealthChecks, r: HealthOrMonitorFacts): boolean {
  return health === HealthChecks.Shown || !isHealthOrMonitor(r);
}

/** PromQL matcher leaving out monitor series. Series without the label (old collectors, real
 *  traffic) have it empty, so they are kept. */
export const PROM_NOT_SYNTHETIC = `${MonitorField.Synthetic}!="1"`;

/** Every PromQL matcher of the rule, for inbound hop series. */
export const PROM_NOT_HEALTH_OR_MONITOR: readonly string[] = [PROM_NOT_HEALTH_CHECK, PROM_NOT_SYNTHETIC];

/**
 * LogQL line filter dropping records marked synthetic, in JSON (`"synthetic":1`, `"synthetic":"1"`,
 * escaped inside a stored envelope) and key=value (`synthetic=1`) form; `true` is accepted like the
 * parser does. `\b` on both sides keeps `f_synthetic=1` and `synthetic=10`. Narrows a scan only.
 */
export const LOGQL_NOT_SYNTHETIC = `!~ "\\\\bsynthetic\\\\W{1,6}(?:1|true)\\\\b"`;

/** Both LogQL line filters of the rule, health checks first. */
export const LOGQL_NOT_HEALTH_OR_MONITOR = `${LOGQL_NOT_HEALTH_CHECK} ${LOGQL_NOT_SYNTHETIC}`;

/** The toggle's label on Requests and Performance (the parameter stays `health`). */
export const HEALTH_TOGGLE_LABEL = "Show health checks and monitors";
/** Short form for the folded phone filters' summary. */
export const HEALTH_TOGGLE_SHORT = "health checks and monitors";
/** The chip on a monitor's request (request view, and list rows when shown). */
export const MONITOR_BADGE = "Monitor";
/** Hover text of the chip. */
export const MONITOR_TITLE = "An uptime monitor's request, or one it caused downstream (synthetic=1). Left out of Requests, the Overview and Performance unless health checks and monitors are shown.";
