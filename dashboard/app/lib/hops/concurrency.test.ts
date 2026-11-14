// BAC-71: calls that could run together. Requests are built from records and run through
// buildRequestTree, as the request view does.
import { describe, expect, test } from "bun:test";
import { GAP_US, Independence, MAX_CHAIN_CALLS, MIN_SAVED_US, candidatesByHop, follows, parallelCandidates, parallelChains, parallelSentence } from "./concurrency";
import { detectRepeats } from "./repeated";
import { buildRequestTree } from "./tree";
import { HopKind, Via, type HopId, type HopRecord, type TraceId } from "./types";

const TRACE = "7a1e0c0d7a1e0c0d7a1e0c0d7a1e0c0d" as TraceId;
const T0 = 1_763_020_800_000;
const NOW = T0 + 60_000;
const SVC = "shop-api";
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

function request(durMs: number): HopRecord[] {
  return [
    record(HopKind.In, 1, null, T0, { method: "GET", op: "/orders/:id", path: "/orders/5120" }),
    record(HopKind.InEnd, 1, null, T0 + durMs, { method: "GET", op: "/orders/:id", path: "/orders/5120", status: 200, durationUs: durMs * 1000 }),
  ];
}

/** A database call from `startMs` (after T0) that took `ms`. */
function db(id: number, startMs: number, ms: number, table = "orders", over: Partial<HopRecord> = {}): HopRecord {
  return record(HopKind.OutEnd, id, 1, T0 + startMs + ms, { via: Via.Db, op: "select", peer: "shop-db", table, stmt: `select ${table}.id from ${table} where ${table}.id = ?`, durationUs: Math.round(ms * 1000), ...over });
}

function cache(id: number, startMs: number, ms: number, over: Partial<HopRecord> = {}): HopRecord {
  return record(HopKind.OutEnd, id, 1, T0 + startMs + ms, { via: Via.Cache, adapter: "ioredis", op: "get", peer: "redis.internal", durationUs: Math.round(ms * 1000), ...over });
}

/** An outbound HTTP call to `service`, with the callee's inbound hop on a clock `skewMs` off. */
function http(id: number, service: string, startMs: number, ms: number, skewMs = 0, over: Partial<HopRecord> = {}): HopRecord[] {
  const base = { via: Via.Http, adapter: "undici", method: "POST", peer: `${service}.internal`, hopSent: true, ...over };
  const calleeId = id + 1000;
  return [
    record(HopKind.Out, id, 1, T0 + startMs, base),
    record(HopKind.In, calleeId, id, T0 + startMs + 0.4 + skewMs, { service, source: service, method: "POST", op: "/x" }),
    record(HopKind.InEnd, calleeId, id, T0 + startMs + ms - 0.4 + skewMs, { service, source: service, method: "POST", op: "/x", status: 200, durationUs: Math.round((ms - 0.8) * 1000) }),
    record(HopKind.OutEnd, id, 1, T0 + startMs + ms, { ...base, status: 200, durationUs: Math.round(ms * 1000) }),
  ];
}

const chains = (records: HopRecord[]) => parallelChains(buildRequestTree(records, [], NOW));
const candidates = (records: HopRecord[]) => parallelCandidates(buildRequestTree(records, [], NOW));

