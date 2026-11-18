import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { LineKind, classifyLine } from "~/lib/ingest/enforce.server";
import { entryLine } from "~/lib/ingest/drains/entry.server";
import { TOKEN_PLACEHOLDER } from "~/lib/ingest/drains/platforms";
import { IntakeStatus, intakeLines } from "~/lib/ingest/records-intake.server";
import { Level, MAX_LINES, rfc3339Ns, type IntakeLine } from "~/lib/ingest/records.server";
import {
  CwMessageType,
  alreadyStored,
  cloudWatchEntry,
  commonAttributes,
  firehoseEntries,
  firehoseResponse,
  hostOfLogStream,
  markStored,
  readFirehoseRequest,
  serviceOfLogGroup,
} from "./firehose.server";
import { PUSH_ACK_STATUSES, logEntryToEntry, readPush, severityLevel, shortLogName } from "./gcp.server";
import { CloudSource, FIREHOSE_PATH, cloudGuides, gcpPushPath } from "./sources";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const json = (name: string): Record<string, unknown> => JSON.parse(fixture(name)) as Record<string, unknown>;
/** A CloudWatch subscription record as Firehose carries it: gzip JSON, base64 in the request. */
const cwRecord = (name: string): string => gzipSync(fixture(name)).toString("base64");
const firehoseBody = (data: string[]): string =>
  JSON.stringify({ requestId: "ed4acda5-034f-9f42-bba1-f29aea6d7d8f", timestamp: 1578090901599, records: data.map((d) => ({ data: d })) });
const pushBody = (entry: Record<string, unknown>): string =>
  JSON.stringify({
    message: {
      attributes: { "logging.googleapis.com/timestamp": String(entry.timestamp ?? "") },
      data: Buffer.from(JSON.stringify(entry)).toString("base64"),
      messageId: "2070443601311540",
      message_id: "2070443601311540",
      publishTime: "2026-11-17T18:40:04.3Z",
      publish_time: "2026-11-17T18:40:04.3Z",
    },
    subscription: "projects/acme-prod/subscriptions/backwork-push",
  });
const parsedLine = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;

