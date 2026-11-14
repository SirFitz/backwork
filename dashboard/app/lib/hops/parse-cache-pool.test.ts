// BAC-79: the proposed cache hit and connection wait fields (HOP-25, HOP-26) in both record forms.
import { describe, expect, test } from "bun:test";
import { parseHopRecord, type RawLogEntry } from "./parse";

const T = "6503f5f183b828139d5b143365ad72fa";
const entry = (line: string): RawLogEntry => ({ ts: 1_700_000_000_000, line, labels: { service: "shop-api" } });
const HEAD = `trace_id=${T} hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=shop-api`;
const kv = (rest: string) => parseHopRecord(entry(`${HEAD} ${rest}`));
const json = (fields: Record<string, unknown>) =>
  parseHopRecord(entry(JSON.stringify({ trace_id: T, hop_id: "1f0a6c2e9b7d4405", parent_id: "b7ad6b7169203331", service: "shop-api", ...fields })));

describe("inbound totals", () => {
  test("kv: hits, misses and connection wait are read", () => {
    const r = kv("hop=in_end adapter=fastify via=http outcome=ok duration_us=90000 db_n=3 db_us=40000 db_wait_us=31000 cache_n=10 cache_us=900 cache_hit_n=3 cache_miss_n=7");
    expect(r?.totals).toEqual({ dbCalls: 3, dbUs: 40000, cacheCalls: 10, cacheUs: 900, cacheHits: 3, cacheMisses: 7, dbWaitUs: 31000 });
  });
  test("JSON: the same, numbers or digit strings", () => {
    const r = json({ hop: "in_end", adapter: "fastify", via: "http", outcome: "ok", duration_us: 9000, cache_n: 2, cache_us: 100, cache_hit_n: 2, cache_miss_n: "0" });
    expect(r?.totals).toEqual({ dbCalls: 0, dbUs: 0, cacheCalls: 2, cacheUs: 100, cacheHits: 2, cacheMisses: 0, dbWaitUs: null });
  });
  test("a service that does not report them reads null, never 0", () => {
    const r = kv("hop=in_end adapter=plug via=http outcome=ok duration_us=9000 db_n=2 db_us=3000 cache_n=1 cache_us=400");
    expect(r?.totals).toMatchObject({ cacheHits: null, cacheMisses: null, dbWaitUs: null });
  });
  test("out of range values read null", () => {
    const r = json({ hop: "in_end", adapter: "x", via: "http", outcome: "ok", duration_us: 9000, db_n: 1, db_us: 10, db_wait_us: -4, cache_n: 1, cache_us: 1, cache_hit_n: 1.5, cache_miss_n: "7x" });
    expect(r?.totals).toMatchObject({ cacheHits: null, cacheMisses: null, dbWaitUs: null });
  });
  test("new totals alone do not make totals: the null rule is unchanged", () => {
    expect(kv("hop=in_end adapter=x via=http outcome=ok duration_us=9000 cache_hit_n=3 db_wait_us=12")?.totals).toBeNull();
  });
  test("totals are read on inbound end records only", () => {
    expect(kv("hop=out_end hop_sent=false adapter=x via=http outcome=ok duration_us=9000 db_n=1 db_us=1 cache_hit_n=3")?.totals).toBeNull();
  });
});

describe("per-call fields", () => {
  test("kv: hit on a cache end record", () => {
    expect(kv("hop=out_end hop_sent=false adapter=ioredis via=cache op=get peer=redis outcome=ok duration_us=600 hit=true")?.hit).toBe(true);
    expect(kv("hop=out_end hop_sent=false adapter=ioredis via=cache op=get peer=redis outcome=ok duration_us=600 hit=false")?.hit).toBe(false);
    expect(kv("hop=out_end hop_sent=false adapter=ioredis via=cache op=set peer=redis outcome=ok duration_us=600")?.hit).toBeNull();
  });
  test("JSON: hit as a boolean, anything else is null", () => {
    const cache = { hop: "out_end", hop_sent: false, adapter: "ioredis", via: "cache", op: "get", peer: "redis", outcome: "ok", duration_us: 600 };
    expect(json({ ...cache, hit: true })?.hit).toBe(true);
    expect(json({ ...cache, hit: false })?.hit).toBe(false);
    expect(json({ ...cache, hit: 1 })?.hit).toBeNull();
    expect(json({ ...cache, hit: "yes" })?.hit).toBeNull();
  });
  test("hit is ignored on anything but a cache end record", () => {
    expect(kv("hop=out_end hop_sent=false adapter=pg via=db op=select peer=db outcome=ok duration_us=600 hit=true")?.hit).toBeNull();
    expect(kv("hop=in_end adapter=x via=http outcome=ok duration_us=600 hit=true")?.hit).toBeNull();
  });
  test("kv and JSON: wait_us on a database end record", () => {
    expect(kv("hop=out_end hop_sent=false adapter=ecto via=db op=select peer=db outcome=ok duration_us=6000 wait_us=4100")?.waitUs).toBe(4100);
    expect(json({ hop: "out_end", hop_sent: false, adapter: "pg", via: "db", op: "select", peer: "db", outcome: "ok", duration_us: 6000, wait_us: 0 })?.waitUs).toBe(0);
  });
  test("wait_us longer than the call reads as the call's duration", () => {
    expect(kv("hop=out_end hop_sent=false adapter=ecto via=db op=select peer=db outcome=ok duration_us=6000 wait_us=9000")?.waitUs).toBe(6000);
  });
  test("out of range wait_us, or wait_us off a database record, is null", () => {
    expect(kv("hop=out_end hop_sent=false adapter=ecto via=db op=select peer=db outcome=ok duration_us=6000 wait_us=-1")?.waitUs).toBeNull();
    expect(json({ hop: "out_end", hop_sent: false, adapter: "pg", via: "db", outcome: "ok", duration_us: 6000, wait_us: 1.5 })?.waitUs).toBeNull();
    expect(json({ hop: "out_end", hop_sent: false, adapter: "pg", via: "db", outcome: "ok", duration_us: 6000, wait_us: "12" })?.waitUs).toBe(12);
    expect(kv("hop=out_end hop_sent=false adapter=ioredis via=cache op=get peer=r outcome=ok duration_us=600 wait_us=100")?.waitUs).toBeNull();
    expect(kv("hop=out_end hop_sent=false adapter=ecto via=db op=select peer=db outcome=ok duration_us=6000")?.waitUs).toBeNull();
  });
});
