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
