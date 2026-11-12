import { describe, expect, test } from "bun:test";
import { buildRequestTree, faultCount, headHop, storeCallCounts, STALL_AFTER_MS } from "./tree";
import { GapKind, HopState, type HopId, type HopKind, type HopRecord, type LinkedId, type TraceId, type TraceLogLine, type Via } from "./types";

const TRACE = "6503f5f183b828139d5b143365ad72fa" as TraceId;
const T0 = 1_762_941_663_120; // 10:01:03.120
let counter = 0;
const hid = (n: number): HopId => n.toString(16).padStart(16, "0") as HopId;

interface Spec {
  id: number; parent?: number; svc: string; via?: Via; method?: string; op?: string; peer?: string;
  start?: number; dur?: number; sent?: boolean; tracer?: boolean; pid?: string; attempt?: number;
  status?: number; outcome?: "ok" | "error"; error?: string; totals?: Partial<HopRecord["totals"] & object>; fields?: Record<string, string>;
}

function base(kind: HopKind, s: Spec, timeMs: number): HopRecord {
  counter++;
  const out = kind === "out" || kind === "out_end";
  const end = kind === "in_end" || kind === "out_end";
  return {
    traceId: TRACE, hop: kind, hopId: hid(s.id), parentHop: s.parent ? hid(s.parent) : null,
    hopSent: out ? s.sent ?? true : null, tracer: out ? s.tracer ?? false : false, parentId: s.pid ?? "b7ad6b7169203331",
    service: s.svc, adapter: "test", via: s.via ?? "http", method: s.method ?? null, op: s.op ?? null, peer: out ? s.peer ?? null : null,
    attempt: out ? null : s.attempt ?? null, outcome: end ? s.outcome ?? "ok" : null, status: end ? s.status ?? null : null,
    error: end ? s.error ?? null : null, durationUs: end && s.dur !== undefined ? Math.round(s.dur * 1000) : null,
    totals: kind === "in_end" && s.totals ? { dbCalls: 0, dbUs: 0, cacheCalls: 0, cacheUs: 0, ...s.totals } : null,
    fields: kind === "in_end" && s.fields ? Object.entries(s.fields).map(([name, value]) => ({ name, value })) : [],
    timeMs,
  };
}

/** Start and, when it has a duration, end records. Store hops get the end record only. */
function hop(dir: "in" | "out", s: Spec): HopRecord[] {
  const start = T0 + (s.start ?? 0);
  const store = s.via === "db" || s.via === "cache";
  const out: HopRecord[] = [];
  if (!store) out.push(base(dir, s, start));
  if (s.dur !== undefined) out.push(base(dir === "in" ? "in_end" : "out_end", s, start + s.dur));
  return out;
}

const API = "commerce-api", RISK = "commerce-risk", PAY = "commerce-payments", WORKER = "commerce-worker";

/** Frame 2: the healthy POST /orders. Times in ms from T0. */
function healthy(): HopRecord[] {
  return [
    ...hop("in", { id: 1, svc: API, method: "POST", op: "/orders", start: 0, dur: 61.2, status: 201, totals: { dbCalls: 1, dbUs: 3800 }, fields: { order_id: "7731" } }),
    ...hop("out", { id: 2, parent: 1, svc: API, method: "POST", peer: "risk.internal", start: 3.1, dur: 8.4, status: 200 }),
    ...hop("in", { id: 3, parent: 2, svc: RISK, method: "POST", op: "/assess", start: 3.4, dur: 7.9, status: 200, totals: { cacheCalls: 1, cacheUs: 400 } }),
    ...hop("out", { id: 4, parent: 3, svc: RISK, via: "cache", op: "get", peer: "redis.internal", start: 3.9, dur: 0.4, sent: false }),
    ...hop("out", { id: 5, parent: 1, svc: API, method: "POST", peer: "payments.internal", start: 14.0, dur: 15.3, status: 201 }),
    ...hop("in", { id: 6, parent: 5, svc: PAY, method: "POST", op: "/charges", start: 14.2, dur: 14.8, status: 201, totals: { dbCalls: 2, dbUs: 3500 }, fields: { order_id: "7731", currency: "JMD" } }),
    ...hop("out", { id: 7, parent: 6, svc: PAY, via: "db", op: "select", peer: "payments-db", start: 14.6, dur: 1.2, sent: false }),
    ...hop("out", { id: 8, parent: 6, svc: PAY, method: "POST", peer: "acquirer.example", start: 16.0, dur: 11.2, status: 200, sent: false }),
    ...hop("out", { id: 9, parent: 6, svc: PAY, via: "db", op: "insert", peer: "payments-db", start: 27.2, dur: 2.3, sent: false }),
    ...hop("out", { id: 10, parent: 1, svc: API, via: "db", op: "insert", peer: "orders-db", start: 47.6, dur: 3.8, sent: false }),
    ...hop("out", { id: 11, parent: 1, svc: API, via: "job", peer: "receipts", start: 52.0, dur: 1.1 }),
    ...hop("in", { id: 12, parent: 11, svc: WORKER, via: "job", op: "Receipts.SendEmail", start: 2353.1, dur: 412, attempt: 1 }),
  ];
}

