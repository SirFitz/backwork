// BAC-75: two requests side by side. Requests are built from records and run through
// buildRequestTree, as the comparison page does.
import { describe, expect, test } from "bun:test";
import { buildRequestTree } from "./tree";
import {
  CALLS_DIFF_MIN, DIFF_MIN_SHARE, DIFF_MIN_US, DiffKind, TOP_ROWS, callsNote, differingRows, diffRequests, fmtDeltaUs, rowKind, type DiffRow,
} from "./diff";
import { HopKind, Via, type HopId, type HopRecord, type RequestTree, type TraceId } from "./types";

const T0 = 1_763_020_800_000;
const NOW = T0 + 60_000;
const SVC = "shop-api";
const ORDERS = "select orders.id, orders.total from orders where orders.id = ?";
const PLANS = "select plans.id, plans.name, plans.price from plans where plans.number = ?";
const hid = (n: number): HopId => n.toString(16).padStart(16, "0") as HopId;

function record(trace: TraceId, kind: HopKind, id: number, parent: number | null, timeMs: number, over: Partial<HopRecord>): HopRecord {
  const out = kind === HopKind.Out || kind === HopKind.OutEnd;
  const end = kind === HopKind.InEnd || kind === HopKind.OutEnd;
  return {
    traceId: trace, hop: kind, hopId: hid(id), parentHop: parent === null ? null : hid(parent),
    hopSent: out ? false : null, tracer: false, handoff: false, parentId: null,
    service: SVC, source: SVC, adapter: out ? "prisma" : "fastify", via: Via.Http, method: null, op: null, path: null,
    peer: null, table: null, stmt: null, attempt: null, outcome: end ? "ok" : null, status: null, error: null,
    durationUs: null, totals: null, fields: [], timeMs, ...over,
  };
}

/** What a test request makes, in order. Times in ms from the request's start. */
type Call =
  | { db: string; table: string; ms: number; times?: number }
  | { cache: string; ms: number }
  | { service: string; route: string; ms: number };

interface Spec {
  trace: number;
  durMs: number;
  calls: Call[];
  route?: string;
}

function build(spec: Spec): RequestTree {
  const trace = spec.trace.toString(16).padStart(32, "0") as TraceId;
  const route = spec.route ?? "/orders/:id";
  const base = { method: "GET", op: route, path: route };
  const recs: HopRecord[] = [
    record(trace, HopKind.In, 1, null, T0, base),
    record(trace, HopKind.InEnd, 1, null, T0 + spec.durMs, { ...base, status: 200, durationUs: Math.round(spec.durMs * 1000) }),
  ];
  let id = 10;
  let at = 0.5;
  for (const c of spec.calls) {
    if ("db" in c) {
      for (let i = 0; i < (c.times ?? 1); i++) {
        at += c.ms;
        recs.push(record(trace, HopKind.OutEnd, id++, 1, T0 + at, { via: Via.Db, op: "select", peer: "shop-db", table: c.table, stmt: c.db, durationUs: Math.round(c.ms * 1000) }));
        at += 0.05;
      }
    } else if ("cache" in c) {
      at += c.ms;
      recs.push(record(trace, HopKind.OutEnd, id++, 1, T0 + at, { via: Via.Cache, adapter: "ioredis", op: c.cache, peer: "redis.internal", durationUs: Math.round(c.ms * 1000) }));
      at += 0.05;
    } else {
      const out = id++;
      const inbound = id++;
      const call = { method: "POST", op: c.route, peer: c.service, hopSent: true };
      const callee = { service: c.service, source: c.service, method: "POST", op: c.route, path: c.route };
      recs.push(record(trace, HopKind.Out, out, 1, T0 + at, call));
      recs.push(record(trace, HopKind.In, inbound, out, T0 + at + 0.2, callee));
      recs.push(record(trace, HopKind.InEnd, inbound, out, T0 + at + c.ms - 0.2, { ...callee, status: 200, durationUs: Math.round((c.ms - 0.4) * 1000) }));
      recs.push(record(trace, HopKind.OutEnd, out, 1, T0 + at + c.ms, { ...call, status: 200, durationUs: Math.round(c.ms * 1000) }));
      at += c.ms + 0.05;
    }
  }
  return buildRequestTree(recs, [], NOW);
}

