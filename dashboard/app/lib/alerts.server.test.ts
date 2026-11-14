import { describe, expect, test } from "bun:test";
import { AlertMetric, METRIC_META, RETIRED_METRICS, RETIRED_NOTE, isAlertMetric, normalizeRule, ruleQuery, type AlertRule } from "./alerts.server";
import { parseRule, ruleForMs, ruleFromDraft, type RuleDraftInput } from "./alert-kinds";

const base: AlertRule = { id: "r1", name: "x", metric: AlertMetric.ErrorRate, service: "*", comparator: ">", threshold: 2, channelIds: [], enabled: true };

describe("alert kinds", () => {
  test("five kinds: two log kinds and three slowness kinds; container kinds stay retired", () => {
    expect(Object.keys(METRIC_META).sort()).toEqual(["error_rate", "log_rate", "route_error_rate", "route_p95", "slow_query"]);
    for (const k of RETIRED_METRICS) expect(isAlertMetric(k)).toBe(false);
  });
  test("a stored container rule comes back disabled with the note", () => {
    for (const metric of RETIRED_METRICS) {
      const r = normalizeRule({ ...base, metric, enabled: true });
      expect(r.enabled).toBe(false);
      expect(r.retired).toBe(RETIRED_NOTE);
    }
  });
  test("a log rule is unchanged", () => {
    expect(normalizeRule(base)).toEqual(base);
  });
  test("rules count ordinary log lines, never hop records", () => {
    expect(ruleQuery(AlertMetric.ErrorRate, "*")).toBe('sum(rate({kind!="hop",level="error",service=~".+"}[5m]))');
    expect(ruleQuery(AlertMetric.LogRate, 'a"b')).toBe('sum(rate({kind!="hop",service="a\\"b"}[5m]))');
  });
});

describe("one service, one name (BAC-51)", () => {
  test("a rule for a service counts its lines under any of its sources", async () => {
    const { buildServiceNames } = await import("./service-names");
    const names = buildServiceNames([{ source: "dev-commerce-api-dserve", service: "commerce-api" }]);
    expect(ruleQuery(AlertMetric.ErrorRate, "commerce-api", names)).toBe('sum(rate({kind!="hop",level="error",source=~"dev-commerce-api-dserve"}[5m]))');
    expect(ruleQuery(AlertMetric.LogRate, "worker", names)).toBe('sum(rate({kind!="hop",service="worker"}[5m]))');
  });
  test("a rule saved under the container name keeps counting after lines are relabelled", async () => {
    const { buildServiceNames } = await import("./service-names");
    const names = buildServiceNames([{ source: "dev-commerce-api-dserve", service: "commerce-api" }]);
    expect(ruleQuery(AlertMetric.LogRate, "dev-commerce-api-dserve", names)).toBe('sum(rate({kind!="hop",source=~"dev-commerce-api-dserve"}[5m]))');
  });
});

describe("rules are validated on read (BAC-72)", () => {
  test("a stored log rule reads back unchanged", () => {
    expect(parseRule({ ...base })).toEqual(base);
  });
  test("a route rule keeps its fields; malformed optional fields are dropped", () => {
    const stored = { ...base, metric: "route_p95", service: "shop-api", route: { method: "GET", op: "/x" }, window: "15m", minRequests: 10, forMinutes: 3 };
    expect(parseRule(stored)).toEqual({ ...base, metric: AlertMetric.RouteP95, service: "shop-api", route: { method: "GET", op: "/x" }, window: "15m", minRequests: 10, forMinutes: 3 });
    const bad = parseRule({ ...stored, window: "2m", minRequests: -1, forMinutes: 99, route: { op: 3 }, shape: { id: 1 } });
    expect(bad).toEqual({ ...base, metric: AlertMetric.RouteP95, service: "shop-api" });
  });
  test("not a rule at all is null; a retired kind survives parsing so it can be retired", () => {
    expect(parseRule(null)).toBeNull();
    expect(parseRule({ id: "x" })).toBeNull();
    expect(parseRule({ ...base, threshold: "2" })).toBeNull();
    expect(normalizeRule(parseRule({ ...base, metric: "cpu" })!).retired).toBe(RETIRED_NOTE);
  });
  test("pending period defaults: 5 minutes for slowness kinds, none for log kinds", () => {
    expect(ruleForMs(base)).toBe(0);
    expect(ruleForMs({ ...base, metric: AlertMetric.RouteP95 })).toBe(5 * 60_000);
    expect(ruleForMs({ ...base, metric: AlertMetric.SlowQuery, forMinutes: 2 })).toBe(2 * 60_000);
  });
});

