import { describe, expect, test } from "bun:test";
import { metricInstant, type LogEntry, type MetricSample, type TimeWindowMs } from "~/lib/loki.server";
import type { Tenant } from "~/lib/tenant.server";
import { RecordFormat, SLOW_GROUP_LIMIT, SlowMeasure, SlowWindow, slowQueryLogql } from "./slow-queries";
import { computeRoutesFor, computeSlowQueries, slowQueries, type LogRunner, type MetricRunner } from "./slow-queries.server";

const ORDERS = "select o0.id, o0.total, o0.status from orders as o0 where (o0.customer_id = ?) order by o0.created_at desc limit ?";
const PLANS = "select plans.id, plans.name, plans.price from plans where plans.number = ?";

function formatOf(q: string): RecordFormat {
  return q.includes("| regexp") ? RecordFormat.Kv : RecordFormat.Json;
}
function measureOf(q: string): SlowMeasure {
  const head = q.split(" and ")[0];
  if (head.includes("quantile_over_time")) return SlowMeasure.P95;
  if (head.includes("sum_over_time")) return SlowMeasure.Total;
  return SlowMeasure.Calls;
}

type Canned = Record<RecordFormat, Record<SlowMeasure, MetricSample[]>>;
const sample = (service: string, stmt: string, value: number, table = "orders"): MetricSample => ({ metric: { service, peer: "shop-db", table, stmt }, value });

function runner(canned: Canned, seen: string[] = []): MetricRunner {
  return async (query) => {
    seen.push(query);
    return canned[formatOf(query)][measureOf(query)];
  };
}

const TENANT: Tenant = { orgId: "org-slowq", platform: false };
const NOW = 1_800_000_000_000;
const on = async (): Promise<boolean> => false;

// The shared fixture stack's shape: the slow orders query, the plans N+1, and the plans query also
// written by a key=value service (another adapter's spelling of the same statement).
const CANNED: Canned = {
  [RecordFormat.Json]: {
    [SlowMeasure.Calls]: [sample("shop-api", ORDERS, 12), sample("shop-api", PLANS, 168, "plans")],
    [SlowMeasure.Total]: [sample("shop-api", ORDERS, 3_685_715), sample("shop-api", PLANS, 194_101, "plans")],
    [SlowMeasure.P95]: [sample("shop-api", ORDERS, 400_085), sample("shop-api", PLANS, 1_381, "plans")],
  },
  [RecordFormat.Kv]: {
    [SlowMeasure.Calls]: [sample("shop-api", 'SELECT "plans"."id", "plans"."name", "plans"."price" FROM "plans" WHERE "plans"."number" = $1', 32, "plans")],
    [SlowMeasure.Total]: [sample("shop-api", 'SELECT "plans"."id", "plans"."name", "plans"."price" FROM "plans" WHERE "plans"."number" = $1', 40_000, "plans")],
    [SlowMeasure.P95]: [sample("shop-api", 'SELECT "plans"."id", "plans"."name", "plans"."price" FROM "plans" WHERE "plans"."number" = $1', 2_000, "plans")],
  },
};

describe("computeSlowQueries", () => {
  test("six queries over the window; formats merge by shape; orders tops by time, plans by calls", async () => {
    const seen: string[] = [];
    const windows: TimeWindowMs[] = [];
    const run: MetricRunner = async (q, w, t) => {
      windows.push(w);
      expect(t).toBe(TENANT);
      return runner(CANNED, seen)(q, w, t);
    };
    const r = await computeSlowQueries(TENANT, SlowWindow.H1, NOW, run, on);
    expect(seen.length).toBe(6);
    expect(new Set(seen).size).toBe(6);
    expect(windows.every((w) => w.start === NOW - 3_600_000 && w.end === NOW)).toBe(true);
    expect(r.groupLimited).toBe(false);
    expect(r.statementsOff).toBe(false);
    expect(r.computedAt).toBe(NOW);
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].sample).toBe(ORDERS);
    expect(r.rows[0].totalS).toBeCloseTo(3.685715, 6);
    const plans = r.rows[1];
    expect(plans.shape).toBe(PLANS);
    expect(plans.calls).toBe(200);
    expect(plans.totalS).toBeCloseTo(0.234101, 6);
    expect(plans.p95Approx).toBe(true);
    // (1381 x 168 + 2000 x 32) / 200 microseconds.
    expect(plans.p95S).toBeCloseTo((1381 * 168 + 2000 * 32) / 200 / 1e6, 9);
  });

  test("the Query text switch off is reported", async () => {
    const empty: Canned = {
      [RecordFormat.Json]: { calls: [], total: [], p95: [] },
      [RecordFormat.Kv]: { calls: [], total: [], p95: [] },
    };
    const asked: string[] = [];
    const r = await computeSlowQueries(TENANT, SlowWindow.H6, NOW, runner(empty), async (org) => {
      asked.push(org);
      return true;
    });
    expect(asked).toEqual(["org-slowq"]);
    expect(r.statementsOff).toBe(true);
    expect(r.rows).toEqual([]);
  });

  test("a list at the group cap sets groupLimited and reads calls and p95 again for the top total groups", async () => {
    const many = Array.from({ length: SLOW_GROUP_LIMIT }, (_, i) => sample("svc", `select c${i} from t`, i + 1, "t"));
    const canned: Canned = {
      [RecordFormat.Json]: { calls: many, total: many, p95: many },
      [RecordFormat.Kv]: { calls: [], total: [], p95: [] },
    };
    const seen: string[] = [];
    const r = await computeSlowQueries(TENANT, SlowWindow.H1, NOW, runner(canned, seen), on);
    expect(r.groupLimited).toBe(true);
    expect(seen.length).toBe(10);
    const again = seen.slice(6);
    expect(again).toContain(slowQueryLogql(RecordFormat.Json, SlowMeasure.Calls, SlowWindow.H1, undefined, true));
    expect(again).toContain(slowQueryLogql(RecordFormat.Kv, SlowMeasure.P95, SlowWindow.H1, undefined, true));
    expect(r.rows.length).toBe(SLOW_GROUP_LIMIT);
  });
});

