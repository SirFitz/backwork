import { describe, expect, test } from "bun:test";
import { BUILT_IN_PATTERNS, Feature, compileFilter, type ControlRow, type FilterPattern } from "~/lib/controls.server";
import { classifyLine, enforceStreams, hopMetricsAllowed, LineKind, stripHopFields, type LokiStream } from "./enforce.server";

const T = "6503f5f183b828139d5b143365ad72fa";
const KV_IN = `10:01:03.134 [info] trace_id=${T} hop=in hop_id=5d9e0b3347c1a2f8 parent_id=b7ad6b7169203331 adapter=hono via=http method=POST op=/charges`;
const KV_END = `trace_id=${T} hop=in_end hop_id=5d9e0b3347c1a2f8 parent_id=b7ad6b7169203331 adapter=hono via=http outcome=ok status=201 duration_us=14800 db_n=2 db_us=3500 f_order_id=7731`;
const JSON_STORE = JSON.stringify({ trace_id: T, hop: "out_end", hop_id: "b6f20e9d41c7a385", parent_id: "b7ad6b7169203331", adapter: "postgres", via: "db", op: "select", outcome: "ok", duration_us: 1200, msg: "hop" });
const JSON_NESTED_END = JSON.stringify({ message: "hop", metadata: { trace_id: T, hop: "in_end", hop_id: "a7d03b5e9c2f4816", parent_id: "b7ad6b7169203331", via: "http", outcome: "ok", duration_us: 7900, cache_n: 1, cache_us: 400, f_currency: "JMD" } });
const LINK = `trace_id=${T} link_name=order_id link_value=7731 hop_id=1f0a6c2e9b7d4405`;
const PLAIN = "customer updated card=4111 1111 1111 1111 email=jane@example.com member=MBR-123456";

const env = (message: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ message, display: message, service: "commerce-api", ...extra });

const push = (lines: string[], labels: Record<string, string> = { service: "commerce-api" }): LokiStream[] => [
  { stream: labels, values: lines.map((l, i) => [String(1731390000000000000 + i), l]) },
];

const off = (feature: ControlRow["feature"], scope: Partial<ControlRow> = {}): ControlRow => ({
  orgId: "o", projectId: null, service: null, feature, enabled: false, updatedBy: null, updatedAt: new Date(0), ...scope,
});

const member: FilterPattern = { name: "member", pattern: "MBR-\\d{6}", enabled: true, builtIn: false, replacement: "" };
const filter = compileFilter([...BUILT_IN_PATTERNS, member]);

const lines = (r: ReturnType<typeof enforceStreams>): { kind: string; message: string }[] =>
  r.streams.flatMap((s) => s.values.map((v) => ({ kind: s.stream.kind, message: (JSON.parse(v[1] as string) as { message: string }).message })));

describe("classifyLine", () => {
  test("kv, json, nested json, link, plain", () => {
    expect(classifyLine(KV_IN).kind).toBe(LineKind.Hop);
    expect(classifyLine(JSON_STORE).kind).toBe(LineKind.Hop);
    const n = classifyLine(JSON_NESTED_END);
    expect(n.kind).toBe(LineKind.Hop);
    expect(n.box).toBe("metadata");
    expect(classifyLine(LINK).kind).toBe(LineKind.Link);
    expect(classifyLine(PLAIN).kind).toBe(LineKind.Log);
    expect(classifyLine(`trace_id=${T} hop=in hop_id=short`).kind).toBe(LineKind.Log);
    expect(classifyLine(`{"trace_id":"${T}","hop":"in"`).kind).toBe(LineKind.Log);
  });
});

