import { describe, expect, test } from "bun:test";
import type { LogEntry } from "~/lib/loki.server";
import { logLinesFor, logsOnly, progressiveLookup, searchWindow, SearchWindow, type HopQueryFn } from "./query.server";
import type { Tenant } from "~/lib/tenant.server";
import type { TraceId } from "./types";

const T = "6503f5f183b828139d5b143365ad72fa" as TraceId;
const OTHER = "9c2f41d07be3a6158d04f2c7b91e60aa";
const NOW = 1_762_941_663_120;
const tenant: Tenant = { orgId: "org_a", platform: false };
const rec = (ts: number, hop: string, id = "1f0a6c2e9b7d4405", trace = T): LogEntry => ({
  ts, labels: { service: "commerce-api", kind: "hop" }, level: "info", service: "commerce-api",
  line: `trace_id=${trace} hop=${hop} hop_id=${id} parent_id=b7ad6b7169203331 adapter=plug via=http`, message: "",
});

interface Call { query: string; start: number; end: number; limit: number; tenant: Tenant }
function fake(byWindow: (start: number) => LogEntry[]): { fn: HopQueryFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn: HopQueryFn = async (query, opts, t) => {
    calls.push({ query, ...opts, tenant: t });
    return byWindow(opts.start);
  };
  return { fn, calls };
}

describe("searchWindow", () => {
  test("queries only the hop streams for the trace ID, with the viewer's tenant", async () => {
    const { fn, calls } = fake(() => [rec(NOW - 1000, "in")]);
    const r = await searchWindow(T, SearchWindow.Hour, tenant, NOW, fn);
    expect(calls).toEqual([{ query: `{kind="hop"} |= "${T}"`, start: NOW - 3_600_000, end: NOW, limit: 5000, tenant }]);
    expect(r.found).toBe(true);
    expect(r.records.length).toBe(1);
  });
  test("records of another trace that merely contain the ID text are dropped", async () => {
    const { fn } = fake(() => [rec(NOW - 1000, "in", "1f0a6c2e9b7d4405", OTHER)]);
    expect((await searchWindow(T, SearchWindow.Hour, tenant, NOW, fn)).found).toBe(false);
  });
  test("refuses a value that is not a trace ID", async () => {
    const { fn, calls } = fake(() => []);
    await expect(searchWindow('x" or {a="b' as TraceId, SearchWindow.Hour, tenant, NOW, fn)).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
});

describe("progressiveLookup", () => {
  test("stops at the first window that finds records", async () => {
    const { fn, calls } = fake(() => [rec(NOW - 1000, "in")]);
    const p = progressiveLookup(T, tenant, NOW, fn);
    expect((await p.retention).window).toBe(SearchWindow.Hour);
    expect(calls.length).toBe(1);
  });
  test("searches hour, then day, then the rest of 30 days, without overlap", async () => {
    const { fn, calls } = fake(() => []);
    const r = await progressiveLookup(T, tenant, NOW, fn).retention;
    expect(r.found).toBe(false);
    expect(calls.map((c) => [NOW - c.start, NOW - c.end])).toEqual([[3_600_000, 0], [86_400_000, 3_600_000], [30 * 86_400_000, 86_400_000]]);
    expect(r.searchedFromMs).toBe(NOW - 30 * 86_400_000);
  });
});

describe("log lines", () => {
  test("every service of the organisation, ordinary lines only, 5 s either side, 1,000 at a time", async () => {
    const { fn: f1 } = fake(() => [rec(NOW - 2000, "in"), rec(NOW - 1000, "in_end")]);
    const found = await searchWindow(T, SearchWindow.Hour, tenant, NOW, f1);
    const { fn, calls } = fake(() => []);
    await logLinesFor(T, found, tenant, NOW, fn);
    expect(calls[0]).toEqual({ query: `{service=~".+", kind!="hop"} |= "${T}"`, start: NOW - 7000, end: NOW + 4000, limit: 1000, tenant });
  });
  test("a container's lines are named after the hop service of the same source", async () => {
    const hop = `trace_id=${T} hop=in hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=fs-hono adapter=hono via=http method=GET op=/`;
    const { fn: f1 } = fake(() => [{ ts: NOW - 2000, line: hop, labels: { service: "fs-hono", source: "fs-web-hono-bserve", kind: "hop" }, level: "info", service: "fs-hono", message: hop }]);
    const found = await searchWindow(T, SearchWindow.Hour, tenant, NOW, f1);
    expect(found.records[0].service).toBe("fs-hono");
    const line = `rendered page trace_id=${T}`;
    const { fn } = fake(() => [
      { ts: NOW - 1500, line, labels: { service: "fs-web-hono-bserve", source: "fs-web-hono-bserve", kind: "log" }, level: "info", service: "fs-web-hono-bserve", message: line },
      { ts: NOW - 1400, line, labels: { service: "other-box", kind: "log" }, level: "info", service: "other-box", message: line },
    ]);
    const lines = await logLinesFor(T, found, tenant, NOW, fn);
    expect(lines.map((l) => l.service)).toEqual(["fs-hono", "other-box"]);
  });
  test("records stored before BAC-49 (container name as the service label) still join", async () => {
    const hop = `trace_id=${T} hop=in hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=commerce-payments adapter=hono via=http method=POST op=/charges`;
    const { fn: f1 } = fake(() => [{ ts: NOW - 2000, line: hop, labels: { service: "commerce-payments-staging", kind: "hop" }, level: "info", service: "commerce-payments-staging", message: hop }]);
    const found = await searchWindow(T, SearchWindow.Hour, tenant, NOW, f1);
    const line = `charge created trace_id=${T}`;
    const { fn } = fake(() => [{ ts: NOW - 1500, line, labels: { service: "commerce-payments-staging", kind: "log" }, level: "info", service: "commerce-payments-staging", message: line }]);
    const lines = await logLinesFor(T, found, tenant, NOW, fn);
    expect(lines.map((l) => l.service)).toEqual(["commerce-payments"]);
  });
  test("a hop still open reads lines up to now", async () => {
    const { fn: f1 } = fake(() => [rec(NOW - 600_000, "in")]);
    const found = await searchWindow(T, SearchWindow.Hour, tenant, NOW, f1);
    const { fn, calls } = fake(() => []);
    await logLinesFor(T, found, tenant, NOW, fn);
    expect(calls[0].end).toBe(NOW);
  });
  test("logs-only fallback: every service, last 24 hours", async () => {
    const { fn, calls } = fake(() => []);
    await logsOnly(T, tenant, NOW, fn);
    expect(calls[0]).toMatchObject({ query: `{service=~".+", kind!="hop"} |= "${T}"`, start: NOW - 86_400_000, end: NOW, tenant });
  });
});
