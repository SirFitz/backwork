// Strict parsing of hop records (spec 13.1) and linked-ID lines (spec LOG-5) out of log entries.
// This is the only module that reads untyped log content. Pure: no Loki or Remix.
import {
  HOP_KINDS,
  OUTCOMES,
  VIAS,
  type HopId,
  type HopKind,
  type HopRecord,
  type LinkedId,
  type NamedField,
  type Outcome,
  type StoreTotals,
  type TraceId,
  type TraceLogLine,
  Via,
} from "./types";
import { PATH_FIELD } from "./paths";
import { StoreField } from "./store-fields";
import { StatementField, isStatement, isTableName, recordPairs, splitStatement } from "./stmt";

/** One log entry as the Loki client returns it. */
export interface RawLogEntry {
  /** Epoch ms. */
  ts: number;
  line: string;
  labels: Readonly<Record<string, string>>;
}

/** A line longer than this is never a hop record (a full record is well under 2 KB). */
export const MAX_RECORD_LINE = 8192;
/** Containers log formatters use for structured fields (design 5.1). */
const NESTED_KEYS = ["metadata", "fields", "data", "context", "attributes"] as const;
/** Wrapper keys whose string value may itself be a JSON log line (Docker / logger envelopes). */
const ENVELOPE_KEYS = ["message", "log", "msg"] as const;
const MAX_NAMED_FIELDS = 8;
const MAX_VALUE_BYTES = 200;

type Scalar = string | number | boolean;
/** Flat view of the fields of one line, by name. Values are unvalidated. */
type FieldBag = ReadonlyMap<string, Scalar>;

// ---------------------------------------------------------------- validators (no backtracking, VAL-2)

function isLowerHex(s: string, len: number): boolean {
  if (s.length !== len) return false;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

function notAllZero(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s[i] !== "0") return true;
  return false;
}

/** 32 lowercase hex characters, not all zeros. */
export function isTraceId(value: unknown): value is TraceId {
  return typeof value === "string" && isLowerHex(value, 32) && notAllZero(value);
}

/** 16 lowercase hex characters, not all zeros. */
export function isHopId(value: unknown): value is HopId {
  return typeof value === "string" && isLowerHex(value, 16) && notAllZero(value);
}

/** 1 to 200 bytes, every byte in 0x21-0x7E (HOP-12). */
export function isPrintableValue(value: string, max = MAX_VALUE_BYTES): boolean {
  if (value.length < 1 || value.length > max) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

function isNameOf(value: string, max: number, extra: string): boolean {
  if (value.length < 1 || value.length > max) return false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const c = value.charCodeAt(i);
    const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || ch === "_" || extra.includes(ch);
    if (!ok) return false;
  }
  return true;
}

// ---------------------------------------------------------------- line -> field bag

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function tryJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trimStart();
  if (!t.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(t);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Top-level scalars first, then one level down under the nested keys; first value found wins. */
function bagFromJson(obj: Record<string, unknown>): Map<string, Scalar> {
  const bag = new Map<string, Scalar>();
  const take = (o: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(o)) if (isScalar(v) && !bag.has(k)) bag.set(k, v);
  };
  take(obj);
  for (const key of NESTED_KEYS) {
    const inner = obj[key];
    if (isRecord(inner)) take(inner);
  }
  return bag;
}

/** `key=value` pairs separated by spaces; other words (a timestamp, a level) are skipped.
 *  `stmt` is read first: everything after ` stmt=` to the end of the line (spec HOP-14). */
function bagFromKeyValue(line: string): Map<string, Scalar> {
  const bag = new Map<string, Scalar>();
  const split = splitStatement(line);
  const text = recordPairs(split.head);
  const stmt = split.stmt;
  if (stmt !== null) bag.set(StatementField.Stmt, stmt);
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
    const start = i;
    while (i < n && text[i] !== " " && text[i] !== "\t") i++;
    const word = text.slice(start, i);
    const eq = word.indexOf("=");
    if (eq > 0) {
      const key = word.slice(0, eq);
      let value = word.slice(eq + 1);
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (isNameOf(key, 64, "") && !bag.has(key)) bag.set(key, value);
    }
  }
  return bag;
}

