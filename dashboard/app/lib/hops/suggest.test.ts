// BAC-93: the rules, over requests built from records as the request view builds them. The first two
// requests copy the shape of the two real findings in the ticket (commerce-api).
import { describe, expect, test } from "bun:test";
import { buildObservedSchema } from "./observed-schema";
import { detectRepeats } from "./repeated";
import { NO_CONTEXT, SuggestionKind, boardSuggestion, requestSuggestions, suggestionsByHop, type SuggestContext } from "./suggest";
import type { QueryRow } from "./slow-queries";
import { buildRequestTree } from "./tree";
import { statementShape, shapeId } from "./stmt-shape";
import { HopKind, Via, type HopId, type HopRecord, type TraceId } from "./types";

const TRACE = "098366970eadce0748e441f2d3cd5d58" as TraceId;
const T0 = 1_763_020_800_000;
const NOW = T0 + 60_000;
const SVC = "commerce-api";
const hid = (n: number): HopId => n.toString(16).padStart(16, "0") as HopId;

function record(kind: HopKind, id: number, parent: number | null, timeMs: number, over: Partial<HopRecord>): HopRecord {
  const out = kind === HopKind.Out || kind === HopKind.OutEnd;
  const end = kind === HopKind.InEnd || kind === HopKind.OutEnd;
  return {
    traceId: TRACE, hop: kind, hopId: hid(id), parentHop: parent === null ? null : hid(parent),
    hopSent: out ? false : null, tracer: false, handoff: false, parentId: null,
    service: SVC, source: SVC, adapter: out ? "sequelize" : "express", via: Via.Http, method: null, op: null, path: null,
    peer: null, table: null, stmt: null, attempt: null, outcome: end ? "ok" : null, status: null, error: null,
    durationUs: null, hit: null, waitUs: null, totals: null, fields: [], timeMs, ...over,
  };
}

function request(durMs: number): HopRecord[] {
  return [
    record(HopKind.In, 1, null, T0, { method: "POST", op: "/payments", path: "/payments" }),
    record(HopKind.InEnd, 1, null, T0 + durMs, { method: "POST", op: "/payments", path: "/payments", status: 200, durationUs: durMs * 1000 }),
  ];
}

/** A database call from `startMs` that took `ms`. */
function db(id: number, startMs: number, ms: number, stmt: string, over: Partial<HopRecord> = {}): HopRecord {
  const table = /(?:from|into|update)\s+"?([a-z_]+)"?/i.exec(stmt)?.[1] ?? null;
  return record(HopKind.OutEnd, id, 1, T0 + startMs + ms, {
    via: Via.Db, op: stmt.trim().split(/\s/)[0].toLowerCase(), peer: "commerce-db", table, stmt, durationUs: Math.round(ms * 1000), ...over,
  });
}

const suggest = (records: HopRecord[], ctx: SuggestContext = NO_CONTEXT) => {
  const tree = buildRequestTree(records, [], NOW);
  return requestSuggestions(tree, detectRepeats(tree, false), ctx);
};

describe("DoubleLookup", () => {
  test("merchants looked up by username, then by lower(username): one lookup, and a functional index", () => {
    const s = suggest([
      ...request(80),
      db(10, 2, 4.1, `SELECT "id", "username", "name" FROM "merchants" AS "Merchant" WHERE "Merchant"."username" = 'zed' LIMIT 1;`),
      db(11, 8, 9.6, `SELECT "id", "username", "name" FROM "merchants" AS "Merchant" WHERE lower("Merchant"."username") = 'zed' LIMIT 1;`),
    ]);
    const d = s.find((x) => x.kind === SuggestionKind.DoubleLookup);
    expect(d).toBeDefined();
    expect(d?.table).toBe("merchants");
    expect(d?.hopIds).toEqual([hid(10), hid(11)]);
    expect(d?.summary).toContain("looked up 2 times by username");
    expect(d?.advice).toContain("one lookup");
    expect(d?.advice).toContain("lower");
    expect(d?.sketch).toBe("create index on merchants (lower(username))");
    expect(d?.savedUs).toBe(4100);
    // Names only: nothing from a value reaches the text.
    expect(JSON.stringify(d)).not.toContain("zed");
  });

  test("the same query twice is flagged; different columns are not", () => {
    const twice = suggest([
      ...request(50),
      db(10, 2, 3, `select id from accounts where merchant_id = 4`),
      db(11, 7, 3, `select id from accounts where merchant_id = 4`),
    ]);
    expect(twice.filter((x) => x.kind === SuggestionKind.DoubleLookup)).toHaveLength(1);
    const differ = suggest([
      ...request(50),
      db(10, 2, 3, `select id from accounts where merchant_id = 4`),
      db(11, 7, 3, `select id from accounts where owner_id = 4`),
    ]);
    expect(differ.filter((x) => x.kind === SuggestionKind.DoubleLookup)).toHaveLength(0);
  });
});

