import { describe, expect, test } from "bun:test";
import { splitRequests } from "./split";
import { buildRequestTree } from "./tree";
import type { HopId, HopKind, HopRecord, LinkedId, TraceId, TraceLogLine, Via } from "./types";

const TRACE = "068faeb300214014b3c1b5c8d878194b" as TraceId;
const T0 = 1_762_941_663_000;
const hid = (n: number): HopId => n.toString(16).padStart(16, "0") as HopId;

function rec(kind: HopKind, id: number, parent: number | null, svc: string, timeMs: number, via: Via = "http", method: string | null = null): HopRecord {
  const out = kind === "out" || kind === "out_end";
  const end = kind === "in_end" || kind === "out_end";
  return {
    traceId: TRACE, hop: kind, hopId: hid(id), parentHop: parent ? hid(parent) : null, hopSent: out ? true : null,
    tracer: false, handoff: false, parentId: "b7ad6b7169203331", service: svc, source: svc, adapter: "test", via,
    method, op: null, peer: out ? "x.internal" : null, table: null, stmt: null, path: null, attempt: null,
    outcome: end ? "ok" : null, status: end ? 200 : null, error: null, durationUs: end ? 5000 : null,
    totals: null, fields: [], timeMs,
  };
}
const pair = (id: number, parent: number | null, svc: string, at: number, via: Via = "http", method: string | null = null): HopRecord[] =>
  [rec("in", id, parent, svc, T0 + at, via, method), rec("in_end", id, parent, svc, T0 + at + 5, via, method)];

const log = (svc: string, at: number): TraceLogLine => ({ service: svc, timeMs: T0 + at, line: "x" } as TraceLogLine);

describe("splitRequests", () => {
  test("a GET and a POST 13 s apart with one trace ID are two requests", () => {
    const records = [...pair(1, null, "app", 0, "http", "GET"), ...pair(2, null, "app", 13_060, "http", "POST")];
    const parts = splitRequests(records, [log("app", 2), log("app", 13_062)], []);
    expect(parts).toHaveLength(2);
    expect(parts[0].records.every((r) => r.method === "GET")).toBe(true);
    expect(parts[1].records.every((r) => r.method === "POST")).toBe(true);
    expect(parts[0].logs).toHaveLength(1);
    expect(parts[1].logs).toHaveLength(1);
    const trees = parts.map((p) => buildRequestTree(p.records, p.logs, T0 + 20_000, p.links));
    expect(trees.map((t) => t.roots.length)).toEqual([1, 1]);
  });

  test("a downstream call stays with the request that made it", () => {
    const records = [
      ...pair(1, null, "app", 0), rec("out", 3, 1, "app", T0 + 1), rec("out_end", 3, 1, "app", T0 + 4), ...pair(4, 3, "api", 2),
      ...pair(2, null, "app", 13_000), rec("out", 5, 2, "app", T0 + 13_001), rec("out_end", 5, 2, "app", T0 + 13_004), ...pair(6, 5, "api", 13_002),
    ];
    const parts = splitRequests(records, [], []);
    expect(parts).toHaveLength(2);
    expect(new Set(parts[0].records.map((r) => r.hopId))).toEqual(new Set([1, 3, 4].map(hid)));
    expect(new Set(parts[1].records.map((r) => r.hopId))).toEqual(new Set([2, 5, 6].map(hid)));
  });

  test("a request with its job and a retry stays one request", () => {
    const records = [...pair(1, null, "app", 0), rec("out", 2, 1, "app", T0 + 1, "job"), rec("out_end", 2, 1, "app", T0 + 2, "job"), ...pair(3, 2, "worker", 2000, "job"), ...pair(4, 2, "worker", 9000, "job")];
    expect(splitRequests(records, [], [])).toHaveLength(1);
  });

  test("a stray job with a lost caller goes with the latest request that had begun", () => {
    const records = [...pair(1, null, "app", 0, "http", "GET"), ...pair(2, null, "app", 13_000, "http", "POST"), ...pair(9, 77, "worker", 14_000, "job")];
    const parts = splitRequests(records, [], []);
    expect(parts).toHaveLength(2);
    expect(parts[1].records.map((r) => r.hopId)).toContain(hid(9));
  });

  test("linked IDs follow their hop; ones with no hop follow their time", () => {
    const l = (hopId: number | null, at: number): LinkedId => ({ traceId: TRACE, name: "order", value: `v${at}`, hopId: hopId ? hid(hopId) : null, service: "app", timeMs: T0 + at });
    const records = [...pair(1, null, "app", 0), ...pair(2, null, "app", 13_000)];
    const parts = splitRequests(records, [], [l(2, 100), l(null, 13_500)]);
    expect(parts[0].links).toHaveLength(0);
    expect(parts[1].links).toHaveLength(2);
  });

  test("one request, or none, comes back whole", () => {
    expect(splitRequests(pair(1, null, "app", 0), [log("app", 1)], [])).toHaveLength(1);
    expect(splitRequests([], [log("app", 1)], [])).toHaveLength(1);
  });

  test("a parent cycle ends, and no record is lost", () => {
    const records = [...pair(1, 2, "app", 0), ...pair(2, 1, "app", 5)];
    const parts = splitRequests(records, [], []);
    expect(parts.flatMap((p) => p.records)).toHaveLength(records.length);
  });
});
