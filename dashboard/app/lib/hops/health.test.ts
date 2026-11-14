import { describe, expect, test } from "bun:test";
import {
  HEALTH_CHECK_PATHS,
  HealthChecks,
  LOGQL_NOT_HEALTH_CHECK,
  LOGQL_NOT_HEALTH_OR_MONITOR,
  LOGQL_NOT_SYNTHETIC,
  PROM_NOT_HEALTH_CHECK,
  PROM_NOT_HEALTH_OR_MONITOR,
  PROM_NOT_SYNTHETIC,
  healthChecksFrom,
  isHealthCheckOp,
  isHealthOrMonitor,
  shownUnder,
} from "./health";

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
  test("pino JSON inside the stored envelope (quotes escaped) is matched too", () => {
    const stored = JSON.stringify({ message: JSON.stringify({ trace_id: "a", hop: "in_end", via: "http", op: "/healthz", status: 200 }) });
    expect(re.test(stored)).toBe(true);
    const other = JSON.stringify({ message: JSON.stringify({ hop: "in_end", via: "http", op: "/health/db" }) });
    expect(re.test(other)).toBe(false);
  });
});

describe("PromQL matcher", () => {
  test("anchored, case-insensitive alternation of every path", () => {
    expect(PROM_NOT_HEALTH_CHECK).toBe('op!~"(?i)/(?:healthz|health|ready|live|livez|readyz|ping)"');
  });
});

// ---------------------------------------------------------------- monitors (BAC-80, HOP-28)

describe("isHealthOrMonitor and shownUnder", () => {
  test("a monitor's hop, a health check, and an ordinary or old record", () => {
    expect(isHealthOrMonitor({ op: "/cart", synthetic: true })).toBe(true);
    expect(isHealthOrMonitor({ op: "/healthz", synthetic: false })).toBe(true);
    expect(isHealthOrMonitor({ op: "/cart", synthetic: false })).toBe(false);
    expect(isHealthOrMonitor({ op: "/cart" })).toBe(false);
    expect(isHealthOrMonitor({ op: null })).toBe(false);
  });
  test("hidden by default, every hop shown with the toggle", () => {
    expect(shownUnder(HealthChecks.Hidden, { op: "/cart", synthetic: true })).toBe(false);
    expect(shownUnder(HealthChecks.Hidden, { op: "/cart" })).toBe(true);
    expect(shownUnder(HealthChecks.Shown, { op: "/cart", synthetic: true })).toBe(true);
    expect(shownUnder(HealthChecks.Shown, { op: "/healthz" })).toBe(true);
  });
  test("the toggle keeps its parameter: ?health=1", () => {
    expect(healthChecksFrom("1")).toBe(HealthChecks.Shown);
    expect(healthChecksFrom(null)).toBe(HealthChecks.Hidden);
  });
});

describe("monitor LogQL line filter", () => {
  const re = logqlRegex(LOGQL_NOT_SYNTHETIC);
  test("matches synthetic records in JSON (number and string), escaped JSON and key=value", () => {
    expect(re.test('{"hop":"in_end","op":"/cart","host":"binary.fleeksite.com","synthetic":1,"status":200}')).toBe(true);
    expect(re.test('{"hop":"in","synthetic":"1"}')).toBe(true);
    expect(re.test('{"hop":"in","synthetic":true}')).toBe(true);
    expect(re.test("trace_id=a hop=in_end via=http op=/cart host=binary.fleeksite.com synthetic=1 status=200")).toBe(true);
    expect(re.test("hop=in op=/cart synthetic=1")).toBe(true);
    const stored = JSON.stringify({ message: JSON.stringify({ hop: "in_end", op: "/cart", synthetic: 1 }) });
    expect(re.test(stored)).toBe(true);
  });
  test("keeps real requests, old records and look-alike fields", () => {
    expect(re.test('{"hop":"in_end","op":"/cart","host":"shop.example.com","status":200}')).toBe(false);
    expect(re.test("hop=in_end op=/orders status=201")).toBe(false);
    expect(re.test("hop=in_end op=/cart synthetic=0")).toBe(false);
    expect(re.test("hop=in_end op=/cart synthetic=10")).toBe(false);
    expect(re.test("hop=in_end op=/cart f_synthetic=1")).toBe(false);
    expect(re.test('{"hop":"in_end","f_synthetic":"1"}')).toBe(false);
  });
  test("the combined filter is the health-check filter then the monitor filter", () => {
    expect(LOGQL_NOT_HEALTH_OR_MONITOR).toBe(`${LOGQL_NOT_HEALTH_CHECK} ${LOGQL_NOT_SYNTHETIC}`);
    expect(LOGQL_NOT_SYNTHETIC).toBe('!~ "\\\\bsynthetic\\\\W{1,6}(?:1|true)\\\\b"');
  });
});

describe("monitor PromQL matcher", () => {
  test("keeps series without the label (older collectors, real traffic)", () => {
    expect(PROM_NOT_SYNTHETIC).toBe('synthetic!="1"');
    expect(PROM_NOT_HEALTH_OR_MONITOR).toEqual([PROM_NOT_HEALTH_CHECK, 'synthetic!="1"']);
  });
});