describe("Firehose HTTP endpoint delivery", () => {
  test("request body: requestId, timestamp, base64 records (doc example)", () => {
    const r = readFirehoseRequest('{"requestId":"ed4acda5-034f-9f42-bba1-f29aea6d7d8f","timestamp":1578090901599,"records":[{"data":"aGVsbG8="},{"data":"aGVsbG8gd29ybGQ="}]}', "hdr");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.requestId).toBe("ed4acda5-034f-9f42-bba1-f29aea6d7d8f");
    expect(r.request.timestamp).toBe(1578090901599);
    expect(r.request.records.map((b) => b.toString())).toEqual(["hello", "hello world"]);
    expect(readFirehoseRequest("nope", "hdr")).toEqual({ ok: false, requestId: "hdr", reason: "body is not JSON" });
    expect(readFirehoseRequest('{"requestId":"r1"}', "hdr")).toEqual({ ok: false, requestId: "r1", reason: "body has no records array" });
  });

  test("response: JSON, requestId echoed, timestamp ms, errorMessage only on failure, Content-Length set", async () => {
    const ok = firehoseResponse(200, "r1");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/json");
    expect(ok.headers.get("content-encoding")).toBeNull();
    const okBody = (await ok.json()) as Record<string, unknown>;
    expect(Object.keys(okBody).sort()).toEqual(["requestId", "timestamp"]);
    expect(okBody.requestId).toBe("r1");
    expect(typeof okBody.timestamp).toBe("number");
    const bad = firehoseResponse(401, "r2", "invalid access key");
    const text = await bad.text();
    expect(bad.headers.get("content-length")).toBe(String(Buffer.byteLength(text)));
    expect(JSON.parse(text)).toMatchObject({ requestId: "r2", errorMessage: "invalid access key" });
  });

  test("common attributes header", () => {
    expect(commonAttributes('{"commonAttributes":{"service":"orders","n":3}}')).toEqual({ service: "orders" });
    expect(commonAttributes("garbage")).toEqual({});
    expect(commonAttributes(null)).toEqual({});
  });

  test("log group and stream names", () => {
    expect(serviceOfLogGroup("/aws/lambda/checkout-fn")).toBe("checkout-fn");
    expect(serviceOfLogGroup("/ecs/orders-api")).toBe("orders-api");
    expect(serviceOfLogGroup("")).toBeNull();
    expect(hostOfLogStream("2026/11/17/[$LATEST]0a1b2c")).toBe("0a1b2c");
    expect(hostOfLogStream("ecs/orders-api/4f2c9a")).toBe("4f2c9a");
  });

  test("CloudWatch Lambda records: service, host, level and request ID from the text format, platform lines, hop record kept", () => {
    const req = readFirehoseRequest(firehoseBody([cwRecord("cloudwatch-lambda.json")]), "");
    if (!req.ok) throw new Error(req.reason);
    const out = firehoseEntries(req.request.records, {})!;
    expect(out.control).toBe(0);
    expect(out.entries).toHaveLength(6);
    expect(out.entries.every((e) => e.service === "checkout-fn" && e.host === "0a1b2c3d4e5f60718293a4b5c6d7e8f9")).toBe(true);
    const [start, info, err, warnJson, hop, report] = out.entries;
    expect(start).toMatchObject({ level: Level.Info, timeNs: 1_794_940_801_000_000_000n });
    expect(info).toMatchObject({ message: "charging order 7731", level: Level.Info, timeNs: rfc3339Ns("2026-11-17T18:40:01.005Z") });
    expect(parsedLine(entryLine(err))).toMatchObject({ level: "error", request_id: "6f1e3a8c-2b4d-4c5e-9f0a-1b2c3d4e5f60", log_group: "/aws/lambda/checkout-fn" });
    expect(entryLine(warnJson)).toContain('"level":"WARN"');
    expect(classifyLine(entryLine(hop)).kind).toBe(LineKind.Hop);
    expect(report.message.startsWith("REPORT RequestId:")).toBe(true);
  });

  test("CONTROL_MESSAGE acknowledged, not stored; several records; common attribute names the service", () => {
    const req = readFirehoseRequest(firehoseBody([cwRecord("cloudwatch-control.json"), cwRecord("cloudwatch-ecs.json")]), "");
    if (!req.ok) throw new Error(req.reason);
    const out = firehoseEntries(req.request.records, { service: "orders" })!;
    expect(out.control).toBe(1);
    expect(out.entries.map((e) => [e.service, e.host, e.message.slice(0, 15)])).toEqual([
      ["orders", "4f2c9a1be2d34c0a9b7e6d5c4b3a2910", '{"level":"error'],
      ["orders", "4f2c9a1be2d34c0a9b7e6d5c4b3a2910", "GET /health 200"],
    ]);
    expect(JSON.parse(fixture("cloudwatch-control.json")).messageType).toBe(CwMessageType.Control);
  });

  test("Firehose decompression on (plain JSON) and message extraction (bare lines)", () => {
    const plain = firehoseEntries([Buffer.from(fixture("cloudwatch-ecs.json"))], {})!;
    expect(plain.entries.map((e) => e.service)).toEqual(["orders-api", "orders-api"]);
    const extracted = firehoseEntries([Buffer.from("line one\nline two\n")], { service: "svc" })!;
    expect(extracted.entries.map((e) => [e.message, e.service])).toEqual([["line one", "svc"], ["line two", "svc"]]);
  });

  test("corrupt gzip or over the unpack limit refused", () => {
    expect(firehoseEntries([Buffer.from([0x1f, 0x8b, 1, 2])], {})).toBeNull();
    expect(firehoseEntries([gzipSync(Buffer.alloc(5000))], {}, 1000)).toBeNull();
  });

  test("Lambda text format parser", () => {
    const e = cloudWatchEntry("2026-11-17T18:40:01.005Z\t6f1e3a8c-2b4d-4c5e-9f0a-1b2c3d4e5f60\tWARN\tlow stock\n", 1, "fn", "h", {});
    expect(e).toMatchObject({ message: "low stock", level: Level.Warn, fields: { request_id: "6f1e3a8c-2b4d-4c5e-9f0a-1b2c3d4e5f60" } });
    expect(cloudWatchEntry("plain", 1794940801000, "fn", null, {})).toMatchObject({ level: null, timeNs: 1_794_940_801_000_000_000n });
  });

  test("retried request IDs are recognised", () => {
    expect(alreadyStored("p:r-new", 1000)).toBe(false);
    markStored("p:r-new", 1000);
    expect(alreadyStored("p:r-new", 2000)).toBe(true);
    expect(alreadyStored("p:r-new", 1000 + 31 * 60 * 1000)).toBe(false);
  });
});

