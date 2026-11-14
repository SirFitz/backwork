import { describe, expect, test } from "bun:test";
import { AlertMetric, Comparator, type AlertRule } from "./alert-kinds";
import { ObservationKind } from "./alert-decision";
import { isAlertLabelValue, isBreach, observe, pickSlowQuery, routeQueries, routeReading, slowQueryReading } from "./alert-queries";
import { HealthChecks, Quantile, errorRateQueries, isLabelValue, quantileQuery, type Scope } from "./hops/metrics.server";
import type { QueryRow } from "./hops/slow-queries";

const rule = (over: Partial<AlertRule>): AlertRule => ({
  id: "r1", name: "x", metric: AlertMetric.RouteP95, service: "shop-api", comparator: Comparator.Above, threshold: 300, channelIds: [], enabled: true,
  route: { method: "GET", op: "/orders/:id" }, ...over,
});

const LB = 7 * 86400;

describe("routeQueries", () => {
  test("exact strings for a 15 minute window", () => {
    const q = routeQueries("shop-api", "GET", "/orders/:id", "15m");
    const sel = 'dir="in",service="shop-api",method="GET",op="/orders/:id"';
    const inc = (s: string, by: string) =>
      `clamp_min((sum ${by}(increase(${s}[${900 + LB}s])) - sum ${by}(increase(${s}[${LB}s] offset 900s))) or sum ${by}(increase(${s}[${900 + LB}s])), 0)`;
    expect(q).toEqual({
      requests: inc(`backwork_hop_duration_seconds_count{${sel}}`, ""),
      errA: inc(`backwork_hop_duration_seconds_count{${sel},outcome="error"}`, ""),
      errB: inc(`backwork_hop_duration_seconds_count{${sel},outcome!="error",status_class="5xx"}`, ""),
      p95: `histogram_quantile(0.95, ${inc(`backwork_hop_duration_seconds_bucket{${sel}}`, "by (le) ")})`,
    });
  });
  test("each window sets its own length", () => {
    expect(routeQueries("a", "GET", "/x", "5m")?.requests).toContain(`[${300 + LB}s]`);
    expect(routeQueries("a", "GET", "/x", "5m")?.requests).toContain("offset 300s");
    expect(routeQueries("a", "GET", "/x", "1h")?.requests).toContain(`[${3600 + LB}s]`);
    expect(routeQueries("a", "GET", "/x", "1h")?.requests).toContain("offset 3600s");
  });
  test("the same strings the Performance builders produce for that route", () => {
    for (const w of ["5m", "15m", "1h"] as const) {
      const scope: Scope = { by: [], where: { service: "shop-api", method: "GET", op: "/orders/:id" }, health: HealthChecks.Shown };
      const q = routeQueries("shop-api", "GET", "/orders/:id", w);
      expect(q?.p95).toBe(quantileQuery(Quantile.P95, "in", scope, "1h", w));
      // errorRateQueries is per second over a PerfRange; the alert counts over the window, so compare the selectors
      const [a, b] = errorRateQueries("in", scope, "1h");
      expect(q?.errA).toContain(/increase\((.*?)\[/.exec(a)?.[1] ?? "missing");
      expect(q?.errB).toContain(/increase\((.*?)\[/.exec(b)?.[1] ?? "missing");
    }
  });
  test("label values are gated; a quote is escaped; an empty method matches series without one", () => {
    expect(routeQueries("shop api", "GET", "/x", "15m")).toBeNull();
    expect(routeQueries("shop-api", "GET", "", "15m")).toBeNull();
    expect(routeQueries("shop-api", "GE T", "/x", "15m")).toBeNull();
    expect(routeQueries("a", "GET", '/x"y', "15m")?.requests).toContain('op="/x\\"y"');
    expect(routeQueries("a", "", "Receipts.SendEmail", "15m")?.requests).toContain('method="",op="Receipts.SendEmail"');
    for (const v of ["a", "a b", "", "x".repeat(201), "é"]) expect(isAlertLabelValue(v)).toBe(isLabelValue(v));
  });
});

describe("routeReading", () => {
  test("below the request floor is no data", () => {
    expect(routeReading(rule({}), { requests: 19, p95S: 0.5, errA: null, errB: null })).toEqual({ value: 0, noData: true, requests: 19 });
    expect(routeReading(rule({ minRequests: 5 }), { requests: 19, p95S: 0.5, errA: null, errB: null })).toEqual({ value: 500, noData: false, requests: 19 });
  });
  test("no p95 is no data", () => {
    expect(routeReading(rule({}), { requests: 100, p95S: null, errA: null, errB: null }).noData).toBe(true);
  });
  test("error rate adds the two halves, in percent", () => {
    const r = routeReading(rule({ metric: AlertMetric.RouteErrorRate }), { requests: 200, p95S: null, errA: 6, errB: 4 });
    expect(r).toEqual({ value: 5, noData: false, requests: 200 });
    expect(routeReading(rule({ metric: AlertMetric.RouteErrorRate }), { requests: 200, p95S: null, errA: null, errB: null }).value).toBe(0);
  });
});

const row = (over: Partial<QueryRow>): QueryRow => ({
  shapeId: "aaaaaaaa", shape: "select ? from orders", sample: "select 1 from orders", service: "shop-api", peer: null, table: "orders",
  calls: 50, totalS: 10, p95S: 0.4, p95Approx: false, shareOfDb: 1, ...over,
});

describe("slow query rules", () => {
  const rows = [
    row({ shapeId: "11111111", p95S: 0.4, calls: 50 }),
    row({ shapeId: "22222222", p95S: 0.9, calls: 3 }),
    row({ shapeId: "33333333", p95S: 0.6, calls: 25, service: "other-api" }),
  ];
  const slow = (over: Partial<AlertRule>) => rule({ metric: AlertMetric.SlowQuery, route: undefined, service: "*", shape: "any", ...over });
  test("any picks the highest p95 among rows with enough calls", () => {
    expect(pickSlowQuery(slow({}), rows)?.shapeId).toBe("33333333");
    expect(pickSlowQuery(slow({ minCalls: 1 }), rows)?.shapeId).toBe("22222222");
    expect(pickSlowQuery(slow({ service: "shop-api" }), rows)?.shapeId).toBe("11111111");
  });
  test("a named shape matches by service and id; missing is no data", () => {
    expect(slowQueryReading(slow({ shape: { id: "11111111", service: "shop-api" } }), rows)).toEqual({ value: 400, noData: false, query: rows[0] });
    expect(slowQueryReading(slow({ shape: { id: "11111111", service: "other-api" } }), rows).noData).toBe(true);
    expect(slowQueryReading(slow({ shape: { id: "22222222", service: "shop-api" } }), rows).noData).toBe(true);
  });
});

describe("breach and observation", () => {
  test("above and below", () => {
    expect(isBreach(rule({}), { value: 301, noData: false })).toBe(true);
    expect(isBreach(rule({}), { value: 300, noData: false })).toBe(false);
    expect(isBreach(rule({ comparator: Comparator.Below }), { value: 299, noData: false })).toBe(true);
    expect(observe(rule({}), { value: 999, noData: true }).kind).toBe(ObservationKind.NoData);
    expect(observe(rule({}), { value: 999, noData: false }).kind).toBe(ObservationKind.Breach);
    expect(observe(rule({}), { value: 1, noData: false }).kind).toBe(ObservationKind.Ok);
  });
});
