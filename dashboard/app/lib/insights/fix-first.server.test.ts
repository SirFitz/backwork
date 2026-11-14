import { describe, expect, test } from "bun:test";
import { allRoutesScope, routesByTotalTime, routesByTotalTimeQueries, totalTimeQuery, PerfRange, type PromClient } from "~/lib/hops/metrics.server";
import { HealthChecks } from "~/lib/hops/health";
import { compareRow } from "~/lib/hops/compare";
import type { Tenant } from "~/lib/tenant.server";
import type { SlowQueries } from "~/lib/hops/slow-queries.server";
import type { RepeatScan } from "~/lib/hops/repeats.server";
import { SlowWindow } from "~/lib/hops/slow-queries";
import { computeFixFirst, fixFirst, type FixSources } from "./fix-first.server";
import { FixKind, FixWindow, SourceState } from "./fix-first";

let seq = 0;
const org = (): Tenant => ({ orgId: `fixfirst-test-${++seq}`, platform: false });

type Sample = { metric: Record<string, string>; value: number };

function fakeClient(answers: Array<[(q: string) => boolean, Sample[]]>): { client: PromClient; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    client: {
      async instant(q) {
        seen.push(q);
        for (const [match, out] of answers) if (match(q)) return out;
        return [];
      },
      async range() {
        return [];
      },
    },
  };
}

describe("routesByTotalTime", () => {
  test("ranks by the increase of the duration _sum with topk, the rest restricted to the same routes", () => {
    const q = routesByTotalTimeQueries(allRoutesScope(), PerfRange.H1, 15);
    expect(q.total.startsWith("topk(15, clamp_min((sum by (service, method, op) (increase(backwork_hop_duration_seconds_sum{dir=\"in\",op!~")).toBe(true);
    for (const k of ["requests", "errA", "errB", "p95", "storeShare"] as const) expect(q[k].endsWith(`) and ${q.total}`)).toBe(true);
    expect(q.errA).toContain(`outcome="error"`);
    expect(q.errB).toContain(`outcome!="error",status_class="5xx"`);
    expect(q.p95).toContain("histogram_quantile(0.95");
    expect(q.storeShare).toContain("backwork_hop_store_seconds_total");
    expect(routesByTotalTimeQueries(allRoutesScope(HealthChecks.Shown), PerfRange.H6, 15).total).not.toContain("op!~");
  });

  test("joins the six answers into rows, largest total first", async () => {
    const m = (op: string) => ({ service: "shop-api", method: "GET", op });
    const { client, seen } = fakeClient([
      [(q) => q.startsWith("topk("), [{ metric: m("/shop"), value: 4.3 }, { metric: m("/orders/:id"), value: 35 }, { metric: m("/idle"), value: 0 }]],
      [(q) => q.includes("histogram_quantile"), [{ metric: m("/orders/:id"), value: 0.48 }]],
      [(q) => q.includes("store_seconds"), [{ metric: m("/orders/:id"), value: 0.99 }]],
      [(q) => q.includes(`outcome="error"`), [{ metric: m("/shop"), value: 2 }]],
      [(q) => q.includes("status_class"), [{ metric: m("/shop"), value: 1 }]],
      [(q) => q.includes("_count"), [{ metric: m("/shop"), value: 112 }, { metric: m("/orders/:id"), value: 116 }]],
    ]);
    const rows = await routesByTotalTime(allRoutesScope(), PerfRange.H1, org(), client, 15);
    expect(seen).toHaveLength(6);
    expect(rows).toEqual([
      { service: "shop-api", method: "GET", op: "/orders/:id", totalS: 35, requests: 116, failed: 0, p95S: 0.48, storeShare: 0.99 },
      { service: "shop-api", method: "GET", op: "/shop", totalS: 4.3, requests: 112, failed: 3, p95S: null, storeShare: null },
    ]);
  });

  test("totalTimeQuery reads last week with an offset and a shorter lookback", () => {
    expect(totalTimeQuery(allRoutesScope(), PerfRange.H1, "7d", 518400)).toContain("[522000s] offset 604800s");
  });
});

