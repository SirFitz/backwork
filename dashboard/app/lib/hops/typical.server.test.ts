// BAC-75: choosing the typical request to compare with, with an injected Loki read.
import { describe, expect, test } from "bun:test";
import type { LogEntry } from "~/lib/loki.server";
import type { Tenant } from "~/lib/tenant.server";
import type { RequestListRow } from "./requests.server";
import { pickTypical, typicalRequest, TYPICAL_RECORD_LIMIT, TYPICAL_WINDOW_MS, type TypicalHead } from "./typical.server";

const NOW = 1_763_020_800_000;
const tenant: Tenant = { orgId: "org-typical", platform: false };
const trace = (n: number): string => n.toString(16).padStart(32, "0");
const HEAD: TypicalHead = { traceId: trace(1) as TypicalHead["traceId"], service: "shop-api", method: "GET", op: "/orders/:id", failed: false };

function row(n: number, durationMs: number, over: Partial<RequestListRow> = {}): RequestListRow {
  return {
    traceID: trace(n), service: "shop-api", method: "GET", route: "/orders/:id", path: "/orders/7", status: 200,
    durationMs, startMs: NOW - 1000 * n, error: false, totals: null, ...over,
  };
}

describe("pickTypical", () => {
  test("the one nearest the median, among those within 0.8x to 1.25x of it", () => {
    // Median of 100, 150, 160, 170, 400 is 160.
    const rows = [row(2, 100), row(3, 150), row(4, 170), row(5, 400), row(6, 160)];
    expect(pickTypical(rows, HEAD)).toEqual({ traceId: trace(6), durationMs: 160 });
  });
  test("an even count: nearest the middle pair's mean", () => {
    // Median (160 + 170) / 2 = 165; 160 and 170 tie, the faster one wins.
    const rows = [row(2, 100), row(3, 160), row(4, 170), row(5, 400), row(6, 500), row(7, 60)];
    expect(pickTypical(rows, HEAD)?.traceId).toBe(trace(3));
  });
  test("fewer than 5 candidates: the fastest", () => {
    expect(pickTypical([row(2, 300), row(3, 120), row(4, 200)], HEAD)).toEqual({ traceId: trace(3), durationMs: 120 });
  });
  test("leaves out the head itself, other routes, services and methods", () => {
    const rows = [row(1, 10), row(2, 20, { route: "/shop" }), row(3, 30, { service: "other" }), row(4, 40, { method: "POST" }), row(5, 500)];
    expect(pickTypical(rows, HEAD)?.traceId).toBe(trace(5));
  });
  test("leaves out failed ones for a request that did not fail, and the reverse", () => {
    const rows = [row(2, 10, { status: 500 }), row(3, 20, { error: true }), row(4, 300)];
    expect(pickTypical(rows, HEAD)?.traceId).toBe(trace(4));
    expect(pickTypical(rows, { ...HEAD, failed: true })?.traceId).toBe(trace(2));
  });
  test("one trace listed twice counts once", () => {
    const rows = [row(2, 100), row(2, 100), row(3, 101), row(4, 102), row(5, 103)];
    // Four distinct candidates: the fastest.
    expect(pickTypical(rows, HEAD)?.traceId).toBe(trace(2));
  });
  test("null when none qualifies", () => {
    expect(pickTypical([], HEAD)).toBeNull();
    expect(pickTypical([row(1, 10)], HEAD)).toBeNull();
  });
});

function entry(n: number, durUs: number, route = "/orders/:id"): LogEntry {
  const line = `trace_id=${trace(n)} hop=in_end hop_id=${n.toString(16).padStart(16, "0")} service=shop-api adapter=fastify via=http method=GET op=${route} outcome=ok status=200 duration_us=${durUs}`;
  return { ts: NOW - n * 1000, line, labels: { service: "shop-api", kind: "hop" }, level: "info", service: "shop-api" };
}

describe("typicalRequest", () => {
  test("reads the last hour of the route's end records and picks from them", async () => {
    const calls: Array<{ query: string; start: number; end: number; limit: number }> = [];
    const pick = await typicalRequest(tenant, HEAD, NOW, async (query, opts) => {
      calls.push({ query, ...opts });
      return [entry(1, 400_000), entry(2, 180_000), entry(3, 90_000), entry(4, 30_000, "/shop")];
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain('{kind="hop",service="shop-api"}');
    expect(calls[0].query).toContain('|= "/orders/:id"');
    expect(calls[0]).toMatchObject({ start: NOW - TYPICAL_WINDOW_MS, end: NOW, limit: TYPICAL_RECORD_LIMIT });
    // Head (1) and the other route (4) left out; two candidates: the fastest.
    expect(pick).toEqual({ traceId: trace(3), durationMs: 90 });
  });
  test("null when the log store has none", async () => {
    expect(await typicalRequest(tenant, HEAD, NOW, async () => [])).toBeNull();
  });
  test("null without a route, with no query", async () => {
    let asked = false;
    const pick = await typicalRequest(tenant, { ...HEAD, op: null }, NOW, async () => {
      asked = true;
      return [];
    });
    expect(pick).toBeNull();
    expect(asked).toBe(false);
  });
});
