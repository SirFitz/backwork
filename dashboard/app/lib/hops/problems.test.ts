import { describe, expect, test } from "bun:test";
import { buildRequestTree } from "./tree";
import { parseHopRecord } from "./parse";
import { failedCallsSentence, requestProblems, retriedSentence } from "./problems";
import type { HopRecord } from "./types";

const T = "21af0c5f183b828139d5b143365ad72f";
const NOW = 1_800_000_000_000;
let n = 0;
const id = (): string => (++n).toString(16).padStart(16, "0");
const rec = (line: string, ts: number, service: string): HopRecord => {
  const r = parseHopRecord({ ts, line, labels: { service } });
  if (!r) throw new Error(line);
  return r;
};

/** A commerce-worker job calling commerce-payments `calls` times, `failed` of them answered 500. */
function workerJob(calls: number, failed: number): HopRecord[] {
  const job = id();
  const out: HopRecord[] = [
    rec(`trace_id=${T} hop=in hop_id=${job} parent_id=b7ad6b7169203331 service=commerce-worker adapter=oban via=job op=Settle`, NOW, "commerce-worker"),
  ];
  for (let i = 0; i < calls; i++) {
    const call = id();
    const recv = id();
    const status = i < failed ? 500 : 200;
    out.push(rec(`trace_id=${T} hop=out hop_id=${call} parent_hop=${job} hop_sent=true parent_id=b7ad6b7169203331 service=commerce-worker adapter=finch via=http method=POST peer=payments.internal`, NOW + i * 10, "commerce-worker"));
    out.push(rec(`trace_id=${T} hop=in hop_id=${recv} parent_hop=${call} parent_id=b7ad6b7169203331 service=commerce-payments adapter=hono via=http method=POST op=/charges`, NOW + i * 10 + 1, "commerce-payments"));
    out.push(rec(`trace_id=${T} hop=in_end hop_id=${recv} parent_hop=${call} parent_id=b7ad6b7169203331 service=commerce-payments adapter=hono via=http method=POST op=/charges outcome=ok status=${status} duration_us=4000`, NOW + i * 10 + 5, "commerce-payments"));
    out.push(rec(`trace_id=${T} hop=out_end hop_id=${call} parent_hop=${job} hop_sent=true parent_id=b7ad6b7169203331 service=commerce-worker adapter=finch via=http method=POST peer=payments.internal outcome=ok status=${status} duration_us=5000`, NOW + i * 10 + 6, "commerce-worker"));
  }
  out.push(rec(`trace_id=${T} hop=in_end hop_id=${job} parent_id=b7ad6b7169203331 service=commerce-worker adapter=oban via=job op=Settle outcome=ok duration_us=950000`, NOW + 950, "commerce-worker"));
  return out;
}

describe("requestProblems (frame 3 lead, BAC-41 row 4)", () => {
  test("63 of 90 calls answered 500, named by the service that answered", () => {
    const p = requestProblems(buildRequestTree(workerJob(90, 63), [], NOW + 2000));
    expect(p.failedCalls).toEqual([{ destination: "commerce-payments", failed: 63, total: 90, statuses: [500], withoutStatus: 0 }]);
    expect(failedCallsSentence(p.failedCalls[0])).toBe("63 of 90 calls to commerce-payments were answered with an error (500).");
  });
  test("a healthy request has nothing to say", () => {
    const p = requestProblems(buildRequestTree(workerJob(3, 0), [], NOW + 2000));
    expect(p.failedCalls).toEqual([]);
    expect(p.retried).toBeNull();
  });
  test("a single failed call, and calls that failed without an answer", () => {
    expect(failedCallsSentence({ destination: "bank-gw.internal", failed: 1, total: 1, statuses: [502], withoutStatus: 0 })).toBe("The call to bank-gw.internal was answered with an error (502).");
    expect(failedCallsSentence({ destination: "bank-gw.internal", failed: 2, total: 5, statuses: [], withoutStatus: 2 })).toBe("2 of 5 calls to bank-gw.internal failed without an answer.");
  });
  test("jobs retried: inbound job hops above attempt 1, once per job", () => {
    const parent = id();
    const job = id();
    const lines: HopRecord[] = [
      rec(`trace_id=${T} hop=in hop_id=${parent} parent_id=b7ad6b7169203331 service=commerce-api adapter=plug via=http method=POST op=/orders`, NOW, "commerce-api"),
      rec(`trace_id=${T} hop=out hop_id=${job} parent_hop=${parent} hop_sent=true parent_id=b7ad6b7169203331 service=commerce-api adapter=oban via=job op=Mail peer=mailers`, NOW + 1, "commerce-api"),
    ];
    for (const attempt of [1, 2, 3]) {
      const h = id();
      lines.push(rec(`trace_id=${T} hop=in hop_id=${h} parent_hop=${job} parent_id=b7ad6b7169203331 service=commerce-worker adapter=oban via=job op=Mail attempt=${attempt}`, NOW + attempt * 100, "commerce-worker"));
      lines.push(rec(`trace_id=${T} hop=in_end hop_id=${h} parent_hop=${job} parent_id=b7ad6b7169203331 service=commerce-worker adapter=oban via=job op=Mail attempt=${attempt} outcome=${attempt < 3 ? "error" : "ok"} error=Timeout duration_us=1000`, NOW + attempt * 100 + 5, "commerce-worker"));
    }
    const p = requestProblems(buildRequestTree(lines, [], NOW + 2000));
    expect(p.retried).toEqual({ jobs: 1, retries: 2 });
    expect(retriedSentence(p.retried!)).toBe("A job it queued failed and was retried (2 retries).");
    expect(retriedSentence({ jobs: 3, retries: 3 })).toBe("3 jobs it queued failed and were retried.");
  });
});
