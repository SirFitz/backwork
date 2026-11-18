/**
 * AWS (BAC-99): CloudWatch Logs subscription filter -> Amazon Data Firehose -> HTTP endpoint
 * destination = backwork. Implements the Firehose HTTP endpoint delivery spec
 * (https://docs.aws.amazon.com/firehose/latest/dev/httpdeliveryrequestresponse.html):
 *
 * - Request: POST, Content-Type application/json, gzip when the stream compresses; headers
 *   X-Amz-Firehose-Request-Id, X-Amz-Firehose-Access-Key (the project ingest token, copied
 *   verbatim), X-Amz-Firehose-Common-Attributes ({"commonAttributes":{...}}),
 *   X-Amz-Firehose-Protocol-Version 1.0; body {requestId, timestamp, records: [{data: base64}]}.
 * - Response: application/json, uncompressed, {requestId (echoed), timestamp (ms)}, plus
 *   errorMessage on 4xx/5xx. Only 200 is success; 413 is permanent; every other code is retried
 *   with the same request ID.
 *
 * Each record from a CloudWatch Logs subscription is gzip JSON {messageType, owner, logGroup,
 * logStream, subscriptionFilters, logEvents: [{id, timestamp, message}]}. CONTROL_MESSAGE
 * records (CloudWatch checking the destination) are acknowledged and not stored. With Firehose's
 * own decompression on, records arrive as plain JSON; with message extraction, as the bare
 * messages, one per line. Any other record is taken as newline-delimited text.
 */
import { gunzipSync } from "node:zlib";
import { Level, rfc3339Ns, validLabel } from "~/lib/ingest/records.server";
import { arr, jsonObjects, levelWord, msNs, num, str, type DrainEntry, type EntryFields } from "~/lib/ingest/drains/entry.server";

/** Request headers Firehose sends. */
export const FirehoseHeader = {
  RequestId: "x-amz-firehose-request-id",
  AccessKey: "x-amz-firehose-access-key",
  CommonAttributes: "x-amz-firehose-common-attributes",
  ProtocolVersion: "x-amz-firehose-protocol-version",
  SourceArn: "x-amz-firehose-source-arn",
} as const;

/** CloudWatch Logs subscription message types. */
export const CwMessageType = { Data: "DATA_MESSAGE", Control: "CONTROL_MESSAGE" } as const;
export type CwMessageType = (typeof CwMessageType)[keyof typeof CwMessageType];

/** Common attributes backwork reads (set on the Firehose stream's HTTP endpoint destination). */
export const FirehoseAttribute = { Service: "service", Host: "host" } as const;

/** Largest Firehose body taken (before gzip and after). Firehose's buffer for the destination
 *  should be 1 MiB (the setup steps say so): CloudWatch records are themselves gzip, so the logs
 *  in a 1 MiB body can be several times larger. */
export const FIREHOSE_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Most bytes of logs unpacked from one request's records. */
export const FIREHOSE_MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

export interface FirehoseRequest {
  requestId: string;
  timestamp: number | null;
  records: Buffer[];
}

export type FirehoseRead = { ok: true; request: FirehoseRequest } | { ok: false; requestId: string; reason: string };

/** The request body, or why it is not one. REQUEST_ID_HEADER is used when the body has none. */
export function readFirehoseRequest(text: string, requestIdHeader: string): FirehoseRead {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, requestId: requestIdHeader, reason: "body is not JSON" };
  }
  const requestId = str(v, "requestId") ?? requestIdHeader;
  if (typeof v !== "object" || v === null || !Array.isArray((v as { records?: unknown }).records)) {
    return { ok: false, requestId, reason: "body has no records array" };
  }
  const records: Buffer[] = [];
  for (const r of arr(v, "records")) {
    const data = str(r, "data") ?? "";
    records.push(Buffer.from(data, "base64"));
  }
  return { ok: true, request: { requestId, timestamp: num(v, "timestamp"), records } };
}

