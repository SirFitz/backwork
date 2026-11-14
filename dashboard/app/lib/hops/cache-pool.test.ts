// BAC-79: cache hit ratio and connection wait, as figures, request view words and verdict clause.
import { describe, expect, test } from "bun:test";
import {
  CACHE_READ_FACT, DB_WAIT_SHARE, NO_CACHE_HITS_TIP, NO_CONN_WAIT_TIP, WAITED_FACT,
  cacheHitsCell, cacheReadOf, waitSuffixOf, connWaitCell, connectionWait, connectionWaitClause, hitRatio, storeCallFacts, storeTotalsChips, waitShare, waitSuffix,
} from "./cache-pool";
import { detectRepeats } from "./repeated";
import { buildRequestTree } from "./tree";
import { VerdictKind, whyItWasSlow } from "./verdict";
import { HopKind, Via, type Hop, type HopId, type HopRecord, type StoreTotals, type TraceId } from "./types";

const TRACE = "70707070707070707070707070707070" as TraceId;
const T0 = 1_763_020_800_000;
const NOW = T0 + 60_000;
const hid = (n: number): HopId => n.toString(16).padStart(16, "0") as HopId;

function record(kind: HopKind, id: number, parent: number | null, timeMs: number, over: Partial<HopRecord>): HopRecord {
  const out = kind === HopKind.Out || kind === HopKind.OutEnd;
  const end = kind === HopKind.InEnd || kind === HopKind.OutEnd;
  return {
    traceId: TRACE, hop: kind, hopId: hid(id), parentHop: parent === null ? null : hid(parent),
    hopSent: out ? false : null, tracer: false, handoff: false, parentId: null,
    service: "commerce-payments", source: "commerce-payments", adapter: out ? "pg" : "hono", via: Via.Http, method: null, op: null, path: null,
    peer: null, table: null, stmt: null, attempt: null, outcome: end ? "ok" : null, status: null, error: null,
    durationUs: null, hit: null, waitUs: null, totals: null, fields: [], timeMs, ...over,
  };
}

/** POST /refunds, 100 ms: a 25 ms lookup and a 60 ms update, each waited `waitMs` for a connection. */
function refunds(waitMs: number | null): HopRecord[] {
  const base = { method: "POST", op: "/refunds" };
  const call = (id: number, endMs: number, us: number, table: string) => record(HopKind.OutEnd, id, 1, T0 + endMs, {
    via: Via.Db, op: "update", peer: "payments-db", table, stmt: `update ${table} set a = ? where id = ?`, durationUs: us, waitUs: waitMs === null ? null : Math.min(us, waitMs * 1000),
  });
  return [record(HopKind.In, 1, null, T0, base), call(10, 28, 25_000, "refunds"), call(11, 92, 60_000, "charges"), record(HopKind.InEnd, 1, null, T0 + 100, { ...base, status: 201, durationUs: 100_000 })];
}

function hopOf(over: Partial<Hop>): Hop {
  const tree = buildRequestTree([record(HopKind.OutEnd, 5, null, T0 + 10, { via: Via.Db, durationUs: 6000 })], [], NOW);
  return { ...tree.hops[0], ...over };
}

const totals = (over: Partial<StoreTotals>): StoreTotals => ({ dbCalls: 0, dbUs: 0, cacheCalls: 0, cacheUs: 0, cacheHits: null, cacheMisses: null, dbWaitUs: null, ...over });

describe("figures", () => {
  test("hit ratio: hits over reads; all misses is 0; no reads is no data", () => {
    expect(hitRatio(3, 10)).toBeCloseTo(0.3, 9);
    expect(hitRatio(null, 12)).toBe(0);
    expect(hitRatio(null, null)).toBeNull();
    expect(hitRatio(0, 0)).toBeNull();
    expect(hitRatio(Number.NaN, 4)).toBe(0);
    expect(hitRatio(5, 4)).toBe(1);
  });
  test("wait share: finite and clamped, else no data", () => {
    expect(waitShare(0.72)).toBe(0.72);
    expect(waitShare(Number.NaN)).toBeNull();
    expect(waitShare(null)).toBeNull();
    expect(waitShare(1.3)).toBe(1);
  });
  test("cells: a percent with its tooltip, or no figure with the not-reported tooltip", () => {
    expect(cacheHitsCell(0.3)).toEqual({ text: "30%", title: "30% of one-key cache reads found a value, 70% missed" });
    expect(cacheHitsCell(0)).toMatchObject({ text: "0%" });
    expect(cacheHitsCell(null)).toEqual({ text: null, title: NO_CACHE_HITS_TIP });
    expect(connWaitCell(0.72)).toEqual({ text: "72%", title: "72% of database time was spent waiting for a connection" });
    expect(connWaitCell(null)).toEqual({ text: null, title: NO_CONN_WAIT_TIP });
  });
});

