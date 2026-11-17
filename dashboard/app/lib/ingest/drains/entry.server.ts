/**
 * What every platform parser produces (BAC-98), and how its entries become intake lines for the
 * records pipeline (records.server.ts). Platform metadata goes where the pipeline already reads
 * it: service and host as labels, the event time as the line time, and the level, request and
 * trace IDs inside the stored line, in the shape the collectors read for level and display text
 * (`{"level","msg",...}`, as OTLP records are stored).
 */
import { gunzipSync } from "node:zlib";
import { LineKind, classifyLine } from "~/lib/ingest/enforce.server";
import { Level, MAX_BODY_BYTES, lineTimeNs, validLabel, type IntakeLine, type LineOrigin } from "~/lib/ingest/records.server";

/** Context kept in a structured line next to level and msg. */
export type EntryFields = Record<string, string | number>;

/** One log event from a platform. */
export interface DrainEntry {
  message: string;
  /** The level the platform states, or null to let the collector read it from the line. */
  level: Level | null;
  service: string | null;
  host: string | null;
  /** Unix nanoseconds of the event, when the platform sends one. */
  timeNs: bigint | null;
  fields?: EntryFields;
}

export type DrainParse =
  | { ok: true; entries: DrainEntry[]; /** A platform's set-up test request: answer 200, store nothing. */ test: boolean }
  | { ok: false; reason: string };

/** A platform parser: the (unpacked) body and the request headers to entries. */
export type DrainParser = (body: Buffer, headers: Headers) => DrainParse;

export function parsed(entries: DrainEntry[], test = false): DrainParse {
  return { ok: true, entries, test };
}

export function unreadable(reason: string): DrainParse {
  return { ok: false, reason };
}

const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** Gunzip a body that is gzip without saying so (Cloudflare Logpush), within the size limit.
 *  Null when it is gzip but corrupt or too large unpacked. */
export function unpacked(bytes: Buffer, limit: number = MAX_BODY_BYTES): Buffer | null {
  if (bytes.length < 2 || bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) return bytes;
  try {
    return gunzipSync(bytes, { maxOutputLength: limit });
  } catch {
    return null;
  }
}

/** JSON objects from a body that is a JSON array, one JSON object, or NDJSON. Lines that do not
 *  parse to an object are skipped. Null when the body is a JSON array that does not parse. */
export function jsonObjects(text: string): Record<string, unknown>[] | null {
  const t = text.trim();
  if (t === "") return [];
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (t.startsWith("[")) {
    try {
      const v: unknown = JSON.parse(t);
      return Array.isArray(v) ? v.filter(isObject) : null;
    } catch {
      return null;
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const line of t.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObject(v)) out.push(v);
    } catch {
      /* not JSON: skipped */
    }
  }
  return out;
}

/** Typed reads from an untyped platform object. */
export function str(o: unknown, key: string): string | null {
  if (typeof o !== "object" || o === null) return null;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : null;
}

export function num(o: unknown, key: string): number | null {
  if (typeof o !== "object" || o === null) return null;
  const v = (o as Record<string, unknown>)[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function obj(o: unknown, key: string): Record<string, unknown> | null {
  if (typeof o !== "object" || o === null) return null;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function arr(o: unknown, key: string): unknown[] {
  if (typeof o !== "object" || o === null) return [];
  const v = (o as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : [];
}

/** Unix nanoseconds from a millisecond count. */
export function msNs(ms: number | null): bigint | null {
  return ms === null || !Number.isFinite(ms) || ms <= 0 ? null : BigInt(Math.round(ms)) * 1_000_000n;
}

/** Unix nanoseconds from a number whose unit is read from its size (s, ms, µs or ns), a numeric
 *  string, or an RFC 3339 string (Cloudflare's timestamp_format: unixnano, unix or rfc3339). */
export function anyTimeNs(v: unknown): bigint | null {
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{1,20}$/.test(s)) {
      const n = BigInt(s);
      if (n === 0n) return null;
      return n >= 10n ** 17n ? n : n >= 10n ** 14n ? n * 1000n : n >= 10n ** 11n ? n * 1_000_000n : n * 1_000_000_000n;
    }
    return lineTimeNs(s);
  }
  // A JSON number above 2^53 (unixnano) has lost its last digits already; it is still exact to
  // well under a microsecond.
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  if (v >= 1e17) return BigInt(Math.round(v / 1000)) * 1000n;
  if (v >= 1e14) return BigInt(Math.round(v)) * 1000n;
  if (v >= 1e11) return BigInt(Math.round(v)) * 1_000_000n;
  return BigInt(Math.round(v * 1000)) * 1_000_000n;
}

/** A level word from a platform (info, warning, err, critical, log, ...), or null. */
export function levelWord(v: string | null): Level | null {
  if (v === null) return null;
  const t = v.trim().toLowerCase();
  if (t === "") return null;
  if (t.startsWith("fatal") || t === "critical" || t === "crit" || t === "emerg" || t === "emergency" || t === "alert" || t === "panic") return Level.Fatal;
  if (t.startsWith("err")) return Level.Error;
  if (t.startsWith("warn")) return Level.Warn;
  if (t.startsWith("debug")) return Level.Debug;
  if (t.startsWith("trace")) return Level.Trace;
  if (t === "info" || t === "log" || t === "notice" || t === "information") return Level.Info;
  return null;
}

/** The level of an HTTP status: 5xx error, 4xx warn, else info. */
export function statusLevel(status: number | null): Level {
  if (status !== null && status >= 500) return Level.Error;
  if (status !== null && status >= 400) return Level.Warn;
  return Level.Info;
}

/** True when a message is a JSON object carrying its own level (an app's structured logger). */
function hasOwnLevel(message: string): boolean {
  if (!message.startsWith("{")) return false;
  try {
    const v: unknown = JSON.parse(message);
    return typeof v === "object" && v !== null && ["level", "lvl", "severity"].some((k) => k in (v as object));
  } catch {
    return false;
  }
}

/**
 * The stored line for an entry. A Correlator hop record or link line, or a structured line with
 * its own level, is kept as written (so it is detected, counted and read as the app wrote it); a
 * line with a platform level becomes `{"level","msg",...fields}`; any other line is kept as is,
 * and the collector reads its level from the text.
 */
export function entryLine(e: DrainEntry): string {
  if (classifyLine(e.message).kind !== LineKind.Log || hasOwnLevel(e.message) || e.level === null) return e.message;
  return JSON.stringify({ level: e.level, msg: e.message, ...(e.fields ?? {}) });
}

/**
 * Intake lines for a platform's entries. A service or host named on the request (?service=,
 * x-backwork-service) wins over the platform's; entries with neither get FALLBACK_SERVICE.
 * Times outside the window are replaced in linesToStreams.
 */
export function entriesToLines(entries: readonly DrainEntry[], origin: LineOrigin, fallbackService: string): IntakeLine[] {
  return entries
    .filter((e) => e.message.trim() !== "")
    .map((e) => ({
      line: entryLine(e),
      service: origin.service ?? (validLabel(e.service) ? e.service : fallbackService),
      host: origin.host ?? (validLabel(e.host) ? e.host : null),
      timeNs: e.timeNs,
    }));
}
