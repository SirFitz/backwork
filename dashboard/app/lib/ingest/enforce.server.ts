/**
 * Ingest-side enforcement (design 19): the switches decide what is saved, and
 * the sensitive-data filter runs again on every line, whatever the agent did.
 *
 * Input is a Loki JSON push body as Vector's loki sink sends it (compression
 * none): `{ streams: [{ stream: {labels}, values: [[ts, line, meta?], ...] }] }`,
 * where each line is Vector's JSON-encoded event with the raw log line in
 * `message`. Lines that are not such envelopes are treated as the raw line.
 *
 * Pure apart from the inputs it is given: no I/O here.
 */
import {
  Feature,
  applyFilter,
  resolveAll,
  type CompiledFilter,
  type ControlRow,
} from "~/lib/controls.server";
import { STATEMENT_FIELDS, StatementField, recordPairs, splitStatement } from "~/lib/hops/stmt";

export const LineKind = { Log: "log", Hop: "hop", Link: "link" } as const;
export type LineKind = (typeof LineKind)[keyof typeof LineKind];

const HOP_KINDS = new Set(["in", "in_end", "out", "out_end"]);
const NESTED = ["metadata", "fields", "data", "context", "attributes"] as const;
const TRACE_RE = /^[0-9a-f]{32}$/;
const HOP_ID_RE = /^[0-9a-f]{16}$/;
const STORE_TOTALS = new Set(["db_n", "db_us", "cache_n", "cache_us"]);

type Fields = Record<string, unknown>;

export interface Classified {
  kind: LineKind;
  /** The object holding the hop fields, for JSON lines. */
  format: "json" | "kv" | "none";
  /** Key of the container in the JSON line ("" = top level). */
  box: string;
  fields: Fields;
}

function isObject(v: unknown): v is Fields {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse space-separated key=value pairs (values may be double-quoted). `stmt` is read first:
 *  everything after ` stmt=` to the end of the line (spec HOP-14), so nothing inside it is a pair. */
export function parseKeyValue(full: string): Fields {
  const out: Fields = {};
  const split = splitStatement(full);
  const line = recordPairs(split.head);
  const stmt = split.stmt;
  const re = /([^\s=]+)=("(?:[^"\\]|\\.)*"|\S*)/g;
  if (stmt !== null) out[StatementField.Stmt] = stmt;
  for (const m of line.matchAll(re)) {
    const v = m[2];
    out[m[1]] = v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v;
  }
  return out;
}

/** Design 5.1, the same rules as the collector's bw_detect. */
export function classifyLine(raw: string): Classified {
  let fields: Fields = {};
  let format: Classified["format"] = "none";
  let box = "";
  let parsed: unknown = undefined;
  if (raw.startsWith("{")) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }
  if (isObject(parsed)) {
    format = "json";
    if (parsed.trace_id != null) fields = parsed;
    else {
      for (const k of NESTED) {
        const c = parsed[k];
        if (isObject(c) && c.trace_id != null) {
          fields = c;
          box = k;
          break;
        }
      }
    }
  } else if (raw.includes("trace_id=")) {
    format = "kv";
    fields = parseKeyValue(raw);
  }
  const tid = typeof fields.trace_id === "string" ? fields.trace_id : "";
  let kind: LineKind = LineKind.Log;
  if (TRACE_RE.test(tid)) {
    const hop = String(fields.hop ?? "");
    const hopId = String(fields.hop_id ?? "");
    if (HOP_KINDS.has(hop) && HOP_ID_RE.test(hopId)) kind = LineKind.Hop;
    else if (fields.link_name != null && fields.link_value != null) kind = LineKind.Link;
  }
  return { kind, format, box, fields };
}

/** What to remove from a hop record before it is saved. */
export interface HopStrip {
  /** `f_` named fields (Named fields off). */
  named: boolean;
  /** Data-store totals (Database and cache off). */
  stores: boolean;
  /** `table` and `stmt` (Query text off, design 21). */
  statements: boolean;
}

const STATEMENT_KEYS: ReadonlySet<string> = new Set(STATEMENT_FIELDS);

