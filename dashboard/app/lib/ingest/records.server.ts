/**
 * The records intake (BAC-96): newline-delimited text lines (Correlator hop records, link lines
 * and a service's own log lines) posted with a project ingest token, with no agent on the host.
 * This module is the pure part: reading the request, splitting the body and shaping the lines
 * into the streams enforceStreams takes and the events the stack collector's `records` input
 * takes. The I/O is in records-intake.server.ts.
 */
import { gunzipSync } from "node:zlib";
import { RecordField, type RecordEvent } from "~/lib/agent/vector-config.server";
import { Feature, type CollectorFeature } from "~/lib/controls.server";
import { LineKind, classifyLine, type LokiStream } from "~/lib/ingest/enforce.server";
import type { IngestTenant } from "~/lib/ingest/stored.server";

/** Request headers the intake reads. */
export const IntakeHeader = {
  /** The service the posted lines belong to (hop records keep their own `service` field). */
  Service: "x-backwork-service",
  /** The host they came from (optional). */
  Host: "x-backwork-host",
  /** The ingest token, for clients that cannot set Authorization (OTEL_EXPORTER_OTLP_HEADERS). */
  Token: "x-backwork-token",
} as const;
export type IntakeHeader = (typeof IntakeHeader)[keyof typeof IntakeHeader];

/** Query parameters with the same meaning, for clients configured by URL alone
 *  (CORRELATOR_RECORD_SINK=https://backwork.dev/ingest/records?service=shop-api). */
export const IntakeQuery = { Service: "service", Host: "host" } as const;
export type IntakeQuery = (typeof IntakeQuery)[keyof typeof IntakeQuery];

/** Largest body accepted, before and after gzip. Correlator posts 500 lines at most. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Most lines in one post. */
export const MAX_LINES = 20_000;
/** Service name for ordinary lines when the post names none, as the collectors use. */
export const UNKNOWN_SERVICE = "unknown";

/** A valid label value (HOP-12), the rule the collectors apply. */
const LABEL_RE = /^[\x21-\x7e]{1,200}$/;

export function validLabel(v: unknown): v is string {
  return typeof v === "string" && LABEL_RE.test(v);
}

/**
 * The ingest token: `Authorization: Bearer <token>`, the `x-backwork-token` header, or HTTP Basic
 * with the token as the user name or the password (a URL with the token in its user info, which
 * Node's http client turns into Basic, so a client configured by URL alone can authenticate).
 */
export function tokenFrom(headers: Headers): string {
  const auth = (headers.get("authorization") || "").trim();
  if (/^bearer /i.test(auth)) return auth.slice(7).trim();
  if (/^basic /i.test(auth)) {
    let decoded = "";
    try {
      decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
    } catch {
      return "";
    }
    const i = decoded.indexOf(":");
    const user = decodeURIComponent(i < 0 ? decoded : decoded.slice(0, i));
    const pass = i < 0 ? "" : decodeURIComponent(decoded.slice(i + 1));
    return pass || user;
  }
  return (headers.get(IntakeHeader.Token) || "").trim();
}

/** Where posted lines come from, from the headers or the query. Invalid values are ignored. */
export interface LineOrigin {
  service: string | null;
  host: string | null;
}

export function originFrom(url: URL, headers: Headers): LineOrigin {
  const pick = (h: IntakeHeader, q: IntakeQuery): string | null => {
    const v = (headers.get(h) ?? url.searchParams.get(q) ?? "").trim();
    return validLabel(v) ? v : null;
  };
  return { service: pick(IntakeHeader.Service, IntakeQuery.Service), host: pick(IntakeHeader.Host, IntakeQuery.Host) };
}

export const BodyError = { TooLarge: 413, Unreadable: 400 } as const;
export type BodyError = (typeof BodyError)[keyof typeof BodyError];

export type BodyResult = { ok: true; bytes: Buffer } | { ok: false; status: BodyError; reason: string };

/** Read the body, refusing one over LIMIT bytes (sent or unpacked) with 413; gunzip when the
 *  request says gzip. */
