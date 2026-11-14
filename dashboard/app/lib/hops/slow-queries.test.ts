import { describe, expect, test } from "bun:test";
import {
  KV_STMT_REGEXP,
  QuerySort,
  RecordFormat,
  SLOW_GROUP_LIMIT,
  SlowMeasure,
  SlowWindow,
  groupCallingRoutes,
  hopSelector,
  inboundEndLogql,
  kvFieldRegexp,
  mergeByShape,
  parentBatches,
  rawGroups,
  slowQueryLogql,
  sortQueryRows,
  statementCallsLogql,
  statementNeedles,
  type MeasureSample,
  type RawStatementGroup,
  type SampledCall,
} from "./slow-queries";
import { shapeId, statementShape } from "./stmt-shape";

// The exact queries validated against Loki 3.3 on the insights fixture stack (status file 02).
const PRELUDE =
  '{kind="hop"} |= "out_end" |~ "via\\\\W{1,6}db" | json rec="message" | drop __error__, __error_details__ | line_format "{{ if contains \\"trace_id\\" .rec }}{{ .rec }}{{ else }}{{ __line__ }}{{ end }}"';
const coalesce = (f: string): string =>
  `${f}="{{ or .${f} .metadata_${f} .fields_${f} .data_${f} .context_${f} .attributes_${f} }}"`;
const JSON_PIPE =
  `${PRELUDE} | json | __error__="" | label_format ${["hop", "via", "stmt", "table", "peer", "duration_us"].map(coalesce).join(", ")}` +
  ' | hop="out_end" | via="db" | stmt!="" | keep service, peer, table, stmt, duration_us';
const KV_PIPE =
  `${PRELUDE} !~ "^\\\\s*\\\\{" | regexp "^(?P<kv_head>.*?)\\\\sstmt=(?P<stmt>.*)$" | line_format "{{ .kv_head }} "` +
  ["hop", "via", "table", "peer", "duration_us"].map((f) => ` | regexp "(?:^|\\\\s)${f}=(?P<${f}>\\\\S+)\\\\s"`).join("") +
  ' | hop="out_end" | via="db" | stmt!="" | keep service, peer, table, stmt, duration_us';
const BY = "by (service, peer, table, stmt)";

describe("statement LogQL", () => {
  test("JSON total over 1 hour", () => {
    expect(slowQueryLogql(RecordFormat.Json, SlowMeasure.Total, SlowWindow.H1)).toBe(
      `topk(200, sum ${BY} (sum_over_time(${JSON_PIPE} | unwrap duration_us | __error__="" [1h])))`,
    );
  });

  test("key=value calls over 6 hours", () => {
    expect(slowQueryLogql(RecordFormat.Kv, SlowMeasure.Calls, SlowWindow.H6)).toBe(`topk(200, sum ${BY} (count_over_time(${KV_PIPE} [6h])))`);
  });

  test("p95 is a quantile over the unwrapped duration", () => {
    expect(slowQueryLogql(RecordFormat.Json, SlowMeasure.P95, SlowWindow.H1)).toBe(
      `topk(200, quantile_over_time(0.95, ${JSON_PIPE} | unwrap duration_us | __error__="" [1h]) ${BY})`,
    );
  });

  test("restricted to the top total-time groups with and", () => {
    const q = slowQueryLogql(RecordFormat.Kv, SlowMeasure.Calls, SlowWindow.H1, undefined, true);
    expect(q).toBe(
      `sum ${BY} (count_over_time(${KV_PIPE} [1h])) and topk(200, sum ${BY} (sum_over_time(${KV_PIPE} | unwrap duration_us | __error__="" [1h])))`,
    );
    // Total is never restricted against itself.
    expect(slowQueryLogql(RecordFormat.Kv, SlowMeasure.Total, SlowWindow.H1, undefined, true)).toStartWith(`topk(${SLOW_GROUP_LIMIT}, `);
  });

  test("a service name with a quote is escaped in the selector", () => {
    expect(hopSelector('we"ird\\svc')).toBe('{kind="hop", service="we\\"ird\\\\svc"}');
    expect(slowQueryLogql(RecordFormat.Json, SlowMeasure.Calls, SlowWindow.H1, 'a"b')).toContain('{kind="hop", service="a\\"b"}');
  });
});

