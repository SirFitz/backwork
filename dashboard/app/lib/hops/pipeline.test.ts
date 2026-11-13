// BAC-63: a redis MULTI block (ioredis `multi().lpush().ltrim().expire().exec()`) is one call.
// The adapter writes one cache record per command; all of them are in flight together and settle
// when the block's replies arrive, so their durations are near-identical. Shaped on the fs-hono GET
// of trace 70792515987280e4ac4431ce54024edf: a `set`, then the plugin invocation log written
// fire-and-forget at the end of the request, ending after the request's end record was written
// (so the request's totals count the `set` only). Log times are whole milliseconds, as Loki gives them.
import { describe, expect, test } from "bun:test";
import { buildPathNodes, rowUs, summaryOf, visibleRows } from "./path-rows";
import { storeLabel } from "./store-label";
import { buildRequestTree, storeCallCounts } from "./tree";
import { HopKind, Via, type HopId, type HopRecord, type StoreTotals, type TraceId } from "./types";

const TRACE = "70792515987280e4ac4431ce54024edf" as TraceId;
const T0 = 1_763_020_800_000;
const NOW = T0 + 60_000;
const SVC = "fs-hono";
const REDIS = "redis.internal";
const hid = (n: number): HopId => n.toString(16).padStart(16, "0") as HopId;

function record(kind: HopKind, id: number, parent: number | null, timeMs: number, over: Partial<HopRecord>): HopRecord {
  const out = kind === HopKind.Out || kind === HopKind.OutEnd;
  const end = kind === HopKind.InEnd || kind === HopKind.OutEnd;
  return {
    traceId: TRACE, hop: kind, hopId: hid(id), parentHop: parent === null ? null : hid(parent),
    hopSent: out ? false : null, tracer: false, handoff: false, parentId: null,
    service: SVC, source: SVC, adapter: out ? "ioredis" : "hono", via: Via.Http, method: null, op: null, path: null,
    peer: null, table: null, stmt: null, attempt: null, outcome: end ? "ok" : null, status: null, error: null,
    durationUs: null, totals: null, fields: [], timeMs, ...over,
  };
}

/** A cache command's end record (the only record a data-store hop has, HOP-19). */
function cache(id: number, op: string, endMs: number, durationUs: number, outcome: "ok" | "error" = "ok"): HopRecord {
  return record(HopKind.OutEnd, id, 1, T0 + Math.floor(endMs), { via: Via.Cache, op, peer: REDIS, durationUs, outcome });
}

function request(totals: StoreTotals | null, durMs = 6): HopRecord[] {
  return [
    record(HopKind.In, 1, null, T0, { method: "GET", op: "/s/:slug" }),
    record(HopKind.InEnd, 1, null, T0 + durMs, { method: "GET", op: "/s/:slug", status: 200, durationUs: durMs * 1000, totals }),
  ];
}

const PIPELINE = ["multi", "lpush", "ltrim", "expire", "exec"];
/** The five commands of one MULTI block, all settling at `endMs`, each in flight `us`. */
const pipeline = (firstId: number, endMs: number, us = 2400): HopRecord[] => PIPELINE.map((op, i) => cache(firstId + i, op, endMs, us));

/** The live shape: set 1.6 ms at 1.0-2.6 ms; the block 2.4 ms ending at 6 ms; totals hold the set only. */
function liveShape(): HopRecord[] {
  return [
    ...request({ dbCalls: 0, dbUs: 0, cacheCalls: 1, cacheUs: 1600 }),
    cache(2, "set", 2.6, 1600),
    ...pipeline(10, 6),
  ];
}

describe("a redis MULTI block is one call", () => {
  const tree = buildRequestTree(liveShape(), [], NOW);
  const root = tree.roots[0];
  const stores = tree.hops.filter((h) => h.isStore);

  test("the five command records become one hop that lists the commands", () => {
    expect(stores.length).toBe(2);
    const block = stores.find((h) => h.op === "multi")!;
    expect(block.pipeline?.ops).toEqual(PIPELINE);
    expect(storeLabel(block)).toBe(`multi lpush/ltrim/expire/exec ${REDIS}`);
    expect(root.children.map((h) => h.op)).toEqual(["set", "multi"]);
  });

  test("the block keeps its real duration and its real start, not one copy per command", () => {
    const block = stores.find((h) => h.op === "multi")!;
    expect(block.durationUs).toBe(2400);
    expect(block.startMs - T0).toBeCloseTo(3.6, 3);
    expect(block.endMs! - T0).toBeCloseTo(6, 3);
    expect(block.pipeline?.commandUs).toBe(5 * 2400);
  });

  test("header count, time split and rows agree: two cache calls, 4.0 ms", () => {
    expect(storeCallCounts(tree)).toEqual({ db: 0, cache: 2 });
    expect(tree.split).toMatchObject({ cacheCalls: 2, cacheUs: 4000, cacheSumUs: 4000 });
    const rows = visibleRows(buildPathNodes(tree.roots), new Map(), root.durationUs ?? 0).filter((r) => r.node.hop.isStore);
    expect(rows.length).toBe(2);
    expect(rows.reduce((a, r) => a + rowUs(r.node), 0)).toBe(tree.split!.cacheSumUs);
    expect(root.unrecorded).toEqual([]);
  });

  test("a folded row counts the block once", () => {
    const parent = record(HopKind.In, 99, null, T0 - 1, { op: "/outer" });
    const call = record(HopKind.Out, 98, 99, T0 - 1, { hopSent: true });
    const nested = buildRequestTree([parent, call, ...liveShape().map((r) => (r.hopId === hid(1) && r.hop === HopKind.In ? { ...r, parentHop: hid(98) } : r))], [], NOW);
    const nodes = buildPathNodes(nested.roots);
    expect(summaryOf(nodes[0])).toBe("2 cache calls · 1 call");
  });
});