const FAST: Call[] = [{ db: ORDERS, table: "orders", ms: 60 }, { cache: "get", ms: 0.6 }, { cache: "get", ms: 0.6 }, { cache: "get", ms: 0.6 }];

function row(rows: readonly DiffRow[], label: string): DiffRow {
  const r = rows.find((x) => x.label === label);
  if (!r) throw new Error(`no row ${label}: ${rows.map((x) => x.label).join(", ")}`);
  return r;
}

describe("diffRequests", () => {
  test("identical requests: every row the same, nothing on top", () => {
    const d = diffRequests(build({ trace: 1, durMs: 64, calls: FAST }), build({ trace: 2, durMs: 64, calls: FAST }));
    expect(d.rows.map((r) => r.kind)).toEqual([DiffKind.Same, DiffKind.Same, DiffKind.Same]);
    expect(d.rows.map((r) => r.label)).toEqual(["shop-api GET /orders/:id", "select orders", "get redis.internal"]);
    expect(row(d.rows, "get redis.internal").a).toEqual({ durationUs: 1800, calls: 3 });
    expect(d.top).toEqual([]);
    expect(d.warnings).toEqual([]);
    expect(d.sentences).toEqual([
      "This request took 64.0 ms and the typical request 64.0 ms: about the same.",
      "They made the same calls, and none took 10.0 ms more or less.",
    ]);
  });

  test("a slower store call: named as most of the difference", () => {
    const slow = build({ trace: 1, durMs: 416, calls: [{ db: ORDERS, table: "orders", ms: 412 }, ...FAST.slice(1)] });
    const d = diffRequests(slow, build({ trace: 2, durMs: 64, calls: FAST }));
    expect(row(d.rows, "select orders").kind).toBe(DiffKind.Slower);
    expect(row(d.rows, "select orders").deltaUs).toBe(352_000);
    expect(d.top[0].label).toBe("select orders");
    expect(d.sentences).toEqual([
      "This request took 416 ms and the typical request 64.0 ms: 352 ms more.",
      "Most of the difference, 352 ms, is select orders (412 ms against 60.0 ms).",
    ]);
    expect(d.splitDelta.dbUs).toBe(352_000);
  });

  test("one extra call to another service, only in this request", () => {
    const a = build({ trace: 1, durMs: 104, calls: [...FAST, { service: "commerce-payments", route: "/charges", ms: 40 }] });
    const d = diffRequests(a, build({ trace: 2, durMs: 64, calls: FAST }));
    const pay = row(d.rows, "commerce-payments POST /charges");
    expect(pay.kind).toBe(DiffKind.OnlyA);
    expect(pay.b).toBeNull();
    expect(pay.depth).toBe(1);
    expect(d.top[0]).toBe(pay);
    expect(d.sentences[1]).toBe("Most of the difference, 40.0 ms, is commerce-payments POST /charges, which only this request called (40.0 ms).");
  });

  test("a downstream service only the typical request called", () => {
    const b = build({ trace: 2, durMs: 104, calls: [...FAST, { service: "commerce-risk", route: "/score", ms: 40 }] });
    const d = diffRequests(build({ trace: 1, durMs: 64, calls: FAST }), b);
    const risk = row(d.rows, "commerce-risk POST /score");
    expect(risk.kind).toBe(DiffKind.OnlyB);
    expect(risk.deltaUs).toBe(-40_000);
    expect(d.sentences[0]).toBe("This request took 64.0 ms and the typical request 104 ms: 40.0 ms less.");
    expect(d.sentences[1]).toBe("Most of the difference, 40.0 ms, is commerce-risk POST /score, which only the typical request called (40.0 ms).");
  });

  test("a repeat group of 14 against 2 is one row with both counts", () => {
    const a = build({ trace: 1, durMs: 90, calls: [...FAST, { db: PLANS, table: "plans", ms: 1.5, times: 14 }] });
    const b = build({ trace: 2, durMs: 68, calls: [...FAST, { db: PLANS, table: "plans", ms: 1.5, times: 2 }] });
    const d = diffRequests(a, b);
    const plans = row(d.rows, "select plans");
    expect(plans.kind).toBe(DiffKind.MoreCalls);
    expect(plans.a?.calls).toBe(14);
    expect(plans.b?.calls).toBe(2);
    expect(callsNote(plans)).toBe("×14 against ×2");
    expect(d.top.map((r) => r.label)).toContain("select plans");
    expect(d.sentences.join(" ")).toContain("select plans (21.0 ms against 3.0 ms, ×14 against ×2)");
  });

  test("the also sentence names more calls and a service only one called", () => {
    const a = build({ trace: 1, durMs: 520, calls: [{ db: ORDERS, table: "orders", ms: 412 }, ...FAST.slice(1), { db: PLANS, table: "plans", ms: 1.5, times: 14 }, { service: "payments-api", route: "/pay", ms: 40 }] });
    const b = build({ trace: 2, durMs: 68, calls: [...FAST, { db: PLANS, table: "plans", ms: 1.5, times: 2 }] });
    const d = diffRequests(a, b);
    expect(d.sentences).toHaveLength(3);
    expect(d.sentences[1]).toBe("Most of the difference, 352 ms, is select orders (412 ms against 60.0 ms).");
    expect(d.sentences[2]).toBe("It also made 12 more calls to select plans, and called payments-api POST /pay, which the typical request did not.");
  });

  test("keys do not depend on the order of different siblings", () => {
    const one = build({ trace: 1, durMs: 70, calls: [{ db: ORDERS, table: "orders", ms: 60 }, { cache: "get", ms: 0.6 }, { db: PLANS, table: "plans", ms: 2 }] });
    const two = build({ trace: 2, durMs: 70, calls: [{ db: PLANS, table: "plans", ms: 2 }, { cache: "get", ms: 0.6 }, { db: ORDERS, table: "orders", ms: 60 }] });
    const d = diffRequests(one, two);
    expect(d.rows.every((r) => r.a && r.b)).toBe(true);
    expect(d.rows.map((r) => r.kind)).toEqual([DiffKind.Same, DiffKind.Same, DiffKind.Same, DiffKind.Same]);
    const keys = (t: RequestTree): string[] => diffRequests(t, t).rows.map((r) => r.key).sort();
    expect(keys(one)).toEqual(keys(two));
  });

  test("identical sibling calls to one service line up by occurrence", () => {
    const a = build({ trace: 1, durMs: 120, calls: [{ service: "commerce-risk", route: "/score", ms: 20 }, { service: "commerce-risk", route: "/score", ms: 80 }] });
    const b = build({ trace: 2, durMs: 60, calls: [{ service: "commerce-risk", route: "/score", ms: 20 }, { service: "commerce-risk", route: "/score", ms: 20 }] });
    const d = diffRequests(a, b);
    const calls = d.rows.filter((r) => r.label === "commerce-risk POST /score");
    expect(calls).toHaveLength(2);
    expect(calls.map((r) => r.kind)).toEqual([DiffKind.Same, DiffKind.Slower]);
    expect(new Set(d.rows.map((r) => r.key)).size).toBe(d.rows.length);
    expect(calls[1].key.endsWith("#1")).toBe(true);
  });

  test("totals add up: the top row is the whole difference, its rows and own time explain it", () => {
    const a = build({ trace: 1, durMs: 470, calls: [{ db: ORDERS, table: "orders", ms: 412 }, ...FAST.slice(1), { db: PLANS, table: "plans", ms: 1.5, times: 14 }] });
    const b = build({ trace: 2, durMs: 64, calls: FAST });
    const d = diffRequests(a, b);
    const root = d.rows[0];
    expect(root.parentKey).toBeNull();
    expect(root.deltaUs).toBe(d.totalDeltaUs);
    const parts = d.rows.filter((r) => r.parentKey === root.key).reduce((t, r) => t + r.deltaUs, 0);
    expect(root.contributionUs + parts).toBe(d.totalDeltaUs);
    // Only-in-one parts count once, at their top.
    const sum = d.rows.reduce((t, r) => t + r.contributionUs, 0);
    expect(sum).toBe(d.totalDeltaUs);
  });

  test("different routes are compared with a warning", () => {
    const d = diffRequests(build({ trace: 1, durMs: 64, calls: FAST }), build({ trace: 2, durMs: 30, calls: FAST, route: "/shop" }));
    expect(d.warnings).toEqual(["These are different routes (GET /orders/:id and GET /shop), so their calls line up only in part."]);
    expect(d.rows[0].a && d.rows[0].b).toBeTruthy();
  });

  test("truncated records and another name for B", () => {
    const t = build({ trace: 1, durMs: 64, calls: FAST });
    const d = diffRequests(t, t, { aTruncated: true, bTruncated: true, otherName: "the other request" });
    expect(d.warnings).toEqual([
      "Some records of this request were not loaded, so it may have made more calls than shown.",
      "Some records of the other request were not loaded, so it may have made more calls than shown.",
    ]);
    expect(d.sentences[0]).toBe("This request took 64.0 ms and the other request 64.0 ms: about the same.");
  });

  test("at most TOP_ROWS contributors, largest first", () => {
    const tables = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const a = build({ trace: 1, durMs: 525, calls: tables.map((t, i) => ({ db: `select x from ${t}`, table: t, ms: 30 + 10 * i })) });
    const b = build({ trace: 2, durMs: 20, calls: tables.map((t) => ({ db: `select x from ${t}`, table: t, ms: 1 })) });
    const d = diffRequests(a, b);
    expect(d.top).toHaveLength(TOP_ROWS);
    expect(d.top[0].label).toBe("select h");
    const sizes = d.top.map((r) => Math.abs(r.contributionUs));
    expect(sizes).toEqual([...sizes].sort((x, y) => y - x));
  });
});

