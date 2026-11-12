import { COUNTER_LOOKBACK_SECONDS, windowIncrease } from "./counter-window";
import { describe, expect, test } from "bun:test";
import {
  ATTENTION_WINDOW_MS,
  INBOUND_RECORDS_QUERY,
  JumpKind,
  LIST_LIMIT,
  OUTBOUND_CALLS_QUERY,
  RECORD_LIMIT,
  detectJumps,
  findStalled,
  findUnreceived,
  onlyKnownPeers,
  serviceJumps,
  stalledRequests,
  unreceivedCalls,
  windowQueries,
  type RecordQueryFn,
  type ServiceWindow,
  type UnreceivedCall,
} from "./attention.server";
import { parseHopRecord } from "./parse";
import type { HopRecord } from "./types";
import type { PromClient } from "./metrics.server";
import type { Tenant } from "~/lib/tenant.server";

const NOW = 1_800_000_000_000;
const T = "6503f5f183b828139d5b143365ad72fa";
let seq = 0;
function org(): Tenant {
  seq += 1;
  return { orgId: `org-attn-${seq}`, platform: false };
}
function rec(line: string, ts: number, service = "commerce-api"): HopRecord {
  const r = parseHopRecord({ ts, line, labels: { service } });
  if (!r) throw new Error(`not a hop record: ${line}`);
  return r;
}
const w = (service: string, requests: number, failed: number, p95: number | null): ServiceWindow => ({ service, requests, failed, p95 });

describe("detectJumps", () => {
  test("error share jump against the baseline", () => {
    const j = detectJumps([w("api", 100, 12, 0.2)], [w("api", 1000, 10, 0.2)]);
    expect(j).toEqual([{ service: "api", kind: JumpKind.Errors, requests: 100, now: 0.12, before: 0.01 }]);
  });
  test("p95 jump needs 1.5x and 100 ms", () => {
    expect(detectJumps([w("api", 50, 0, 0.9)], [w("api", 500, 0, 0.3)]).map((x) => x.kind)).toEqual([JumpKind.Latency]);
    // 2x but only 40 ms slower: not a jump
    expect(detectJumps([w("api", 50, 0, 0.08)], [w("api", 500, 0, 0.04)])).toEqual([]);
    // 90 ms slower but 1.1x: not a jump
    expect(detectJumps([w("api", 50, 0, 0.99)], [w("api", 500, 0, 0.9)])).toEqual([]);
  });
  test("steady high error rate is not a jump", () => {
    expect(detectJumps([w("api", 100, 30, 0.2)], [w("api", 1000, 290, 0.2)])).toEqual([]);
  });
  test("too few requests never count", () => {
    expect(detectJumps([w("api", 9, 9, 5)], [w("api", 1000, 0, 0.1)])).toEqual([]);
  });
  test("a new service counts only from a 20% error share", () => {
    expect(detectJumps([w("new", 20, 3, 1)], [])).toEqual([]);
    expect(detectJumps([w("new", 20, 5, 1)], []).map((x) => x.before)).toEqual([null]);
  });
  test("worst first", () => {
    const j = detectJumps([w("a", 100, 10, null), w("b", 100, 50, null)], [w("a", 100, 0, null), w("b", 100, 0, null)]);
    expect(j.map((x) => x.service)).toEqual(["b", "a"]);
  });
});

describe("windowQueries", () => {
  test("current window and the 3 hours before it, without health checks", () => {
    const c = windowQueries(null);
    const sel = 'backwork_hop_duration_seconds_count{dir="in",op!~"(?i)/(?:healthz|health|ready|live|livez|readyz|ping)"}';
    expect(c.requests).toBe(windowIncrease(sel, "15m", ["service"]));
    // The baseline: 3 hours ending where the current window starts.
    expect(windowQueries("15m").requests).toBe(windowIncrease(sel, "3h", ["service"], "15m"));
    expect(windowQueries("15m").p95).toContain(`[${10800 + COUNTER_LOOKBACK_SECONDS}s] offset 900s`);
  });
  test("serviceJumps joins both windows", async () => {
    const client: PromClient = {
      async instant(q) {
        // Only the baseline's whole-window term ends 15 minutes back.
        const base = /\] offset 900s\)\) -/.test(q);
        if (q.startsWith("histogram_quantile")) return [{ metric: { service: "api" }, value: base ? 0.2 : 0.8 }];
        if (q.includes('outcome="error"')) return [];
        if (q.includes("5xx")) return [];
        return [{ metric: { service: "api" }, value: base ? 1000 : 60 }];
      },
      async range() {
        return [];
      },
    };
    const j = await serviceJumps(org(), client);
    expect(j).toEqual([{ service: "api", kind: JumpKind.Latency, requests: 60, now: 0.8, before: 0.2 }]);
  });
});

const IN = (id: string, op = "/charges", parent = "") =>
  `trace_id=${T} hop=in hop_id=${id}${parent ? ` parent_hop=${parent}` : ""} parent_id=b7ad6b7169203331 adapter=plug via=http method=POST op=${op}`;