const line = (service: string, at: number, text: string, level = "info"): TraceLogLine => ({ service, level, timeMs: T0 + at, line: text });
const NOW = T0 + 60 * 60 * 1000;

describe("straight chain", () => {
  const records = [
    ...hop("in", { id: 1, svc: API, op: "/orders", dur: 61.2, status: 201 }),
    ...hop("out", { id: 2, parent: 1, svc: API, peer: "payments.internal", start: 1, dur: 15.31 }),
    ...hop("in", { id: 3, parent: 2, svc: PAY, op: "/charges", start: 1.2, dur: 14.82 }),
  ];
  const tree = buildRequestTree(records, [], NOW);
  test("one root, each hop under the hop it names", () => {
    expect(tree.roots.map((h) => h.hopId)).toEqual([hid(1)]);
    expect(tree.roots[0].children[0].hopId).toBe(hid(2));
    expect(tree.roots[0].children[0].children[0].hopId).toBe(hid(3));
  });
  test("pairs start and end records; all finished, durations from duration_us", () => {
    expect(tree.hops.every((h) => h.state === HopState.Finished)).toBe(true);
    expect(tree.hops.find((h) => h.hopId === hid(3))?.durationUs).toBe(14820);
    expect(faultCount(tree)).toBe(0);
    expect(tree.services).toEqual([API, PAY]);
  });
  test("order comes from the records, not from clocks: a child logged with an earlier clock stays a child", () => {
    const skewed = records.map((r) => (r.hopId === hid(3) ? { ...r, timeMs: r.timeMs - 5000 } : r));
    const t = buildRequestTree(skewed, [], NOW);
    expect(t.roots.length).toBe(1);
    expect(t.roots[0].children[0].children[0].hopId).toBe(hid(3));
  });
  test("a re-shipped duplicate line changes nothing", () => {
    expect(buildRequestTree([...records, ...records], [], NOW).hops.length).toBe(3);
  });
});

describe("parallel calls", () => {
  const records = [
    ...hop("in", { id: 1, svc: API, dur: 50 }),
    ...hop("out", { id: 3, parent: 1, svc: API, peer: "b", start: 5, dur: 20 }),
    ...hop("out", { id: 2, parent: 1, svc: API, peer: "a", start: 2, dur: 30 }),
    ...hop("in", { id: 4, parent: 2, svc: PAY, start: 2.5, dur: 29 }),
    ...hop("in", { id: 5, parent: 3, svc: RISK, start: 5.5, dur: 19 }),
  ];
  const tree = buildRequestTree(records, [], NOW);
  test("siblings are ordered by start time", () => {
    expect(tree.roots[0].children.map((h) => h.peer)).toEqual(["a", "b"]);
  });
  test("waiting time is the combined span of overlapping calls, not their sum", () => {
    expect(tree.split?.waitingUs).toBe(30000); // 2..32 covers 5..25
    expect(tree.split?.ownUs).toBe(20000);
  });
});