describe("the New rule form (BAC-72)", () => {
  const draft = (over: Partial<RuleDraftInput>): RuleDraftInput => ({
    name: "Slow orders", metric: "route_p95", service: "shop-api", comparator: null, threshold: "300", channelIds: ["c1"],
    route: "GET /orders/:id", window: "15m", minRequests: "", shape: null, minCalls: null, forMinutes: "", ...over,
  });
  test("a route rule gets its defaults and always fires above", () => {
    expect(ruleFromDraft(draft({}))).toEqual({ ok: true, rule: {
      name: "Slow orders", metric: AlertMetric.RouteP95, service: "shop-api", comparator: ">", threshold: 300, channelIds: ["c1"],
      route: { method: "GET", op: "/orders/:id" }, window: "15m", minRequests: 20, forMinutes: 5,
    } });
  });
  test("a route without a method keeps the empty method", () => {
    const r = ruleFromDraft(draft({ route: " Receipts.SendEmail" }));
    expect(r.ok && r.rule.route).toEqual({ method: "", op: "Receipts.SendEmail" });
  });
  test("each missing or bad field has its own message", () => {
    expect(ruleFromDraft(draft({ metric: "cpu" }))).toEqual({ ok: false, error: "Pick a valid metric." });
    expect(ruleFromDraft(draft({ threshold: "" }))).toEqual({ ok: false, error: "Threshold must be a number." });
    expect(ruleFromDraft(draft({ threshold: "0" }))).toEqual({ ok: false, error: "Threshold must be above 0." });
    expect(ruleFromDraft(draft({ service: "*" }))).toEqual({ ok: false, error: "Pick a service." });
    expect(ruleFromDraft(draft({ route: "" }))).toEqual({ ok: false, error: "Pick a route." });
    expect(ruleFromDraft(draft({ window: "2m" }))).toEqual({ ok: false, error: "Pick a window of 5 minutes, 15 minutes or 1 hour." });
    expect(ruleFromDraft(draft({ forMinutes: "61" }))).toEqual({ ok: false, error: "Wait must be a whole number from 0 to 60." });
    expect(ruleFromDraft(draft({ metric: "route_error_rate", threshold: "120" }))).toEqual({ ok: false, error: "An error rate threshold is a percent, from 0 to 100." });
    expect(ruleFromDraft(draft({ metric: "slow_query", shape: "nope" }))).toEqual({ ok: false, error: "Pick a query, or Any query." });
  });
  test("a slow query rule on a named shape takes the shape's service", () => {
    const r = ruleFromDraft(draft({ metric: "slow_query", service: "*", shape: "shop-api:5bcb6030", minCalls: "10" }));
    expect(r.ok && r.rule).toMatchObject({ metric: "slow_query", service: "shop-api", shape: { service: "shop-api", id: "5bcb6030" }, minCalls: 10 });
    const any = ruleFromDraft(draft({ metric: "slow_query", service: "*", shape: "any" }));
    expect(any.ok && any.rule).toMatchObject({ service: "*", shape: "any", minCalls: 20 });
  });
  test("a log rule keeps the old fields", () => {
    expect(ruleFromDraft(draft({ metric: "error_rate", comparator: ">", threshold: "2", service: "" }))).toEqual({ ok: true, rule: {
      name: "Slow orders", metric: AlertMetric.ErrorRate, service: "*", comparator: ">", threshold: 2, channelIds: ["c1"],
    } });
    expect(ruleFromDraft(draft({ metric: "log_rate", comparator: "=" }))).toEqual({ ok: false, error: "Pick a valid comparator." });
  });
});