describe("NPlusOne", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => db(100 + i, 5 + i * 4, 3, `select id, name, price from products where id = ${900 + i}`));

  test("one select per id, back to back: one query with any(?)", () => {
    const s = suggest([...request(120), ...rows(6)]);
    const n = s.find((x) => x.kind === SuggestionKind.NPlusOne);
    expect(n?.summary).toBe("select products ran 6 times back to back.");
    expect(n?.sketch).toBe("select id, name, price from products where id = any(?)");
    expect(n?.hopIds).toHaveLength(6);
    expect(n?.savedUs).toBe(15_000);
  });

  test("three is enough (BAC-68 needs five); two is not an N+1", () => {
    expect(suggest([...request(60), ...rows(3)]).some((x) => x.kind === SuggestionKind.NPlusOne)).toBe(true);
    expect(suggest([...request(60), ...rows(2)]).some((x) => x.kind === SuggestionKind.NPlusOne)).toBe(false);
  });

  test("calls that ran together are not an N+1", () => {
    const together = Array.from({ length: 5 }, (_, i) => db(100 + i, 5, 20, `select id from products where id = ${i}`, { durationUs: 20_000 }));
    expect(suggest([...request(60), ...together]).some((x) => x.kind === SuggestionKind.NPlusOne)).toBe(false);
  });

  test("an insert per row: one multi-row insert", () => {
    const ins = Array.from({ length: 4 }, (_, i) => db(100 + i, 5 + i * 4, 3, `insert into order_items (order_id, sku) values (${i}, 'a${i}')`));
    const n = suggest([...request(60), ...ins]).find((x) => x.kind === SuggestionKind.NPlusOne);
    expect(n?.advice).toContain("multi-row insert");
    expect(n?.sketch).toContain("values (?), (?), ...");
  });
});

describe("DominantShape and JoinColumn", () => {
  const slow = `select o.id, o.total from orders o inner join order_items i on i.order_id = o.id where o.merchant_id = 12 and o.status = 'paid' order by o.created_at desc limit 20`;
  const records = [
    ...request(300),
    db(10, 5, 220, slow),
    db(11, 230, 4, `select id from merchants where id = 12`),
    db(12, 240, 6, `select id, name from plans where code = 'x'`),
  ];

  test("a shape with most of the database time: an index on its filter columns, marked likely", () => {
    const d = suggest(records).find((x) => x.kind === SuggestionKind.DominantShape);
    expect(d?.confidence).toBe("likely");
    expect(d?.sketch).toBe("create index on orders (merchant_id, status)");
    expect(d?.evidence[0]).toContain("96 percent");
    expect(d?.advice).toContain("would likely help");
  });

  test("a dominant join also names the join column", () => {
    const j = suggest(records).find((x) => x.kind === SuggestionKind.JoinColumn);
    expect(j?.sketch).toBe("create index on order_items (order_id)");
  });

  test("the observed schema adds the columns that travel with a lone filter column", () => {
    const schema = buildObservedSchema([
      { shape: statementShape(`select * from orders where merchant_id = 1 and status = 'paid'`), calls: 900 },
      { shape: statementShape(`select * from orders where merchant_id = 1`), calls: 40 },
    ]);
    const only = [...request(300), db(10, 5, 250, `select id from orders where merchant_id = 12`), db(11, 260, 3, `select id from plans where id = 1`)];
    const d = suggest(only, { schema, rows: [] }).find((x) => x.kind === SuggestionKind.DominantShape);
    expect(d?.sketch).toBe("create index on orders (merchant_id, status)");
    expect(d?.advice).toContain("filter status together with merchant_id");
  });

  test("the board's figures are quoted when the shape is on the board", () => {
    const row: QueryRow = { shapeId: shapeId(statementShape(slow)), shape: statementShape(slow), sample: slow, service: SVC, peer: null, table: "orders", calls: 4000, totalS: 900, p95S: 0.4, p95Approx: false, shareOfDb: 0.7 };
    const d = suggest(records, { schema: buildObservedSchema([]), rows: [row] }).find((x) => x.kind === SuggestionKind.DominantShape);
    expect(d?.evidence[1]).toContain("4,000 calls");
    expect(d?.evidence[1]).toContain("70 percent");
  });

  test("a fast request, a key lookup and a spread-out request give nothing", () => {
    expect(suggest([...request(20), db(10, 2, 8, `select * from orders where merchant_id = 1`)]).filter((x) => x.kind === SuggestionKind.DominantShape)).toHaveLength(0);
    expect(suggest([...request(300), db(10, 2, 200, `select * from orders where id = 1`)]).filter((x) => x.kind === SuggestionKind.DominantShape)).toHaveLength(0);
    const even = [...request(300), db(10, 2, 30, `select * from a where x = 1`), db(11, 40, 30, `select * from b where y = 1`), db(12, 80, 30, `select * from c where z = 1`)];
    expect(suggest(even).filter((x) => x.kind === SuggestionKind.DominantShape)).toHaveLength(0);
  });
});