describe("the healthy request of frame 2", () => {
  const links: LinkedId[] = [
    { traceId: TRACE, name: "order_id", value: "7731", hopId: hid(1), service: API, timeMs: T0 + 2 },
    { traceId: TRACE, name: "acquirer_ref", value: "A91K20", hopId: hid(6), service: PAY, timeMs: T0 + 27 },
    { traceId: TRACE, name: "order_id", value: "7731", hopId: hid(6), service: PAY, timeMs: T0 + 15 },
  ];
  const logs = [
    line(PAY, 15.0, "charge requested amount=4500 currency=JMD"),
    line(PAY, 16.1, "acquirer call started"),
    line(PAY, 27.0, "acquirer approved auth=A91K20"),
    line(PAY, 28.0, "charge stored id=ch_7731"),
    line(RISK, 11.0, "assessment ok score=12"),
    line(API, 1.0, "order received"),
    line(API, 90_000, "late line"),
  ];
  const tree = buildRequestTree(healthy(), logs, NOW, links);
  const byId = (n: number) => tree.hops.find((h) => h.hopId === hid(n))!;

  test("12 hops, 8 of them not data-store hops, 4 services, no faults", () => {
    expect(tree.hops.length).toBe(12);
    expect(tree.hops.filter((h) => !h.isStore).length).toBe(8);
    expect(tree.services).toEqual([API, RISK, PAY, WORKER]);
    expect(faultCount(tree)).toBe(0);
    expect(headHop(tree)?.op).toBe("/orders");
  });
  test("data-store hops: end record only, finished, children of the inbound hop, start = end - duration", () => {
    const db = byId(7);
    expect(db.isStore).toBe(true);
    expect(db.state).toBe(HopState.Finished);
    expect(db.parentHop).toBe(hid(6));
    expect(db.startMs).toBeCloseTo(T0 + 14.6, 6);
    expect(byId(6).children.map((h) => h.hopId)).toEqual([hid(7), hid(8), hid(9)]);
  });
  test("database and cache calls counted from the totals", () => {
    expect(storeCallCounts(tree)).toEqual({ db: 3, cache: 1 });
  });
  test("where the time went: 32.6 ms own, 3.8 ms database, 24.8 ms waiting", () => {
    expect(tree.split).toEqual({ totalUs: 61200, dbUs: 3800, cacheUs: 0, waitingUs: 24800, ownUs: 32600 });
  });
  test("log lines go under the innermost inbound hop of their service", () => {
    expect(byId(6).logs.map((l) => l.line)).toEqual([
      "charge requested amount=4500 currency=JMD", "acquirer call started", "acquirer approved auth=A91K20", "charge stored id=ch_7731",
    ]);
    expect(byId(3).logs.map((l) => l.line)).toEqual(["assessment ok score=12"]);
    expect(byId(1).logs.map((l) => l.line)).toEqual(["order received"]);
    expect(tree.unplacedLogs[API].map((l) => l.line)).toEqual(["late line"]);
  });
  test("an outbound hop shows its service's lines while the call ran", () => {
    expect(byId(8).logs.map((l) => l.line)).toEqual(["acquirer call started", "acquirer approved auth=A91K20"]);
  });
  test("named fields on the hop that set them", () => {
    expect(byId(6).fields).toEqual([{ name: "order_id", value: "7731" }, { name: "currency", value: "JMD" }]);
    expect(byId(2).fields).toEqual([]);
  });
  test("linked IDs: deduplicated on the request, and on the hop that recorded them", () => {
    expect(tree.linkedIds.map((l) => `${l.name}=${l.value}`)).toEqual(["order_id=7731", "acquirer_ref=A91K20"]);
    expect(byId(1).linkedIds.map((l) => l.name)).toEqual(["order_id"]);
    expect(byId(6).linkedIds.map((l) => l.name)).toEqual(["acquirer_ref"]);
  });
  test("a call outside your services (hop_sent false) is a note, not a fault", () => {
    expect(byId(8).gaps.map((g) => g.kind)).toEqual([GapKind.NotLinked]);
  });
  test("a job that ran later belongs to the request that queued it", () => {
    expect(byId(12).parentHop).toBe(hid(11));
    expect(byId(11).children[0].hopId).toBe(hid(12));
  });
});

