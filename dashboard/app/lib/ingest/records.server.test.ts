import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { RECORDS_INTAKE, RECORDS_NORMALIZE_VRL, RecordField } from "~/lib/agent/vector-config.server";
import { config } from "~/lib/config.server";
import { BUILT_IN_PATTERNS, Feature, compileFilter, type ControlRow, type FilterPattern } from "~/lib/controls.server";
import { enforceStreams, streamSwitches, type EnforceContext } from "./enforce.server";
import {
  BodyError,
  IntakeHeader,
  MAX_BODY_BYTES,
  UNKNOWN_SERVICE,
  linesToStreams,
  lineOf,
  originFrom,
  readBody,
  splitLines,
  toNdjson,
  toRecordEvents,
  tokenFrom,
} from "./records.server";

const T = "6503f5f183b828139d5b143365ad72fa";
const IN = `trace_id=${T} hop=in hop_id=5d9e0b3347c1a2f8 parent_id=b7ad6b7169203331 service=shop-api adapter=node-http via=http method=POST op=/orders`;
const END = `trace_id=${T} hop=in_end hop_id=5d9e0b3347c1a2f8 parent_id=b7ad6b7169203331 service=shop-api adapter=node-http via=http method=POST op=/orders outcome=ok status=201 duration_us=61200 db_n=2 db_us=6400 f_order_id=7731`;
const LOG = '{"level":"info","message":"order placed","card":"4111 1111 1111 1111","trace_id":"' + T + '"}';
const NOW = 1_763_400_000_000_000_000n;
const tenant = { orgId: "org-1", projectId: "p-1", project: "production" };
const member: FilterPattern = { name: "member", pattern: "MBR-\\d{6}", enabled: true, builtIn: false, replacement: "" };
const off = (feature: ControlRow["feature"], scope: Partial<ControlRow> = {}): ControlRow => ({
  orgId: "org-1", projectId: null, service: null, feature, enabled: false, updatedBy: null, updatedAt: new Date(0), ...scope,
});
const ctxOf = (rows: ControlRow[] = []): EnforceContext => ({ projectId: "p-1", rows, filter: compileFilter([...BUILT_IN_PATTERNS, member]), deriveErrors: true });

const post = (body: BodyInit, headers: Record<string, string> = {}): Request =>
  new Request("http://x/ingest/records", { method: "POST", body, headers });