describe("stripHopFields", () => {
  test("kv named fields and totals", () => {
    const c = classifyLine(KV_END);
    expect(stripHopFields(KV_END, c, { named: true, stores: false, statements: false })).not.toContain("f_order_id");
    expect(stripHopFields(KV_END, c, { named: false, stores: true, statements: false })).not.toContain("db_n=");
    expect(stripHopFields(KV_END, c, { named: false, stores: true, statements: false })).toContain("f_order_id=7731");
  });
  test("nested json", () => {
    const c = classifyLine(JSON_NESTED_END);
    const out = JSON.parse(stripHopFields(JSON_NESTED_END, c, { named: true, stores: true, statements: false })) as { metadata: Record<string, unknown> };
    expect(out.metadata.f_currency).toBeUndefined();
    expect(out.metadata.cache_n).toBeUndefined();
    expect(out.metadata.hop_id).toBe("a7d03b5e9c2f4816");
  });
});

const KV_DB = `trace_id=${T} hop=out_end hop_id=83c2d1907ae45b16 parent_hop=1f0a6c2e9b7d4405 hop_sent=false parent_id=b7ad6b7169203331 service=commerce-api adapter=ecto via=db op=select table=merchants peer=db.internal outcome=ok duration_us=15200 stmt=select a, f_x=? from merchants where status=? and email = ? limit ?`;
const JSON_DB = JSON.stringify({ trace_id: T, hop: "out_end", hop_id: "93c2d1907ae45b16", parent_hop: "1f0a6c2e9b7d4405", hop_sent: false, parent_id: "b7ad6b7169203331", adapter: "pg", via: "db", op: "insert", table: "charges", peer: "payments-db", outcome: "ok", duration_us: 2300, stmt: "insert into charges (id, amount) values (?)", msg: "hop" });

describe("statement fields (BAC-51)", () => {
  test("stmt is read first: text inside it is not a field", () => {
    const c = classifyLine(KV_DB);
    expect(c.fields.stmt).toBe("select a, f_x=? from merchants where status=? and email = ? limit ?");
    expect(c.fields.status).toBeUndefined();
    expect(c.fields.table).toBe("merchants");
  });
  test("named fields off never edits inside stmt", () => {
    const out = stripHopFields(KV_DB, classifyLine(KV_DB), { named: true, stores: true, statements: false });
    expect(out).toBe(KV_DB);
  });
  test("query text off removes table and stmt, kv and json, the rest unchanged", () => {
    const kv = stripHopFields(KV_DB, classifyLine(KV_DB), { named: false, stores: false, statements: true });
    expect(kv).toBe(KV_DB.replace(" table=merchants", "").replace(/ stmt=.*$/, ""));
    const js = JSON.parse(stripHopFields(JSON_DB, classifyLine(JSON_DB), { named: false, stores: false, statements: true })) as Record<string, unknown>;
    expect(js.table).toBeUndefined();
    expect(js.stmt).toBeUndefined();
    expect(js.op).toBe("insert");
    expect(js.duration_us).toBe(2300);
  });
  test("enforceStreams: query text off for one service, on elsewhere; filter runs over stmt", () => {
    const rows = [off(Feature.Statements, { projectId: "p", service: "svc-quiet" })];
    const quiet = enforceStreams(push([env(KV_DB)], { service: "svc-quiet" }), { projectId: "p", rows, filter });
    expect(lines(quiet)[0].message).not.toContain("stmt=");
    expect(lines(quiet)[0].message).not.toContain("table=");
    const loud = enforceStreams(push([env(KV_DB.replace("limit ?", "limit ? -- jane@example.com"))]), { projectId: "p", rows, filter });
    const m = lines(loud)[0].message;
    expect(m).toContain("table=merchants");
    expect(m).toContain("stmt=select a, f_x=? from merchants");
    expect(m).not.toContain("jane@example.com");
  });
  test("query text off at the organisation wins over nothing set below", () => {
    const rows = [off(Feature.Statements)];
    const r = enforceStreams(push([env(KV_DB)]), { projectId: "p", rows, filter });
    expect(lines(r)[0].message).not.toContain("stmt=");
  });
});

