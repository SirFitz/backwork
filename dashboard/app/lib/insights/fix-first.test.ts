import { describe, expect, test } from "bun:test";
import { compareRow, type CompareRow } from "~/lib/hops/compare";
import type { Figures } from "~/lib/hops/metrics.server";
import type { QueryRow } from "~/lib/hops/slow-queries";
import {
  FIX_MAX_ROWS,
  FixKind,
  FixWindow,
  ItemTone,
  SourceState,
  filterFixItems,
  queryTitle,
  rankFixFirst,
  regressionImpactS,
  sourceNote,
  type FixInputs,
  type FixRegressionInput,
  type FixRepeatInput,
  type FixRouteInput,
} from "./fix-first";

const route = (op: string, totalS: number, extra: Partial<FixRouteInput> = {}): FixRouteInput => ({
  service: "shop-api", method: "GET", op, totalS, requests: 100, failed: 0, p95S: 0.074, storeShare: 0.71, ...extra,
});
const queryRow = (table: string, totalS: number, extra: Partial<QueryRow> = {}): QueryRow => ({
  shapeId: `id${table}`, shape: `select ${table}.id from ${table} where ${table}.id = ?`, sample: "s", service: "shop-api",
  peer: "shop-db", table, calls: 12, totalS, p95S: 0.222, p95Approx: false, shareOfDb: 0.9, ...extra,
});
const repeat = (wastedUs: number, extra: Partial<FixRepeatInput> = {}): FixRepeatInput => ({
  shapeId: "5bcb6030", shape: "select plans.id from plans where plans.number = ?", label: "select plans", service: "shop-api",
  table: "plans", requests: 112, medianRepeats: 14, sequentialRequests: 112, wastedUs, ...extra,
});
const fig = (p95: number, rate: number, errorShare = 0): Figures => ({ rate, errorShare, p50: p95 / 2, p95, p99: p95 * 1.5 });
const regression = (service: string, nowP95: number, beforeP95: number, totalNowS: number, totalBeforeS: number): FixRegressionInput => {
  const row: CompareRow = compareRow(service, null, null, fig(nowP95, 0.1), fig(beforeP95, 0.1), 360, 360);
  return { row, totalNowS, totalBeforeS };
};
const empty: FixInputs = { window: FixWindow.H1, routes: [], queries: [], repeats: [], repeatsSampled: false, regressions: [] };