describe("GCP Pub/Sub push", () => {
  test("wrapped push envelope with a Cloud Run text entry", () => {
    const r = readPush(pushBody(json("gcp-cloudrun-text.json")));
    if (!r.ok) throw new Error(r.reason);
    expect(r.message.messageId).toBe("2070443601311540");
    const e = logEntryToEntry(r.message.entry!, r.message.attributes)!;
    expect(e).toMatchObject({ message: "payment webhook signature mismatch", level: Level.Error, service: "orders", host: "00f46b9285c2c1a4d1b2c3", timeNs: 1_794_940_803_900_123_456n });
    expect(parsedLine(entryLine(e))).toMatchObject({ level: "error", trace_id: "6503f5f183b828139d5b143365ad72fe", span_id: "a1b2c3d4e5f60718", log: "run.googleapis.com/stderr" });
  });

  test("jsonPayload keeps its fields with the severity as level; request logs; GKE hop record kept exactly", () => {
    const j = logEntryToEntry(json("gcp-cloudrun-json.json"))!;
    expect(parsedLine(entryLine(j))).toMatchObject({ level: "info", message: "order 7731 shipped", order_id: "7731", log: "run.googleapis.com/stdout" });
    const req = logEntryToEntry(json("gcp-cloudrun-request.json"))!;
    expect(req).toMatchObject({ message: "POST https://orders-abc-uc.a.run.app/orders 503 0.120s", level: Level.Error });
    const hop = logEntryToEntry(json("gcp-gke-hop.json"))!;
    expect(hop).toMatchObject({ service: "cart", host: "cart-7d9f8b6c5-x2k4p" });
    expect(classifyLine(entryLine(hop)).kind).toBe(LineKind.Hop);
  });

  test("unwrapped payload, non-JSON data, bad bodies", () => {
    const u = readPush(fixture("gcp-cloudrun-text.json"));
    expect(u.ok && logEntryToEntry(u.message.entry!)?.service).toBe("orders");
    const text = readPush(JSON.stringify({ message: { data: Buffer.from("just text").toString("base64") } }));
    expect(text.ok && text.message.entry).toEqual({ textPayload: "just text" });
    expect(readPush("not json").ok).toBe(false);
    expect(readPush("[1]").ok).toBe(false);
  });

  test("severities, log names, ack statuses", () => {
    expect(severityLevel("WARNING")).toBe(Level.Warn);
    expect(severityLevel("CRITICAL")).toBe(Level.Fatal);
    expect(severityLevel("DEFAULT")).toBeNull();
    expect(severityLevel("NOTICE")).toBe(Level.Info);
    expect(shortLogName("projects/p/logs/cloudaudit.googleapis.com%2Factivity")).toBe("cloudaudit.googleapis.com/activity");
    expect(PUSH_ACK_STATUSES).toContain(204);
  });
});

describe("cloud intake", () => {
  const tenant = { orgId: "org-1", projectId: "p-1", project: "production" };

  test("lines past MAX_LINES are stored in batches; a collector failure stops and is reported", async () => {
    const lines: IntakeLine[] = Array.from({ length: MAX_LINES * 2 + 5 }, (_, i) => ({ line: `l${i}`, service: "s" }));
    const sizes: number[] = [];
    const ok = await intakeLines(tenant, lines, 1n, async (streams) => {
      const n = streams.reduce((a, s) => a + s.values.length, 0);
      sizes.push(n);
      return { status: IntakeStatus.Stored, accepted: n - 1, dropped: 1 };
    });
    expect(sizes).toEqual([MAX_LINES, MAX_LINES, 5]);
    expect(ok).toEqual({ status: IntakeStatus.Stored, accepted: lines.length - 3, dropped: 3 });
    let calls = 0;
    const failed = await intakeLines(tenant, lines, 1n, async () => {
      calls++;
      return calls === 2 ? { status: IntakeStatus.CollectorFailed, accepted: 0, dropped: 0, reason: "down" } : { status: IntakeStatus.Stored, accepted: 1, dropped: 0 };
    });
    expect(failed).toMatchObject({ status: IntakeStatus.CollectorFailed, accepted: 1, reason: "down" });
    expect(calls).toBe(2);
  });

  test("setup steps: Firehose URL and access key, GCP token in the push path", () => {
    const [aws, gcp] = cloudGuides("https://backwork.dev/", "bw_abc");
    expect(aws.source).toBe(CloudSource.AwsFirehose);
    const all = (g: typeof aws): string => [...g.console, ...g.cli].map((s) => s.copy ?? "").join("\n");
    expect(all(aws)).toContain(`https://backwork.dev${FIREHOSE_PATH}`);
    expect(all(aws)).toContain('"AccessKey": "bw_abc"');
    expect(all(gcp)).toContain('--push-endpoint="https://backwork.dev/ingest/cloud/gcp/bw_abc"');
    expect(gcpPushPath(TOKEN_PLACEHOLDER)).toBe(`/ingest/cloud/gcp/${TOKEN_PLACEHOLDER}`);
  });
});