describe("stalled hop (frame 3)", () => {
  const start = T0;
  const now = start + (4 * 60 + 12) * 1000;
  const records = [
    ...hop("in", { id: 1, svc: API, method: "POST", op: "/payouts/:id/release", dur: 30020, status: 504, outcome: "ok" }),
    ...hop("out", { id: 2, parent: 1, svc: API, method: "POST", peer: "payments.internal", start: 180, dur: 30000, outcome: "error", error: "Mint.TransportError" }),
    ...hop("in", { id: 3, parent: 2, svc: PAY, method: "POST", op: "/transfers", start: 360 }),
    ...hop("out", { id: 4, parent: 3, svc: PAY, via: "db", op: "select", peer: "payments-db", start: 370, dur: 2.1, sent: false }),
    ...hop("out", { id: 5, parent: 3, svc: PAY, method: "POST", peer: "bank-gw.internal", start: 380 }),
    ...hop("out", { id: 6, parent: 1, svc: API, via: "job", peer: "notifications", start: 30000, dur: 0.9 }),
  ];
  const logs = [line(PAY, 381, "bank transfer submitted ref=TRF-88213"), line(PAY, 6386, "bank gateway slow, still waiting (6s)", "warn")];
  const tree = buildRequestTree(records, logs, now);
  const byId = (n: number) => tree.hops.find((h) => h.hopId === hid(n))!;

  test("hops without an end record after 60 s are stalled; only the deepest is where it stopped", () => {
    expect(byId(3).state).toBe(HopState.Stalled);
    expect(byId(5).state).toBe(HopState.Stalled);
    expect(byId(3).gaps).toEqual([]);
    expect(byId(5).gaps.map((g) => g.kind)).toEqual([GapKind.Stopped]);
  });
  test("a call still running is not reported as never received", () => {
    expect(byId(5).gaps.some((g) => g.kind === GapKind.NoReceiver)).toBe(false);
  });
  test("missing receiver: a sent job with no inbound record", () => {
    expect(byId(6).gaps).toEqual([{ kind: GapKind.NoReceiver, hopId: hid(6), label: "No record from notifications", detail: "notifications" }]);
  });
  test("two faults; a failed call keeps its error type", () => {
    expect(faultCount(tree)).toBe(2);
    expect(byId(2).error).toBe("Mint.TransportError");
  });
  test("an open hop's window runs to now, so later lines are placed under it", () => {
    expect(byId(3).logs.length).toBe(2);
    expect(byId(5).logs.length).toBe(2);
  });
  test("a hop without an end record younger than 60 s is open, not stalled", () => {
    const t = buildRequestTree(records, [], T0 + 360 + STALL_AFTER_MS - 1);
    expect(t.hops.find((h) => h.hopId === hid(3))?.state).toBe(HopState.Open);
    expect(t.gaps.some((g) => g.kind === GapKind.Stopped && g.hopId === hid(3))).toBe(false);
  });
  test("the time split of a request that has not finished runs to now", () => {
    const t = buildRequestTree(records.filter((r) => r.hopId !== hid(1) || r.hop === "in"), [], now);
    expect(t.split?.totalUs).toBe((now - T0) * 1000);
  });
});

describe("missing caller", () => {
  test("an inbound hop whose parent is not among the records is a root with a gap", () => {
    const tree = buildRequestTree(hop("in", { id: 3, parent: 99, svc: PAY, dur: 5 }), [], NOW);
    expect(tree.roots.map((h) => h.hopId)).toEqual([hid(3)]);
    expect(tree.gaps.map((g) => g.kind)).toEqual([GapKind.MissingCaller]);
    expect(faultCount(tree)).toBe(1);
  });
  test("an inbound hop with no parent is a plain root", () => {
    expect(buildRequestTree(hop("in", { id: 3, svc: PAY, dur: 5 }), [], NOW).gaps).toEqual([]);
  });
});