describe("calls that could run together", () => {
  test("three calls back to back (1 ms apart) are one chain with serial, parallel and saved times", () => {
    const c = candidates([...request(80), db(10, 2, 20, "orders"), db(11, 23, 14, "customers"), cache(12, 38, 25)]);
    expect(c).toHaveLength(1);
    expect(c[0].hopIds).toEqual([hid(10), hid(11), hid(12)]);
    expect(c[0].labels).toEqual(["select orders", "select customers", "get redis.internal"]);
    expect(c[0].serialUs).toBe(61_000);
    expect(c[0].parallelUs).toBe(25_000);
    expect(c[0].savedUs).toBe(36_000);
    expect(c[0].independent).toBe(Independence.Unknown);
    expect(c[0].service).toBe(SVC);
    expect(c[0].parentHopId).toBe(hid(1));
  });

  test("a 10 ms gap of own work breaks the chain", () => {
    const c = chains([...request(120), db(10, 2, 30), db(11, 42, 30, "customers")]);
    expect(c).toHaveLength(0);
  });

  test("a gap just inside GAP_US still links; just past it does not", () => {
    const inside = chains([...request(120), db(10, 2, 30), db(11, 32 + GAP_US / 1000 - 0.1, 30, "customers")]);
    expect(inside).toHaveLength(1);
    const past = chains([...request(120), db(10, 2, 30), db(11, 32 + GAP_US / 1000 + 0.1, 30, "customers")]);
    expect(past).toHaveLength(0);
  });

  test("overlapping calls already ran together and are not reported", () => {
    const c = chains([...request(80), db(10, 2, 30), db(11, 10, 30, "customers"), db(12, 15, 30, "plans")]);
    expect(c).toHaveLength(0);
  });

  test("touching within the 1 ms slack still counts as one after another", () => {
    const c = chains([...request(80), db(10, 2, 30), db(11, 31.5, 30, "customers")]);
    expect(c).toHaveLength(1);
  });

  test("identical-shape repeats (feature 1's N+1) are excluded and break the chain", () => {
    const n1 = Array.from({ length: 6 }, (_, i) => db(20 + i, 30 + i * 6, 5.5, "plans"));
    const c = chains([...request(120), db(10, 2, 27.5, "orders"), ...n1, db(30, 66.2, 30, "customers")]);
    expect(c.flatMap((x) => x.hopIds).some((id) => [20, 21, 22, 23, 24, 25].map(hid).includes(id))).toBe(false);
    expect(c).toHaveLength(0);
  });

  test("three identical gets below feature 1's minimum can still form a chain", () => {
    const c = chains([...request(80), cache(10, 2, 10), cache(11, 12.3, 10), cache(12, 22.6, 10)]);
    expect(c).toHaveLength(1);
    expect(c[0].hopIds).toHaveLength(3);
  });

  test("a plain pipeline of 12 gets started in one write is not reported", () => {
    const gets = Array.from({ length: 12 }, (_, i) => cache(10 + i, 1.0, 0.7 + 0.02 * i));
    expect(chains([...request(4), ...gets])).toHaveLength(0);
    expect(candidates([...request(4), ...gets])).toHaveLength(0);
  });

  test("calls started together are not chained even when sub-millisecond", () => {
    const c = chains([...request(4), db(10, 1, 0.5), cache(11, 1, 0.4), db(12, 1.02, 0.6, "plans")]);
    expect(c).toHaveLength(0);
  });

  test("handoff and after-response calls are ignored", () => {
    const c = chains([
      ...request(70),
      db(10, 2, 30),
      db(11, 32.5, 30, "customers", { handoff: true }),
      db(12, 62.5, 30, "plans"),
    ]);
    // the handoff call is not request time; 12 starts 30 ms after 10 ended: no chain
    expect(c).toHaveLength(0);
    const after = chains([...request(40), db(10, 2, 30), db(11, 32.5, 30, "customers")]);
    // 11 ends at 62.5 ms, after the 40 ms response
    expect(after).toHaveLength(0);
  });

  test("a saving below 20 ms is found by parallelChains but not reported", () => {
    const records = [...request(320), db(10, 2, 300, "orders"), cache(11, 302.3, 0.6), cache(12, 303.2, 0.8), cache(13, 304.3, 0.5)];
    const all = chains(records);
    expect(all).toHaveLength(1);
    expect(all[0].hopIds).toHaveLength(4);
    expect(all[0].savedUs).toBeLessThan(MIN_SAVED_US);
    expect(Math.round(all[0].savedUs / 100) / 10).toBe(2.8);
    expect(candidates(records)).toHaveLength(0);
  });

  test("cross-service HTTP calls use the caller-side hop, so callee skew does not matter", () => {
    const records = [...request(100), ...http(10, "commerce-payments", 2, 48, 0), ...http(20, "commerce-risk", 50.8, 32, -400)];
    const c = candidates(records);
    expect(c).toHaveLength(1);
    expect(c[0].hopIds).toEqual([hid(10), hid(20)]);
    expect(c[0].labels).toEqual(["POST commerce-payments", "POST commerce-risk"]);
    expect(c[0].serialUs).toBe(80_800);
    expect(c[0].parallelUs).toBe(48_000);
    expect(c[0].savedUs).toBe(32_800);
  });

  test("a chain longer than 12 calls is not reported", () => {
    const tables = Array.from({ length: MAX_CHAIN_CALLS + 1 }, (_, i) => `t${i}`);
    const calls = tables.map((t, i) => db(10 + i, 2 + i * 5.5, 5, t));
    expect(chains([...request(200), ...calls])[0].hopIds).toHaveLength(MAX_CHAIN_CALLS + 1);
    expect(candidates([...request(200), ...calls])).toHaveLength(0);
  });

  test("records out of order give the same result", () => {
    const records = [...request(80), db(10, 2, 20, "orders"), db(11, 23, 14, "customers"), cache(12, 38, 25)];
    const shuffled = [records[4], records[0], records[3], records[2], records[1]];
    expect(candidates(shuffled)).toEqual(candidates(records));
  });

  test("candidatesByHop maps every chained call", () => {
    const c = candidates([...request(80), db(10, 2, 20, "orders"), db(11, 23, 14, "customers"), cache(12, 38, 25)]);
    const m = candidatesByHop(c);
    expect(m.size).toBe(3);
    expect(m.get(hid(11))).toBe(c[0]);
  });

  test("follows: overlap, touch, gap and start-together cases", () => {
    expect(follows({ startMs: 0, endMs: 10 }, { startMs: 10.5 })).toBe(true);
    expect(follows({ startMs: 0, endMs: 10 }, { startMs: 9.2 })).toBe(true);
    expect(follows({ startMs: 0, endMs: 10 }, { startMs: 8 })).toBe(false);
    expect(follows({ startMs: 0, endMs: 10 }, { startMs: 12.5 })).toBe(false);
    expect(follows({ startMs: 0, endMs: 0.5 }, { startMs: 0.05 })).toBe(false);
  });

  test("sentence", () => {
    const c = candidates([...request(80), cache(10, 2, 13), cache(11, 15.5, 14), db(12, 30, 14, "orders")]);
    expect(parallelSentence(c[0])).toBe(
      "3 calls from shop-api ran one after another (get redis.internal, get redis.internal, select orders, 42.0 ms). " +
        "If they do not depend on each other, running them together could take about 14.0 ms and save 28.0 ms.",
    );
  });

  test("5000 calls finish in well under a second (the request view passes the repeats it already found)", () => {
    // every 10th call starts after a 10 ms pause, so there are about 500 chains of up to 10 calls
    const calls = Array.from({ length: 5000 }, (_, i) => db(10 + i, 2 + i * 2.5 + Math.floor(i / 10) * 10, 2, `t${i}`));
    const tree = buildRequestTree([...request(80_000), ...calls], [], NOW);
    const repeats = detectRepeats(tree, false);
    const t = performance.now();
    const all = parallelChains(tree, repeats);
    parallelCandidates(tree, repeats);
    // A generous bound (see repeated.test.ts): a tight one only fails when the machine is busy.
    expect(performance.now() - t).toBeLessThan(1500);
    expect(all.length).toBe(500);
  });
});