describe("totals that include the block (it ended before the response)", () => {
  const tree = buildRequestTree([
    ...request({ dbCalls: 0, dbUs: 0, cacheCalls: 6, cacheUs: 1600 + 5 * 2400 }, 8),
    cache(2, "set", 2.6, 1600),
    ...pipeline(10, 6),
  ], [], NOW);
  test("no calls are reported missing and the counts follow the rows", () => {
    expect(tree.roots[0].unrecorded).toEqual([]);
    expect(storeCallCounts(tree)).toEqual({ db: 0, cache: 2 });
    expect(tree.split).toMatchObject({ cacheCalls: 2, cacheSumUs: 4000, cacheUs: 4000 });
  });
  test("calls past the record limit still count once each, beyond the block's commands", () => {
    const t = buildRequestTree([
      ...request({ dbCalls: 0, dbUs: 0, cacheCalls: 9, cacheUs: 1600 + 5 * 2400 + 3 * 500 }, 8),
      cache(2, "set", 2.6, 1600),
      ...pipeline(10, 6),
    ], [], NOW);
    expect(t.roots[0].unrecorded).toEqual([{ store: "cache", calls: 3, us: 1500 }]);
    expect(storeCallCounts(t)).toEqual({ db: 0, cache: 5 });
    expect(t.split).toMatchObject({ cacheCalls: 5, cacheSumUs: 5500 });
  });
});

describe("what is and is not a block", () => {
  test("two blocks one after the other stay two rows, and fold together as one shape", () => {
    const t = buildRequestTree([...request(null, 20), ...pipeline(10, 6), ...pipeline(20, 11), ...pipeline(30, 16)], [], NOW);
    const blocks = t.hops.filter((h) => h.isStore);
    expect(blocks.map((h) => h.pipeline?.ops.length)).toEqual([5, 5, 5]);
    const rows = visibleRows(buildPathNodes(t.roots), new Map(), 20000);
    expect(rows[1].node.members?.length).toBe(3);
  });
  test("a cache call on its own before or after the block is not pulled into it", () => {
    const t = buildRequestTree([...request(null, 12), cache(2, "get", 3, 500), ...pipeline(10, 6), cache(3, "get", 10, 500)], [], NOW);
    expect(t.hops.filter((h) => h.isStore).map((h) => h.op)).toEqual(["get", "multi", "get"]);
  });
  test("a failed command makes the block failed", () => {
    const recs = [...request(null, 8), ...pipeline(10, 6)];
    recs[recs.length - 1] = cache(14, "exec", 6, 2400, "error");
    const block = buildRequestTree(recs, [], NOW).hops.find((h) => h.isStore)!;
    expect(block.outcome).toBe("error");
  });
  test("a MULTI with no EXEC or DISCARD record is left as recorded", () => {
    const t = buildRequestTree([...request(null, 8), ...pipeline(10, 6).slice(0, 4)], [], NOW);
    expect(t.hops.filter((h) => h.isStore).length).toBe(4);
  });
});

describe("record order within one millisecond (Loki keeps nanoseconds)", () => {
  test("exactMs keeps microseconds and falls back to whole ms on odd input", async () => {
    const { exactMs } = await import("~/lib/loki.server");
    expect(exactMs("1763020800006123456")).toBe(1763020800006.123);
    expect(exactMs("not-a-number")).toBeNaN();
  });
  test("the commands are listed in the order their replies were written", () => {
    // Durations that would sort the wrong way by start; ends 50 µs apart give the real order.
    const recs = [...request(null, 8), ...PIPELINE.map((op, i) => ({ ...cache(10 + i, op, 6, 2400 + (PIPELINE.length - i) * 10), timeMs: T0 + 6 + i * 0.05 }))];
    const block = buildRequestTree(recs, [], NOW).hops.find((h) => h.isStore)!;
    expect(block.pipeline?.ops).toEqual(PIPELINE);
  });
});
