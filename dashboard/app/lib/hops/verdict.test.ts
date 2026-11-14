// BAC-70: the "Why" verdict on a request. Requests are built from records and run through
// buildRequestTree and detectRepeats, as the request view does.
import { describe, expect, test } from "bun:test";
import { detectRepeats } from "./repeated";
import { buildRequestTree } from "./tree";
import {
  CULPRIT_SHARE, FAST_US, SKEW_NOTE, TRUNCATED_NOTE, UNFINISHED_SENTENCE, VerdictKind, verdictShown, whyItWasSlow, type Verdict,
} from "./verdict";
import { HopKind, Via, type HopId, type HopRecord, type TraceId } from "./types";

const TRACE = "70707070707070707070707070707070" as TraceId;
const T0 = 1_763_020_800_000;
const NOW = T0 + 60_000;
const SVC = "shop-api";
const PLANS = "select plans.id, plans.name, plans.price from plans where plans.number = ?";
const hid = (n: number): HopId => n.toString(16).padStart(16, "0") as HopId;

function record(kind: HopKind, id: number, parent: number | null, timeMs: number, over: Partial<HopRecord>): HopRecord {
  const out = kind === HopKind.Out || kind === HopKind.OutEnd;
  const end = kind === HopKind.InEnd || kind === HopKind.OutEnd;
  return {
    traceId: TRACE, hop: kind, hopId: hid(id), parentHop: parent === null ? null : hid(parent),
    hopSent: out ? false : null, tracer: false, handoff: false, parentId: null,
    service: SVC, source: SVC, adapter: out ? "prisma" : "fastify", via: Via.Http, method: null, op: null, path: null,
    peer: null, table: null, stmt: null, attempt: null, outcome: end ? "ok" : null, status: null, error: null,
    durationUs: null, totals: null, fields: [], timeMs, ...over,
  };
}

/** The inbound hop 1, `durMs` long; `end: false` leaves it open. */
function request(durMs: number, over: Partial<HopRecord> = {}, end = true): HopRecord[] {
  const base = { method: "GET", op: "/shop", path: "/shop", ...over };
  const start = record(HopKind.In, 1, null, T0, base);
  if (!end) return [start];
  return [start, record(HopKind.InEnd, 1, null, T0 + durMs, { ...base, status: 200, durationUs: Math.round(durMs * 1000), ...over })];
}

/** A database call made by hop 1, ending at `endMs` (from T0), `us` long. */
function db(id: number, endMs: number, us: number, over: Partial<HopRecord> = {}): HopRecord {
  return record(HopKind.OutEnd, id, 1, T0 + endMs, { via: Via.Db, op: "select", peer: "shop-db", table: "orders", stmt: `select orders.id from orders where orders.id = ? and n = ${id}`, durationUs: us, ...over });
}

/** `n` plans lookups one after another, `eachMs` long, from 2 ms. */
function plans(n: number, eachMs: number, firstId = 100): HopRecord[] {
  return Array.from({ length: n }, (_, i) => db(firstId + i, 2 + (i + 1) * (eachMs + 0.1), eachMs * 1000, { table: "plans", stmt: PLANS }));
}

/** An HTTP call from hop 1 to `service`, answered by an inbound hop there. */
function call(outId: number, inId: number, service: string, startMs: number, durMs: number, inStartShiftMs = 0.2): HopRecord[] {
  const out = { via: Via.Http, method: "POST", peer: `${service}.internal`, adapter: "undici", hopSent: true };
  const inbound = { service, source: service, via: Via.Http, method: "POST", op: "/work" };
  return [
    record(HopKind.Out, outId, 1, T0 + startMs, out),
    record(HopKind.In, inId, outId, T0 + startMs + inStartShiftMs, inbound),
    record(HopKind.InEnd, inId, outId, T0 + startMs + durMs - 0.2, { ...inbound, status: 200, durationUs: Math.round((durMs - 0.2 - inStartShiftMs) * 1000) }),
    record(HopKind.OutEnd, outId, 1, T0 + startMs + durMs, { ...out, status: 200, durationUs: Math.round(durMs * 1000) }),
  ];
}