export async function readBody(request: Request, limit: number = MAX_BODY_BYTES): Promise<BodyResult> {
  const tooLarge: BodyResult = { ok: false, status: BodyError.TooLarge, reason: `body over ${limit} bytes` };
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return tooLarge;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return tooLarge;
      }
      chunks.push(value);
    }
  }
  const raw = Buffer.concat(chunks);
  const enc = (request.headers.get("content-encoding") || "").toLowerCase();
  if (!enc.includes("gzip")) return { ok: true, bytes: raw };
  try {
    return { ok: true, bytes: gunzipSync(raw, { maxOutputLength: limit }) };
  } catch (e: unknown) {
    if (e instanceof RangeError || (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") return tooLarge;
    return { ok: false, status: BodyError.Unreadable, reason: "body is not valid gzip" };
  }
}

/** The non-blank lines of a newline-delimited body (\n or \r\n). */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "");
}

/** One line with where it came from, as an input to linesToStreams. */
export interface IntakeLine {
  line: string;
  /** The service it belongs to, when the post or record says (else the origin's service). */
  service?: string | null;
  host?: string | null;
  /** Unix nanoseconds, when the client sent a time (else the receive time). */
  timeNs?: bigint | null;
}

/** Every posted line goes to enforceStreams inside an envelope, as an agent's lines do: a line
 *  that is itself JSON with a `message` field would otherwise be read as the envelope, and its
 *  other fields would skip the filter. */
function envelope(line: string): string {
  return JSON.stringify({ message: line });
}

/** The line inside an enforced envelope, or null when it is not one. */
export function lineOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const p: unknown = JSON.parse(value);
    if (typeof p === "object" && p !== null && typeof (p as { message?: unknown }).message === "string") return (p as { message: string }).message;
  } catch {
    return null;
  }
  return null;
}

/**
 * Group lines into streams as an agent's push would carry them: a hop record or link line under
 * its own `service` field (the collectors' naming rule, BAC-49), every other line under the
 * service the post names; `source` is the posted service, so ordinary lines join their hop
 * records. Lines without a time get the receive time plus their position, so their order holds.
 */
export function linesToStreams(lines: readonly IntakeLine[], origin: LineOrigin, nowNs: bigint): LokiStream[] {
  const groups = new Map<string, LokiStream>();
  lines.forEach((l, i) => {
    const posted = validLabel(l.service) ? l.service : origin.service;
    const c = classifyLine(l.line);
    const own = c.kind !== LineKind.Log && validLabel(c.fields.service) ? c.fields.service : null;
    const service = own ?? posted ?? UNKNOWN_SERVICE;
    const source = posted ?? service;
    const host = validLabel(l.host) ? l.host : origin.host;
    const labels: Record<string, string> = { service, source, ...(host ? { host } : {}) };
    const key = JSON.stringify([service, source, host]);
    let g = groups.get(key);
    if (!g) {
      g = { stream: labels, values: [] };
      groups.set(key, g);
    }
    g.values.push([String(l.timeNs ?? nowNs + BigInt(i)), envelope(l.line)]);
  });
  return [...groups.values()];
}

/** The collector events for enforced streams. SWITCHES gives the switches a stream resolved to
 *  (streamSwitches), for the two the collector acts on after detection. */
export function toRecordEvents(
  streams: readonly LokiStream[],
  tenant: IngestTenant,
  switches: (labels: Readonly<Record<string, string>>) => Record<CollectorFeature, boolean>,
): RecordEvent[] {
  const out: RecordEvent[] = [];
  for (const s of streams) {
    const on = switches(s.stream);
    const service = s.stream.service ?? UNKNOWN_SERVICE;
    for (const v of s.values) {
      const line = lineOf(v[1]);
      if (typeof v[0] !== "string" || line === null) continue;
      out.push({
        [RecordField.Message]: line,
        [RecordField.Service]: service,
        [RecordField.Source]: s.stream.source ?? service,
        ...(s.stream.host ? { [RecordField.Host]: s.stream.host } : {}),
        [RecordField.Project]: tenant.project,
        [RecordField.OrgId]: tenant.orgId,
        [RecordField.Time]: v[0],
        [RecordField.Metrics]: on[Feature.Metrics],
        [RecordField.Stores]: on[Feature.Stores],
      });
    }
  }
  return out;
}

/** Newline-delimited JSON, the `records` input's framing. */
export function toNdjson(events: readonly RecordEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