describe("rankFixFirst", () => {
  test("empty input gives an empty list", () => {
    expect(rankFixFirst(empty)).toEqual([]);
    expect(rankFixFirst({ ...empty, routes: null, queries: null, repeats: null, regressions: null })).toEqual([]);
  });

  test("mixes kinds and sorts by impact, largest first", () => {
    const items = rankFixFirst({
      ...empty,
      routes: [route("/shop", 4.3), route("/orders/:id", 35)],
      queries: [queryRow("orders", 4.6)],
      repeats: [repeat(1_830_000)],
      regressions: [regression("shop-api", 0.43, 0.21, 48, 23)],
    });
    expect(items.map((i) => i.kind)).toEqual([FixKind.Route, FixKind.Regression, FixKind.Query, FixKind.Route, FixKind.Repeat]);
    expect(items.map((i) => i.impactS)).toEqual([35, 25, 4.6, 4.3, 1.83]);
  });

  test("ties are stable by id", () => {
    const items = rankFixFirst({ ...empty, routes: [route("/b", 2), route("/a", 2)] });
    expect(items.map((i) => i.id)).toEqual(["route:shop-api:GET /a", "route:shop-api:GET /b"]);
    expect(rankFixFirst({ ...empty, routes: [route("/a", 2), route("/b", 2)] }).map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  test("limit cuts the list; the default is two pages", () => {
    const routes = Array.from({ length: 40 }, (_, i) => route(`/r${i}`, 40 - i));
    expect(rankFixFirst({ ...empty, routes }, 3)).toHaveLength(3);
    expect(rankFixFirst({ ...empty, routes })).toHaveLength(FIX_MAX_ROWS);
    expect(rankFixFirst({ ...empty, routes }, 0)).toEqual([]);
  });

  test("leaves out zero-time routes and regressions that are not slower or failing more", () => {
    const same = regression("commerce-api", 0.1, 0.1, 10, 10);
    const items = rankFixFirst({ ...empty, routes: [route("/idle", 0)], regressions: [same] });
    expect(items).toEqual([]);
  });

  test("takes at most ten slow queries and ten repeats", () => {
    const queries = Array.from({ length: 14 }, (_, i) => queryRow(`t${i}`, i + 1));
    const repeats = Array.from({ length: 14 }, (_, i) => repeat((i + 1) * 1000, { shapeId: `s${i}` }));
    const items = rankFixFirst({ ...empty, queries, repeats });
    expect(items.filter((i) => i.kind === FixKind.Query)).toHaveLength(10);
    expect(items.filter((i) => i.kind === FixKind.Repeat)).toHaveLength(10);
    expect(Math.min(...items.filter((i) => i.kind === FixKind.Query).map((i) => i.impactS))).toBe(5);
  });
});

describe("labels", () => {
  test("route: time spent, store share and p95; links to the filtered request list", () => {
    const [i] = rankFixFirst({ ...empty, routes: [route("/orders/:id", 84)] });
    expect(i.title).toBe("GET /orders/:id");
    expect(i.impactLabel).toBe("1 m 24 s of request time in the last hour");
    expect(i.why).toBe("71% of its time is database and cache, p95 74.0 ms, 100 requests");
    expect(i.href).toBe("/requests?service=shop-api&method=GET&route=%2Forders%2F%3Aid&range=1h");
    expect(i.tone).toBe(ItemTone.Neutral);
  });

  test("route: error-heavy routes are amber and say so; jobs have no method", () => {
    const [i] = rankFixFirst({ ...empty, window: FixWindow.H6, routes: [route("Receipts.SendEmail", 3, { method: "", failed: 8, storeShare: null })] });
    expect(i.title).toBe("Receipts.SendEmail");
    expect(i.tone).toBe(ItemTone.Warn);
    expect(i.why.startsWith("8% of its requests failed")).toBe(true);
    expect(i.impactLabel).toBe("3.00 s of request time in the last 6 hours");
    expect(i.href).toBe("/requests?service=shop-api&route=Receipts.SendEmail&range=6h");
  });

  test("route: overlapping store calls never read as more than 100%", () => {
    const [i] = rankFixFirst({ ...empty, routes: [route("/feed", 0.4, { storeShare: 2.86 })] });
    expect(i.why).not.toContain("286%");
    expect(i.why).toContain("overlap");
  });

  test("query: verb and table title in mono, time in the query, link opens the row", () => {
    const [i] = rankFixFirst({ ...empty, window: FixWindow.H6, queries: [queryRow("orders", 4.56, { p95Approx: true })] });
    expect(i.title).toBe("select orders");
    expect(i.mono).toBe(true);
    expect(i.impactLabel).toBe("4.56 s in this query in the last 6 hours");
    expect(i.why).toBe("12 calls, p95 about 222 ms, 90% of the service's database time");
    expect(i.href).toBe("/insights/queries?window=6h&service=shop-api&open=shop-api%3Aidorders");
  });

  test("repeat: a saving, labelled could save, at least when sampled", () => {
    const [i] = rankFixFirst({ ...empty, repeats: [repeat(1_830_000)] });
    expect(i.title).toBe("select plans, 14 times per request");
    expect(i.impactLabel).toBe("could save 1.83 s in the last hour");
    expect(i.impactShort).toBe("save 1.83 s");
    const [s] = rankFixFirst({ ...empty, repeats: [repeat(1_830_000, { sequentialRequests: 0 })], repeatsSampled: true });
    expect(s.impactLabel).toBe("could save at least 1.83 s in the last hour");
    expect(s.why).toBe("repeated in 112 requests, together (sampled)");
  });

  test("regression: time added against last week, amber, links to the compare view", () => {
    const [i] = rankFixFirst({ ...empty, regressions: [regression("shop-api", 0.43, 0.21, 48, 23)] });
    expect(i.title).toBe("shop-api, slower than last week");
    expect(i.impactLabel).toBe("added 25.00 s in the last hour");
    expect(i.why).toBe("p95 430 ms, 2.0x last week");
    expect(i.tone).toBe(ItemTone.Warn);
    expect(i.href).toBe("/performance?service=shop-api&compare=1&range=1h");
  });

  test("could save, spent and added stay separate: nothing is summed across kinds", () => {
    const items = rankFixFirst({ ...empty, routes: [route("/shop", 4)], repeats: [repeat(2_000_000)], regressions: [regression("shop-api", 0.43, 0.21, 48, 23)] });
    expect(items).toHaveLength(3);
    expect(items.find((i) => i.kind === FixKind.Route)?.impactLabel).toContain("of request time");
    expect(items.find((i) => i.kind === FixKind.Repeat)?.impactLabel.startsWith("could save")).toBe(true);
    expect(items.find((i) => i.kind === FixKind.Regression)?.impactLabel.startsWith("added")).toBe(true);
  });

  test("queryTitle falls back to the shortened shape without a table", () => {
    expect(queryTitle("select 1", null)).toBe("select 1");
    expect(queryTitle("update stock set n = ?", "stock")).toBe("update stock");
  });
});

describe("regressionImpactS", () => {
  test("requests times the rise of the mean request time", () => {
    // 360 requests both weeks; 48 s now against 23 s then: 25 s added.
    expect(regressionImpactS(regression("a", 0.43, 0.21, 48, 23))).toBeCloseTo(25, 6);
  });
  test("scales last week to this week's requests and never goes below zero", () => {
    const r = regression("a", 0.43, 0.21, 10, 30);
    expect(regressionImpactS(r)).toBe(0);
    const busier: FixRegressionInput = { ...r, row: { ...r.row, requestsNow: 720, requestsBefore: 360 }, totalNowS: 80, totalBeforeS: 30 };
    expect(regressionImpactS(busier)).toBeCloseTo(20, 6);
  });
  test("zero without both totals or without last week's requests", () => {
    const r = regression("a", 0.43, 0.21, 48, 23);
    expect(regressionImpactS({ ...r, totalBeforeS: null })).toBe(0);
    expect(regressionImpactS({ ...r, row: { ...r.row, requestsBefore: 0 } })).toBe(0);
  });
});

describe("filterFixItems and sourceNote", () => {
  test("filters by kind in rank order; null keeps every item", () => {
    const items = rankFixFirst({ ...empty, routes: [route("/a", 3), route("/b", 1)], queries: [queryRow("orders", 2)] });
    expect(filterFixItems(items, FixKind.Route).map((i) => i.impactS)).toEqual([3, 1]);
    expect(filterFixItems(items, FixKind.Repeat)).toEqual([]);
    expect(filterFixItems(items, null)).toHaveLength(3);
  });
  test("notes only for sources that did not contribute", () => {
    expect(sourceNote(FixKind.Query, SourceState.Ok)).toBeNull();
    expect(sourceNote(FixKind.Query, SourceState.Off)).toBe("Slow queries off: query text is switched off for this organisation.");
    expect(sourceNote(FixKind.Route, SourceState.Unavailable)).toBe("Route figures unavailable.");
  });
});