function verdict(records: HopRecord[], truncated = false): Verdict {
  const tree = buildRequestTree(records, [], NOW);
  return whyItWasSlow(tree, detectRepeats(tree, truncated), NOW);
}

describe("why was this request slow", () => {
  test("a healthy fast request has no verdict line", () => {
    const v = verdict([...request(24, { method: "POST", op: "/orders", path: "/orders" }), db(10, 6, 3000), db(11, 12, 2000)]);
    expect(v.kind).toBe(VerdictKind.Fast);
    expect(verdictShown(v)).toBe(false);
  });

  test("14 selects one after another taking most of the time are repeated calls, named with their share", () => {
    const v = verdict([...request(240), ...plans(14, 10)]);
    expect(v.kind).toBe(VerdictKind.RepeatedCalls);
    expect(v.culpritHopId).toBe(hid(100));
    expect(v.share).toBeCloseTo(140 / 240, 2);
    expect(v.sentence).toBe("58 percent of the 240 ms went on select plans, run 14 times one after another (140 ms in all).");
    expect(v.detail).toBe("The next biggest is shop-api's own code (42 percent, 100 ms).");
  });

  test("repeated calls on a fast request are still named when they take more than 10 ms", () => {
    const v = verdict([...request(36), ...plans(14, 1.1)]);
    expect(v.kind).toBe(VerdictKind.RepeatedCalls);
    expect(v.sentence).toStartWith("43 percent of the 36.0 ms went on select plans, run 14 times");
  });

  test("one 900 ms query is the slow call", () => {
    const v = verdict([...request(1000), db(10, 902, 900_000), db(11, 905, 1000)]);
    expect(v.kind).toBe(VerdictKind.SlowCall);
    expect(v.culpritHopId).toBe(hid(10));
    expect(v.sentence).toBe("One call took 90 percent of the 1.00 s: select orders, 900 ms.");
    expect(verdictShown(v)).toBe(true);
  });

  test("calls to two services one after another are waiting, naming the longest", () => {
    const v = verdict([...request(100, { method: "POST", op: "/checkout", path: "/checkout" }), ...call(20, 21, "commerce-payments", 2, 55), ...call(30, 31, "commerce-risk", 58, 38)]);
    expect(v.kind).toBe(VerdictKind.Waiting);
    expect(v.culpritHopId).toBe(hid(20));
    expect(v.sentence).toBe("93 percent of the 100 ms was spent waiting on other services, the longest on commerce-payments (55.0 ms).");
    expect(v.detail).toBeNull();
  });

  test("waiting on one slow downstream names it", () => {
    const v = verdict([...request(500), ...call(20, 21, "commerce-payments", 5, 300), db(10, 400, 60_000)]);
    expect(v.kind).toBe(VerdictKind.Waiting);
    expect(v.sentence).toBe("60 percent of the 500 ms was spent waiting on commerce-payments (300 ms).");
    expect(v.detail).toBe("The next biggest is shop-api's own code (28 percent, 140 ms).");
  });

  test("a long stretch of the service's own code is own time", () => {
    const v = verdict([...request(410, { op: "/checkout", path: "/checkout" }), db(10, 40, 30_000), db(11, 400, 40_000)]);
    expect(v.kind).toBe(VerdictKind.OwnTime);
    expect(v.sentence).toBe("Most of the 410 ms (83 percent, 340 ms) was spent inside shop-api itself, not waiting on anything.");
  });

  test("own time on a fast request is not news", () => {
    expect(verdict([...request(3.4), db(10, 1.7, 700)]).kind).toBe(VerdictKind.Fast);
  });

  test("a plain cache pipeline on a fast request is hidden", () => {
    const gets = Array.from({ length: 12 }, (_, i) => record(HopKind.OutEnd, 200 + i, 1, T0 + 1.7 + 0.02 * i, { via: Via.Cache, adapter: "ioredis", op: "get", peer: "redis.internal", durationUs: 700 + 20 * i }));
    const v = verdict([...request(3.4, { op: "/feed", path: "/feed" }), ...gets]);
    expect(v.kind).toBe(VerdictKind.Fast);
    expect(verdictShown(v)).toBe(false);
  });

  test("a failed request defers to the Alert box", () => {
    const records = request(900);
    records[1] = { ...records[1], status: 500, outcome: "error" };
    const v = verdict([...records, db(10, 802, 800_000)]);
    expect(v.kind).toBe(VerdictKind.Failed);
    expect(verdictShown(v)).toBe(false);
  });

  test("an open request has nothing to explain yet", () => {
    const v = verdict([...request(0, {}, false), db(10, 50, 40_000)]);
    expect(v.kind).toBe(VerdictKind.Unknown);
    expect(v.sentence).toBe(UNFINISHED_SENTENCE);
    expect(verdictShown(v)).toBe(true);
  });

  test("overlapping repeated calls never pass 100 percent, and their summed time is call time", () => {
    const calls = Array.from({ length: 10 }, (_, i) => db(100 + i, 300 + i * 0.1, 290_000, { table: "plans", stmt: PLANS }));
    const v = verdict([...request(320), ...calls]);
    expect(v.kind).toBe(VerdictKind.RepeatedCalls);
    expect(v.share).toBeLessThanOrEqual(1);
    expect(v.sentence).toMatch(/^9\d percent of the 320 ms went on select plans, run 10 times together \(2\.90 s of call time\)\.$/);
  });

  test("records cut at the fetch limit add the understate note and keep the kind", () => {
    const v = verdict([...request(1000), db(10, 902, 900_000)], true);
    expect(v.kind).toBe(VerdictKind.SlowCall);
    expect(v.sentence.endsWith(` ${TRUNCATED_NOTE}`)).toBe(true);
  });

  test("a call at 40 percent is the culprit, at 39 percent it is not", () => {
    expect(CULPRIT_SHARE).toBe(0.4);
    const at40 = verdict([...request(1000), db(10, 402, 400_000)]);
    expect(at40.kind).toBe(VerdictKind.SlowCall);
    const at39 = verdict([...request(1000), db(10, 392, 390_000)]);
    expect(at39.kind).toBe(VerdictKind.OwnTime);
  });

  test("the fast threshold is 200 ms", () => {
    expect(FAST_US).toBe(200_000);
    // About 65 percent own time: hidden under 200 ms, named at 200 ms.
    expect(verdict([...request(199), db(10, 71, 69_000)]).kind).toBe(VerdictKind.Fast);
    expect(verdict([...request(200), db(10, 72, 70_000)]).kind).toBe(VerdictKind.OwnTime);
  });

  test("a downstream hop shifted by clock skew adds the clock note", () => {
    // commerce-payments' clock is 80 ms behind: its inbound hop starts before the call that sent it.
    const v = verdict([...request(500), ...call(20, 21, "commerce-payments", 100, 300, -80)]);
    expect(v.kind).toBe(VerdictKind.Waiting);
    expect(v.sentence.endsWith(` ${SKEW_NOTE}`)).toBe(true);
  });

  test("every sentence shows units and has no em dash", () => {
    const all = [
      verdict([...request(240), ...plans(14, 10)]),
      verdict([...request(1000), db(10, 902, 900_000)]),
      verdict([...request(500), ...call(20, 21, "commerce-payments", 5, 300)]),
      verdict([...request(410), db(10, 40, 30_000)]),
    ];
    for (const v of all) {
      const text = `${v.sentence} ${v.detail ?? ""}`;
      expect(text).not.toContain("—");
      expect(text).toMatch(/\d (ms|s)\b/);
    }
  });
});
