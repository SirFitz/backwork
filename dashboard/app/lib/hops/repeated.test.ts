// BAC-68: repeated calls inside one request. Requests are built from records and run through
// buildRequestTree, as the request view does.
import { describe, expect, test } from "bun:test";
import {
  REPEAT_MIN_DB, RepeatChip, Repetition, callShapeKey, classifyRepetition, detectRepeats, repeatChip, repeatHint,
  repeatNote, repeatSentence, repeatsByHop, wastedUsOf,
} from "./repeated";
import { buildRequestTree } from "./tree";
import { HopKind, StoreKind, Via, type HopId, type HopRecord, type StoreTotals, type TraceId } from "./types";

const TRACE = "5bcb60305bcb60305bcb60305bcb6030" as TraceId;
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

function request(durMs: number, totals: StoreTotals | null = null): HopRecord[] {
  return [
    record(HopKind.In, 1, null, T0, { method: "GET", op: "/shop", path: "/shop" }),
    record(HopKind.InEnd, 1, null, T0 + durMs, { method: "GET", op: "/shop", path: "/shop", status: 200, durationUs: durMs * 1000, totals }),
  ];
}

/** A database call ending at `endMs` (from T0) that took `us`. */
function db(id: number, endMs: number, us: number, over: Partial<HopRecord> = {}): HopRecord {
  return record(HopKind.OutEnd, id, 1, T0 + endMs, { via: Via.Db, op: "select", peer: "shop-db", table: "plans", stmt: PLANS, durationUs: us, ...over });
}

function cache(id: number, op: string, endMs: number, us: number, over: Partial<HopRecord> = {}): HopRecord {
  return record(HopKind.OutEnd, id, 1, T0 + endMs, { via: Via.Cache, adapter: "ioredis", op, peer: "redis.internal", durationUs: us, ...over });
}

/** `n` selects one after another, 1 ms each with 0.2 ms between them, starting at 2 ms. */
function sequential(n: number, firstId = 100, over: Partial<HopRecord> = {}): HopRecord[] {
  return Array.from({ length: n }, (_, i) => db(firstId + i, 2 + i * 1.2 + 1, 1000 + i * 10, over));
}

const report = (records: HopRecord[], truncated = false) => detectRepeats(buildRequestTree(records, [], NOW), truncated);

