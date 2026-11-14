import { describe, expect, test } from "bun:test";
import { inboundEndQuery, isFailedRow, rowsFromRecords } from "./requests.server";
import { HealthChecks, LOGQL_NOT_HEALTH_OR_MONITOR } from "./health";
import { parseHopRecord } from "./parse";
import type { HopRecord } from "./types";

const T = "6503f5f183b828139d5b143365ad72fa";

function rec(line: string, ts = 1_700_000_000_000, service = "commerce-api"): HopRecord {
  const r = parseHopRecord({ ts, line, labels: { service } });
  if (!r) throw new Error(`not a hop record: ${line}`);
  return r;
}

describe("inboundEndQuery", () => {
  test("all services", () => {
    expect(inboundEndQuery(null, HealthChecks.Shown)).toBe('{kind="hop"} |= "in_end" |~ "via\\\\W{1,6}http"');
  });
  test("one service, quoted", () => {
    expect(inboundEndQuery('a"b', HealthChecks.Shown)).toBe('{kind="hop",service="a\\"b"} |= "in_end" |~ "via\\\\W{1,6}http"');
  });
  test("one route: a quoted line filter after the via filter (BAC-75)", () => {
    expect(inboundEndQuery("shop-api", HealthChecks.Shown, false, "/orders/:id"))
      .toBe('{kind="hop",service="shop-api"} |= "in_end" |~ "via\\\\W{1,6}http" |= "/orders/:id"');
  });
  test("the route filter is escaped", () => {
    expect(inboundEndQuery(null, HealthChecks.Shown, false, '/a"b\\c')).toBe('{kind="hop"} |= "in_end" |~ "via\\\\W{1,6}http" |= "/a\\"b\\\\c"');
  });
  test("no route, no filter", () => {
    expect(inboundEndQuery(null, HealthChecks.Shown, false, null)).toBe(inboundEndQuery(null, HealthChecks.Shown));
  });
});

describe("line filters over stored envelopes", () => {
  test("via=http matches in plain text, JSON and pino JSON inside the stored envelope", () => {
    const body = inboundEndQuery(null, HealthChecks.Shown).split('|~ "')[1].slice(0, -1);
    const re = new RegExp(body.replace(/\\(.)/g, "$1"));
    expect(re.test("hop=in_end via=http")).toBe(true);
    expect(re.test('{"hop":"in_end","via":"http"}')).toBe(true);
    expect(re.test(JSON.stringify({ message: JSON.stringify({ hop: "in_end", via: "http" }) }))).toBe(true);
  });
});

describe("health checks", () => {
  const HC = `trace_id=${T} hop=in_end hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=fastify via=http method=GET op=/healthz outcome=ok status=200 duration_us=900`;
  const ORDER = `trace_id=${T} hop=in_end hop_id=2f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=fastify via=http method=GET op=/health/db outcome=ok status=200 duration_us=900`;
  test("left out of the query and the rows by default", () => {
    expect(inboundEndQuery(null)).toBe(`{kind="hop"} |= "in_end" |~ "via\\\\W{1,6}http" ${LOGQL_NOT_HEALTH_OR_MONITOR}`);
    expect(rowsFromRecords([rec(HC), rec(ORDER)]).map((r) => r.route)).toEqual(["/health/db"]);
  });
  test("brought back when shown", () => {
    expect(rowsFromRecords([rec(HC), rec(ORDER)], HealthChecks.Shown).map((r) => r.route)).toEqual(["/healthz", "/health/db"]);
  });
  test("failed rows: outcome error or 5xx", () => {
    const base = { traceID: T, service: "s", method: "GET", route: "/x", path: null, durationMs: 1, startMs: 0 };
    expect(isFailedRow({ ...base, status: 503, error: false })).toBe(true);
    expect(isFailedRow({ ...base, status: null, error: true })).toBe(true);
    expect(isFailedRow({ ...base, status: 404, error: false })).toBe(false);
    expect(inboundEndQuery(null, HealthChecks.Hidden, true)).toContain('|~ "outcome');
  });
});

