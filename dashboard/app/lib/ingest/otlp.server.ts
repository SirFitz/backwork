/**
 * OTLP/HTTP logs (BAC-97): ExportLogsServiceRequest as protobuf or JSON, decoded into plain typed
 * records and turned into the lines the records intake (BAC-96) takes. Pure: no I/O.
 *
 * Mapping, per record:
 *  - service: the resource's `service.name`; host: `host.name`.
 *  - level: SeverityNumber (1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17-20 error, 21-24 fatal),
 *    else the severity text, else info.
 *  - the stored line: a body that is itself a Correlator hop record or link line is kept as is (so
 *    it is detected and counted like any other); anything else becomes one JSON line
 *    `{"level", "msg", "trace_id", "span_id", "attributes"}`, which the collectors read for level
 *    and display text, and whose trace_id links the line to its request.
 *  - time: timeUnixNano, else observedTimeUnixNano, else the receive time.
 *
 * Wire format: opentelemetry-proto, logs/v1 and common/v1 (the fields read here). Protobuf is
 * decoded by protobufjs (pinned) from the schema below; JSON follows the OTLP/JSON rules (lower
 * camel case keys, trace and span IDs as hex, 64-bit integers as strings or numbers).
 */
import protobuf from "protobufjs";
import { LineKind, classifyLine } from "~/lib/ingest/enforce.server";
import { Level, timeWithin, type IntakeLine } from "~/lib/ingest/records.server";

/** Content types an OTLP/HTTP exporter sends. */
export const OtlpContentType = { Protobuf: "application/x-protobuf", Json: "application/json" } as const;
export type OtlpContentType = (typeof OtlpContentType)[keyof typeof OtlpContentType];

export function otlpContentType(header: string | null): OtlpContentType | null {
  const ct = (header || "").split(";")[0].trim().toLowerCase();
  if (ct === OtlpContentType.Protobuf || ct === "application/protobuf") return OtlpContentType.Protobuf;
  if (ct === OtlpContentType.Json) return OtlpContentType.Json;
  return null;
}

/** An attribute or body value, as OTLP's AnyValue. */
export type AnyValue = string | number | boolean | null | AnyValue[] | { [key: string]: AnyValue };

export interface OtlpLogRecord {
  /** Unix nanoseconds; null when the record has none. */
  timeNs: bigint | null;
  severityNumber: number;
  severityText: string;
  body: AnyValue;
  attributes: Record<string, AnyValue>;
  /** Lower-case hex, "" when absent. */
  traceId: string;
  spanId: string;
}

export interface OtlpResourceLogs {
  resource: Record<string, AnyValue>;
  records: OtlpLogRecord[];
}

// ---------------------------------------------------------------------------
// Protobuf
// ---------------------------------------------------------------------------

const KV = { fields: { key: { type: "string", id: 1 }, value: { type: "AnyValue", id: 2 } } };
const SCHEMA = {
  nested: {
    otlp: {
      nested: {
        ExportLogsServiceRequest: { fields: { resourceLogs: { rule: "repeated", type: "ResourceLogs", id: 1 } } },
        ResourceLogs: { fields: { resource: { type: "Resource", id: 1 }, scopeLogs: { rule: "repeated", type: "ScopeLogs", id: 2 }, schemaUrl: { type: "string", id: 3 } } },
        Resource: { fields: { attributes: { rule: "repeated", type: "KeyValue", id: 1 }, droppedAttributesCount: { type: "uint32", id: 2 } } },
        ScopeLogs: { fields: { scope: { type: "InstrumentationScope", id: 1 }, logRecords: { rule: "repeated", type: "LogRecord", id: 2 }, schemaUrl: { type: "string", id: 3 } } },
        InstrumentationScope: { fields: { name: { type: "string", id: 1 }, version: { type: "string", id: 2 }, attributes: { rule: "repeated", type: "KeyValue", id: 3 }, droppedAttributesCount: { type: "uint32", id: 4 } } },
        LogRecord: {
          fields: {
            timeUnixNano: { type: "fixed64", id: 1 },
            observedTimeUnixNano: { type: "fixed64", id: 11 },
            severityNumber: { type: "int32", id: 2 },
            severityText: { type: "string", id: 3 },
            body: { type: "AnyValue", id: 5 },
            attributes: { rule: "repeated", type: "KeyValue", id: 6 },
            droppedAttributesCount: { type: "uint32", id: 7 },
            flags: { type: "fixed32", id: 8 },
            traceId: { type: "bytes", id: 9 },
            spanId: { type: "bytes", id: 10 },
            eventName: { type: "string", id: 12 },
          },
        },
        KeyValue: KV,
        AnyValue: {
          oneofs: { value: { oneof: ["stringValue", "boolValue", "intValue", "doubleValue", "arrayValue", "kvlistValue", "bytesValue"] } },
          fields: {
            stringValue: { type: "string", id: 1 },
            boolValue: { type: "bool", id: 2 },
            intValue: { type: "int64", id: 3 },
            doubleValue: { type: "double", id: 4 },
            arrayValue: { type: "ArrayValue", id: 5 },
            kvlistValue: { type: "KeyValueList", id: 6 },
            bytesValue: { type: "bytes", id: 7 },
          },
        },
        ArrayValue: { fields: { values: { rule: "repeated", type: "AnyValue", id: 1 } } },
        KeyValueList: { fields: { values: { rule: "repeated", type: "KeyValue", id: 1 } } },
      },
    },
  },
};