describe("repeated calls in one request", () => {
  test("14 identical selects one after another are one sequential group; wasted is the total minus the first", () => {
    const r = report([...request(30), ...sequential(14)]);
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0];
    expect(g.repetition).toBe(Repetition.Sequential);
    expect(g.count).toBe(14);
    expect(g.kind).toBe(StoreKind.Db);
    expect(g.label).toBe("select plans");
    const total = Array.from({ length: 14 }, (_, i) => 1000 + i * 10).reduce((a, b) => a + b, 0);
    expect(g.totalUs).toBe(total);
    expect(g.wastedUs).toBe(total - 1000);
    expect(g.atLeast).toBe(false);
    expect(g.statementKnown).toBe(true);
    expect(g.hopIds[0]).toBe(hid(100));
    expect(r.repeatedCalls).toBe(14);
    expect(r.wastedUs).toBe(g.wastedUs);
  });

  test("the same 14 started together are concurrent; wasted is the total minus the longest", () => {
    const calls = Array.from({ length: 14 }, (_, i) => db(100 + i, 5 + i * 0.1, 3000 + i * 100));
    const g = report([...request(30), ...calls]).groups[0];
    expect(g.repetition).toBe(Repetition.Concurrent);
    const durs = Array.from({ length: 14 }, (_, i) => 3000 + i * 100);
    expect(g.wastedUs).toBe(durs.reduce((a, b) => a + b, 0) - 4300);
  });

  test("12 cache gets started within 1 ms on one client are a pipeline and not reported", () => {
    const gets = Array.from({ length: 12 }, (_, i) => cache(200 + i, "get", 1.0 + 0.7 + 0.02 * i, 700 + 20 * i));
    expect(report([...request(4), ...gets]).groups).toEqual([]);
  });

  test("12 cache gets that overlap but are spread out are concurrent and reported", () => {
    const gets = Array.from({ length: 12 }, (_, i) => cache(200 + i, "get", 1 + i * 0.5 + 3, 3000));
    const g = report([...request(20), ...gets]).groups[0];
    expect(g.repetition).toBe(Repetition.Concurrent);
    expect(repeatSentence(g)).toBe("get redis.internal ran 12 times together (about 3.0 ms each).");
    expect(repeatHint(g)).toBeNull();
    expect(repeatChip(g)).toBe(RepeatChip.Repeated);
  });

  test("4 repeats are below the minimum and absent", () => {
    expect(report([...request(30), ...sequential(REPEAT_MIN_DB - 1)]).groups).toEqual([]);
  });

  test("different tables never merge", () => {
    const a = sequential(3, 100);
    const b = sequential(3, 200, { table: "prices", stmt: "select prices.id from prices where prices.number = ?" }).map((r) => ({ ...r, timeMs: r.timeMs + 20 }));
    expect(report([...request(40), ...a, ...b]).groups).toEqual([]);
  });

  test("whitespace and IN list variants of one statement merge", () => {
    const stmts = [
      "select stock.count from stock where stock.id in (?, ?, ?)",
      "SELECT stock.count  FROM stock WHERE stock.id IN (?)",
      "select stock.count from stock where stock.id in (?,?)",
      "select stock.count from stock\nwhere stock.id in (?, ?);",
      "select stock.count from stock where stock.id in ($1, $2)",
    ];
    const calls = stmts.map((stmt, i) => db(100 + i, 3 + i * 1.5, 1000, { table: "stock", stmt }));
    const r = report([...request(20), ...calls]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].count).toBe(5);
    expect(r.groups[0].shape).toBe("select stock.count from stock where stock.id in (?)");
  });

  test("without the statement, calls group by host, command and table and say so", () => {
    const calls = sequential(6, 100, { stmt: null });
    const g = report([...request(30), ...calls]).groups[0];
    expect(g.statementKnown).toBe(false);
    expect(g.shape).toBeNull();
    expect(g.count).toBe(6);
    expect(repeatSentence(g)).toContain("(matched by command and table: the query text was not recorded).");
    // An update to the same table is another call.
    const mixed = [...sequential(3, 100, { stmt: null }), ...sequential(3, 200, { stmt: null, op: "update" }).map((r) => ({ ...r, timeMs: r.timeMs + 20 }))];
    expect(report([...request(40), ...mixed]).groups).toEqual([]);
  });

  test("calls made in the background (handoff) or after the response are ignored", () => {
    expect(report([...request(30), ...sequential(14, 100, { handoff: true })]).groups).toEqual([]);
    // Ending after the request's end record: after the response.
    const late = sequential(14).map((r) => ({ ...r, timeMs: r.timeMs + 40 }));
    expect(report([...request(30), ...late]).groups).toEqual([]);
  });

  test("at least: when the fetch was truncated, and when calls were not recorded one by one", () => {
    expect(report([...request(30), ...sequential(14)], true).groups[0].atLeast).toBe(true);
    const short = report([...request(30, { dbCalls: 20, dbUs: 20_000, cacheCalls: 0, cacheUs: 0 }), ...sequential(14)]);
    expect(short.groups[0].atLeast).toBe(true);
    expect(repeatSentence(short.groups[0])).toMatch(/^select plans ran at least 14 times, one after another/);
    // A cache shortfall does not make a database count a floor.
    const cacheShort = report([...request(30, { dbCalls: 14, dbUs: 14_910, cacheCalls: 3, cacheUs: 1000 }), ...sequential(14)]);
    expect(cacheShort.groups[0].atLeast).toBe(false);
  });

  test("the live /shop shape: 7 sets one after another (2.10 s) are reported, the 4 multi blocks are not", () => {
    // 7 sets of 300 ms each one after another, then 4 MULTI blocks of 207 ms each.
    const sets = Array.from({ length: 7 }, (_, i) => cache(300 + i, "set", 10 + (i + 1) * 300.5, 300_000));
    const multis = Array.from({ length: 4 }, (_, i) => {
      const end = 2200 + (i + 1) * 210;
      return ["multi", "set", "expire", "exec"].map((op, j) => cache(400 + i * 10 + j, op, end, 207_000));
    }).flat();
    const r = report([...request(3100), ...sequential(8, 100, { table: null, stmt: null, op: "select" }).map((x, i) => ({ ...x, table: `t${i}` })), ...sets, ...multis]);
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0];
    expect(g.label).toBe("set redis.internal");
    expect(g.count).toBe(7);
    expect(g.repetition).toBe(Repetition.Sequential);
    expect(repeatSentence(g)).toBe("set redis.internal ran 7 times, one after another, 2.10 s in all.");
    expect(repeatHint(g)).toBe("Use one multi-key command or a pipeline.");
    expect(repeatChip(g)).toBe(RepeatChip.Repeated);
  });

  test("sentence, hint, chip and note of a sequential database group", () => {
    const calls = Array.from({ length: 14 }, (_, i) => db(100 + i, 2 + (i + 1) * 4.5, 4430));
    const g = report([...request(80), ...calls]).groups[0];
    expect(repeatSentence(g)).toBe("select plans ran 14 times, one after another, 62.0 ms in all.");
    expect(repeatHint(g)).toBe("Fetch them together with one query that takes a list of IDs.");
    expect(repeatChip(g)).toBe(RepeatChip.NPlusOne);
    expect(repeatNote(g)).toBe("repeated 14 times");
    expect(repeatsByHop({ groups: [g], repeatedCalls: 14, wastedUs: g.wastedUs, truncated: false }).get(hid(105))).toBe(g);
  });

  test("groups are sorted by wasted time", () => {
    const small = sequential(5, 100);
    const big = sequential(10, 200, { table: "prices", stmt: "select prices.id from prices where prices.number = ?" }).map((r) => ({ ...r, timeMs: r.timeMs + 10, durationUs: 5000 }));
    const r = report([...request(80), ...small, ...big]);
    expect(r.groups.map((g) => g.table)).toEqual(["prices", "plans"]);
    expect(r.repeatedCalls).toBe(15);
  });

  test("a large request (5000 store calls) is analysed well under 100 ms", () => {
    const calls: HopRecord[] = [];
    for (let i = 0; i < 5000; i++) calls.push(db(1000 + i, 2 + i * 0.2 + 0.1, 100, { table: `t${i % 50}`, stmt: `select t${i % 50}.id from t${i % 50} where t${i % 50}.id = ?` }));
    const tree = buildRequestTree([...request(1100), ...calls], [], NOW);
    const t = performance.now();
    const r = detectRepeats(tree, false);
    const ms = performance.now() - t;
    expect(r.groups).toHaveLength(50);
    expect(ms).toBeLessThan(100);
  });
});