describe("rowKind boundaries", () => {
  const cell = (ms: number, calls = 1) => ({ durationUs: ms * 1000, calls });
  test("slower from DIFF_MIN_US when B is short", () => {
    expect(DIFF_MIN_US).toBe(10_000);
    expect(rowKind(cell(50), cell(40))).toBe(DiffKind.Slower);
    expect(rowKind(cell(49.999), cell(40))).toBe(DiffKind.Same);
    expect(rowKind(cell(40), cell(50))).toBe(DiffKind.Faster);
    expect(rowKind(cell(40.001), cell(50))).toBe(DiffKind.Same);
  });
  test("slower from DIFF_MIN_SHARE of B when B is long", () => {
    expect(DIFF_MIN_SHARE).toBe(0.25);
    expect(rowKind(cell(125), cell(100))).toBe(DiffKind.Slower);
    expect(rowKind(cell(124.9), cell(100))).toBe(DiffKind.Same);
    // Faster is the mirror: measured against A's time.
    expect(rowKind(cell(80), cell(100))).toBe(DiffKind.Faster);
    expect(rowKind(cell(80.1), cell(100))).toBe(DiffKind.Same);
  });
  test("call counts from CALLS_DIFF_MIN, before times", () => {
    expect(CALLS_DIFF_MIN).toBe(3);
    expect(rowKind(cell(1, 5), cell(1, 2))).toBe(DiffKind.MoreCalls);
    expect(rowKind(cell(1, 4), cell(1, 2))).toBe(DiffKind.Same);
    expect(rowKind(cell(900, 2), cell(1, 5))).toBe(DiffKind.FewerCalls);
  });
  test("a missing side", () => {
    expect(rowKind(cell(1), null)).toBe(DiffKind.OnlyA);
    expect(rowKind(null, cell(1))).toBe(DiffKind.OnlyB);
  });
});

describe("helpers", () => {
  test("differingRows keeps the rows that differ and those above them", () => {
    const slow = build({ trace: 1, durMs: 416, calls: [{ db: ORDERS, table: "orders", ms: 412 }, ...FAST.slice(1)] });
    const d = diffRequests(slow, build({ trace: 2, durMs: 64, calls: FAST }));
    expect(differingRows(d.rows).map((r) => r.label)).toEqual(["shop-api GET /orders/:id", "select orders"]);
    const same = build({ trace: 3, durMs: 64, calls: FAST });
    expect(differingRows(diffRequests(same, same).rows)).toEqual([]);
  });
  test("signed differences and call notes", () => {
    expect(fmtDeltaUs(236_000)).toBe("+236 ms");
    expect(fmtDeltaUs(-12_870)).toBe("-12.9 ms");
    expect(fmtDeltaUs(0)).toBe("0.00 ms");
    expect(callsNote({ a: { durationUs: 1, calls: 1 }, b: { durationUs: 1, calls: 1 } })).toBeNull();
    expect(callsNote({ a: { durationUs: 1, calls: 3 }, b: null })).toBe("×3 against ×0");
  });
});