/** The {"commonAttributes":{...}} header, as a string map (empty when absent or malformed). */
export function commonAttributes(header: string | null): Record<string, string> {
  if (!header) return {};
  try {
    const v: unknown = JSON.parse(header);
    const attrs = typeof v === "object" && v !== null ? (v as { commonAttributes?: unknown }).commonAttributes : null;
    if (typeof attrs !== "object" || attrs === null) return {};
    return Object.fromEntries(Object.entries(attrs as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** Service from a log group: /aws/lambda/<fn>, /ecs/<task>, /aws/ecs/..., else its last segment. */
export function serviceOfLogGroup(group: string | null): string | null {
  if (!group) return null;
  const lambda = /^\/aws\/lambda\/(.+)$/.exec(group);
  if (lambda) return lambda[1];
  const parts = group.split("/").filter((p) => p !== "");
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/** Host from a log stream: its last segment, without a Lambda [$VERSION] prefix
 *  ("2026/11/17/[$LATEST]0a1b..." -> "0a1b...", "ecs/api/4f2c..." -> "4f2c..."). */
export function hostOfLogStream(stream: string | null): string | null {
  if (!stream) return null;
  const parts = stream.split("/").filter((p) => p !== "");
  const last = (parts[parts.length - 1] ?? "").replace(/^\[[^\]]*\]/, "");
  return last === "" ? null : last;
}

const LAMBDA_TEXT_RE = /^(\S+)\t([0-9a-f-]{36})\t(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\t([\s\S]*)$/;
const LAMBDA_PLATFORM_RE = /^(START|END|REPORT|INIT_START) RequestId: ([0-9a-f-]{36})/;

/** One CloudWatch log event. Lambda's text format (`time\trequestId\tLEVEL\tmessage`) gives the
 *  level and request ID; JSON lines and anything else keep their text (the collector reads them). */
export function cloudWatchEntry(message: string, timestampMs: number | null, service: string | null, host: string | null, base: EntryFields): DrainEntry {
  const text = message.replace(/\n$/, "");
  const lambda = LAMBDA_TEXT_RE.exec(text);
  if (lambda) {
    const [, ts, requestId, level, rest] = lambda;
    return { message: rest, level: levelWord(level), service, host, timeNs: rfc3339Ns(ts) ?? msNs(timestampMs), fields: { ...base, request_id: requestId } };
  }
  const platform = LAMBDA_PLATFORM_RE.exec(text);
  if (platform) return { message: text, level: Level.Info, service, host, timeNs: msNs(timestampMs), fields: { ...base, request_id: platform[2] } };
  return { message: text, level: null, service, host, timeNs: msNs(timestampMs), fields: base };
}

export interface RecordEntries {
  entries: DrainEntry[];
  /** CONTROL_MESSAGE records seen (not stored). */
  control: number;
}

/** The text as one JSON object (a CloudWatch message), else null (NDJSON is tried next). */
function wholeObject(text: string): Record<string, unknown>[] | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? [v as Record<string, unknown>] : null;
  } catch {
    return null;
  }
}

function gunzipped(b: Buffer, limit: number): Buffer | null {
  if (b.length < 2 || b[0] !== 0x1f || b[1] !== 0x8b) return b;
  try {
    return gunzipSync(b, { maxOutputLength: limit });
  } catch {
    return null;
  }
}

/** Entries for the records of one request. Null when the logs unpack beyond the limit or a
 *  record is corrupt gzip. ATTRS are the stream's common attributes. */
export function firehoseEntries(records: readonly Buffer[], attrs: Readonly<Record<string, string>>, limit: number = FIREHOSE_MAX_UNPACKED_BYTES): RecordEntries | null {
  const out: RecordEntries = { entries: [], control: 0 };
  const attrService = validLabel(attrs[FirehoseAttribute.Service]) ? attrs[FirehoseAttribute.Service] : null;
  const attrHost = validLabel(attrs[FirehoseAttribute.Host]) ? attrs[FirehoseAttribute.Host] : null;
  let total = 0;
  for (const raw of records) {
    const data = gunzipped(raw, Math.max(1, limit - total));
    if (data === null) return null;
    total += data.length;
    if (total > limit) return null;
    const text = data.toString("utf8");
    const objects = text.trimStart().startsWith("{") ? wholeObject(text) ?? jsonObjects(text) ?? [] : [];
    const messages = objects.filter((o) => "logEvents" in o || "messageType" in o);
    if (messages.length === 0) {
      // Message extraction on, or not CloudWatch: one line per entry.
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() !== "") out.entries.push(cloudWatchEntry(line, null, attrService, attrHost, {}));
      }
      continue;
    }
    for (const m of messages) {
      if (str(m, "messageType") === CwMessageType.Control) {
        out.control++;
        continue;
      }
      const group = str(m, "logGroup");
      const stream = str(m, "logStream");
      const service = attrService ?? serviceOfLogGroup(group);
      const host = attrHost ?? hostOfLogStream(stream);
      const base: EntryFields = {};
      if (group) base.log_group = group;
      for (const e of arr(m, "logEvents")) {
        const message = str(e, "message");
        if (message !== null) out.entries.push(cloudWatchEntry(message, num(e, "timestamp"), service, host, base));
      }
    }
  }
  return out;
}

/** The Firehose response: JSON, uncompressed, requestId echoed, timestamp in ms. */
export function firehoseResponse(status: number, requestId: string, errorMessage?: string): Response {
  const body: { requestId: string; timestamp: number; errorMessage?: string } = { requestId, timestamp: Date.now() };
  if (status !== 200) body.errorMessage = (errorMessage ?? "delivery failed").slice(0, 8192);
  const text = JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } });
}

/**
 * Firehose resends a batch with the same request ID when a response is lost or late. Request IDs
 * stored in the last DEDUPE_TTL_MS are answered 200 again without storing twice (best effort,
 * per dashboard process).
 */
export const DEDUPE_TTL_MS = 30 * 60 * 1000;
const DEDUPE_MAX = 10_000;
const seen = new Map<string, number>();

export function alreadyStored(key: string, now: number = Date.now()): boolean {
  const at = seen.get(key);
  return at !== undefined && now - at < DEDUPE_TTL_MS;
}

export function markStored(key: string, now: number = Date.now()): void {
  seen.delete(key);
  seen.set(key, now);
  // Oldest first (insertion order) when full.
  for (const k of seen.keys()) {
    if (seen.size <= DEDUPE_MAX) break;
    seen.delete(k);
  }
}