const slow = (rows: SlowQueries["rows"], statementsOff = false): SlowQueries => ({ rows, window: SlowWindow.H1, computedAt: 0, statementsOff, groupLimited: false });
const scan = (statementsOff = false, truncated = false): RepeatScan => ({ rows: [], recordsRead: 0, truncated, windowMs: 3_600_000, statementsOff });
const fig = { rate: 0.1, errorShare: 0, p50: 0.1, p95: 0.43, p99: 0.6 };

function sources(over: Partial<FixSources> = {}): FixSources {
  return {
    routes: async () => [{ service: "shop-api", method: "GET", op: "/orders/:id", totalS: 35, requests: 116, failed: 0, p95S: 0.48, storeShare: 0.99 }],
    queries: async () =>
      slow([{ shapeId: "ab96385b", shape: "select orders.id from orders", sample: "s", service: "shop-api", peer: "shop-db", table: "orders", calls: 17, totalS: 4.56, p95S: 0.4, p95Approx: false, shareOfDb: 0.9 }]),
    repeats: async () => scan(),
    regressions: async () => [{ row: compareRow("shop-api", null, null, fig, { ...fig, p95: 0.21 }, 360, 360), totalNowS: 48, totalBeforeS: 23 }],
    ...over,
  };
}

describe("computeFixFirst", () => {
  test("ranks every source and marks each ok", async () => {
    const r = await computeFixFirst(org(), FixWindow.H1, 1000, sources());
    expect(r.items.map((i) => i.kind)).toEqual([FixKind.Route, FixKind.Regression, FixKind.Query]);
    expect(Object.values(r.sources)).toEqual([SourceState.Ok, SourceState.Ok, SourceState.Ok, SourceState.Ok]);
    expect(r.computedAt).toBe(1000);
  });

  test("a failing source is unavailable with its reason; the others still rank", async () => {
    const r = await computeFixFirst(org(), FixWindow.H1, 1000, sources({ routes: async () => { throw new Error("fetch failed"); } }));
    expect(r.sources[FixKind.Route]).toBe(SourceState.Unavailable);
    expect(r.errors[FixKind.Route]).toBe("fetch failed");
    expect(r.items.map((i) => i.kind)).toEqual([FixKind.Regression, FixKind.Query]);
  });

  test("query text off shows the statement sources as off", async () => {
    const r = await computeFixFirst(org(), FixWindow.H1, 1000, sources({ queries: async () => slow([], true), repeats: async () => scan(true) }));
    expect(r.sources[FixKind.Query]).toBe(SourceState.Off);
    expect(r.sources[FixKind.Repeat]).toBe(SourceState.Off);
    expect(r.items.map((i) => i.kind)).toEqual([FixKind.Route, FixKind.Regression]);
  });

  test("a sampled repeats scan is passed on", async () => {
    expect((await computeFixFirst(org(), FixWindow.H1, 1000, sources({ repeats: async () => scan(false, true) }))).repeatsSampled).toBe(true);
  });
});

describe("fixFirst cache", () => {
  test("serves a stale value at once and refreshes once in the background", async () => {
    const tenant = org();
    let calls = 0;
    let t = 0;
    const clock = () => t;
    const counted = sources({ routes: async () => { calls++; return []; } });
    await fixFirst(tenant, FixWindow.H1, counted, clock);
    expect(calls).toBe(1);
    t = 30_000; // fresh
    await fixFirst(tenant, FixWindow.H1, counted, clock);
    expect(calls).toBe(1);
    t = 120_000; // stale: served at once, one refresh for both callers
    const [a, b] = await Promise.all([fixFirst(tenant, FixWindow.H1, counted, clock), fixFirst(tenant, FixWindow.H1, counted, clock)]);
    expect(a.computedAt).toBe(0);
    expect(b.computedAt).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    t = 130_000;
    expect((await fixFirst(tenant, FixWindow.H1, counted, clock)).computedAt).toBe(120_000);
  });

  test("windows are cached apart", async () => {
    const tenant = org();
    let calls = 0;
    const counted = sources({ routes: async () => { calls++; return []; } });
    await fixFirst(tenant, FixWindow.H1, counted, () => 0);
    await fixFirst(tenant, FixWindow.H6, counted, () => 0);
    expect(calls).toBe(2);
  });
});
