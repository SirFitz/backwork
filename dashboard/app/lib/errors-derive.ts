/**
 * Error events derived from what ingest already sees (BAC-85): error-level log lines and
 * inbound requests that ended with a 5xx status. Pure: no I/O, so the ingest proxy can call
 * it on every line of a push.
 */
import { createHash } from "node:crypto";

import { ErrorLevel, ErrorSource, LogLevel } from "~/lib/error-kinds";

export { ERROR_SOURCES, ErrorLevel, ErrorSource, LogLevel, isErrorSource } from "~/lib/error-kinds";

const LEVEL_ALIASES: Readonly<Record<string, LogLevel>> = {
  "10": LogLevel.Trace, "20": LogLevel.Debug, "30": LogLevel.Info, "40": LogLevel.Warn, "50": LogLevel.Error, "60": LogLevel.Fatal,
  trace: LogLevel.Trace, debug: LogLevel.Debug, info: LogLevel.Info, notice: LogLevel.Info,
  warn: LogLevel.Warn, warning: LogLevel.Warn,
  error: LogLevel.Error, err: LogLevel.Error, critical: LogLevel.Fatal, crit: LogLevel.Fatal,
  fatal: LogLevel.Fatal, panic: LogLevel.Fatal, emergency: LogLevel.Fatal, alert: LogLevel.Fatal,
};

/** A level as a logger wrote it (a name in any case, or a pino number) → its LogLevel, or null. */
export function toLogLevel(v: unknown): LogLevel | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  return LEVEL_ALIASES[String(v).trim().toLowerCase()] ?? null;
}

export function isErrorLevel(l: LogLevel | null): l is typeof LogLevel.Error | typeof LogLevel.Fatal {
  return l === LogLevel.Error || l === LogLevel.Fatal;
}

/** One occurrence of a derived error, before it is grouped and written. */
export interface DerivedError {
  source: typeof ErrorSource.Log | typeof ErrorSource.Request;
  fingerprint: string;
  /** Group title: the normalised message, or `METHOD route → status`. */
  title: string;
  /** Short kind shown beside the level: the logger's error name, or `HTTP 500`. */
  type: string;
  service: string;
  level: ErrorLevel;
  /** The occurrence's own text (after the sensitive-data filter), shown under recent occurrences. */
  message: string;
  traceId: string | null;
  /** Request-derived only. */
  method: string | null;
  route: string | null;
  status: number | null;
  /** Epoch ms of the line. */
  at: number;
}

const MAX_TITLE = 300;
const MAX_MESSAGE = 2000;

// Order matters: wider shapes first, so a timestamp's digits are not read as numbers.
const NORMALISERS: ReadonlyArray<readonly [RegExp, string]> = [
  // ISO-8601 / RFC 3339 timestamps and plain date-times
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<time>"],
  [/\b\d{4}-\d{2}-\d{2}\b/g, "<date>"],
  [/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>"],
  // e-mail addresses
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "<email>"],
  // UUIDs, then 32-hex trace ids and other long hex runs
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "<uuid>"],
  [/\b0x[0-9a-fA-F]+\b/g, "<hex>"],
  [/\b[0-9a-fA-F]{16,}\b/g, "<id>"],
  // IPv4 (with optional port) and IPv6
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "<ip>"],
  [/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, "<ip>"],
  // quoted values
  [/"(?:[^"\\]|\\.)*"/g, '"<str>"'],
  [/'(?:[^'\\]|\\.)*'/g, "'<str>'"],
  // random-looking tokens: 8+ letters/digits with at least one of each (ULIDs, nanoids, hashed file names)
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{8,}\b/g, "<id>"],
  // any remaining number
  [/\b\d+(?:[.,]\d+)*\b/g, "<n>"],
];

/** Terminal colour and cursor codes (ESC [ ... letter). */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** A leading level tag such as `[error]`, `ERROR:` or `[ERR]`: the level badge already says it. */
const LEADING_LEVEL = /^\s*(?:\[(?:fatal|error|err|crit(?:ical)?|panic)\]|(?:fatal|error|err|crit(?:ical)?|panic):)\s*/i;

/** A message with what varies between occurrences replaced by placeholders, so repeats group. */
export function normaliseMessage(message: string): string {
  let m = message.replace(ANSI_ESCAPE, "").replace(LEADING_LEVEL, "");
  for (const [re, to] of NORMALISERS) m = m.replace(re, to);
  return m.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

/** A request path with ids replaced, for routes without an `op` template. Query strings are dropped. */
export function normalisePath(path: string): string {
  const bare = path.split("?")[0] || "/";
  return bare
    .split("/")
    .map((seg) => (seg === "" ? seg : normaliseSegment(seg)))
    .join("/")
    .slice(0, MAX_TITLE);
}

function normaliseSegment(seg: string): string {
  const dot = seg.lastIndexOf(".");
  // keep a file extension readable: /RSC/<id>.txt
  if (dot > 0 && /^[A-Za-z0-9]{1,5}$/.test(seg.slice(dot + 1))) return `${normaliseSegment(seg.slice(0, dot))}${seg.slice(dot)}`;
  if (/^\d+$/.test(seg)) return ":n";
  if (/^[0-9a-fA-F-]{16,}$/.test(seg)) return ":id";
  if (seg.length >= 8 && /\d/.test(seg) && /[A-Za-z]/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg)) return ":id";
  return seg;
}

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