/** RE2 and JS agree on these patterns; the LogQL strings hold them escaped once more. */
describe("key=value regexps are anchored", () => {
  const jsRe = (pattern: string): RegExp => new RegExp(pattern.replace(/\(\?P</g, "(?<"));
  const head = "05:11:01.030 [info] trace_id=4f90d322aa53591344a1ee776a840350 hop=in_end hop_id=ee975d713aae9194 op=GET via=db table=charges peer=payments-db duration_us=2300 ";

  test("hop=in_end never matches the op or table fields", () => {
    expect(jsRe(kvFieldRegexp("op")).exec(head)?.groups?.op).toBe("GET");
    expect(jsRe(kvFieldRegexp("hop")).exec(head)?.groups?.hop).toBe("in_end");
    const noTable = "x hop=in_end ... op=GET ";
    expect(jsRe(kvFieldRegexp("table")).exec(noTable)).toBeNull();
    expect(jsRe(kvFieldRegexp("table")).exec("a f_table=x ")).toBeNull();
    expect(jsRe(kvFieldRegexp("table")).exec(head)?.groups?.table).toBe("charges");
  });

  test("the statement runs to the end of the line and fields after it are not read", () => {
    const line = `${head.trim()} stmt=update orders set status=? where a = ? and outcome=error and duration_us=? and peer=x`;
    const m = jsRe(KV_STMT_REGEXP).exec(line);
    expect(m?.groups?.stmt).toBe("update orders set status=? where a = ? and outcome=error and duration_us=? and peer=x");
    expect(jsRe(kvFieldRegexp("peer")).exec(`${m?.groups?.kv_head} `)?.groups?.peer).toBe("payments-db");
    expect(jsRe(kvFieldRegexp("duration_us")).exec(`${m?.groups?.kv_head} `)?.groups?.duration_us).toBe("2300");
  });
});

const g = (over: Partial<RawStatementGroup>): RawStatementGroup => ({
  service: "shop-api",
  peer: "shop-db",
  table: "plans",
  stmt: "select plans.id from plans where plans.number = ?",
  calls: 10,
  totalUs: 10_000,
  p95Us: 1_500,
  ...over,
});

describe("rawGroups", () => {
  const m = (stmt: string, service = "shop-api"): Record<string, string> => ({ service, peer: "shop-db", table: "plans", stmt });
  test("joins the three measures of each group and adds the formats", () => {
    const json: MeasureSample = { metric: m("select 1"), value: 4 };
    const kv: MeasureSample = { metric: m("select 1"), value: 6 };
    const groups = rawGroups({
      [SlowMeasure.Calls]: [json, kv],
      [SlowMeasure.Total]: [{ metric: m("select 1"), value: 9_000 }],
      [SlowMeasure.P95]: [{ metric: m("select 1"), value: 800 }, { metric: m("select 1"), value: 1200 }],
    });
    expect(groups).toEqual([{ service: "shop-api", peer: "shop-db", table: "plans", stmt: "select 1", calls: 10, totalUs: 9_000, p95Us: 1200 }]);
  });

  test("series without a statement are dropped; a missing table or peer becomes null", () => {
    const groups = rawGroups({
      [SlowMeasure.Calls]: [{ metric: { service: "a" }, value: 1 }, { metric: { service: "a", stmt: "select 2" }, value: 3 }],
      [SlowMeasure.Total]: [],
      [SlowMeasure.P95]: [],
    });
    expect(groups).toEqual([{ service: "a", peer: null, table: null, stmt: "select 2", calls: 3, totalUs: null, p95Us: null }]);
  });
});

describe("mergeByShape", () => {
  test("statements that differ only by values merge, calls and totals add", () => {
    const rows = mergeByShape([
      g({ stmt: "select * from plans where id = 1", calls: 3, totalUs: 3_000, p95Us: 1_000 }),
      g({ stmt: "select * from plans where id = 2", calls: 1, totalUs: 5_000, p95Us: 5_000 }),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].shape).toBe("select * from plans where id = ?");
    expect(rows[0].shapeId).toBe(shapeId("select * from plans where id = ?"));
    expect(rows[0].calls).toBe(4);
    expect(rows[0].totalS).toBeCloseTo(0.008, 9);
    // Call-weighted: (1 ms x 3 + 5 ms x 1) / 4 = 2 ms.
    expect(rows[0].p95S).toBeCloseTo(0.002, 9);
    expect(rows[0].p95Approx).toBe(true);
    // The sample is the group with the most time.
    expect(rows[0].sample).toBe("select * from plans where id = 2");
  });

  test("in lists of different lengths merge", () => {
    const rows = mergeByShape([g({ stmt: "select id from stock where id in (?, ?)" }), g({ stmt: "select id from stock where id in (?)" })]);
    expect(rows.length).toBe(1);
    expect(rows[0].shape).toBe("select id from stock where id in (?)");
  });

  test("the same statement written by different adapters and formats merges", () => {
    const shape = statementShape("select plans.id from plans where plans.number = ?");
    const rows = mergeByShape([
      g({ stmt: "select plans.id from plans where plans.number = ?" }),
      g({ stmt: 'SELECT "plans"."id" FROM "plans" WHERE "plans"."number" = $1' }),
    ]);
    expect(rows.map((r) => r.shape)).toEqual([shape]);
  });

  test("different tables and different services stay apart", () => {
    const rows = mergeByShape([
      g({ stmt: "select id from plans where id = ?", totalUs: 3 }),
      g({ stmt: "select id from orders where id = ?", table: "orders", totalUs: 2 }),
      g({ stmt: "select id from plans where id = ?", service: "other", totalUs: 1 }),
    ]);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => !r.p95Approx)).toBe(true);
  });

  test("shareOfDb sums to 1 per service", () => {
    const rows = mergeByShape([
      g({ stmt: "select a from plans", totalUs: 1_000 }),
      g({ stmt: "select b from plans", totalUs: 3_000 }),
      g({ stmt: "select c from plans", service: "b", totalUs: 7 }),
    ]);
    const sums = new Map<string, number>();
    for (const r of rows) sums.set(r.service, (sums.get(r.service) ?? 0) + r.shareOfDb);
    expect(sums.get("shop-api")).toBeCloseTo(1, 9);
    expect(sums.get("b")).toBeCloseTo(1, 9);
    expect(rows[0].shareOfDb).toBeCloseTo(0.75, 9);
  });

  test("groups without a total are left out; a missing p95 stays null", () => {
    const rows = mergeByShape([g({ stmt: "select x from plans", totalUs: null }), g({ stmt: "select y from plans", p95Us: null })]);
    expect(rows.map((r) => r.sample)).toEqual(["select y from plans"]);
    expect(rows[0].p95S).toBeNull();
    expect(rows[0].p95Approx).toBe(false);
  });
});

