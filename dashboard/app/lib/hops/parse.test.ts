import { describe, expect, test } from "bun:test";
import { MAX_RECORD_LINE, parseHopRecord, parseLinkLine, stripAnsi, toTraceLogLine, traceIdOfLine, type RawLogEntry } from "./parse";

const T = "6503f5f183b828139d5b143365ad72fa";
const entry = (line: string, labels: Record<string, string> = { service: "commerce-api" }, ts = 1_700_000_000_000): RawLogEntry => ({ ts, line, labels });

// The spec's own example lines (13.1).
const IN = `trace_id=${T} hop=in hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=commerce-api adapter=plug via=http method=POST op=/orders`;
const OUT = `trace_id=${T} hop=out hop_id=83c2d1907ae45b16 parent_hop=1f0a6c2e9b7d4405 hop_sent=true parent_id=b7ad6b7169203331 service=commerce-api adapter=finch via=http method=POST peer=payments.internal`;
const IN_END = `trace_id=${T} hop=in_end hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=commerce-api adapter=plug via=http method=POST op=/orders outcome=ok status=201 duration_us=61240 db_n=1 db_us=3800 f_order_id=7731`;

describe("parseHopRecord: key=value form", () => {
  test("reads the spec's start record", () => {
    const r = parseHopRecord(entry(IN));
    expect(r).toMatchObject({
      traceId: T, hop: "in", hopId: "1f0a6c2e9b7d4405", parentHop: null, hopSent: null, parentId: "b7ad6b7169203331",
      service: "commerce-api", adapter: "plug", via: "http", method: "POST", op: "/orders", peer: null, outcome: null, durationUs: null,
    });
  });
  test("reads an outbound record with hop_sent and peer", () => {
    const r = parseHopRecord(entry(OUT));
    expect(r).toMatchObject({ hop: "out", parentHop: "1f0a6c2e9b7d4405", hopSent: true, tracer: false, peer: "payments.internal" });
  });
  test("reads an end record with totals and named fields", () => {
    const r = parseHopRecord(entry(IN_END));
    expect(r).toMatchObject({ hop: "in_end", outcome: "ok", status: 201, durationUs: 61240, totals: { dbCalls: 1, dbUs: 3800, cacheCalls: 0, cacheUs: 0 }, fields: [{ name: "order_id", value: "7731" }] });
  });
  test("a timestamp and level in front are skipped", () => {
    expect(parseHopRecord(entry(`10:01:03.120 [info] ${IN}`))?.hopId).toBe("1f0a6c2e9b7d4405");
  });
  test("the record's own service field wins over the collector's label; the label is the source", () => {
    const r = parseHopRecord(entry(IN, { service: "commerce-api-staging" }));
    expect(r?.service).toBe("commerce-api");
    expect(r?.source).toBe("commerce-api-staging");
    expect(parseHopRecord(entry(IN, { service: "commerce-api", source: "commerce-api-staging" }))?.source).toBe("commerce-api-staging");
    expect(parseHopRecord(entry(IN, {}))?.service).toBe("commerce-api");
    expect(parseHopRecord(entry(IN, {}))?.source).toBeNull();
  });
  test("source from the stored JSON line when the label is missing (agents installed earlier)", () => {
    const stored = JSON.stringify({ message: IN, service: "commerce-api", source: "commerce-api-staging", kind: "hop" });
    expect(parseHopRecord(entry(stored, { service: "commerce-api" }))?.source).toBe("commerce-api-staging");
  });
  test("without a valid service field the collector's label names the service", () => {
    const noField = IN.replace(" service=commerce-api", "");
    expect(parseHopRecord(entry(noField, { service: "api-container" }))?.service).toBe("api-container");
    expect(parseHopRecord(entry(noField, {}))?.service).toBe("unknown");
  });
});