/** Parse one line into its fields, or null when it is too long to be a record. */
export function fieldsOf(line: string): FieldBag | null {
  if (line.length > MAX_RECORD_LINE * 4) return null;
  const obj = tryJsonObject(line);
  if (obj) {
    const bag = bagFromJson(obj);
    if (bag.has("trace_id")) return bag;
    // An envelope whose message is itself a log line (JSON or key=value).
    for (const key of ENVELOPE_KEYS) {
      const inner = obj[key];
      if (typeof inner !== "string") continue;
      const innerObj = tryJsonObject(inner);
      const innerBag = innerObj ? bagFromJson(innerObj) : bagFromKeyValue(inner);
      if (innerBag.has("trace_id")) return innerBag;
    }
    return bag;
  }
  return bagFromKeyValue(line);
}

// ---------------------------------------------------------------- typed reads from a bag

function str(bag: FieldBag, key: string): string | null {
  const v = bag.get(key);
  if (v === undefined) return null;
  const s = typeof v === "string" ? v : String(v);
  return isPrintableValue(s) ? s : null;
}

function bool(bag: FieldBag, key: string): boolean | null {
  const v = bag.get(key);
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return null;
}

function int(bag: FieldBag, key: string, min: number, max: number): number | null {
  const v = bag.get(key);
  if (v === undefined) return null;
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.length > 0 && v.length <= 16) {
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c < 48 || c > 57) return null;
    }
    n = Number(v);
  } else return null;
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