describe("records intake: request", () => {
  test("token from Bearer, x-backwork-token or Basic (user or password)", () => {
    expect(tokenFrom(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(tokenFrom(new Headers({ [IntakeHeader.Token]: "abc" }))).toBe("abc");
    expect(tokenFrom(new Headers({ authorization: "Basic " + Buffer.from("abc:").toString("base64") }))).toBe("abc");
    expect(tokenFrom(new Headers({ authorization: "Basic " + Buffer.from("x:abc").toString("base64") }))).toBe("abc");
    expect(tokenFrom(new Headers({}))).toBe("");
  });
  test("service and host from headers, else the query; invalid values ignored", () => {
    expect(originFrom(new URL("http://x/?service=shop-api&host=web-1"), new Headers())).toEqual({ service: "shop-api", host: "web-1" });
    expect(originFrom(new URL("http://x/?service=q"), new Headers({ [IntakeHeader.Service]: "h" }))).toEqual({ service: "h", host: null });
    expect(originFrom(new URL("http://x/?service=has%20space"), new Headers())).toEqual({ service: null, host: null });
  });
  test("body: plain, gzip, 413 over the limit sent or unpacked, 400 bad gzip", async () => {
    const body = `${IN}\n${END}\n`;
    const plain = await readBody(post(body));
    expect(plain.ok && plain.bytes.toString()).toBe(body);
    const gz = await readBody(post(gzipSync(body), { "content-encoding": "gzip" }));
    expect(gz.ok && gz.bytes.toString()).toBe(body);
    const big = await readBody(post("x".repeat(2048)), 1024);
    expect(!big.ok && big.status).toBe(BodyError.TooLarge);
    const bomb = await readBody(post(gzipSync("x".repeat(MAX_BODY_BYTES + 10)), { "content-encoding": "gzip" }));
    expect(!bomb.ok && bomb.status).toBe(BodyError.TooLarge);
    const bad = await readBody(post("not gzip", { "content-encoding": "gzip" }));
    expect(!bad.ok && bad.status).toBe(BodyError.Unreadable);
  });
  test("Correlator's sink body (text/plain, lines + trailing newline, \\r\\n tolerated)", () => {
    expect(splitLines(`${IN}\r\n${END}\n\n`)).toEqual([IN, END]);
  });
});

describe("records intake: streams and events", () => {
  test("hop records under their own service, ordinary lines under the posted one, source = posted, order kept", () => {
    const streams = linesToStreams([{ line: IN }, { line: "plain line" }, { line: END }], { service: "shop-web", host: "web-1" }, NOW);
    const hop = streams.find((s) => s.stream.service === "shop-api");
    const log = streams.find((s) => s.stream.service === "shop-web");
    expect(hop?.stream).toEqual({ service: "shop-api", source: "shop-web", host: "web-1" });
    expect(hop?.values.map((v) => v[0])).toEqual([String(NOW), String(NOW + 2n)]);
    expect(log?.stream).toEqual({ service: "shop-web", source: "shop-web", host: "web-1" });
    expect(lineOf(log?.values[0][1])).toBe("plain line");
  });
  test("no posted service: hop records still named, other lines unknown", () => {
    const streams = linesToStreams([{ line: IN }, { line: "x" }], { service: null, host: null }, NOW);
    expect(streams.map((s) => s.stream)).toEqual([
      { service: "shop-api", source: "shop-api" },
      { service: UNKNOWN_SERVICE, source: UNKNOWN_SERVICE },
    ]);
  });
  test("the filter runs on the whole of a JSON line (never read as an envelope), the line is otherwise as posted", () => {
    const ctx = ctxOf();
    const r = enforceStreams(linesToStreams([{ line: LOG }, { line: "member MBR-123456 signed in" }], { service: "shop-api", host: null }, NOW), ctx);
    const events = toRecordEvents(r.streams, tenant, (l) => streamSwitches(l, ctx).on);
    expect(events.map((e) => e.message)).toEqual([
      '{"level":"info","message":"order placed","card":"[filtered]","trace_id":"' + T + '"}',
      "member [filtered] signed in",
    ]);
    expect(events.every((e) => !e.message.includes("4111") && !e.message.includes("MBR-123456"))).toBe(true);
  });
  test("switches: logs off drops ordinary lines; named fields off strips f_; metrics/stores per service reach the collector", () => {
    const ctx = ctxOf([off(Feature.Logs), off(Feature.NamedFields), off(Feature.Metrics, { service: "shop-api" })]);
    const r = enforceStreams(linesToStreams([{ line: IN }, { line: "plain" }, { line: END }], { service: "shop-web", host: null }, NOW), ctx);
    expect(r.dropped).toBe(1);
    const events = toRecordEvents(r.streams, tenant, (l) => streamSwitches(l, ctx).on);
    expect(events).toHaveLength(2);
    expect(events[1].message).not.toContain("f_order_id");
    expect(events.every((e) => e[RecordField.Metrics] === false && e[RecordField.Stores] === true)).toBe(true);
    expect(events[0]).toMatchObject({ service: "shop-api", source: "shop-web", project: "production", org_id: "org-1", bw_ts: String(NOW) });
  });
  test("NDJSON: one event per line, trailing newline", () => {
    const ctx = ctxOf();
    const r = enforceStreams(linesToStreams([{ line: IN }, { line: END }], { service: "shop-api", host: null }, NOW), ctx);
    const body = toNdjson(toRecordEvents(r.streams, tenant, (l) => streamSwitches(l, ctx).on));
    expect(body.endsWith("\n")).toBe(true);
    expect(body.trimEnd().split("\n").map((l) => (JSON.parse(l) as { message: string }).message)).toEqual([IN, END]);
  });
});

describe("records intake: one schema with the collector", () => {
  test("every field the intake sends is read by the records input", () => {
    for (const f of Object.values(RecordField)) expect(RECORDS_NORMALIZE_VRL).toContain(`.${f}`);
  });
  test("the default collector URL is the records input", () => {
    if (!process.env.RECORDS_COLLECTOR_URL) expect(config.recordsCollectorUrl).toBe(`http://vector:${RECORDS_INTAKE.port}${RECORDS_INTAKE.path}`);
  });
});
