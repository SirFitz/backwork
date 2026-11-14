// BAC-68: the Insights > Repeated calls scan, with an injected Loki read.
import { describe, expect, test } from "bun:test";
import type { LogEntry } from "~/lib/loki.server";
import type { Tenant } from "~/lib/tenant.server";
import { DB_RECORDS_QUERY, RECORD_LIMIT, REPEATS_WINDOW_MS, scanRepeats } from "./repeats.server";
import { shapeId, statementShape } from "./stmt-shape";

const NOW = 1_763_020_800_000;
const PLANS = "select plans.id, plans.name, plans.price from plans where plans.number = ?";
const hex = (n: number, len: number): string => n.toString(16).padStart(len, "0");
const trace = (n: number): string => hex(n + 0xabc, 32);
let tenantNo = 0;
const tenant = (): Tenant => ({ orgId: `org-repeats-${++tenantNo}`, platform: false });

/** A kv database end record line. */
function kv(t: number, id: number, parent: number, stmt: string | null, endMs: number, us: number, table = "plans", service = "shop-api"): LogEntry {
  const line = `trace_id=${trace(t)} hop=out_end hop_id=${hex(id, 16)} parent_hop=${hex(parent, 16)} hop_sent=false service=${service} adapter=prisma via=db op=select peer=shop-db table=${table} outcome=ok duration_us=${us}${stmt ? ` stmt=${stmt}` : ""}`;
  return { ts: Math.floor(endMs), tsExactMs: endMs, line, labels: { service, kind: "hop" } };
}

/** The same record as a JSON line. */
function json(t: number, id: number, parent: number, stmt: string, endMs: number, us: number): LogEntry {
  const line = JSON.stringify({ trace_id: trace(t), hop: "out_end", hop_id: hex(id, 16), parent_hop: hex(parent, 16), hop_sent: false, service: "shop-api", adapter: "pg", via: "db", op: "select", peer: "shop-db", table: "plans", outcome: "ok", duration_us: us, stmt });
  return { ts: Math.floor(endMs), tsExactMs: endMs, line, labels: { service: "shop-api", kind: "hop" } };
}

/** One request: `n` plans lookups one after another (1 ms each), ending at `at`. */
function request(t: number, n: number, at: number, format: "kv" | "json" = "kv", stmt: string = PLANS): LogEntry[] {
  const parent = 1000 + t;
  return Array.from({ length: n }, (_, i) => {
    const end = at - (n - i) * 1.2;
    return format === "kv" ? kv(t, t * 100 + i, parent, stmt, end, 1000) : json(t, t * 100 + i, parent, stmt, end, 1000);
  });
}

function reader(entries: LogEntry[]) {
  const calls: Array<{ query: string; start: number; end: number; limit: number }> = [];
  const read = async (query: string, opts: { start: number; end: number; limit: number }): Promise<LogEntry[]> => {
    calls.push({ query, ...opts });
    return entries;
  };
  return { read, calls };
}

describe("scanRepeats", () => {
  test("groups by request, keeps repeats from the minimum, aggregates by shape with the median and an example", async () => {
    const entries = [
      ...request(1, 14, NOW - 60_000),
      ...request(2, 10, NOW - 50_000, "json", "SELECT plans.id, plans.name, plans.price FROM plans WHERE plans.number = $1"),
      ...request(3, 12, NOW - 40_000),
      ...request(4, 4, NOW - 30_000), // below the minimum
    ];
    const { read, calls } = reader(entries);
    const scan = await scanRepeats(tenant(), REPEATS_WINDOW_MS, read, NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe(DB_RECORDS_QUERY);
    expect(calls[0].limit).toBe(RECORD_LIMIT);
    expect(calls[0].end - calls[0].start).toBe(REPEATS_WINDOW_MS);
    expect(scan.rows).toHaveLength(1);
    const row = scan.rows[0];
    expect(row.label).toBe("select plans");
    expect(row.shape).toBe(statementShape(PLANS));
    expect(row.shapeId).toBe(shapeId(statementShape(PLANS)));
    expect(row.requests).toBe(3);
    expect(row.medianRepeats).toBe(12);
    expect(row.sequentialRequests).toBe(3);
    expect(row.totalUs).toBe(36_000);
    expect(row.wastedUs).toBe(33_000);
    expect(row.exampleTraceId).toBe(trace(3));
    expect(scan.recordsRead).toBe(entries.length);
    expect(scan.truncated).toBe(false);
    expect(scan.statementsOff).toBe(false);
  });

  test("two calling hops in one trace are two requests; a different table is another row", async () => {
    const a = request(5, 6, NOW - 20_000);
    // The same trace, a second calling hop with its own calls.
    const b = request(5, 6, NOW - 10_000).map((e, i) => ({
      ...e,
      line: e.line.replace(`parent_hop=${hex(1005, 16)}`, `parent_hop=${hex(2005, 16)}`).replace(/hop_id=\w+/, `hop_id=${hex(90_000 + i, 16)}`),
    }));
    const other = Array.from({ length: 5 }, (_, i) => kv(6, 600 + i, 1006, "select prices.id from prices where prices.n = ?", NOW - 5000 + i * 2, 1000, "prices"));
    const scan = await scanRepeats(tenant(), REPEATS_WINDOW_MS, reader([...a, ...b, ...other]).read, NOW);
    expect(scan.rows.map((r) => [r.table, r.requests])).toEqual([["plans", 2], ["prices", 1]]);
  });

  test("records past the limit mark the scan as sampled", async () => {
    const many = Array.from({ length: RECORD_LIMIT }, (_, i) => kv(7, 10_000 + i, 1007, PLANS, NOW - 100_000 + i * 1.2, 1000));
    const scan = await scanRepeats(tenant(), REPEATS_WINDOW_MS, reader(many).read, NOW);
    expect(scan.truncated).toBe(true);
    expect(scan.rows[0].medianRepeats).toBe(RECORD_LIMIT);
  });

  test("database records without statement text: statements off, nothing listed", async () => {
    const entries = Array.from({ length: 8 }, (_, i) => kv(8, 800 + i, 1008, null, NOW - 1000 + i * 2, 1000));
    const scan = await scanRepeats(tenant(), REPEATS_WINDOW_MS, reader(entries).read, NOW);
    expect(scan.rows).toEqual([]);
    expect(scan.statementsOff).toBe(true);
  });

  test("nothing read: empty, not statements off", async () => {
    const scan = await scanRepeats(tenant(), REPEATS_WINDOW_MS, reader([]).read, NOW);
    expect(scan).toEqual({ rows: [], recordsRead: 0, truncated: false, windowMs: REPEATS_WINDOW_MS, statementsOff: false });
  });

  test("records older than the window are left out", async () => {
    const scan = await scanRepeats(tenant(), REPEATS_WINDOW_MS, reader(request(9, 14, NOW - REPEATS_WINDOW_MS - 60_000)).read, NOW);
    expect(scan.rows).toEqual([]);
  });

  test("called twice, Loki is read once", async () => {
    const t = tenant();
    const { read, calls } = reader(request(10, 14, NOW - 1000));
    const a = await scanRepeats(t, REPEATS_WINDOW_MS, read, NOW);
    const b = await scanRepeats(t, REPEATS_WINDOW_MS, read, NOW);
    expect(calls).toHaveLength(1);
    expect(b).toBe(a);
  });
});
