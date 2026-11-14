import { describe, expect, test } from "bun:test";
import { AlertMetric, Comparator, type AlertRule } from "./alert-kinds";
import { evaluate, evaluateRule, targetRoutes, type EvalDeps } from "./alerts-eval.server";
import { EMPTY_NAMES } from "./service-names";
import type { QueryRow } from "./hops/slow-queries";
import type { Tenant } from "./tenant.server";

const tenant: Tenant = { orgId: "org-1", platform: false };

const route: AlertRule = {
  id: "r1", name: "slow orders", metric: AlertMetric.RouteP95, service: "shop-api", comparator: Comparator.Above, threshold: 300,
  channelIds: [], enabled: true, route: { method: "GET", op: "/orders/:id" }, window: "15m",
};

/** A fake VictoriaMetrics: answers by which part of the query it sees. */
function deps(answers: { requests?: number; p95?: number; errA?: number; errB?: number; fail?: boolean }, rows: QueryRow[] = []): EvalDeps & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    prom: {
      instant: async (q, t) => {
        seen.push(q);
        expect(t).toBe(tenant);
        if (answers.fail) throw new Error("vm down");
        const v = q.startsWith("histogram_quantile") ? answers.p95 : q.includes('outcome="error"') ? answers.errA : q.includes("5xx") ? answers.errB : answers.requests;
        return v === undefined ? [] : [{ metric: {}, value: v }];
      },
    },
    logScalar: async () => 3,
    names: async () => EMPTY_NAMES,
    slowRows: async () => rows,
  };
}

describe("evaluateRule", () => {
  test("route p95 in ms with the request count", async () => {
    expect(await evaluateRule(route, tenant, deps({ requests: 120, p95: 0.48 }))).toEqual({ value: 480, noData: false, requests: 120 });
  });
  test("below the floor is no data", async () => {
    expect((await evaluateRule(route, tenant, deps({ requests: 19, p95: 0.48 }))).noData).toBe(true);
  });
  test("a failing query is no data, never firing", async () => {
    const s = await evaluate(tenant, deps({ fail: true }), [route]);
    expect(s[0].noData).toBe(true);
    expect(s[0].firing).toBe(false);
  });
  test("route error rate reads requests and both error halves, not the p95", async () => {
    const d = deps({ requests: 200, errA: 6, errB: 4, p95: 9 });
    expect(await evaluateRule({ ...route, metric: AlertMetric.RouteErrorRate, threshold: 2 }, tenant, d)).toEqual({ value: 5, noData: false, requests: 200 });
    expect(d.seen.some((q) => q.startsWith("histogram_quantile"))).toBe(false);
  });
  test("a route that cannot be placed in a query is no data without asking", async () => {
    const d = deps({ requests: 200, p95: 1 });
    expect((await evaluateRule({ ...route, service: "shop api" }, tenant, d)).noData).toBe(true);
    expect(d.seen).toEqual([]);
  });
  test("slow query any picks the max over rows with enough calls; a missing shape is no data", async () => {
    const row = (shapeId: string, p95S: number, calls: number): QueryRow => ({ shapeId, shape: "select ?", sample: "select 1", service: "shop-api", peer: null, table: null, calls, totalS: 1, p95S, p95Approx: false, shareOfDb: 0.5 });
    const rows = [row("11111111", 0.4, 30), row("22222222", 2, 2)];
    const slow: AlertRule = { ...route, metric: AlertMetric.SlowQuery, route: undefined, service: "*", shape: "any" };
    expect((await evaluateRule(slow, tenant, deps({}, rows))).value).toBe(400);
    expect((await evaluateRule({ ...slow, shape: { id: "99999999", service: "shop-api" } }, tenant, deps({}, rows))).noData).toBe(true);
  });
  test("log kinds still read Loki; retired kinds read nothing", async () => {
    expect(await evaluateRule({ ...route, metric: AlertMetric.ErrorRate, route: undefined, service: "*", threshold: 2 }, tenant, deps({}))).toEqual({ value: 3, noData: false });
    expect((await evaluateRule({ ...route, metric: "cpu" }, tenant, deps({}))).noData).toBe(true);
  });
});

describe("targetRoutes", () => {
  test("every route with traffic, sorted, once each", async () => {
    const prom = {
      instant: async () => [
        { metric: { service: "shop-api", method: "GET", op: "/shop" }, value: 1 },
        { metric: { service: "commerce-worker", op: "Receipts.SendEmail" }, value: 1 },
        { metric: { service: "shop-api", method: "GET", op: "/feed" }, value: 0 },
        { metric: { service: "shop-api", method: "GET", op: "/orders/:id" }, value: 2 },
      ],
    };
    expect(await targetRoutes(tenant, prom)).toEqual([
      { service: "commerce-worker", method: "", op: "Receipts.SendEmail" },
      { service: "shop-api", method: "GET", op: "/orders/:id" },
      { service: "shop-api", method: "GET", op: "/shop" },
    ]);
  });
});