const IN_END = (id: string) =>
  `trace_id=${T} hop=in_end hop_id=${id} parent_id=b7ad6b7169203331 adapter=plug via=http method=POST op=/charges outcome=ok status=201 duration_us=1000`;
const OUT_END = (id: string, sent = true, via = "http", extra = "outcome=ok status=200") =>
  `trace_id=${T} hop=out_end hop_id=${id} parent_hop=1f0a6c2e9b7d4405 hop_sent=${sent} parent_id=b7ad6b7169203331 adapter=finch via=${via} method=POST peer=payments.internal ${extra} duration_us=2000`;

describe("findStalled", () => {
  test("a start older than a minute with no end", () => {
    const rows = findStalled([rec(IN("1f0a6c2e9b7d4401"), NOW - 120_000)], NOW);
    expect(rows.map((r) => [r.service, r.op, r.startMs])).toEqual([["commerce-api", "/charges", NOW - 120_000]]);
  });
  test("finished, too young, outside the window or a health check: not stalled", () => {
    const rows = findStalled(
      [
        rec(IN("1f0a6c2e9b7d4401"), NOW - 120_000),
        rec(IN_END("1f0a6c2e9b7d4401"), NOW - 119_000),
        rec(IN("1f0a6c2e9b7d4402"), NOW - 30_000),
        rec(IN("1f0a6c2e9b7d4403"), NOW - ATTENTION_WINDOW_MS - 1),
        rec(IN("1f0a6c2e9b7d4404", "/healthz"), NOW - 120_000),
      ],
      NOW
    );
    expect(rows).toEqual([]);
  });
  test("exactly one minute old is stalled", () => {
    expect(findStalled([rec(IN("1f0a6c2e9b7d4401"), NOW - 60_000)], NOW).length).toBe(1);
  });
});

describe("findUnreceived", () => {
  const call = "83c2d1907ae45b16";
  test("a sent, finished call no service recorded", () => {
    const rows = findUnreceived([rec(OUT_END(call, true, "http", "outcome=error status=503"), NOW - 60_000)], [], NOW);
    expect(rows.map((r) => [r.peer, r.failed])).toEqual([["payments.internal", true]]);
  });
  test("received, not sent, a database call, still in its grace period: not listed", () => {
    const rows = findUnreceived(
      [
        rec(OUT_END(call), NOW - 60_000),
        rec(OUT_END("83c2d1907ae45b17", false), NOW - 60_000),
        rec(OUT_END("83c2d1907ae45b18", true, "db"), NOW - 60_000),
        rec(OUT_END("83c2d1907ae45b19"), NOW - 10_000),
      ],
      [rec(IN("2f0a6c2e9b7d4401", "/charges", call), NOW - 61_000, "commerce-payments")],
      NOW
    );
    expect(rows).toEqual([]);
  });
  test("a call older than the inbound records read is not judged", () => {
    expect(findUnreceived([rec(OUT_END(call), NOW - 600_000)], [], NOW, NOW - 300_000)).toEqual([]);
  });
});

describe("onlyKnownPeers", () => {
  const call = (peer: string | null): UnreceivedCall => ({ traceId: T as UnreceivedCall["traceId"], service: "s", peer, method: null, op: null, endMs: NOW, failed: false });
  test("only calls to peers some service answered as; all when unknown", () => {
    const calls = [call("payments.internal"), call("kms.amazonaws.com"), call(null)];
    expect(onlyKnownPeers(calls, new Set(["payments.internal"])).map((c) => c.peer)).toEqual(["payments.internal"]);
    expect(onlyKnownPeers(calls, null).length).toBe(3);
  });
});

describe("record reads", () => {
  test("queries narrow to inbound records without health checks, and outbound non-store calls", () => {
    expect(INBOUND_RECORDS_QUERY).toContain('{kind="hop"} |~ "\\\\bhop\\\\W{1,6}in(?:_end)?');
    expect(INBOUND_RECORDS_QUERY).toContain("healthz");
    expect(OUTBOUND_CALLS_QUERY).toContain("(?:db|cache)");
  });
  test("stalled and unreceived share one inbound read and limit the list", async () => {
    const seen: string[] = [];
    const lines = Array.from({ length: LIST_LIMIT + 3 }, (_, i) => ({ ts: NOW - 120_000 - i, line: IN(`1f0a6c2e9b7d44${(10 + i).toString(16).padStart(2, "0")}`), labels: { service: "commerce-api" }, level: "info", service: "commerce-api", message: "" }));
    const read: RecordQueryFn = async (q) => {
      seen.push(q);
      return q === INBOUND_RECORDS_QUERY ? lines : [];
    };
    const t = org();
    const s = await stalledRequests(t, NOW, read);
    expect(s.total).toBe(LIST_LIMIT + 3);
    expect(s.rows.length).toBe(LIST_LIMIT);
    expect(s.truncated).toBe(false);
    const u = await unreceivedCalls(t, NOW, read, { known: async () => new Set(), save: async () => {} });
    expect(u.rows).toEqual([]);
    expect(seen.filter((q) => q === INBOUND_RECORDS_QUERY).length).toBe(1);
    expect(RECORD_LIMIT).toBeGreaterThan(LIST_LIMIT);
  });
});