describe("enforceStreams", () => {
  const all = [env(KV_IN), env(KV_END), env(JSON_STORE), env(LINK), env(PLAIN)];

  test("everything on: all kept, kind set, filter applied", () => {
    const r = enforceStreams(push(all), { projectId: "p1", rows: [], filter });
    expect(r.kept).toBe(5);
    expect(r.dropped).toBe(0);
    const ls = lines(r);
    expect(ls.filter((l) => l.kind === "hop")).toHaveLength(4);
    const plain = ls.find((l) => l.kind === "log")!;
    expect(plain.message).toBe("customer updated card=[filtered] email=[filtered] member=[filtered]");
    expect(ls.find((l) => l.message.startsWith("10:01"))!.message).toBe(KV_IN);
  });

  test("logs off drops only ordinary lines", () => {
    const r = enforceStreams(push(all), { projectId: "p1", rows: [off(Feature.Logs)], filter });
    expect(r.dropped).toBe(1);
    expect(lines(r).every((l) => l.kind === "hop")).toBe(true);
  });

  test("hops off at project drops hop records and link lines", () => {
    const r = enforceStreams(push(all), { projectId: "p1", rows: [off(Feature.Hops, { projectId: "p1" })], filter });
    expect(r.kept).toBe(1);
    expect(enforceStreams(push(all), { projectId: "p2", rows: [off(Feature.Hops, { projectId: "p1" })], filter }).kept).toBe(5);
  });

  test("service-level switch only affects that service", () => {
    const rows = [off(Feature.Hops, { service: "commerce-api" })];
    expect(enforceStreams(push(all), { projectId: "p1", rows, filter }).kept).toBe(1);
    expect(enforceStreams(push(all, { service: "commerce-risk" }), { projectId: "p1", rows, filter }).kept).toBe(5);
  });

  test("linked ids, stores, named fields", () => {
    const r1 = enforceStreams(push(all), { projectId: null, rows: [off(Feature.LinkedIds)], filter });
    expect(lines(r1).some((l) => l.message.includes("link_name"))).toBe(false);
    const r2 = enforceStreams(push(all), { projectId: null, rows: [off(Feature.Stores)], filter });
    expect(r2.dropped).toBe(1);
    expect(lines(r2).some((l) => l.message.includes("db_n="))).toBe(false);
    const r3 = enforceStreams(push(all), { projectId: null, rows: [off(Feature.NamedFields)], filter });
    expect(lines(r3).some((l) => l.message.includes("f_order_id"))).toBe(false);
  });

  test("filter off keeps values", () => {
    const r = enforceStreams(push([env(PLAIN)]), { projectId: null, rows: [off(Feature.Filter)], filter });
    expect(lines(r)[0].message).toBe(PLAIN);
  });

  test("raw (non-envelope) lines and junk values", () => {
    const s: LokiStream[] = [{ stream: { service: "x" }, values: [["1", PLAIN], ["2"], [3, "x"], ["4", LINK]] }];
    const r = enforceStreams(s, { projectId: null, rows: [], filter });
    expect(r.kept).toBe(2);
    expect(r.streams.map((x) => x.stream.kind).sort()).toEqual(["hop", "log"]);
  });

  test("ids are never altered by the filter", () => {
    const l = `trace_id=41111111111111114111111111111111 hop=in hop_id=4111111111111111 parent_id=5500000000000004 via=http`;
    const r = enforceStreams(push([env(l)]), { projectId: null, rows: [], filter });
    expect(lines(r)[0].message).toBe(l);
  });
});

describe("hopMetricsAllowed", () => {
  test("off when metrics or hops off for the project", () => {
    expect(hopMetricsAllowed([], "p1")).toBe(true);
    expect(hopMetricsAllowed([off(Feature.Metrics)], "p1")).toBe(false);
    expect(hopMetricsAllowed([off(Feature.Hops, { projectId: "p1" })], "p1")).toBe(false);
    expect(hopMetricsAllowed([off(Feature.Metrics, { service: "a" })], "p1")).toBe(true);
  });
});