describe("parseHopRecord: JSON form", () => {
  const fields = { trace_id: T, hop: "out_end", hop_id: "aaaaaaaaaaaaaaaa", parent_hop: "1f0a6c2e9b7d4405", hop_sent: false, parent_id: "b7ad6b7169203331", service: "commerce-payments", adapter: "postgres", via: "db", op: "select", peer: "payments-db", outcome: "ok", duration_us: 1200 };
  test("top-level fields (pino style)", () => {
    const r = parseHopRecord(entry(JSON.stringify({ level: 30, time: 1, msg: "hop", ...fields })));
    expect(r).toMatchObject({ hop: "out_end", via: "db", hopSent: false, durationUs: 1200, peer: "payments-db", op: "select" });
  });
  for (const key of ["metadata", "fields", "data", "context", "attributes"]) {
    test(`fields one level down under ${key}`, () => {
      expect(parseHopRecord(entry(JSON.stringify({ message: "hop", [key]: fields })))?.hopId).toBe("aaaaaaaaaaaaaaaa");
    });
  }
  test("fields two levels down are not read", () => {
    expect(parseHopRecord(entry(JSON.stringify({ message: "hop", metadata: { inner: fields } })))).toBeNull();
  });
  test("an envelope whose message is the record", () => {
    expect(parseHopRecord(entry(JSON.stringify({ log: IN, stream: "stdout" })))?.hopId).toBe("1f0a6c2e9b7d4405");
  });
  test("numbers given as strings are read; a status as a number is read", () => {
    const r = parseHopRecord(entry(JSON.stringify({ ...fields, hop: "in_end", via: "http", duration_us: "61240", status: 201 })));
    expect(r).toMatchObject({ durationUs: 61240, status: 201 });
  });
});

describe("parseHopRecord: malformed and oversized", () => {
  const bad: Array<[string, string]> = [
    ["ordinary line", `order received trace_id=${T}`],
    ["uppercase trace ID", IN.replace(T, T.toUpperCase())],
    ["short trace ID", IN.replace(T, T.slice(1))],
    ["all-zero trace ID", IN.replace(T, "0".repeat(32))],
    ["bad hop kind", IN.replace("hop=in ", "hop=inbound ")],
    ["bad hop ID", IN.replace("hop_id=1f0a6c2e9b7d4405", "hop_id=1f0a6c2e9b7d440")],
    ["bad parent hop", OUT.replace("parent_hop=1f0a6c2e9b7d4405", "parent_hop=xyz")],
    ["unknown via", IN.replace("via=http", "via=carrier-pigeon")],
    ["missing via", IN.replace(" via=http", "")],
    ["bad outcome", IN_END.replace("outcome=ok", "outcome=maybe")],
    ["not JSON, not kv", "{{{{"],
    ["empty", ""],
  ];
  for (const [name, line] of bad) test(name, () => expect(parseHopRecord(entry(line))).toBeNull());

  test("an oversized line is never a record", () => {
    expect(parseHopRecord(entry(`${IN} pad=${"x".repeat(MAX_RECORD_LINE)}`))).toBeNull();
  });
  test("an oversized value is left out, not the record (HOP-12)", () => {
    const r = parseHopRecord(entry(IN.replace("op=/orders", `op=/${"a".repeat(250)}`)));
    expect(r?.op).toBeNull();
    expect(r?.hopId).toBe("1f0a6c2e9b7d4405");
  });
  test("bad numbers are left out", () => {
    const r = parseHopRecord(entry(IN_END.replace("status=201", "status=2x1").replace("duration_us=61240", "duration_us=-5")));
    expect(r).toMatchObject({ status: null, durationUs: null });
  });
  test("at most 8 named fields; bad names skipped", () => {
    const extra = Array.from({ length: 10 }, (_, i) => `f_k${i}=v${i}`).join(" ");
    const r = parseHopRecord(entry(`${IN_END} f_Bad=1 ${extra}`));
    expect(r?.fields.length).toBe(8);
    expect(r?.fields.some((f) => f.name === "Bad")).toBe(false);
  });
  test("totals and fields are only read from inbound end records", () => {
    const r = parseHopRecord(entry(`${OUT.replace("hop=out", "hop=out_end")} outcome=ok duration_us=5 db_n=3 f_x=1`));
    expect(r).toMatchObject({ totals: null, fields: [] });
  });
});

