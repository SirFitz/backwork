import { describe, expect, test } from "bun:test";
import { isStatement, isTableName, splitStatement } from "./stmt";
import { parseHopRecord, type RawLogEntry } from "./parse";

const T = "6503f5f183b828139d5b143365ad72fa";
const entry = (line: string): RawLogEntry => ({ ts: 1_700_000_000_000, line, labels: { service: "commerce-api" } });

// Spec draft 0.9, section 13.2, the example end record with the IDs filled in.
const SPEC = `trace_id=${T} hop=out_end hop_id=83c2d1907ae45b16 parent_hop=1f0a6c2e9b7d4405 hop_sent=false parent_id=b7ad6b7169203331 service=commerce-api adapter=ecto via=db op=select table=merchants peer=db.internal outcome=ok duration_us=15200 stmt=select ... from merchants as m0 where (m0.username = ?) limit ?`;

describe("splitStatement (spec HOP-14)", () => {
  test("everything after the first ' stmt=' is the statement, spaces included", () => {
    expect(splitStatement("a=1 b=2 stmt=select x from y where a = ?")).toEqual({ head: "a=1 b=2", stmt: "select x from y where a = ?" });
  });
  test("no stmt, and a leading stmt", () => {
    expect(splitStatement("a=1 b=2")).toEqual({ head: "a=1 b=2", stmt: null });
    expect(splitStatement("stmt=select ?")).toEqual({ head: "", stmt: "select ?" });
  });
  test("a key named like stmt inside another value is not a split point", () => {
    expect(splitStatement("op=xstmt=1 a=2").stmt).toBeNull();
  });
});

describe("bounds (STM-4, HOP-12)", () => {
  test("stmt: 1 to 300 bytes of 0x20..0x7E", () => {
    expect(isStatement("select ?")).toBe(true);
    expect(isStatement("x".repeat(300))).toBe(true);
    expect(isStatement("x".repeat(301))).toBe(false);
    expect(isStatement("")).toBe(false);
    expect(isStatement("select\t?")).toBe(false);
    expect(isStatement("select é")).toBe(false);
  });
  test("table: 1 to 200 bytes of 0x21..0x7E", () => {
    expect(isTableName("public.merchants")).toBe(true);
    expect(isTableName("a b")).toBe(false);
    expect(isTableName("x".repeat(201))).toBe(false);
  });
});

describe("parseHopRecord with statement fields", () => {
  test("the spec's example record", () => {
    const r = parseHopRecord(entry(SPEC));
    expect(r?.op).toBe("select");
    expect(r?.table).toBe("merchants");
    expect(r?.peer).toBe("db.internal");
    expect(r?.durationUs).toBe(15200);
    expect(r?.stmt).toBe("select ... from merchants as m0 where (m0.username = ?) limit ?");
  });
  test("key=value-looking text inside stmt stays inside stmt and never becomes a field", () => {
    const line = SPEC.replace(/stmt=.*$/, "stmt=update orders set status=? where a = ? and outcome=error and duration_us=? and peer=x");
    const r = parseHopRecord(entry(line));
    expect(r?.stmt).toBe("update orders set status=? where a = ? and outcome=error and duration_us=? and peer=x");
    expect(r?.outcome).toBe("ok");
    expect(r?.durationUs).toBe(15200);
    expect(r?.peer).toBe("db.internal");
  });
  test("a pino JSON line carries both as ordinary fields", () => {
    const line = JSON.stringify({ level: 30, time: 1, trace_id: T, hop: "out_end", hop_id: "83c2d1907ae45b16", parent_hop: "1f0a6c2e9b7d4405", hop_sent: false, parent_id: "b7ad6b7169203331", service: "commerce-payments", adapter: "pg", via: "db", op: "insert", table: "charges", peer: "payments-db", outcome: "ok", duration_us: 2300, stmt: "insert into charges (id, amount, status) values (?)", msg: "hop" });
    const r = parseHopRecord(entry(line));
    expect(r?.table).toBe("charges");
    expect(r?.stmt).toBe("insert into charges (id, amount, status) values (?)");
  });
  test("the same inside Vector's stored envelope", () => {
    const r = parseHopRecord(entry(JSON.stringify({ message: SPEC, service: "commerce-api", kind: "hop" })));
    expect(r?.table).toBe("merchants");
    expect(r?.stmt).toBe("select ... from merchants as m0 where (m0.username = ?) limit ?");
  });
  test("either can be absent; an old record has neither", () => {
    expect(parseHopRecord(entry(SPEC.replace(" table=merchants", "")))?.table).toBeNull();
    const old = parseHopRecord(entry(SPEC.replace(/ stmt=.*$/, "").replace(" table=merchants", "")));
    expect(old?.table).toBeNull();
    expect(old?.stmt).toBeNull();
  });
  test("cache hops and inbound hops never carry them", () => {
    const cache = SPEC.replace("via=db", "via=cache").replace("op=select", "op=get");
    expect(parseHopRecord(entry(cache))?.stmt).toBeNull();
    expect(parseHopRecord(entry(cache))?.table).toBeNull();
  });
  test("an oversized statement is left out, the record is kept", () => {
    const r = parseHopRecord(entry(SPEC.replace(/stmt=.*$/, `stmt=${"x".repeat(301)}`)));
    expect(r).not.toBeNull();
    expect(r?.stmt).toBeNull();
  });
});