describe("retried job", () => {
  const records = [
    ...hop("in", { id: 1, svc: API, dur: 10 }),
    ...hop("out", { id: 2, parent: 1, svc: API, via: "job", peer: "receipts", start: 1, dur: 1 }),
    ...hop("in", { id: 3, parent: 2, svc: WORKER, via: "job", op: "Send", start: 100, dur: 5, outcome: "error", error: "Timeout", attempt: 1 }),
    ...hop("in", { id: 4, parent: 2, svc: WORKER, via: "job", op: "Send", start: 2000, dur: 5, attempt: 2 }),
    ...hop("in", { id: 5, parent: 2, svc: WORKER, via: "job", op: "Send", start: 9000, dur: 5, attempt: 3 }),
  ];
  const tree = buildRequestTree(records, [], NOW);
  test("each attempt is its own inbound hop under the same caller", () => {
    expect(tree.roots[0].children[0].children.map((h) => h.attempt)).toEqual([1, 2, 3]);
  });
  test("later attempts are marked Retry 1, Retry 2; not faults", () => {
    expect(tree.gaps.filter((g) => g.kind === GapKind.Retry).map((g) => g.label)).toEqual(["Retry 1", "Retry 2"]);
    expect(faultCount(tree)).toBe(0);
  });
});

describe("tracer-only service in between", () => {
  const mk = (tracer: boolean, inPid: string) => [
    ...hop("in", { id: 1, svc: API, dur: 10, pid: "b7ad6b7169203331" }),
    ...hop("out", { id: 2, parent: 1, svc: API, peer: "x", start: 1, dur: 8, pid: "b7ad6b7169203331", tracer }),
    ...hop("in", { id: 3, parent: 2, svc: PAY, start: 2, dur: 6, pid: inPid }),
  ];
  test("parent_id differs and the caller has no tracer field: passed through a tracer-only service", () => {
    expect(buildRequestTree(mk(false, "c0ffee0000000001"), [], NOW).gaps.map((g) => g.kind)).toEqual([GapKind.TracerBetween]);
  });
  test("same parent_id: direct or through a proxy", () => {
    expect(buildRequestTree(mk(false, "b7ad6b7169203331"), [], NOW).gaps).toEqual([]);
  });
  test("the caller's own tracer wrote its span ID: nothing sat between", () => {
    expect(buildRequestTree(mk(true, "c0ffee0000000001"), [], NOW).gaps).toEqual([]);
  });
});

describe("data-store calls past the record limit", () => {
  const records = [
    ...hop("in", { id: 1, svc: API, dur: 100, totals: { dbCalls: 30, dbUs: 40000, cacheCalls: 2, cacheUs: 600 } }),
    ...Array.from({ length: 25 }, (_, i) => hop("out", { id: 10 + i, parent: 1, svc: API, via: "db", op: "select", peer: "db", start: 1 + i, dur: 1, sent: false })).flat(),
    ...hop("out", { id: 50, parent: 1, svc: API, via: "cache", op: "get", peer: "redis", start: 60, dur: 0.3, sent: false }),
    ...hop("out", { id: 51, parent: 1, svc: API, via: "cache", op: "get", peer: "redis", start: 61, dur: 0.3, sent: false }),
  ];
  const tree = buildRequestTree(records, [], NOW);
  test("one summary row for the calls not recorded one by one, with their combined time", () => {
    expect(tree.roots[0].unrecorded).toEqual([{ store: "db", calls: 5, us: 15000 }]);
  });
  test("counts come from the totals, so every call counts", () => {
    expect(storeCallCounts(tree)).toEqual({ db: 30, cache: 2 });
    expect(tree.split).toMatchObject({ dbUs: 40000, cacheUs: 600, waitingUs: 0, ownUs: 59400 });
  });
});

describe("empty and odd input", () => {
  test("no records gives an empty tree", () => {
    const t = buildRequestTree([], [line(API, 0, "x")], NOW);
    expect(t.roots).toEqual([]);
    expect(t.split).toBeNull();
    expect(t.unplacedLogs[API].length).toBe(1);
  });
  test("a hop naming itself as parent is a root, not a loop", () => {
    const t = buildRequestTree(hop("in", { id: 1, parent: 1, svc: API, dur: 1 }), [], NOW);
    expect(t.roots.length).toBe(1);
  });
});