describe("parseLinkLine", () => {
  test("key=value link line with hop ID", () => {
    expect(parseLinkLine(entry(`trace_id=${T} link_name=order_id link_value=7731 hop_id=1f0a6c2e9b7d4405`))).toMatchObject({ name: "order_id", value: "7731", hopId: "1f0a6c2e9b7d4405" });
  });
  test("JSON link line without hop ID", () => {
    expect(parseLinkLine(entry(JSON.stringify({ msg: "link", trace_id: T, link_name: "acquirer.ref-1", link_value: "A91K20" })))).toMatchObject({ name: "acquirer.ref-1", hopId: null });
  });
  test("rejects bad names, values and hop IDs", () => {
    expect(parseLinkLine(entry(`trace_id=${T} link_name=Order link_value=7731`))).toBeNull();
    expect(parseLinkLine(entry(`trace_id=${T} link_name=${"a".repeat(65)} link_value=7731`))).toBeNull();
    expect(parseLinkLine(entry(JSON.stringify({ trace_id: T, link_name: "order_id", link_value: "77 31" })))).toBeNull();
    expect(parseLinkLine(entry(`trace_id=${T} link_name=order_id link_value=7731 hop_id=nothex`))).toBeNull();
    expect(parseLinkLine(entry(`link_name=order_id link_value=7731`))).toBeNull();
  });
});

describe("handoff (HOP-23)", () => {
  const T2 = "6503f5f183b828139d5b143365ad72fa";
  const line = (extra: string) => `trace_id=${T2} hop=out_end hop_id=83c2d1907ae45b16 parent_hop=1f0a6c2e9b7d4405 hop_sent=false${extra} parent_id=b7ad6b7169203331 service=commerce-api adapter=redix via=cache op=set peer=redis.internal outcome=ok duration_us=1200`;
  test("handoff=true on an outbound record is read", () => {
    expect(parseHopRecord(entry(line(" handoff=true")))?.handoff).toBe(true);
  });
  test("absent or anything else is false", () => {
    expect(parseHopRecord(entry(line("")))?.handoff).toBe(false);
    expect(parseHopRecord(entry(line(" handoff=yes")))?.handoff).toBe(false);
  });
});

describe("traceIdOfLine and toTraceLogLine", () => {
  test("finds the trace ID in JSON and key=value lines", () => {
    expect(traceIdOfLine(JSON.stringify({ msg: "charge stored", trace_id: T }))).toBe(T);
    expect(traceIdOfLine(`[info] charge stored trace_id=${T}`)).toBe(T);
    expect(traceIdOfLine("GET /health 200 0.4ms")).toBeNull();
    expect(traceIdOfLine(`trace_id=${T.toUpperCase()}`)).toBeNull();
  });
  test("reads level and message from JSON; pino numbers map to names", () => {
    expect(toTraceLogLine(entry(JSON.stringify({ level: 40, msg: "bank gateway slow", trace_id: T })))).toMatchObject({ level: "warn", line: "bank gateway slow", service: "commerce-api" });
    expect(toTraceLogLine(entry("plain text", { service: "x", level: "error" }))).toMatchObject({ level: "error", line: "plain text" });
  });
  test("removes terminal colour codes, as Nest's built-in logger writes them", () => {
    const nest = `\u001b[33m[Nest] 1  - \u001b[39m11/12/2026, 1:30:01 PM \u001b[33m   WARN\u001b[39m \u001b[38;5;3m[BankSyncService] \u001b[39m\u001b[33mbank sync: HTTP 404\u001b[39m trace_id=${T}`;
    expect(toTraceLogLine(entry(JSON.stringify({ message: nest, kind: "log", service: "x" }))).line).toBe(`[Nest] 1  - 11/12/2026, 1:30:01 PM    WARN [BankSyncService] bank sync: HTTP 404 trace_id=${T}`);
    expect(stripAnsi("no codes here")).toBe("no codes here");
    expect(stripAnsi("\u001b[0m")).toBe("");
  });
  test("unwraps a collector envelope whose message is the service's JSON line", () => {
    const inner = JSON.stringify({ level: 50, msg: "bank gateway returned 502", trace_id: T });
    expect(toTraceLogLine(entry(JSON.stringify({ message: inner, kind: "log", service: "x" })))).toMatchObject({ level: "error", line: "bank gateway returned 502" });
  });
  test("reads hop records inside a collector envelope", () => {
    expect(parseHopRecord(entry(JSON.stringify({ message: IN, kind: "hop" })))?.hopId).toBe("1f0a6c2e9b7d4405");
  });
});