describe("repetition and waste", () => {
  test("touching calls within the slack are one after another", () => {
    const spans = Array.from({ length: 5 }, (_, i) => ({ startMs: i * 1.0 - 0.5 * (i > 0 ? 1 : 0), endMs: i * 1.0 + 1 }));
    expect(classifyRepetition(spans, false)).toBe(Repetition.Sequential);
  });

  test("batched needs a batchable client; a database burst is concurrent", () => {
    const spans = Array.from({ length: 6 }, (_, i) => ({ startMs: 0.1 * i, endMs: 2 + 0.1 * i }));
    expect(classifyRepetition(spans, true)).toBe(Repetition.Batched);
    expect(classifyRepetition(spans, false)).toBe(Repetition.Concurrent);
  });

  test("waste is never negative and nothing for a batch", () => {
    expect(wastedUsOf(Repetition.Sequential, [])).toBe(0);
    expect(wastedUsOf(Repetition.Batched, [5, 5])).toBe(0);
    expect(wastedUsOf(Repetition.Concurrent, [3, 9, 1])).toBe(4);
  });

  test("the shape key: database by host, table and shape; cache by host and command", () => {
    const base = { via: Via.Db, op: "select", peer: "db", table: "plans", stmt: "select plans.id from plans where plans.n = 1" } as const;
    expect(callShapeKey(base)).toBe(callShapeKey({ ...base, stmt: "SELECT plans.id FROM plans WHERE plans.n = 2" }));
    expect(callShapeKey(base)).not.toBe(callShapeKey({ ...base, peer: "db2" }));
    const c = { via: Via.Cache, op: "get", peer: "redis", table: null, stmt: null } as const;
    expect(callShapeKey(c)).not.toBe(callShapeKey({ ...c, op: "set" }));
  });
});
