// BAC-79: the Database and cache switch removes the proposed totals (cache_hit_n, cache_miss_n,
// db_wait_us) as it removes the existing ones, in key=value and JSON lines, and drops the
// data-store lines that carry `hit` and `wait_us`.
import { describe, expect, test } from "bun:test";
import { BUILT_IN_PATTERNS, Feature, compileFilter, type ControlRow } from "~/lib/controls.server";
import { classifyLine, enforceStreams, stripHopFields, type LokiStream } from "./enforce.server";

const T = "6503f5f183b828139d5b143365ad72fa";
const KV_END = `trace_id=${T} hop=in_end hop_id=5d9e0b3347c1a2f8 parent_id=b7ad6b7169203331 adapter=hono via=http outcome=ok status=201 duration_us=14800 db_n=2 db_us=3500 db_wait_us=2100 cache_n=10 cache_us=900 cache_hit_n=3 cache_miss_n=7 f_order_id=7731 stmt=select db_wait_us=1`;
const JSON_END = JSON.stringify({ trace_id: T, hop: "in_end", hop_id: "a7d03b5e9c2f4816", parent_id: "b7ad6b7169203331", via: "http", outcome: "ok", duration_us: 7900, db_n: 1, db_us: 300, db_wait_us: 120, cache_n: 4, cache_us: 400, cache_hit_n: 1, cache_miss_n: 3, f_currency: "JMD" });
const JSON_NESTED_END = JSON.stringify({ message: "hop", metadata: JSON.parse(JSON_END) as Record<string, unknown> });
const KV_CACHE = `trace_id=${T} hop=out_end hop_id=e19c4d72b05a3f68 parent_hop=a7d03b5e9c2f4816 hop_sent=false parent_id=b7ad6b7169203331 adapter=ioredis via=cache op=get peer=redis outcome=ok duration_us=400 hit=false`;
const JSON_DB = JSON.stringify({ trace_id: T, hop: "out_end", hop_id: "b6f20e9d41c7a385", parent_id: "b7ad6b7169203331", hop_sent: false, adapter: "pg", via: "db", op: "select", outcome: "ok", duration_us: 6000, wait_us: 4100 });

const NEW_TOTALS = ["cache_hit_n", "cache_miss_n", "db_wait_us"];
const OLD_TOTALS = ["db_n", "db_us", "cache_n", "cache_us"];
const STORES_OFF = { named: false, stores: true, statements: false, paths: false };
const ALL_ON = { named: false, stores: false, statements: false, paths: false };

const env = (message: string): string => JSON.stringify({ message, display: message, service: "commerce-api" });
const push = (ls: string[]): LokiStream[] => [{ stream: { service: "commerce-api" }, values: ls.map((l, i) => [String(1731390000000000000 + i), l]) }];
const off = (feature: ControlRow["feature"]): ControlRow => ({ orgId: "o", projectId: null, service: null, feature, enabled: false, updatedBy: null, updatedAt: new Date(0) });
const filter = compileFilter([...BUILT_IN_PATTERNS]);
const messages = (r: ReturnType<typeof enforceStreams>): string[] => r.streams.flatMap((s) => s.values.map((v) => (JSON.parse(v[1] as string) as { message: string }).message));

describe("stripHopFields with Database and cache off", () => {
  test("kv: every total goes, named fields and the statement stay whole", () => {
    const out = stripHopFields(KV_END, classifyLine(KV_END), STORES_OFF);
    for (const k of [...NEW_TOTALS, ...OLD_TOTALS]) expect(out.split(" stmt=")[0]).not.toContain(`${k}=`);
    expect(out).toContain("f_order_id=7731");
    expect(out.endsWith(" stmt=select db_wait_us=1")).toBe(true);
  });
  test("JSON, top level and nested: every total goes", () => {
    const top = JSON.parse(stripHopFields(JSON_END, classifyLine(JSON_END), STORES_OFF)) as Record<string, unknown>;
    const nested = (JSON.parse(stripHopFields(JSON_NESTED_END, classifyLine(JSON_NESTED_END), STORES_OFF)) as { metadata: Record<string, unknown> }).metadata;
    for (const o of [top, nested]) {
      for (const k of [...NEW_TOTALS, ...OLD_TOTALS]) expect(k in o).toBe(false);
      expect(o.f_currency).toBe("JMD");
    }
  });
  test("with the switch on, nothing is removed", () => {
    expect(stripHopFields(KV_END, classifyLine(KV_END), ALL_ON)).toBe(KV_END);
    expect(stripHopFields(JSON_END, classifyLine(JSON_END), ALL_ON)).toBe(JSON_END);
  });
});

describe("enforceStreams", () => {
  const all = [env(KV_END), env(JSON_END), env(JSON_NESTED_END), env(KV_CACHE), env(JSON_DB)];
  test("switch on: the new fields are stored as sent", () => {
    const r = enforceStreams(push(all), { projectId: null, rows: [], filter });
    expect(r.kept).toBe(5);
    const ms = messages(r);
    expect(ms[0]).toContain("cache_hit_n=3 cache_miss_n=7");
    expect(ms[0]).toContain("db_wait_us=2100");
    expect(ms.some((m) => m.includes("hit=false"))).toBe(true);
    expect(ms.some((m) => m.includes('"wait_us":4100'))).toBe(true);
  });
  test("switch off: totals removed from kv and JSON, data-store lines dropped", () => {
    const r = enforceStreams(push(all), { projectId: null, rows: [off(Feature.Stores)], filter });
    expect(r.dropped).toBe(2);
    const ms = messages(r);
    expect(ms).toHaveLength(3);
    const heads = ms.map((m) => m.split(" stmt=")[0]);
    for (const m of heads) for (const k of NEW_TOTALS) {
      expect(m).not.toContain(`${k}=`);
      expect(m).not.toContain(`"${k}"`);
    }
    expect(heads.some((m) => m.includes("hit="))).toBe(false);
    expect(heads.some((m) => m.includes("wait_us"))).toBe(false);
    expect(ms[0].endsWith(" stmt=select db_wait_us=1")).toBe(true);
  });
});