describe("slowQueries (cached)", () => {
  test("a fresh value is served without asking Loki again", async () => {
    const seen: string[] = [];
    const t: Tenant = { orgId: `org-cache-${Math.random()}`, platform: false };
    const a = await slowQueries(t, SlowWindow.H1, NOW, runner(CANNED, seen), on);
    const b = await slowQueries(t, SlowWindow.H1, NOW, runner(CANNED, seen), on);
    expect(seen.length).toBe(6);
    expect(b).toBe(a);
    // Another window is its own entry.
    await slowQueries(t, SlowWindow.H6, NOW, runner(CANNED, seen), on);
    expect(seen.length).toBe(12);
  });

  test("a failure is not stored: the next call asks again", async () => {
    const t: Tenant = { orgId: `org-fail-${Math.random()}`, platform: false };
    let calls = 0;
    const failing: MetricRunner = async () => {
      calls += 1;
      throw new Error("Loki timed out");
    };
    await expect(slowQueries(t, SlowWindow.H1, NOW, failing, on)).rejects.toThrow("Loki timed out");
    const ok = await slowQueries(t, SlowWindow.H1, NOW, runner(CANNED), on);
    expect(calls).toBeGreaterThan(0);
    expect(ok.rows.length).toBe(2);
  });
});

describe("org scoping keeps the templates intact", () => {
  test("only the stream selector gains the org matcher", async () => {
    const q = slowQueryLogql(RecordFormat.Json, SlowMeasure.Total, SlowWindow.H1);
    let sent = "";
    await metricInstant(q, { start: 0, end: 3_600_000 }, TENANT, undefined, async <T,>(url: string): Promise<T> => {
      sent = new URL(url).searchParams.get("query") ?? "";
      return { status: "success", data: { resultType: "matrix", result: [] } } as T;
    });
    expect(sent).toBe(q.replace('{kind="hop"}', '{org_id="org-slowq",kind="hop"}'));
  });
});

// ---------------------------------------------------------------- routes

const T1 = "a".repeat(32), T2 = "b".repeat(32), T3 = "c".repeat(32);
const IN_ORDERS = "1111111111111111", IN_SHOP = "2222222222222222", UNKNOWN = "3333333333333333";

function entry(line: string, service = "shop-api"): LogEntry {
  return { ts: NOW - 1000, line, labels: { service, source: service, kind: "hop" }, level: "info", service, message: line };
}
const envelope = (record: string): string => JSON.stringify({ kind: "hop", message: record, service: "shop-api", source: "shop-api" });
const jsonOut = (trace: string, parent: string, hop: string, us: number, stmt: string): string =>
  envelope(JSON.stringify({ trace_id: trace, hop: "out_end", hop_id: hop, parent_hop: parent, service: "shop-api", via: "db", op: "select", table: "orders", peer: "shop-db", outcome: "ok", duration_us: us, stmt }));
const kvOut = (trace: string, parent: string, hop: string, us: number, stmt: string): string =>
  `05:11:01.030 [info] trace_id=${trace} hop=out_end hop_id=${hop} parent_hop=${parent} service=shop-api via=db op=select table=orders peer=shop-db outcome=ok duration_us=${us} stmt=${stmt}`;
const kvIn = (trace: string, hop: string, method: string, op: string): string =>
  `trace_id=${trace} hop=in_end hop_id=${hop} service=shop-api via=http method=${method} op=${op} outcome=ok status=200 duration_us=400000`;

describe("computeRoutesFor", () => {
  test("kv and JSON calls, parents batched, unknown parent skipped, slowest is the example", async () => {
    const queries: string[] = [];
    const query: LogRunner = async (q) => {
      queries.push(q);
      if (q.includes('|= "out_end"')) {
        return [
          entry(jsonOut(T1, IN_ORDERS, "aaaaaaaaaaaaaaa1", 300_000, ORDERS)),
          entry(kvOut(T2, IN_ORDERS, "aaaaaaaaaaaaaaa2", 410_000, ORDERS)),
          entry(jsonOut(T3, UNKNOWN, "aaaaaaaaaaaaaaa3", 200_000, ORDERS)),
          // Same needle, another statement: not counted.
          entry(jsonOut(T3, IN_SHOP, "aaaaaaaaaaaaaaa4", 900_000, `${ORDERS} for update`)),
        ];
      }
      return [entry(kvIn(T1, IN_ORDERS, "GET", "/orders/:id")), entry(kvIn(T2, IN_SHOP, "GET", "/shop"))];
    };
    const r = await computeRoutesFor(TENANT, { sample: ORDERS, service: "shop-api" }, SlowWindow.H1, NOW, query);
    expect(r.routes).toEqual([{ service: "shop-api", method: "GET", op: "/orders/:id", calls: 2 }]);
    expect(r.exampleTraceId).toBe(T2);
    expect(r.sampled).toBe(3);
    expect(queries.length).toBe(2);
    expect(queries[1]).toBe(`{kind="hop"} |= "in_end" |~ "(${IN_ORDERS}|${UNKNOWN})"`);
  });
});
