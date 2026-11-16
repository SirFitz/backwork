import { describe, expect, test } from "bun:test";
import { BUILT_IN_PATTERNS, Feature, compileFilter, type ControlRow, type FilterPattern } from "~/lib/controls.server";
import { compileExcludedPaths } from "~/lib/excluded-paths";
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
    expect(stripHopFields(KV_END, c, { named: true, stores: false, statements: false, paths: false })).not.toContain("f_order_id");
    expect(stripHopFields(KV_END, c, { named: false, stores: true, statements: false, paths: false })).not.toContain("db_n=");
    expect(stripHopFields(KV_END, c, { named: false, stores: true, statements: false, paths: false })).toContain("f_order_id=7731");
  });
  test("nested json", () => {
    const c = classifyLine(JSON_NESTED_END);
    const out = JSON.parse(stripHopFields(JSON_NESTED_END, c, { named: true, stores: true, statements: false, paths: false })) as { metadata: Record<string, unknown> };
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
  test("a repeated trace_id in front of the record still classifies as a hop", () => {
    const c = classifyLine(`13:46:21.018 trace_id=${T} [info] ${KV_DB}`);
    expect(c.kind).toBe(LineKind.Hop);
    expect(c.fields.op).toBe("select");
  });
  test("named fields off never edits inside stmt", () => {
    const out = stripHopFields(KV_DB, classifyLine(KV_DB), { named: true, stores: true, statements: false, paths: false });
    expect(out).toBe(KV_DB);
  });
  test("query text off removes table and stmt, kv and json, the rest unchanged", () => {
    const kv = stripHopFields(KV_DB, classifyLine(KV_DB), { named: false, stores: false, statements: true, paths: false });
    expect(kv).toBe(KV_DB.replace(" table=merchants", "").replace(/ stmt=.*$/, ""));
    const js = JSON.parse(stripHopFields(JSON_DB, classifyLine(JSON_DB), { named: false, stores: false, statements: true, paths: false })) as Record<string, unknown>;
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

const KV_PATH = `trace_id=${T} hop=in_end hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=commerce-api adapter=fastify via=http method=GET op=/api/v1/public/m/:merchant_username/products path=/api/v1/public/m/island-coffee/products outcome=ok status=200 duration_us=41200`;
const JSON_PATH = JSON.stringify({ level: 30, trace_id: T, hop: "in", hop_id: "2f0a6c2e9b7d4405", parent_id: "b7ad6b7169203331", service: "commerce-payments", adapter: "fastify", via: "http", method: "GET", op: "/v1/payments/:id", path: "/v1/payments/pay_8Kx2", msg: "hop" });

describe("request paths (BAC-52)", () => {
  test("path is a field of an inbound HTTP record", () => {
    expect(classifyLine(KV_PATH).fields.path).toBe("/api/v1/public/m/island-coffee/products");
  });
  test("Request paths off removes path, kv and json; op stays", () => {
    const kv = stripHopFields(KV_PATH, classifyLine(KV_PATH), { named: false, stores: false, statements: false, paths: true });
    expect(kv).toBe(KV_PATH.replace(" path=/api/v1/public/m/island-coffee/products", ""));
    const js = JSON.parse(stripHopFields(JSON_PATH, classifyLine(JSON_PATH), { named: false, stores: false, statements: false, paths: true })) as Record<string, unknown>;
    expect(js.path).toBeUndefined();
    expect(js.op).toBe("/v1/payments/:id");
  });
  test("enforceStreams: off for one service only; the filter runs over path", () => {
    const rows = [off(Feature.Paths, { projectId: "p", service: "svc-quiet" })];
    const quiet = enforceStreams(push([env(KV_PATH)], { service: "svc-quiet" }), { projectId: "p", rows, filter });
    expect(lines(quiet)[0].message).not.toContain("path=");
    const withEmail = KV_PATH.replace("island-coffee", "jane@example.com");
    const loud = enforceStreams(push([env(withEmail)]), { projectId: "p", rows, filter });
    expect(lines(loud)[0].message).toContain("path=/api/v1/public/m/");
    expect(lines(loud)[0].message).not.toContain("jane@example.com");
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

  test("enforceStreams counts requests started (inbound http/rpc start records) and the bytes kept", () => {
    const OUT = `trace_id=${T} hop=out hop_id=0a0a0a0a0a0a0a0a parent_hop=5d9e0b3347c1a2f8 adapter=fetch via=http peer=risk.internal`;
    const JOB_IN = `trace_id=${T} hop=in hop_id=0b0b0b0b0b0b0b0b adapter=bullmq via=job op=Receipts`;
    const r = enforceStreams(push([KV_IN, KV_END, OUT, JOB_IN, PLAIN]), { projectId: "p", rows: [], filter });
    expect(r.requests).toBe(1);
    expect(r.bytes).toBe(r.streams.flatMap((s) => s.values).reduce((n, v) => n + Buffer.byteLength(v[1] as string), 0));
    const none = enforceStreams(push([KV_IN]), { projectId: "p", rows: [off(Feature.Hops)], filter });
    expect(none.requests).toBe(0);
    expect(none.bytes).toBe(0);
  });
});

describe("derived errors (BAC-85)", () => {
  // Real Courier Portal shapes: Vector envelopes with the level as a stream label, and kv inbound end records.
  const CP = { service: "courier-portal-client", level: "error", source: "prod-courier-portal-client" };
  const errLine = (m: string) => JSON.stringify({ host: "dserve", level: "error", message: m, service: "courier-portal-client", source: "prod-courier-portal-client" });
  const end500 = (path: string, extra = "") =>
    JSON.stringify({ message: `trace_id=${T} hop=in_end hop_id=af77fedfbed3e6be parent_id=067ac66f0add67ec service=courier-portal-client adapter=express via=http method=POST host=client.example path=${path}${extra} outcome=error status=500 error=Error duration_us=4105`, service: "courier-portal-client" });
  const end200 = JSON.stringify({ message: `trace_id=${T} hop=in_end hop_id=af77fedfbed3e6be parent_id=067ac66f0add67ec via=http method=GET op=/ok outcome=ok status=200 duration_us=10`, service: "courier-portal-client" });
  const ctx = (rows: ControlRow[] = [], more: Record<string, unknown> = {}) => ({ projectId: null, rows, filter, deriveErrors: true, ...more });

  test("error-level lines and 5xx end records become events; info lines and 2xx do not", () => {
    const r = enforceStreams(
      [
        { stream: CP, values: [["1794804028563274641", errLine("[error] Uncaught in POST /RSC/mh3605y3mbzshuo.txt | POST /RSC/mh3605y3mbzshuo.txt")], ["1794804028563274642", errLine("[error] Uncaught in POST /RSC/5j42raitcsgjeak.txt | POST /RSC/5j42raitcsgjeak.txt")]] },
        { stream: { ...CP, level: "info" }, values: [["1", errLine("all fine")], ["2", end500("/RSC/mh3605y3mbzshuo.txt")], ["3", end500("/RSC/5j42raitcsgjeak.txt")], ["4", end200]] },
      ],
      ctx(),
    );
    const logs = r.errors.filter((e) => e.source === "log");
    const reqs = r.errors.filter((e) => e.source === "request");
    expect(logs.length).toBe(2);
    expect(new Set(logs.map((e) => e.fingerprint)).size).toBe(1);
    expect(logs[0].title).toBe("Uncaught in POST /RSC/<id>.txt | POST /RSC/<id>.txt");
    expect(logs[0].at).toBe(1794804028563);
    expect(reqs.length).toBe(2);
    expect(new Set(reqs.map((e) => e.fingerprint)).size).toBe(1);
    expect(reqs[0].title).toBe("POST /RSC/:id.txt → 500");
    expect(reqs[0].traceId).toBe(T);
    expect(reqs[0].service).toBe("courier-portal-client");
  });

  test("Logs off → no log-derived errors; Hop records off → no request-derived errors", () => {
    const streams: LokiStream[] = [{ stream: CP, values: [["1", errLine("boom")], ["2", end500("/x")]] }];
    expect(enforceStreams(streams, ctx([off(Feature.Logs)])).errors.map((e) => e.source)).toEqual(["request"]);
    expect(enforceStreams(streams, ctx([off(Feature.Hops)])).errors.map((e) => e.source)).toEqual(["log"]);
    expect(enforceStreams(streams, ctx([off(Feature.Logs), off(Feature.Hops)])).errors).toEqual([]);
  });

  test("excluded paths drop the request's error; the filter runs before the message is kept; Request paths off hides the path", () => {
    const streams: LokiStream[] = [{ stream: CP, values: [["1", errLine("card 4111 1111 1111 1111 failed MBR-123456")], ["2", end500("/health")]] }];
    const r = enforceStreams(streams, ctx([], { excluded: compileExcludedPaths(["/health"]) }));
    expect(r.errors.map((e) => e.source)).toEqual(["log"]);
    expect(r.errors[0].message).not.toContain("4111");
    expect(r.errors[0].message).not.toContain("MBR-123456");
    const hidden = enforceStreams([{ stream: CP, values: [["1", end500("/orders/42")]] }], ctx([off(Feature.Paths)]));
    expect(hidden.errors[0].route).toBe("(unknown route)");
  });

  test("not derived unless asked (other callers of enforceStreams)", () => {
    expect(enforceStreams([{ stream: CP, values: [["1", errLine("boom")]] }], { projectId: null, rows: [], filter }).errors).toEqual([]);
  });
});