describe("sortQueryRows", () => {
  const rows = mergeByShape([
    g({ stmt: "select slow from orders", calls: 5, totalUs: 2_000_000, p95Us: 400_000 }),
    g({ stmt: "select many from plans", calls: 140, totalUs: 190_000, p95Us: 1_400 }),
    g({ stmt: "select none from x", calls: 1, totalUs: 1, p95Us: null }),
  ]);
  test("by total, by calls, by p95 (no p95 last)", () => {
    expect(sortQueryRows(rows, QuerySort.Total).map((r) => r.sample)[0]).toBe("select slow from orders");
    expect(sortQueryRows(rows, QuerySort.Calls).map((r) => r.sample)[0]).toBe("select many from plans");
    expect(sortQueryRows(rows, QuerySort.P95).map((r) => r.sample)).toEqual(["select slow from orders", "select many from plans", "select none from x"]);
  });
});

describe("routes that call a statement", () => {
  const call = (parentHop: string | null, durationUs: number | null, traceId = "t".repeat(32)): SampledCall => ({ traceId, parentHop, durationUs });

  test("parent ids in batches of 50, duplicates and invalid ids dropped", () => {
    const calls = Array.from({ length: 120 }, (_, i) => call(i.toString(16).padStart(16, "0"), 1));
    calls.push(call(calls[0].parentHop, 1), call(null, 1), call("not-a-hop-id", 1));
    const batches = parentBatches(calls);
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(inboundEndLogql(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"])).toBe('{kind="hop"} |= "in_end" |~ "(aaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbb)"');
  });

  test("the statement filters avoid quotes, so JSON-escaped statements still match", () => {
    expect(statementNeedles('select "plans"."id" from "plans" where "plans"."number" = $1').sort()).toEqual(["plans", "number", " where ", " from ", " = $1", "select "].sort());
    expect(statementCallsLogql("select o0.id from orders as o0", 'shop"api')).toBe('{kind="hop", service="shop\\"api"} |= "out_end" |= "select o0.id from orders as o0"');
  });

  test("grouped by route, unknown parents skipped, the slowest call is the example", () => {
    const a = "a".repeat(16), b = "b".repeat(16);
    const r = groupCallingRoutes(
      [call(a, 200, "1".repeat(32)), call(a, 900, "2".repeat(32)), call(b, 100, "3".repeat(32)), call("c".repeat(16), 5_000, "4".repeat(32))],
      [
        { hopId: a, service: "shop-api", method: "GET", op: "/orders/:id" },
        { hopId: b, service: "shop-api", method: "GET", op: "/shop" },
      ],
    );
    expect(r.routes).toEqual([
      { service: "shop-api", method: "GET", op: "/orders/:id", calls: 2 },
      { service: "shop-api", method: "GET", op: "/shop", calls: 1 },
    ]);
    // The slowest sampled call, even when its route is unknown.
    expect(r.exampleTraceId).toBe("4".repeat(32));
    expect(r.sampled).toBe(4);
  });
});