describe("rowsFromRecords", () => {
  test("an inbound HTTP end record becomes a row starting duration earlier", () => {
    const rows = rowsFromRecords([
      rec(`trace_id=${T} hop=in_end hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=commerce-api adapter=plug via=http method=POST op=/orders outcome=ok status=201 duration_us=61240`),
    ]);
    expect(rows).toEqual([
      { traceID: T, service: "commerce-api", method: "POST", route: "/orders", path: null, host: null, synthetic: false, status: 201, durationMs: 61.24, startMs: 1_700_000_000_000 - 61.24, error: false, totals: null },
    ]);
  });
  test("the actual path rides along; the route stays the template (BAC-52)", () => {
    const [row] = rowsFromRecords([
      rec(`trace_id=${T} hop=in_end hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=fastify via=http method=GET op=/v1/payments/:id path=/v1/payments/pay_8Kx2 outcome=ok status=200 duration_us=900`),
    ]);
    expect(row.route).toBe("/v1/payments/:id");
    expect(row.path).toBe("/v1/payments/pay_8Kx2");
  });
  test("start records, outbound, jobs and data-store hops are not rows", () => {
    const rows = rowsFromRecords([
      rec(`trace_id=${T} hop=in hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=plug via=http method=POST op=/orders`),
      rec(`trace_id=${T} hop=out_end hop_id=83c2d1907ae45b16 parent_hop=1f0a6c2e9b7d4405 hop_sent=true parent_id=b7ad6b7169203331 adapter=finch via=http method=POST peer=payments.internal outcome=ok status=201 duration_us=15310`),
      rec(`trace_id=${T} hop=in_end hop_id=2f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=oban via=job op=Mailer outcome=ok duration_us=100`),
      rec(`trace_id=${T} hop=out_end hop_id=3f0a6c2e9b7d4405 parent_hop=1f0a6c2e9b7d4405 hop_sent=false parent_id=b7ad6b7169203331 adapter=ecto via=db op=select peer=db outcome=ok duration_us=900`),
    ]);
    expect(rows).toEqual([]);
  });
  test("store totals from the end record ride along (BAC-67)", () => {
    const [row] = rowsFromRecords([
      rec(`trace_id=${T} hop=in_end hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=plug via=http method=GET op=/shop outcome=ok status=200 duration_us=90000 db_n=22 db_us=61000 cache_n=3 cache_us=900`),
    ]);
    expect(row.totals).toEqual({ dbCalls: 22, dbUs: 61000, cacheCalls: 3, cacheUs: 900, cacheHits: null, cacheMisses: null, dbWaitUs: null });
  });
  test("a failed request keeps its error flag and a missing status", () => {
    const [row] = rowsFromRecords([
      rec(`trace_id=${T} hop=in_end hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=plug via=http method=POST op=/payouts/:id/release outcome=error error=Timeout duration_us=30000000`),
    ]);
    expect(row.error).toBe(true);
    expect(row.status).toBeNull();
    expect(row.durationMs).toBe(30000);
  });
});

describe("monitors (BAC-80)", () => {
  const line = (id: string, extra: string) => `trace_id=${T} hop=in_end hop_id=${id} parent_id=b7ad6b7169203331 service=shop-api adapter=hono via=http method=GET op=/cart ${extra} outcome=ok status=200 duration_us=900`;
  const MONITOR = line("1f0a6c2e9b7d4406", "host=binary.fleeksite.com synthetic=1");
  const SHOPPER = line("2f0a6c2e9b7d4406", "host=shop.example.com");
  const OLD = line("3f0a6c2e9b7d4406", "");
  test("left out by default; the shopper and the old record stay, with and without a domain", () => {
    const rows = rowsFromRecords([rec(MONITOR), rec(SHOPPER), rec(OLD)]);
    expect(rows.map((r) => [r.host, r.synthetic])).toEqual([["shop.example.com", false], [null, false]]);
  });
  test("shown with the toggle, marked", () => {
    const rows = rowsFromRecords([rec(MONITOR), rec(SHOPPER)], HealthChecks.Shown);
    expect(rows.map((r) => [r.host, r.synthetic])).toEqual([["binary.fleeksite.com", true], ["shop.example.com", false]]);
  });
  test("the query narrows by both filters only when hidden", () => {
    expect(inboundEndQuery(null)).toContain("synthetic");
    expect(inboundEndQuery(null, HealthChecks.Shown)).not.toContain("synthetic");
  });
});