describe("request view", () => {
  test("a database call that waited: suffix and fact", () => {
    const h = hopOf({ waitUs: 4100 });
    expect(waitSuffix(h)).toBe("waited 4.1 ms");
    expect(storeCallFacts(h)).toEqual([[WAITED_FACT, "4.1 ms, 68% of the call"]]);
  });
  test("a group row adds its calls' waits up", () => {
    expect(waitSuffixOf([hopOf({ waitUs: 17_200 }), hopOf({ waitUs: 13_600 }), hopOf({ waitUs: null })])).toBe("waited 30.8 ms in all");
    expect(waitSuffixOf([hopOf({ waitUs: 0 }), hopOf({ waitUs: null })])).toBeNull();
  });
  test("no wait, or not reported: nothing", () => {
    expect(waitSuffix(hopOf({ waitUs: 0 }))).toBeNull();
    expect(waitSuffix(hopOf({ waitUs: null }))).toBeNull();
    expect(storeCallFacts(hopOf({ waitUs: 0 }))).toEqual([]);
  });
  test("cache reads: hit or miss, only when reported and only on cache hops", () => {
    expect(storeCallFacts(hopOf({ via: Via.Cache, hit: true }))).toEqual([[CACHE_READ_FACT, "hit, a value was found"]]);
    expect(storeCallFacts(hopOf({ via: Via.Cache, hit: false }))).toEqual([[CACHE_READ_FACT, "miss, nothing was found"]]);
    expect(cacheReadOf(hopOf({ via: Via.Cache, hit: null }))).toBeNull();
    expect(cacheReadOf(hopOf({ via: Via.Db, hit: true }))).toBeNull();
    expect(waitSuffix(hopOf({ via: Via.Cache, waitUs: 900 }))).toBeNull();
  });
  test("inbound chips: unchanged for services without the fields", () => {
    expect(storeTotalsChips(totals({ dbCalls: 2, dbUs: 6400, cacheCalls: 1, cacheUs: 400 }))).toEqual(["2 database calls · 6.4 ms", "1 cache call · 0.4 ms"]);
    expect(storeTotalsChips(null)).toEqual([]);
    expect(storeTotalsChips(totals({}))).toEqual([]);
  });
  test("inbound chips: hits, misses and the connection wait", () => {
    expect(storeTotalsChips(totals({ dbCalls: 3, dbUs: 75_000, dbWaitUs: 54_000, cacheCalls: 10, cacheUs: 900, cacheHits: 3, cacheMisses: 7 }))).toEqual([
      "3 database calls · 75.0 ms", "10 cache calls · 0.9 ms", "3 hits, 7 misses", "54.0 ms waiting for connections",
    ]);
    expect(storeTotalsChips(totals({ cacheCalls: 2, cacheUs: 100, cacheMisses: 1 }))).toContain("0 hits, 1 miss");
    expect(storeTotalsChips(totals({ dbCalls: 1, dbUs: 100, dbWaitUs: 0 }))).toEqual(["1 database call · 0.1 ms"]);
  });
});

describe("verdict clause", () => {
  const verdict = (records: HopRecord[]) => {
    const tree = buildRequestTree(records, [], NOW);
    return whyItWasSlow(tree, detectRepeats(tree, false), NOW);
  };
  test("connection wait over reporting calls only", () => {
    const tree = buildRequestTree(refunds(18), [], NOW);
    expect(connectionWait(tree.hops)).toEqual({ waitUs: 36_000, dbUs: 85_000, share: 36 / 85 });
    expect(connectionWait(buildRequestTree(refunds(null), [], NOW).hops)).toBeNull();
  });
  test("a pool-starved request names the waiting", () => {
    const v = verdict(refunds(18));
    expect(v.kind).toBe(VerdictKind.SlowCall);
    expect(v.sentence).toContain("Of the database time, 42 percent (36.0 ms) was spent waiting for a database connection.");
    expect(v.sentence).not.toContain("—");
  });
  test("below the threshold, or not reported, the sentence is as before", () => {
    const before = verdict(refunds(null)).sentence;
    expect(before).toBe("One call took 60 percent of the 100 ms: update charges, 60.0 ms.");
    // 2 x 12.7 ms of 85 ms is just under 30 percent.
    expect(verdict(refunds(12.7)).sentence).toBe(before);
    expect(verdict(refunds(12.8)).sentence).toContain("waiting for a database connection");
    expect(DB_WAIT_SHARE).toBe(0.3);
    expect(connectionWaitClause(null)).toBeNull();
  });
});