const Request = protobuf.Root.fromJSON(SCHEMA).lookupType("otlp.ExportLogsServiceRequest");

/** Decode a protobuf body into the same plain shape OTLP/JSON has (hex IDs, string 64-bit ints). */
export function decodeProtobuf(bytes: Uint8Array): unknown {
  const msg = Request.decode(bytes);
  return Request.toObject(msg, { longs: String, bytes: Array, defaults: false, oneofs: false });
}

// ---------------------------------------------------------------------------
// The untyped edge: protobuf's plain object or JSON, validated into typed records
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Thrown for a body that is not an ExportLogsServiceRequest. */
export class OtlpFormatError extends Error {}

/** IDs: bytes (protobuf, as a number array) or hex (JSON). Base64 is accepted too, as some JSON
 *  encoders write bytes that way. Returns lower-case hex of the expected length, or "". */
function idHex(v: unknown, bytes: number): string {
  let hex = "";
  if (Array.isArray(v)) hex = Buffer.from(v.filter((n): n is number => typeof n === "number")).toString("hex");
  else if (typeof v === "string" && v !== "") {
    if (/^[0-9a-fA-F]+$/.test(v) && v.length === bytes * 2) hex = v.toLowerCase();
    else {
      const b = Buffer.from(v, "base64");
      if (b.length === bytes) hex = b.toString("hex");
    }
  }
  return hex.length === bytes * 2 && !/^0+$/.test(hex) ? hex : "";
}

function nanos(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^\d+$/.test(v) && v !== "0") return BigInt(v);
  return null;
}

function anyValue(v: unknown, depth = 0): AnyValue {
  if (!isObj(v) || depth > 8) return null;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (v.intValue !== undefined && v.intValue !== null) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : String(v.intValue);
  }
  if (v.doubleValue !== undefined && v.doubleValue !== null) return Number(v.doubleValue);
  if (isObj(v.arrayValue)) return arr(v.arrayValue.values).map((x) => anyValue(x, depth + 1));
  if (isObj(v.kvlistValue)) return keyValues(v.kvlistValue.values, depth + 1);
  if (v.bytesValue !== undefined && v.bytesValue !== null) {
    return Array.isArray(v.bytesValue) ? Buffer.from(v.bytesValue as number[]).toString("base64") : str(v.bytesValue);
  }
  return null;
}

function keyValues(list: unknown, depth = 0): Record<string, AnyValue> {
  const out: Record<string, AnyValue> = {};
  for (const kv of arr(list)) if (isObj(kv) && typeof kv.key === "string") out[kv.key] = anyValue(kv.value, depth);
  return out;
}

