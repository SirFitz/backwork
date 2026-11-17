/**
 * Cloudflare Logpush to an HTTP destination
 * (https://developers.cloudflare.com/logs/logpush/logpush-job/enable-destinations/http/): gzip
 * NDJSON, one record per line, request headers only from `header_*` parameters on the destination
 * URL (so `?header_Authorization=Bearer%20<token>`; Cloudflare sends it as a header, backwork
 * never reads a token from the query). On job creation Cloudflare checks the destination with a
 * gzipped `{"content":"tests"}`: answered 200, nothing stored.
 *
 * workers_trace_events: one line per console message (Logs[].Level/Message/TimestampMs), one
 * error line per uncaught exception, and one invocation line ("GET url 200", Outcome); service =
 * ScriptName. http_requests: one line per request, service = ClientRequestHost, level from
 * EdgeResponseStatus, time EdgeStartTimestamp (any timestamp_format). Other datasets: the record
 * as a JSON line, service from ?service= (else "cloudflare").
 */
import { Level } from "~/lib/ingest/records.server";
import { anyTimeNs, arr, jsonObjects, levelWord, msNs, num, obj, parsed, statusLevel, str, unreadable, type DrainEntry, type DrainParser, type EntryFields } from "./entry.server";

/** The datasets read field by field; any other is stored as JSON lines. */
export const LogpushDataset = { WorkersTrace: "workers_trace_events", HttpRequests: "http_requests", Other: "other" } as const;
export type LogpushDataset = (typeof LogpushDataset)[keyof typeof LogpushDataset];

/** Workers Outcome values. */
export const WorkerOutcome = { Ok: "ok", Canceled: "canceled", Exception: "exception", Unknown: "unknown" } as const;

/** The body of Cloudflare's destination check. */
export const LOGPUSH_TEST_CONTENT = "tests";

export function datasetOf(r: Record<string, unknown>): LogpushDataset {
  if ("ScriptName" in r || "Logs" in r || "Exceptions" in r) return LogpushDataset.WorkersTrace;
  if ("ClientRequestHost" in r || "EdgeResponseStatus" in r || "RayID" in r) return LogpushDataset.HttpRequests;
  return LogpushDataset.Other;
}

export function isTestRecord(r: Record<string, unknown>): boolean {
  const keys = Object.keys(r);
  return keys.length === 1 && r.content === LOGPUSH_TEST_CONTENT;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function workerEntries(r: Record<string, unknown>): DrainEntry[] {
  const service = str(r, "ScriptName");
  const at = msNs(num(r, "EventTimestampMs"));
  const outcome = str(r, "Outcome");
  const event = obj(r, "Event");
  const req = event ? obj(event, "Request") : null;
  const res = event ? obj(event, "Response") : null;
  const ray = (event ? str(event, "RayID") : null) ?? null;
  const base: EntryFields = {};
  if (ray) base.ray_id = ray;
  const out: DrainEntry[] = [];
  for (const l of arr(r, "Logs")) {
    const parts = arr(l, "Message");
    const message = parts.length > 0 ? parts.map(text).join(" ") : (str(l, "Message") ?? "");
    out.push({ message, level: levelWord(str(l, "Level")) ?? Level.Info, service, host: null, timeNs: msNs(num(l, "TimestampMs")) ?? at, fields: base });
  }
  for (const x of arr(r, "Exceptions")) {
    const name = str(x, "Name") ?? "Error";
    out.push({ message: `${name}: ${str(x, "Message") ?? ""}`.trim(), level: Level.Error, service, host: null, timeNs: msNs(num(x, "TimestampMs")) ?? at, fields: base });
  }
  const status = res ? num(res, "Status") : null;
  const what = req ? [str(req, "Method"), str(req, "URL")].filter(Boolean).join(" ") : (str(r, "EventType") ?? "invocation");
  const fields: EntryFields = { ...base };
  if (outcome) fields.outcome = outcome;
  if (status !== null) fields.status = status;
  const cpu = num(r, "CPUTimeMs");
  const wall = num(r, "WallTimeMs");
  if (cpu !== null) fields.cpu_ms = cpu;
  if (wall !== null) fields.wall_ms = wall;
  const level = outcome !== null && outcome !== WorkerOutcome.Ok ? (outcome === WorkerOutcome.Exception ? Level.Error : Level.Warn) : statusLevel(status);
  out.push({ message: [what, status === null ? null : String(status), outcome ? `outcome=${outcome}` : null].filter(Boolean).join(" "), level, service, host: null, timeNs: at, fields });
  return out;
}

function httpRequestEntry(r: Record<string, unknown>): DrainEntry {
  const status = num(r, "EdgeResponseStatus");
  const host = str(r, "ClientRequestHost");
  const fields: EntryFields = {};
  const ray = str(r, "RayID");
  if (ray) fields.ray_id = ray;
  if (status !== null) fields.status = status;
  const origin = num(r, "OriginResponseStatus");
  if (origin !== null) fields.origin_status = origin;
  const message = [str(r, "ClientRequestMethod"), `${host ?? ""}${str(r, "ClientRequestURI") ?? ""}`, status === null ? null : String(status), str(r, "CacheCacheStatus")]
    .filter((x) => x !== null && x !== "")
    .join(" ");
  return {
    message: message || JSON.stringify(r),
    level: statusLevel(status),
    service: host,
    host: str(r, "EdgeColoCode"),
    timeNs: anyTimeNs(r.EdgeStartTimestamp ?? r.EdgeEndTimestamp ?? null),
    fields,
  };
}

function otherEntry(r: Record<string, unknown>): DrainEntry {
  const t = r.Datetime ?? r.EventTimestampMs ?? r.Timestamp ?? r.When ?? r.EdgeStartTimestamp ?? null;
  return { message: JSON.stringify(r), level: null, service: null, host: null, timeNs: anyTimeNs(t) };
}

export function cloudflareEntries(r: Record<string, unknown>): DrainEntry[] {
  switch (datasetOf(r)) {
    case LogpushDataset.WorkersTrace:
      return workerEntries(r);
    case LogpushDataset.HttpRequests:
      return [httpRequestEntry(r)];
    case LogpushDataset.Other:
      return [otherEntry(r)];
  }
}

export const parseCloudflare: DrainParser = (body) => {
  const records = jsonObjects(body.toString("utf8"));
  if (records === null) return unreadable("body is not NDJSON of Logpush records");
  if (records.length > 0 && records.every(isTestRecord)) return parsed([], true);
  return parsed(records.filter((r) => !isTestRecord(r)).flatMap(cloudflareEntries));
};