export function logFingerprint(service: string, normalised: string): string {
  return `log:${hash([service, normalised])}`;
}

export function requestFingerprint(service: string, method: string, route: string): string {
  return `request:${hash([service, method.toUpperCase(), route])}`;
}

type Fields = Record<string, unknown>;

function isObject(v: unknown): v is Fields {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The readable message of a JSON log line (pino, winston, bunyan, Vector's envelope), else the line. */
function readableOf(line: string): { text: string; level: unknown; errorName: string | null } {
  if (!line.startsWith("{")) return { text: line, level: null, errorName: null };
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { text: line, level: null, errorName: null };
  }
  if (!isObject(obj)) return { text: line, level: null, errorName: null };
  const err = isObject(obj.err) ? obj.err : isObject(obj.error) ? obj.error : null;
  const msg = obj.msg ?? obj.message ?? (err ? err.message : undefined);
  const name = err && typeof err.type === "string" ? err.type : err && typeof err.name === "string" ? err.name : null;
  return { text: typeof msg === "string" && msg !== "" ? msg : line, level: obj.level ?? obj.severity ?? null, errorName: name };
}

const TRACE_RE = /^[0-9a-f]{32}$/;

export interface LogLineInput {
  /** The line after the switches and the sensitive-data filter. */
  line: string;
  service: string;
  /** Level from the stream labels or the envelope, if any. */
  level: unknown;
  /** Trace id the line carries, if any. */
  traceId: unknown;
  at: number;
}

/** An error event from an ordinary log line, or null when the line is not error- or fatal-level. */
export function fromLogLine(input: LogLineInput): DerivedError | null {
  const r = readableOf(input.line);
  const level = toLogLevel(input.level) ?? toLogLevel(r.level);
  if (!isErrorLevel(level)) return null;
  const title = normaliseMessage(r.text) || "(empty message)";
  const service = input.service || "unknown";
  return {
    source: ErrorSource.Log,
    fingerprint: logFingerprint(service, title),
    title,
    type: (r.errorName ?? (level === LogLevel.Fatal ? "Fatal" : "Error")).slice(0, 200),
    service,
    level: level === LogLevel.Fatal ? ErrorLevel.Fatal : ErrorLevel.Error,
    message: r.text.replace(ANSI_ESCAPE, "").slice(0, MAX_MESSAGE),
    traceId: typeof input.traceId === "string" && TRACE_RE.test(input.traceId) ? input.traceId : null,
    method: null,
    route: null,
    status: null,
    at: input.at,
  };
}

export interface HopEndInput {
  /** Fields of the inbound end record after field stripping and the filter. */
  fields: Fields;
  service: string;
  /** Whether `path` may be used (the Request paths switch). */
  pathsOn: boolean;
  at: number;
}

const UNKNOWN_ROUTE = "(unknown route)";

/** An error event from an inbound end record with a 5xx status, or null. */
export function fromHopEnd(input: HopEndInput): DerivedError | null {
  const f = input.fields;
  if (f.hop !== "in_end") return null;
  const status = typeof f.status === "number" ? f.status : typeof f.status === "string" ? Number.parseInt(f.status, 10) : NaN;
  if (!Number.isInteger(status) || status < 500 || status > 599) return null;
  const method = typeof f.method === "string" && f.method !== "" ? f.method.toUpperCase().slice(0, 16) : f.via === "rpc" ? "RPC" : "REQ";
  const op = typeof f.op === "string" && f.op !== "" ? f.op : null;
  const path = input.pathsOn && typeof f.path === "string" && f.path !== "" ? normalisePath(f.path) : null;
  const route = (op ?? path ?? UNKNOWN_ROUTE).slice(0, MAX_TITLE);
  const service = (typeof f.service === "string" && f.service !== "" ? f.service : input.service) || "unknown";
  const errName = typeof f.error === "string" && f.error !== "" ? f.error.slice(0, 200) : null;
  const title = `${method} ${route} → ${status}`;
  const traceId = typeof f.trace_id === "string" && TRACE_RE.test(f.trace_id) ? f.trace_id : null;
  return {
    source: ErrorSource.Request,
    fingerprint: requestFingerprint(service, method, route),
    title,
    type: `HTTP ${status}`,
    service,
    level: ErrorLevel.Error,
    message: errName ? `${title} (${errName})` : title,
    traceId,
    method,
    route,
    status,
    at: input.at,
  };
}