function oneOf<T extends string>(bag: FieldBag, key: string, allowed: readonly T[]): T | null {
  const v = bag.get(key);
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function totalsOf(bag: FieldBag): StoreTotals | null {
  const dbCalls = int(bag, "db_n", 0, Number.MAX_SAFE_INTEGER);
  const dbUs = int(bag, "db_us", 0, Number.MAX_SAFE_INTEGER);
  const cacheCalls = int(bag, "cache_n", 0, Number.MAX_SAFE_INTEGER);
  const cacheUs = int(bag, "cache_us", 0, Number.MAX_SAFE_INTEGER);
  if (dbCalls === null && cacheCalls === null) return null;
  return {
    dbCalls: dbCalls ?? 0,
    dbUs: dbUs ?? 0,
    cacheCalls: cacheCalls ?? 0,
    cacheUs: cacheUs ?? 0,
    // Proposed HOP-25 and HOP-26: absent (not 0) when the service does not report them.
    cacheHits: int(bag, StoreField.CacheHits, 0, Number.MAX_SAFE_INTEGER),
    cacheMisses: int(bag, StoreField.CacheMisses, 0, Number.MAX_SAFE_INTEGER),
    dbWaitUs: int(bag, StoreField.DbWaitUs, 0, Number.MAX_SAFE_INTEGER),
  };
}

/** `wait_us` on a database end record (proposed HOP-26): whole microseconds, at most the call's
 *  own duration (a larger value is read as the duration, as the writer is told to cap it). */
function waitOf(bag: FieldBag, durationUs: number | null): number | null {
  const w = int(bag, StoreField.WaitUs, 0, Number.MAX_SAFE_INTEGER);
  if (w === null) return null;
  return durationUs !== null && w > durationUs ? durationUs : w;
}

function namedFieldsOf(bag: FieldBag): NamedField[] {
  const out: NamedField[] = [];
  for (const [key, raw] of bag) {
    if (!key.startsWith("f_")) continue;
    const name = key.slice(2);
    const value = typeof raw === "string" ? raw : String(raw);
    if (!isNameOf(name, 32, "") || !isPrintableValue(value)) continue;
    out.push({ name, value });
    if (out.length === MAX_NAMED_FIELDS) break;
  }
  return out;
}

/** `path` (HOP-24): 1 to 200 bytes of 0x21..0x7E, starting with `/`; null otherwise. */
function pathOf(bag: FieldBag): string | null {
  const v = bag.get(PATH_FIELD);
  return typeof v === "string" && v.startsWith("/") && isPrintableValue(v) ? v : null;
}

/** `table` (STM-5, HOP-12); null when absent or out of bounds. */
function tableOf(bag: FieldBag): string | null {
  const v = bag.get(StatementField.Table);
  return isTableName(v) ? v : null;
}

/** `stmt` (STM-4); null when absent or out of bounds. */
function stmtOf(bag: FieldBag): string | null {
  const v = bag.get(StatementField.Stmt);
  return isStatement(v) ? v : null;
}

function serviceOf(entry: RawLogEntry, bag: FieldBag): string {
  // The record's own service field wins: it is the name the developer set and the one that
  // travels between hops (BAC-49, live data 2026-11-12). The collector's label is the fallback.
  const own = str(bag, "service");
  if (own && isServiceName(own)) return own;
  const label = entry.labels.service;
  if (label && isPrintableValue(label)) return label;
  return "unknown";
}

/** A service name as a label value (spec HOP-12): 1 to 200 bytes of printable ASCII, no space. */
function isServiceName(value: string): boolean {
  return /^[\x21-\x7e]{1,200}$/.test(value);
}

/**
 * The collector's name for where a line came from: the `source` label; else the `source` field
 * of the stored JSON line (agents installed before BAC-49 get the field through the controls
 * poller but not the label until reinstalled); else, for lines stored before BAC-49, `service`.
 */
export function sourceOf(labels: Readonly<Record<string, string>>, line = ""): string | null {
  const ok = (v: unknown): v is string => typeof v === "string" && v !== "" && isPrintableValue(v);
  if (ok(labels.source)) return labels.source;
  if (line.startsWith("{") && line.includes('"source"')) {
    try {
      const body: unknown = JSON.parse(line);
      if (body && typeof body === "object" && ok((body as Record<string, unknown>).source)) return (body as Record<string, string>).source;
    } catch {
      /* not JSON: fall through */
    }
  }
  return ok(labels.service) ? labels.service : null;
}

const END_KINDS: readonly HopKind[] = ["in_end", "out_end"];
const OUT_KINDS: readonly HopKind[] = ["out", "out_end"];

/** Validate one log entry into a hop record (spec HOP-8), or null when it is not one. */
export function parseHopRecord(entry: RawLogEntry): HopRecord | null {
  if (entry.line.length > MAX_RECORD_LINE) return null;
  const bag = fieldsOf(entry.line);
  if (!bag) return null;
  const traceId = bag.get("trace_id");
  const hopId = bag.get("hop_id");
  const hop = oneOf<HopKind>(bag, "hop", HOP_KINDS);
  if (!isTraceId(traceId) || !isHopId(hopId) || !hop) return null;

  const parentRaw = bag.get("parent_hop");
  if (parentRaw !== undefined && !isHopId(parentRaw)) return null;
  const via = oneOf<Via>(bag, "via", VIAS);
  if (!via) return null;

  const isEnd = END_KINDS.includes(hop);
  const isOut = OUT_KINDS.includes(hop);
  const outcomeRaw = bag.get("outcome");
  const outcome = oneOf<Outcome>(bag, "outcome", OUTCOMES);
  if (outcomeRaw !== undefined && !outcome) return null;
  if (!Number.isFinite(entry.ts)) return null;

  const parentId = bag.get("parent_id");
  const durationUs = isEnd ? int(bag, "duration_us", 0, Number.MAX_SAFE_INTEGER) : null;
  const storeEnd = hop === "out_end";
  return {
    traceId,
    hop,
    hopId,
    parentHop: parentRaw === undefined ? null : (parentRaw as HopId),
    hopSent: isOut ? bool(bag, "hop_sent") ?? false : null,
    tracer: isOut ? bool(bag, "tracer") === true : false,
    handoff: isOut ? bool(bag, "handoff") === true : false,
    parentId: isHopId(parentId) ? parentId : null,
    service: serviceOf(entry, bag),
    source: sourceOf(entry.labels, entry.line),
    adapter: str(bag, "adapter"),
    via,
    method: str(bag, "method"),
    op: str(bag, "op"),
    path: via === Via.Http && !isOut ? pathOf(bag) : null,
    peer: isOut ? str(bag, "peer") : null,
    table: via === Via.Db && isOut ? tableOf(bag) : null,
    stmt: via === Via.Db && isOut ? stmtOf(bag) : null,
    attempt: isOut ? null : int(bag, "attempt", 1, 1_000_000),
    outcome: isEnd ? outcome : null,
    status: isEnd ? int(bag, "status", 100, 999) : null,
    error: isEnd ? str(bag, "error") : null,
    durationUs,
    hit: storeEnd && via === Via.Cache ? bool(bag, StoreField.Hit) : null,
    waitUs: storeEnd && via === Via.Db ? waitOf(bag, durationUs) : null,
    totals: hop === "in_end" ? totalsOf(bag) : null,
    fields: hop === "in_end" ? namedFieldsOf(bag) : [],
    timeMs: entry.ts,
  };
}

/** Validate one log entry into a linked ID (spec LOG-5), or null when it is not one. */
export function parseLinkLine(entry: RawLogEntry): LinkedId | null {
  if (entry.line.length > MAX_RECORD_LINE) return null;
  const bag = fieldsOf(entry.line);
  if (!bag) return null;
  const traceId = bag.get("trace_id");
  const name = bag.get("link_name");
  const value = bag.get("link_value");
  if (!isTraceId(traceId) || typeof name !== "string" || !isNameOf(name, 64, ".-")) return null;
  const valueStr = typeof value === "number" ? String(value) : value;
  if (typeof valueStr !== "string" || !isPrintableValue(valueStr)) return null;
  const hopId = bag.get("hop_id");
  if (hopId !== undefined && !isHopId(hopId)) return null;
  return {
    traceId,
    name,
    value: valueStr,
    hopId: hopId === undefined ? null : hopId,
    service: serviceOf(entry, bag),
    timeMs: entry.ts,
  };
}

/** The trace ID an ordinary log line carries (LOG-1), or null. */
export function traceIdOfLine(line: string): TraceId | null {
  if (line.length > MAX_RECORD_LINE * 4) return null;
  const bag = fieldsOf(line);
  const v = bag?.get("trace_id");
  return isTraceId(v) ? v : null;
}

const LEVEL_NAMES: Readonly<Record<string, string>> = {
  "10": "trace", "20": "debug", "30": "info", "40": "warn", "50": "error", "60": "fatal",
  warning: "warn", err: "error", critical: "error", notice: "info",
};

/** The readable message of a line: `msg` / `message` / `display`, unwrapping one envelope (Vector's JSON encoding). */
function messageOf(line: string): { message: string; level: string | null } {
  let obj = tryJsonObject(line);
  let message = line;
  let level: unknown = obj?.level ?? null;
  for (let depth = 0; obj && depth < 2; depth++) {
    const m = obj.msg ?? obj.message ?? obj.display;
    if (typeof m !== "string") break;
    message = m;
    const inner = tryJsonObject(m);
    if (!inner) break;
    obj = inner;
    level = inner.level ?? level;
  }
  return { message, level: level === null || level === undefined ? null : String(level) };
}

/** Terminal colour and cursor codes (ESC [ ... letter), as Nest's built-in logger writes them. */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** A log message as a person reads it: terminal colour codes removed. */
export function stripAnsi(text: string): string {
  return text.includes("\u001b") ? text.replace(ANSI_ESCAPE, "") : text;
}

/** An ordinary log line for the request view: level and readable message, never the raw JSON. */
export function toTraceLogLine(entry: RawLogEntry): TraceLogLine {
  const parsed = messageOf(entry.line);
  const rawLevel = parsed.level ?? entry.labels.level ?? null;
  const levelStr = rawLevel === null ? null : rawLevel.toLowerCase();
  const level = levelStr === null ? null : LEVEL_NAMES[levelStr] ?? levelStr.slice(0, 8);
  const service = entry.labels.service && isPrintableValue(entry.labels.service) ? entry.labels.service : "unknown";
  return { service, level, timeMs: entry.ts, line: stripAnsi(parsed.message).slice(0, 2000) };
}
