import { describe, expect, test } from "bun:test";
import { inboundEndQuery, mergeRows, rowsFromRecords, RowSource, type RequestListRow } from "./requests.server";
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
    expect(inboundEndQuery(null)).toBe('{kind="hop"} |= "in_end" |~ "via\\\\W{1,4}http"');
  });
  test("one service, quoted", () => {
    expect(inboundEndQuery('a"b')).toBe('{kind="hop",service="a\\"b"} |= "in_end" |~ "via\\\\W{1,4}http"');
  });
});

describe("rowsFromRecords", () => {
  test("an inbound HTTP end record becomes a row starting duration earlier", () => {
    const rows = rowsFromRecords([
      rec(`trace_id=${T} hop=in_end hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=commerce-api adapter=plug via=http method=POST op=/orders outcome=ok status=201 duration_us=61240`),
    ]);
    expect(rows).toEqual([
      { traceID: T, service: "commerce-api", method: "POST", route: "/orders", status: 201, durationMs: 61.24, startMs: 1_700_000_000_000 - 61.24, error: false, source: RowSource.Hop },
    ]);
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
  test("a failed request keeps its error flag and a missing status", () => {
    const [row] = rowsFromRecords([
      rec(`trace_id=${T} hop=in_end hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=plug via=http method=POST op=/payouts/:id/release outcome=error error=Timeout duration_us=30000000`),
    ]);
    expect(row.error).toBe(true);
    expect(row.status).toBeNull();
    expect(row.durationMs).toBe(30000);
  });
});

describe("mergeRows", () => {
  const row = (traceID: string, service: string, startMs: number, source: RowSource): RequestListRow => ({
    traceID, service, startMs, source, method: "GET", route: "/", status: 200, durationMs: 1, error: false,
  });
  test("newest first, span rows dropped where a hop row covers the same trace and service", () => {
    const merged = mergeRows(
      [row("t1", "api", 10, RowSource.Hop), row("t1", "pay", 12, RowSource.Hop)],
      [row("t1", "api", 9, RowSource.Span), row("t2", "api", 11, RowSource.Span), row("t1", "risk", 13, RowSource.Span)]
    );
    expect(merged.map((r) => `${r.traceID}/${r.service}/${r.source}`)).toEqual(["t1/risk/span", "t1/pay/hop", "t2/api/span", "t1/api/hop"]);
  });
  test("empty inputs", () => {
    expect(mergeRows([], [])).toEqual([]);
  });
});
