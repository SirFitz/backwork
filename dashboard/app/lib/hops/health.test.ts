import { describe, expect, test } from "bun:test";
import { HEALTH_CHECK_PATHS, HealthChecks, LOGQL_NOT_HEALTH_CHECK, PROM_NOT_HEALTH_CHECK, healthChecksFrom, isHealthCheckOp } from "./health";

describe("isHealthCheckOp", () => {
  test("every listed path, in any case", () => {
    for (const p of HEALTH_CHECK_PATHS) {
      expect(isHealthCheckOp(p)).toBe(true);
      expect(isHealthCheckOp(p.toUpperCase())).toBe(true);
    }
    expect(isHealthCheckOp("/Healthz")).toBe(true);
  });
  test("exact path only", () => {
    for (const op of ["/health/db", "/api/health", "/healthzz", "healthz", "/pingback", "/ready/", "", " /healthz"]) {
      expect(isHealthCheckOp(op)).toBe(false);
    }
  });
  test("missing operation is not a health check", () => {
    expect(isHealthCheckOp(null)).toBe(false);
    expect(isHealthCheckOp(undefined)).toBe(false);
  });
});

describe("healthChecksFrom", () => {
  test("only 1 shows them", () => {
    expect(healthChecksFrom("1")).toBe(HealthChecks.Shown);
    for (const v of [null, undefined, "", "0", "true", "yes"]) expect(healthChecksFrom(v)).toBe(HealthChecks.Hidden);
  });
});

/** The regex inside a LogQL `!~ "..."` filter, unescaped the way LogQL reads a double-quoted string. */
function logqlRegex(filter: string): RegExp {
  const body = filter.slice(filter.indexOf('"') + 1, filter.lastIndexOf('"'));
  const unescaped = body.replace(/\\(.)/g, "$1");
  // RE2's scoped (?i:...) is written as a whole-pattern flag for the JS check.
  return new RegExp(unescaped.replace("(?i:", "(?:"), "i");
}

describe("LogQL line filter", () => {
  const re = logqlRegex(LOGQL_NOT_HEALTH_CHECK);
  test("matches health-check records in JSON and key=value", () => {
    expect(re.test('{"trace_id":"a","hop":"in_end","via":"http","op":"/healthz","status":200}')).toBe(true);
    expect(re.test('trace_id=a hop=in_end via=http op=/HEALTH status=200')).toBe(true);
    expect(re.test("hop=in via=http op=/ready")).toBe(true);
  });
  test("keeps other routes", () => {
    expect(re.test('{"hop":"in_end","op":"/health/db"}')).toBe(false);
    expect(re.test('{"hop":"in_end","op":"/charges"}')).toBe(false);
    expect(re.test("hop=in op=/pingback")).toBe(false);
    expect(re.test('{"hop":"in_end","stop":"/healthz"}')).toBe(false);
  });
});

describe("PromQL matcher", () => {
  test("anchored, case-insensitive alternation of every path", () => {
    expect(PROM_NOT_HEALTH_CHECK).toBe('op!~"(?i)/(?:healthz|health|ready|live|livez|readyz|ping)"');
  });
});
