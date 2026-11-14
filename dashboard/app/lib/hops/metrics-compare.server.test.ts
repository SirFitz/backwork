// BAC-67: the offset and lookback parameters, the all-routes scope and the generalised window
// queries. The snapshot file holds the strings the builders produced on main before they gained
// these parameters; with default arguments they must stay byte-identical.
import { describe, expect, test } from "bun:test";
import snapshot from "./query-defaults.snapshot.json";
import { COUNTER_LOOKBACK_SECONDS, windowIncrease, windowPerSecond } from "./counter-window";
import {
  allRoutesScope,
  connectionsScope,
  errorRateQueries,
  HealthChecks,
  PerfRange,
  quantileQuery,
  Quantile,
  rateQuery,
  routesScope,
  servicesScope,
  storeShareQuery,
  trendQuery,
  windowQueries,
} from "./metrics.server";
import { windowQueries as attentionWindowQueries } from "./attention.server";

describe("default arguments keep today's strings", () => {
  test("rate, error, quantile, trend and store share builders", () => {
    expect(rateQuery("in", servicesScope(), PerfRange.H6)).toBe(snapshot.rate);
    expect(rateQuery("in", routesScope("svc"), PerfRange.H1)).toBe(snapshot.rateRoutes);
    expect(errorRateQueries("in", servicesScope(), PerfRange.H1)).toEqual(snapshot.err as [string, string]);
    expect(quantileQuery(Quantile.P95, "in", routesScope("svc"), PerfRange.H1)).toBe(snapshot.q);
    expect(quantileQuery(Quantile.P50, "out", connectionsScope(), PerfRange.H24)).toBe(snapshot.qOut);
    expect(trendQuery(PerfRange.H6)).toBe(snapshot.trend);
    // BAC-79: the store share gains only `store=~"db|cache"` on its store selector (see
    // metrics-cache-pool.server.test.ts); every other character is main's.
    expect(storeShareQuery(servicesScope(), PerfRange.H1)).toBe(snapshot.share.replaceAll("backwork_hop_store_seconds_total{", 'backwork_hop_store_seconds_total{store=~"db|cache",'));
  });

  test("counter windows", () => {
    expect(windowIncrease('m{dir="in"}', "1h", ["service"], "7d")).toBe(snapshot.wi);
    expect(windowPerSecond('m{dir="in"}', "1h", ["service"])).toBe(snapshot.wps);
  });

  test("the Overview's attention window queries", () => {
    expect(attentionWindowQueries(null)).toEqual(snapshot.wq0);
    expect(attentionWindowQueries("15m")).toEqual(snapshot.wq15);
  });

  test("the generalised windowQueries reproduces them", () => {
    expect(windowQueries("15m", null, ["service"])).toEqual(snapshot.wq0);
    expect(windowQueries("3h", "15m", ["service"])).toEqual(snapshot.wq15);
  });
});

/** A lookback that keeps a 7-day offset inside the 14-day retention. */
const LB = 6 * 86400;

describe("offset and lookback", () => {
  test("windowIncrease with offset 7d and a shorter lookback", () => {
    expect(windowIncrease('m{dir="in"}', "1h", ["service"], "7d", LB)).toBe(
      'clamp_min((sum by (service) (increase(m{dir="in"}[522000s] offset 604800s)) - sum by (service) (increase(m{dir="in"}[518400s] offset 608400s))) or sum by (service) (increase(m{dir="in"}[522000s] offset 604800s)), 0)',
    );
  });

  test("windowPerSecond threads offset and lookback", () => {
    expect(windowPerSecond("m", "1h", [], "7d", LB)).toBe(`${windowIncrease("m", "1h", [], "7d", LB)} / 3600`);
  });

  test("rateQuery offset 7d", () => {
    const q = rateQuery("in", servicesScope(HealthChecks.Shown), PerfRange.H1, "7d", LB);
    expect(q).toContain('backwork_hop_duration_seconds_count{dir="in"}[522000s] offset 604800s');
    expect(q).toContain('[518400s] offset 608400s');
    expect(q.endsWith(" / 3600")).toBe(true);
  });

  test("rateQuery with an offset and the default lookback", () => {
    expect(rateQuery("in", servicesScope(), PerfRange.H1, "7d")).toContain(`[${3600 + COUNTER_LOOKBACK_SECONDS}s] offset 604800s`);
  });

  test("errorRateQueries offset applies to both halves", () => {
    const [a, b] = errorRateQueries("in", servicesScope(), PerfRange.H1, "7d", LB);
    for (const q of [a, b]) {
      expect(q).toContain("[522000s] offset 604800s");
      expect(q).toContain("[518400s] offset 608400s");
    }
    expect(a).toContain('outcome="error"');
    expect(b).toContain('outcome!="error",status_class="5xx"');
  });

  test("quantileQuery offset", () => {
    const q = quantileQuery(Quantile.P95, "in", servicesScope(HealthChecks.Shown), PerfRange.H6, undefined, "7d", LB);
    expect(q).toBe(`histogram_quantile(0.95, ${windowIncrease('backwork_hop_duration_seconds_bucket{dir="in"}', "6h", ["service", "le"], "7d", LB)})`);
  });

  test("never rate() with an offset either", () => {
    expect(rateQuery("in", servicesScope(), PerfRange.H24, "7d", LB)).not.toMatch(/\brate\(/);
  });
});

describe("allRoutesScope", () => {
  test("every route of every service", () => {
    expect(allRoutesScope()).toEqual({ by: ["service", "method", "op"], where: {}, health: HealthChecks.Hidden });
    expect(rateQuery("in", allRoutesScope(HealthChecks.Shown), PerfRange.H1)).toContain('sum by (service, method, op) (increase(backwork_hop_duration_seconds_count{dir="in"}[');
  });
});

describe("windowQueries", () => {
  test("by route, health shown, last week", () => {
    const q = windowQueries("1h", "7d", ["service", "method", "op"], HealthChecks.Shown, LB);
    expect(q.requests).toBe(windowIncrease('backwork_hop_duration_seconds_count{dir="in"}', "1h", ["service", "method", "op"], "7d", LB));
    expect(q.errA).toContain('{dir="in",outcome="error"}');
    expect(q.errB).toContain('{dir="in",outcome!="error",status_class="5xx"}');
    expect(q.p95).toContain("sum by (service, method, op, le)");
  });
});