/** The typed records of a decoded request (protobuf plain object or parsed JSON). */
export function readRequest(body: unknown): OtlpResourceLogs[] {
  if (!isObj(body)) throw new OtlpFormatError("not an ExportLogsServiceRequest");
  const rls = body.resourceLogs ?? body.resource_logs;
  if (rls !== undefined && !Array.isArray(rls)) throw new OtlpFormatError("resourceLogs is not a list");
  return arr(rls).filter(isObj).map((rl) => ({
    resource: keyValues(isObj(rl.resource) ? rl.resource.attributes : []),
    records: arr(rl.scopeLogs ?? rl.scope_logs).filter(isObj).flatMap((sl) =>
      arr(sl.logRecords ?? sl.log_records).filter(isObj).map((r): OtlpLogRecord => ({
        timeNs: nanos(r.timeUnixNano) ?? nanos(r.observedTimeUnixNano),
        severityNumber: typeof r.severityNumber === "number" ? r.severityNumber : Number(r.severityNumber) || 0,
        severityText: str(r.severityText),
        body: anyValue(r.body),
        attributes: keyValues(r.attributes),
        traceId: idHex(r.traceId, 16),
        spanId: idHex(r.spanId, 8),
      })),
    ),
  }));
}

/** Decode a body of either content type. Throws OtlpFormatError when it is not a request. */
export function decodeRequest(bytes: Buffer, type: OtlpContentType): OtlpResourceLogs[] {
  let plain: unknown;
  try {
    plain = type === OtlpContentType.Protobuf ? decodeProtobuf(bytes) : JSON.parse(bytes.toString("utf8"));
  } catch (e: unknown) {
    throw new OtlpFormatError(`unreadable ${type === OtlpContentType.Protobuf ? "protobuf" : "JSON"}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return readRequest(plain);
}

// ---------------------------------------------------------------------------
// Records -> intake lines
// ---------------------------------------------------------------------------

export { Level } from "~/lib/ingest/records.server";

/** OTel SeverityNumber ranges, then the severity text, then info. */
export function levelOf(severityNumber: number, severityText: string): Level {
  const n = severityNumber;
  if (n >= 21 && n <= 24) return Level.Fatal;
  if (n >= 17) return n <= 20 ? Level.Error : Level.Info;
  if (n >= 13) return Level.Warn;
  if (n >= 9) return Level.Info;
  if (n >= 5) return Level.Debug;
  if (n >= 1) return Level.Trace;
  const t = severityText.trim().toLowerCase();
  if (t.startsWith("fatal") || t === "critical" || t === "crit" || t === "emergency" || t === "alert") return Level.Fatal;
  if (t.startsWith("err")) return Level.Error;
  if (t.startsWith("warn")) return Level.Warn;
  if (t.startsWith("debug")) return Level.Debug;
  if (t.startsWith("trace")) return Level.Trace;
  return Level.Info;
}

export const ResourceAttr = { ServiceName: "service.name", HostName: "host.name" } as const;

function text(v: AnyValue): string {
  return typeof v === "string" ? v : v === null ? "" : JSON.stringify(v);
}

/** The stored line for one record. */
export function lineOf(r: OtlpLogRecord): string {
  const body = text(r.body);
  // A Correlator hop record or link line logged through OpenTelemetry: keep it as written.
  if (typeof r.body === "string" && classifyLine(body).kind !== LineKind.Log) return body;
  const line: Record<string, AnyValue> = { level: levelOf(r.severityNumber, r.severityText), msg: body };
  if (r.traceId) line.trace_id = r.traceId;
  if (r.spanId) line.span_id = r.spanId;
  if (Object.keys(r.attributes).length > 0) line.attributes = r.attributes;
  return JSON.stringify(line);
}

export { TIME_WINDOW_NS } from "~/lib/ingest/records.server";

/** Intake lines for a request: service and host from each resource. */
export function toIntakeLines(resources: readonly OtlpResourceLogs[], nowNs: bigint): IntakeLine[] {
  return resources.flatMap((rl) => {
    const service = text(rl.resource[ResourceAttr.ServiceName] ?? null) || null;
    const host = text(rl.resource[ResourceAttr.HostName] ?? null) || null;
    return rl.records.map((r): IntakeLine => ({ line: lineOf(r), service, host, timeNs: timeWithin(r.timeNs, nowNs) }));
  });
}