describe("repeated keys: the record's own pairs win", () => {
  const O = "7a1e3c5b9d2f4a6c8e0b1d3f5a7c9e1b";
  test("trace_id printed by the host's format and by the record", () => {
    const r = parseHopRecord(entry(`13:46:21.018 trace_id=${T} [info] trace_id=${T} hop=in hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=commerce-api adapter=plug via=http method=POST op=/orders`));
    expect(r?.traceId).toBe(T);
    expect(r?.op).toBe("/orders");
  });
  test("differing metadata in front: the record's values", () => {
    const r = parseHopRecord(entry(`2026-11-12T13:00:00Z [info] service=meta-svc trace_id=${O} trace_id=${T} hop=in hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=commerce-api adapter=plug via=http op=/orders`));
    expect(r?.traceId).toBe(T);
    expect(r?.service).toBe("commerce-api");
  });
  test("stmt holding trace_id=? and hop=in", () => {
    const r = parseHopRecord(entry(SPEC.replace(/stmt=.*$/, "stmt=select h0.id from hops as h0 where (h0.trace_id = ?) and hop=in and trace_id=?")));
    expect(r?.hop).toBe("out_end");
    expect(r?.stmt).toBe("select h0.id from hops as h0 where (h0.trace_id = ?) and hop=in and trace_id=?");
  });
});

describe("path (HOP-24, BAC-52)", () => {
  const IN = `trace_id=${T} hop=in hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=commerce-api adapter=fastify via=http method=GET op=/api/v1/public/m/:merchant_username/products path=/api/v1/public/m/island-coffee/products`;
  test("inbound HTTP records carry it, op stays the template", () => {
    const r = parseHopRecord(entry(IN));
    expect(r?.op).toBe("/api/v1/public/m/:merchant_username/products");
    expect(r?.path).toBe("/api/v1/public/m/island-coffee/products");
  });
  test("pino JSON", () => {
    const r = parseHopRecord(entry(JSON.stringify({ trace_id: T, hop: "in", hop_id: "1f0a6c2e9b7d4405", parent_id: "b7ad6b7169203331", adapter: "fastify", via: "http", method: "GET", op: "/v1/payments/:id", path: "/v1/payments/*", msg: "hop" })));
    expect(r?.path).toBe("/v1/payments/*");
  });
  test("absent on old records; not read on outbound or non-HTTP hops; out of bounds left out", () => {
    expect(parseHopRecord(entry(IN.replace(/ path=\S+/, "")))?.path).toBeNull();
    expect(parseHopRecord(entry(IN.replace("via=http", "via=job")))?.path).toBeNull();
    expect(parseHopRecord(entry(IN.replace(/path=\S+/, `path=/${"x".repeat(200)}`)))?.path).toBeNull();
    expect(parseHopRecord(entry(IN.replace(/path=\S+/, "path=no-slash")))?.path).toBeNull();
  });
});