describe("ParallelCandidate and AfterResponse", () => {
  test("two independent-looking selects one after another", () => {
    const s = suggest([
      ...request(150),
      db(10, 2, 40, `select id from plans where code = 'a'`),
      db(11, 42.5, 45, `select id from fees where code = 'b'`),
    ]);
    const p = s.find((x) => x.kind === SuggestionKind.ParallelCandidate);
    expect(p?.hopIds).toEqual([hid(10), hid(11)]);
    expect(p?.advice).toContain("If they do not depend on each other");
  });

  test("a slow audit insert on the request path, with another call already handed off", () => {
    const s = suggest([
      ...request(150),
      db(10, 2, 60, `insert into audit_events (actor, kind) values ('a', 'b')`),
      db(11, 70, 5, `select id from plans where code = 'a'`),
      record(HopKind.OutEnd, 12, 1, T0 + 90, { via: Via.Http, method: "POST", peer: "mailer.internal", durationUs: 8000, handoff: true }),
    ]);
    const a = s.find((x) => x.kind === SuggestionKind.AfterResponse);
    expect(a?.summary).toContain("insert audit_events");
    expect(a?.evidence.join(" ")).toContain("already run in the background");
    expect(a?.savedUs).toBe(60_000);
  });

  test("an insert that returns a row, or a fast one, is left alone", () => {
    expect(suggest([...request(150), db(10, 2, 60, `insert into audit_events (a) values (1) returning id`)]).some((x) => x.kind === SuggestionKind.AfterResponse)).toBe(false);
    expect(suggest([...request(150), db(10, 2, 5, `insert into audit_events (a) values (1)`)]).some((x) => x.kind === SuggestionKind.AfterResponse)).toBe(false);
  });
});

describe("a request with a bit of everything", () => {
  test("both ticket findings in one trace, largest saving first, and suggestionsByHop points at the calls", () => {
    const calls = [
      ...request(200),
      db(10, 2, 4, `SELECT "id" FROM "merchants" WHERE "username" = 'a' LIMIT 1`),
      db(11, 8, 10, `SELECT "id" FROM "merchants" WHERE lower("username") = 'a' LIMIT 1`),
      ...Array.from({ length: 5 }, (_, i) => db(20 + i, 30 + i * 12, 10, `select * from plans where id = ${i}`)),
    ];
    const s = suggest(calls);
    expect(s.map((x) => x.kind)).toEqual([SuggestionKind.NPlusOne, SuggestionKind.DoubleLookup]);
    expect(suggestionsByHop(s).get(hid(11))?.kind).toBe(SuggestionKind.DoubleLookup);
  });
  test("a request with nothing to say", () => {
    expect(suggest([...request(30), db(10, 2, 3, `select id from plans where id = 1`)])).toEqual([]);
  });
});

describe("boardSuggestion", () => {
  const row = (over: Partial<QueryRow>): QueryRow => ({
    shapeId: "abcd1234", shape: statementShape(`select * from orders where merchant_id = 1 and status = 'paid'`), sample: "", service: SVC, peer: null, table: "orders",
    calls: 500, totalS: 100, p95S: 0.5, p95Approx: false, shareOfDb: 0.5, ...over,
  });
  const peers = [0.01, 0.02, 0.015, 0.012].map((p95S, i) => row({ shape: `select ${i} from t${i} where a = ?`, shapeId: `x${i}`, p95S, shareOfDb: 0.1, calls: 100 }));

  test("a dominant shape gets an index hint, marked likely", () => {
    const s = boardSuggestion(row({}), [row({}), ...peers], buildObservedSchema([]));
    expect(s?.summary).toBe("Index orders (merchant_id, status), likely");
    expect(s?.sketch).toBe("create index on orders (merchant_id, status)");
  });
  test("a slow shape with a modest share is flagged by its p95 against the others", () => {
    const s = boardSuggestion(row({ shareOfDb: 0.1 }), [row({ shareOfDb: 0.1 }), ...peers], buildObservedSchema([]));
    expect(s?.evidence.join(" ")).toContain("times the median p95");
  });
  test("a quiet shape, too few calls, or no usable column gives nothing", () => {
    expect(boardSuggestion(row({ shareOfDb: 0.05, p95S: 0.02 }), [row({}), ...peers], buildObservedSchema([]))).toBeNull();
    expect(boardSuggestion(row({ calls: 3 }), [row({}), ...peers], buildObservedSchema([]))).toBeNull();
    expect(boardSuggestion(row({ shape: "select * from orders where id = ?" }), [...peers], buildObservedSchema([]))).toBeNull();
  });
});