describe("host and synthetic (spec 0.13, HOP-27 and HOP-28)", () => {
  const T = "6503f5f183b828139d5b143365ad72fa";
  const at = (line: string): RawLogEntry => ({ ts: 1_700_000_000_000, line, labels: { service: "shop-api" } });
  test("key=value: host lower case, synthetic as a boolean", () => {
    const r = parseHopRecord(at(`trace_id=${T} hop=in_end hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=shop-api adapter=hono via=http method=GET op=/cart path=/cart host=binary.fleeksite.com synthetic=1 outcome=ok status=200 duration_us=900`));
    expect(r?.host).toBe("binary.fleeksite.com");
    expect(r?.synthetic).toBe(true);
  });
  test("JSON: number and string forms, nested under metadata, inside the stored envelope", () => {
    const rec = { trace_id: T, hop: "in", hop_id: "1f0a6c2e9b7d4405", parent_id: "b7ad6b7169203331", adapter: "plug", via: "http", op: "/api/v1/public/m/:merchant_username/products", host: "Dev.Inkress.com", synthetic: 1 };
    const top = parseHopRecord(at(JSON.stringify(rec)));
    expect(top?.host).toBe("dev.inkress.com");
    expect(top?.synthetic).toBe(true);
    expect(parseHopRecord(at(JSON.stringify({ ...rec, synthetic: "1" })))?.synthetic).toBe(true);
    expect(parseHopRecord(at(JSON.stringify({ msg: "hop", metadata: rec })))?.synthetic).toBe(true);
    const stored = parseHopRecord(at(JSON.stringify({ message: JSON.stringify(rec) })));
    expect(stored?.host).toBe("dev.inkress.com");
    expect(stored?.synthetic).toBe(true);
  });
  test("a port left on is dropped, a trailing dot too; IPv6 keeps its colons", () => {
    const line = (h: string) => `trace_id=${T} hop=in hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=hono via=http op=/ host=${h}`;
    expect(parseHopRecord(at(line("binary.fleeksite.com:3000")))?.host).toBe("binary.fleeksite.com");
    expect(parseHopRecord(at(line("binary.fleeksite.com.")))?.host).toBe("binary.fleeksite.com");
    expect(parseHopRecord(at(line("[::1]")))?.host).toBe("[::1]");
  });
  test("old records: no host, not synthetic; other values are not synthetic", () => {
    const base = `trace_id=${T} hop=in_end hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=plug via=http op=/orders outcome=ok status=201 duration_us=900`;
    const old = parseHopRecord(at(base));
    expect(old?.host).toBeNull();
    expect(old?.synthetic).toBe(false);
    expect(parseHopRecord(at(`${base} synthetic=0`))?.synthetic).toBe(false);
    expect(parseHopRecord(at(`${base} synthetic=yes`))?.synthetic).toBe(false);
  });
  test("outbound records never carry either (peer names the other side)", () => {
    const r = parseHopRecord(at(`trace_id=${T} hop=out hop_id=1f0a6c2e9b7d4405 parent_hop=2f0a6c2e9b7d4405 hop_sent=true parent_id=b7ad6b7169203331 adapter=finch via=http method=GET peer=api.internal host=x.example synthetic=1`));
    expect(r?.host).toBeNull();
    expect(r?.synthetic).toBe(false);
  });
  test("a logger's or collector's own host beside the record is never the request's host", () => {
    const rec = { trace_id: T, hop: "in", hop_id: "1f0a6c2e9b7d4405", parent_id: "b7ad6b7169203331", adapter: "plug", via: "http", op: "/orders" };
    expect(parseHopRecord(at(JSON.stringify({ host: "web-1", msg: "hop", metadata: rec })))?.host).toBeNull();
    expect(parseHopRecord(at(JSON.stringify({ host: "web-1", msg: "hop", metadata: { ...rec, host: "shop.example.com" } })))?.host).toBe("shop.example.com");
    // The collector's stored envelope (Vector adds the container's host name at the top).
    expect(parseHopRecord(at(JSON.stringify({ host: "06872f263378", kind: "hop", message: JSON.stringify(rec) })))?.host).toBeNull();
    expect(parseHopRecord(at(JSON.stringify({ host: "06872f263378", kind: "hop", message: `trace_id=${T} hop=in hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=hono via=http op=/ host=shop.example.com` })))?.host).toBe("shop.example.com");
  });
  test("an over-long host is left out", () => {
    const r = parseHopRecord(at(`trace_id=${T} hop=in hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 adapter=hono via=http op=/ host=${"a".repeat(201)}`));
    expect(r?.host).toBeNull();
  });
});