/** Remove named fields, store totals and/or the statement fields from a hop record's raw line. */
export function stripHopFields(raw: string, c: Classified, strip: HopStrip): string {
  const { named: dropNamed, stores: dropStores, statements: dropStatements } = strip;
  if (!dropNamed && !dropStores && !dropStatements) return raw;
  const drop = (k: string): boolean =>
    (dropNamed && k.startsWith("f_")) || (dropStores && STORE_TOTALS.has(k)) || (dropStatements && STATEMENT_KEYS.has(k));
  if (c.format === "json") {
    try {
      const obj = JSON.parse(raw) as Fields;
      const target = c.box ? (obj[c.box] as Fields) : obj;
      for (const k of Object.keys(target)) if (drop(k)) delete target[k];
      return JSON.stringify(obj);
    } catch {
      return raw;
    }
  }
  // Only the pairs before stmt are edited; stmt is kept whole or removed whole.
  const { head, stmt } = splitStatement(raw);
  let out = head;
  if (dropNamed) out = out.replace(/ f_[a-z0-9_]+=\S*/g, "");
  if (dropStores) out = out.replace(/ (?:db|cache)_(?:n|us)=\S*/g, "");
  if (dropStatements) out = out.replace(/ table=\S*/g, "");
  return stmt === null || dropStatements ? out : `${out} stmt=${stmt}`;
}

export interface LokiStream {
  stream: Record<string, string>;
  values: unknown[][];
}

export interface EnforceContext {
  projectId: string | null;
  rows: readonly ControlRow[];
  /** The organisation's compiled filter (applied where the filter switch is on). */
  filter: CompiledFilter;
}

export interface EnforceResult {
  streams: LokiStream[];
  kept: number;
  dropped: number;
}

function isDataStore(c: Classified): boolean {
  return c.kind === LineKind.Hop && (c.fields.via === "db" || c.fields.via === "cache");
}

/**
 * Apply the switches and the filter to a push. Streams are regrouped by their
 * labels plus `kind`, which is set from the line when the agent did not set it.
 */
export function enforceStreams(streams: readonly LokiStream[], ctx: EnforceContext): EnforceResult {
  const groups = new Map<string, LokiStream>();
  let kept = 0;
  let dropped = 0;
  for (const s of streams) {
    if (!isObject(s) || !isObject(s.stream) || !Array.isArray(s.values)) continue;
    const service = typeof s.stream.service === "string" ? s.stream.service : null;
    const on = resolveAll(ctx.rows, ctx.projectId, service);
    for (const v of s.values) {
      if (!Array.isArray(v) || typeof v[0] !== "string" || typeof v[1] !== "string") continue;
      const line = v[1];
      let envelope: Fields | null = null;
      if (line.startsWith("{")) {
        try {
          const p: unknown = JSON.parse(line);
          if (isObject(p) && typeof p.message === "string") envelope = p;
        } catch {
          envelope = null;
        }
      }
      let raw = envelope ? (envelope.message as string) : line;
      const c = classifyLine(raw);
      const kindLabel = c.kind === LineKind.Log ? "log" : "hop";
      const off =
        (kindLabel === "log" && !on[Feature.Logs]) ||
        (kindLabel === "hop" && !on[Feature.Hops]) ||
        (c.kind === LineKind.Link && !on[Feature.LinkedIds]) ||
        (isDataStore(c) && !on[Feature.Stores]);
      if (off) {
        dropped++;
        continue;
      }
      if (c.kind === LineKind.Hop) {
        raw = stripHopFields(raw, c, { named: !on[Feature.NamedFields], stores: !on[Feature.Stores], statements: !on[Feature.Statements] });
      }
      let out: string;
      if (envelope) {
        const display = typeof envelope.display === "string" ? envelope.display : null;
        const orig = envelope.message as string;
        envelope.message = on[Feature.Filter] ? applyFilter(raw, ctx.filter) : raw;
        if (display !== null) {
          envelope.display = display === orig ? envelope.message : on[Feature.Filter] ? applyFilter(display, ctx.filter) : display;
        }
        envelope.kind = kindLabel;
        out = JSON.stringify(envelope);
      } else {
        out = on[Feature.Filter] ? applyFilter(raw, ctx.filter) : raw;
      }
      const labels = { ...s.stream, kind: kindLabel };
      const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
      let g = groups.get(key);
      if (!g) {
        g = { stream: labels, values: [] };
        groups.set(key, g);
      }
      g.values.push([v[0], out, ...v.slice(2)]);
      kept++;
    }
  }
  return { streams: [...groups.values()], kept, dropped };
}

/** Whether a hop-metrics remote write for this project is saved (design 19.1). */
export function hopMetricsAllowed(rows: readonly ControlRow[], projectId: string | null): boolean {
  const on = resolveAll(rows, projectId, null);
  return on[Feature.Metrics] && on[Feature.Hops];
}
