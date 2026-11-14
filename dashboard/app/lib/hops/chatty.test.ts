// BAC-71: chatty requests on the list and the request view.
import { describe, expect, test } from "bun:test";
import {
  CHATTY_CALLS, CHATTY_MIN_SAMPLE, ChattyReason, byMostCalls, callsOf, chattyRequest, chattyRow, chattyRows, chattySentence,
  median, onlyChatty, type ChattyInput,
} from "./chatty";
import { buildRequestTree } from "./tree";
import { HopKind, Via, type HopId, type HopRecord, type StoreTotals, type TraceId } from "./types";

function row(dbCalls: number | null, route = "/shop", cacheCalls = 0, over: Partial<ChattyInput> = {}): ChattyInput {
  const totals: StoreTotals | null = dbCalls === null ? null : { dbCalls, dbUs: dbCalls * 1000, cacheCalls, cacheUs: cacheCalls * 500 };
  return { service: "shop-api", method: "GET", route, totals, durationMs: 100, ...over };
}

describe("chatty list rows", () => {
  test("50 calls is chatty on its own; 49 is not", () => {
    expect(chattyRow(row(40, "/a", 10), []).chatty).toBe(true);
    expect(chattyRow(row(40, "/a", 10), []).reason).toBe(ChattyReason.Absolute);
    expect(chattyRow(row(CHATTY_CALLS - 1), []).chatty).toBe(false);
  });

  test("the relative test needs 8 loaded rows of the route", () => {
    const seven = [...Array.from({ length: 6 }, () => row(5)), row(30)];
    expect(chattyRow(row(30), seven).chatty).toBe(false);
    expect(chattyRow(row(30), seven).routeMedian).toBeNull();
    const eight = [...Array.from({ length: CHATTY_MIN_SAMPLE - 1 }, () => row(5)), row(30)];
    const v = chattyRow(row(30), eight);
    expect(v.chatty).toBe(true);
    expect(v.reason).toBe(ChattyReason.Relative);
    expect(v.routeMedian).toBe(5);
  });

  test("relative: below 3 times the median, or below 10 calls, is not chatty", () => {
    const rows = Array.from({ length: 10 }, () => row(5));
    expect(chattyRow(row(14), rows).chatty).toBe(false);
    expect(chattyRow(row(15), rows).chatty).toBe(true);
    const tiny = Array.from({ length: 10 }, () => row(1));
    expect(chattyRow(row(9), tiny).chatty).toBe(false);
  });

  test("a route that is always busy is not chatty relative to itself (GET /shop: 22 calls every time)", () => {
    const rows = Array.from({ length: 20 }, () => row(22));
    expect(chattyRows(rows).some((v) => v.chatty)).toBe(false);
  });

  test("other routes and services do not share a sample", () => {
    const rows = [...Array.from({ length: 10 }, () => row(2, "/feed")), row(30, "/shop")];
    expect(chattyRow(row(30, "/shop"), rows).chatty).toBe(false);
    const other = Array.from({ length: 10 }, () => row(2, "/shop", 0, { service: "other" }));
    expect(chattyRow(row(30, "/shop"), other).routeMedian).toBeNull();
  });

  test("rows without totals are never flagged and do not count in the sample", () => {
    expect(chattyRow(row(null), []).chatty).toBe(false);
    expect(callsOf(row(null))).toBeNull();
    const rows = [...Array.from({ length: 7 }, () => row(5)), ...Array.from({ length: 5 }, () => row(null))];
    expect(chattyRow(row(30), rows).routeMedian).toBeNull();
  });

  test("median with odd and even counts", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("db share of the duration", () => {
    expect(chattyRow(row(50), []).dbShare).toBe(0.5);
    expect(chattyRow(row(50, "/a", 0, { durationMs: 0 }), []).dbShare).toBeNull();
  });

  test("filter and sort helpers", () => {
    const rows = [row(60), row(3), row(null), row(70, "/b")];
    const verdicts = chattyRows(rows);
    expect(onlyChatty(rows, verdicts)).toEqual([rows[0], rows[3]]);
    expect(byMostCalls(rows)).toEqual([rows[3], rows[0], rows[1], rows[2]]);
  });

  test("sentences", () => {
    expect(chattySentence(chattyRow(row(142), []))).toBe("142 database and cache calls in one request (50 or more is a lot).");
    const rows = [...Array.from({ length: 9 }, () => row(12)), row(40)];
    expect(chattySentence(chattyRow(row(40), rows))).toBe("40 database and cache calls; this route's median is 12 among the loaded requests.");
  });
});

// ---------------------------------------------------------------- whole request

const TRACE = "c4a77c4a77c4a77c4a77c4a77c4a77c4" as TraceId;
const T0 = 1_763_020_800_000;
const hid = (n: number): HopId => n.toString(16).padStart(16, "0") as HopId;

function rec(kind: HopKind, id: number, parent: number | null, timeMs: number, over: Partial<HopRecord>): HopRecord {
  return {
    traceId: TRACE, hop: kind, hopId: hid(id), parentHop: parent === null ? null : hid(parent), hopSent: null, tracer: false,
    handoff: false, parentId: null, service: "shop-api", source: "shop-api", adapter: "fastify", via: Via.Http, method: "GET",
    op: "/shop", path: "/shop", peer: null, table: null, stmt: null, attempt: null, outcome: null, status: null, error: null,
    durationUs: null, totals: null, fields: [], timeMs, ...over,
  };
}

function tree(recorded: number, totals: StoreTotals | null) {
  const calls = Array.from({ length: recorded }, (_, i) =>
    rec(HopKind.OutEnd, 10 + i, 1, T0 + 2 + i, { via: Via.Db, op: "select", peer: "shop-db", table: `t${i}`, stmt: null, adapter: "prisma", outcome: "ok", durationUs: 500, method: null, path: null }),
  );
  return buildRequestTree([
    rec(HopKind.In, 1, null, T0, {}),
    rec(HopKind.InEnd, 1, null, T0 + 200, { outcome: "ok", status: 200, durationUs: 200_000, totals }),
    ...calls,
  ], [], T0 + 60_000);
}

describe("chatty whole request", () => {
  test("counts recorded calls and calls only in the totals", () => {
    const v = chattyRequest(tree(20, { dbCalls: 60, dbUs: 30_000, cacheCalls: 0, cacheUs: 0 }));
    expect(v.calls).toBe(60);
    expect(v.chatty).toBe(true);
    expect(v.reason).toBe(ChattyReason.Absolute);
    expect(v.routeMedian).toBeNull();
  });

  test("22 calls is not chatty", () => {
    const v = chattyRequest(tree(22, { dbCalls: 22, dbUs: 11_000, cacheCalls: 0, cacheUs: 0 }));
    expect(v.calls).toBe(22);
    expect(v.chatty).toBe(false);
    expect(v.dbShare).not.toBeNull();
  });
});
