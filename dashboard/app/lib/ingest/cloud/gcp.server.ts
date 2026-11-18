/**
 * GCP (BAC-99): Cloud Logging sink -> Pub/Sub topic -> push subscription to backwork.
 *
 * Logging publishes one LogEntry per Pub/Sub message, as base64 JSON in `message.data`, with the
 * attribute `logging.googleapis.com/timestamp`. A push subscription POSTs
 * `{"message":{"data","attributes","messageId","message_id","publishTime","publish_time"},"subscription","deliveryAttempt"}`
 * (or, with payload unwrapping, the LogEntry itself as the body). Statuses 102, 200, 201, 202
 * and 204 acknowledge; anything else is redelivered.
 *
 * The token is in the push endpoint path: a push subscription cannot set custom headers, and its
 * Authorization header carries Google's own OIDC token when push authentication is on. That OIDC
 * token is not verified (optional hardening: check its signature against Google's keys, the
 * audience and the service account email).
 *
 * service: Cloud Run service_name / job_name, Cloud Functions function_name, App Engine
 * module_id, GKE container_name, else the log name; host: pod, instance, revision; level:
 * severity; time: timestamp (else receiveTimestamp, else the attribute).
 */
import { Level, rfc3339Ns } from "~/lib/ingest/records.server";
import { LineKind, classifyLine } from "~/lib/ingest/enforce.server";
import { num, obj, str, type DrainEntry, type EntryFields } from "~/lib/ingest/drains/entry.server";

/** Cloud Logging severities. */
export const Severity = {
  Default: "DEFAULT",
  Debug: "DEBUG",
  Info: "INFO",
  Notice: "NOTICE",
  Warning: "WARNING",
  Error: "ERROR",
  Critical: "CRITICAL",
  Alert: "ALERT",
  Emergency: "EMERGENCY",
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

const SEVERITY_LEVEL: Readonly<Record<Severity, Level | null>> = {
  [Severity.Default]: null,
  [Severity.Debug]: Level.Debug,
  [Severity.Info]: Level.Info,
  [Severity.Notice]: Level.Info,
  [Severity.Warning]: Level.Warn,
  [Severity.Error]: Level.Error,
  [Severity.Critical]: Level.Fatal,
  [Severity.Alert]: Level.Fatal,
  [Severity.Emergency]: Level.Fatal,
};

export function severityLevel(s: string | null): Level | null {
  if (s === null) return null;
  return (SEVERITY_LEVEL as Record<string, Level | null>)[s.toUpperCase()] ?? null;
}

export const PubSubAttribute = { Timestamp: "logging.googleapis.com/timestamp" } as const;

/** Statuses a push subscription treats as acknowledged. */
export const PUSH_ACK_STATUSES: readonly number[] = [102, 200, 201, 202, 204];

export interface PushMessage {
  /** The LogEntry (or other JSON) the message carried, or null when it is not JSON. */
  entry: Record<string, unknown> | null;
  attributes: Record<string, string>;
  messageId: string | null;
}

export type PushRead = { ok: true; message: PushMessage } | { ok: false; reason: string };

/** A push request body: the wrapped envelope, or an unwrapped LogEntry. */
export function readPush(text: string): PushRead {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, reason: "body is not JSON" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, reason: "body is not a JSON object" };
  const msg = obj(v, "message");
  if (!msg) {
    // Payload unwrapping: the body is the message data itself.
    return { ok: true, message: { entry: v as Record<string, unknown>, attributes: {}, messageId: null } };
  }
  const attrsRaw = obj(msg, "attributes") ?? {};
  const attributes = Object.fromEntries(Object.entries(attrsRaw).filter((e): e is [string, string] => typeof e[1] === "string"));
  const data = Buffer.from(str(msg, "data") ?? "", "base64").toString("utf8");
  let entry: Record<string, unknown> | null = null;
  try {
    const p: unknown = JSON.parse(data);
    if (typeof p === "object" && p !== null && !Array.isArray(p)) entry = p as Record<string, unknown>;
  } catch {
    entry = data.trim() === "" ? null : { textPayload: data };
  }
  return { ok: true, message: { entry, attributes, messageId: str(msg, "messageId") ?? str(msg, "message_id") } };
}

const SERVICE_LABELS = ["service_name", "job_name", "function_name", "module_id", "container_name", "configuration_name"] as const;
const HOST_LABELS = ["pod_name", "instance_id", "revision_name", "zone", "location", "region"] as const;

function firstLabel(labels: Record<string, unknown> | null, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = str(labels, k);
    if (v) return v;
  }
  return null;
}

/** The short log name: projects/p/logs/run.googleapis.com%2Fstdout -> run.googleapis.com/stdout. */
export function shortLogName(logName: string | null): string | null {
  if (!logName) return null;
  const i = logName.indexOf("/logs/");
  const raw = i < 0 ? logName : logName.slice(i + 6);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** projects/p/traces/<id> -> <id>. */
function traceId(trace: string | null): string | null {
  if (!trace) return null;
  const i = trace.lastIndexOf("/");
  return i < 0 ? trace : trace.slice(i + 1);
}

function hasOwnLevel(o: Record<string, unknown>): boolean {
  return ["level", "lvl", "severity"].some((k) => k in o);
}

/** The DrainEntry for one LogEntry. */
export function logEntryToEntry(e: Record<string, unknown>, attributes: Readonly<Record<string, string>> = {}): DrainEntry | null {
  const resource = obj(e, "resource");
  const labels = resource ? obj(resource, "labels") : null;
  const entryLabels = obj(e, "labels");
  const level = severityLevel(str(e, "severity"));
  const http = obj(e, "httpRequest");
  const fields: EntryFields = {};
  const trace = traceId(str(e, "trace"));
  if (trace) fields.trace_id = trace;
  const span = str(e, "spanId");
  if (span) fields.span_id = span;
  const status = http ? num(http, "status") : null;
  if (status !== null) fields.status = status;
  const logName = shortLogName(str(e, "logName"));
  if (logName) fields.log = logName;

  let message: string | null = str(e, "textPayload");
  let entryLevel: Level | null = level;
  const json = obj(e, "jsonPayload");
  const proto = obj(e, "protoPayload");
  if (message === null && json) {
    // The app's structured line: kept as JSON with the severity as its level, unless it is a
    // Correlator hop record or link line (kept exactly) or already says its level.
    const raw = JSON.stringify(json);
    if (classifyLine(raw).kind !== LineKind.Log || hasOwnLevel(json) || level === null) message = raw;
    else message = JSON.stringify({ level, ...json, ...fields });
    entryLevel = null;
  } else if (message === null && proto) {
    message = JSON.stringify(proto);
  } else if (message === null && http) {
    message = [str(http, "requestMethod"), str(http, "requestUrl"), status === null ? null : String(status), str(http, "latency")].filter(Boolean).join(" ");
  }
  if (message === null || message.trim() === "") return null;

  return {
    message: message.replace(/\n$/, ""),
    level: entryLevel,
    service: firstLabel(labels, SERVICE_LABELS) ?? logName ?? str(resource, "type"),
    host: str(entryLabels, "instanceId") ?? firstLabel(labels, HOST_LABELS),
    timeNs: rfc3339Ns(str(e, "timestamp") ?? "") ?? rfc3339Ns(str(e, "receiveTimestamp") ?? "") ?? rfc3339Ns(attributes[PubSubAttribute.Timestamp] ?? ""),
    fields,
  };
}
