// Request lookup queries (design 7.2), through the existing scoped Loki client. Hop records and
// log lines only (the slimmed stack has no span store).
// Every query passes the viewer's tenant, so a trace ID of another organisation returns nothing.
// Only a validated TraceId is ever placed in a query.
import * as loki from "~/lib/loki.server";
import type { Tenant } from "~/lib/tenant.server";
import { isTraceId, parseHopRecord, parseLinkLine, sourceOf, toTraceLogLine, type RawLogEntry } from "./parse";
import { HOP_RETENTION_DAYS, LOG_PAGE, LOG_RETENTION_DAYS, SearchWindow, WINDOW_LABEL, type HopRecord, type LinkedId, type TraceId, type TraceLogLine } from "./types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Lines around the hop records: 5 s either side (design 7.2 step 2). */
export const LOG_PAD_MS = 5000;
/** Loki's default entry cap per query. */
const HOP_LIMIT = 5000;

export { HOP_RETENTION_DAYS, LOG_PAGE, LOG_RETENTION_DAYS, SearchWindow, WINDOW_LABEL };

export interface WindowResult {
  window: SearchWindow;
  found: boolean;
  records: HopRecord[];
  links: LinkedId[];
  /** Earliest time searched so far, epoch ms. */
  searchedFromMs: number;
}

/** Each window's bounds; windows do not overlap, so together they cover the whole retention once. */
function bounds(window: SearchWindow, now: number): { start: number; end: number } {
  switch (window) {
    case SearchWindow.Hour:
      return { start: now - HOUR, end: now };
    case SearchWindow.Day:
      return { start: now - DAY, end: now - HOUR };
    case SearchWindow.Retention:
      return { start: now - HOP_RETENTION_DAYS * DAY, end: now - DAY };
  }
}

function toRaw(e: loki.LogEntry): RawLogEntry {
  // Hop records keep Loki's sub-millisecond time, so records written in one millisecond stay in order.
  return { ts: e.tsExactMs ?? e.ts, line: e.line, labels: e.labels };
}

function assertTraceId(id: TraceId): void {
  // Defence in depth: the type says so, the value must too, before it reaches LogQL.
  if (!isTraceId(id)) throw new Error("invalid trace id");
}

export type HopQueryFn = (query: string, opts: { start: number; end: number; limit: number }, tenant: Tenant) => Promise<loki.LogEntry[]>;

/** Step 1 for one window: hop records and link lines holding the trace ID. */
export async function searchWindow(
  traceId: TraceId,
  window: SearchWindow,
  tenant: Tenant,
  now: number,
  query: HopQueryFn = loki.queryRange,
): Promise<WindowResult> {
  assertTraceId(traceId);
  const { start, end } = bounds(window, now);
  const entries = await query(`{kind="hop"} |= "${traceId}"`, { start, end, limit: HOP_LIMIT }, tenant);
  const records: HopRecord[] = [];
  const links: LinkedId[] = [];
  for (const e of entries) {
    const raw = toRaw(e);
    const rec = parseHopRecord(raw);
    if (rec && rec.traceId === traceId) {
      records.push(rec);
      continue;
    }
    const link = parseLinkLine(raw);
    if (link && link.traceId === traceId) links.push(link);
  }
  return { window, found: records.length > 0 || links.length > 0, records, links, searchedFromMs: start };
}

export interface ProgressiveLookup {
  hour: Promise<WindowResult>;
  day: Promise<WindowResult>;
  retention: Promise<WindowResult>;
}

/** Last hour, then the last 24 hours, then the rest of the retention; a later window runs only when the earlier found nothing. */
export function progressiveLookup(traceId: TraceId, tenant: Tenant, now: number, query?: HopQueryFn): ProgressiveLookup {
  const hour = searchWindow(traceId, SearchWindow.Hour, tenant, now, query);
  const day = hour.then((r) => (r.found ? r : searchWindow(traceId, SearchWindow.Day, tenant, now, query)));
  const retention = day.then((r) => (r.found ? r : searchWindow(traceId, SearchWindow.Retention, tenant, now, query)));
  return { hour, day, retention };
}

/**
 * Step 2: ordinary log lines holding the trace ID, from every service of the organisation, from
 * 5 s before the first record to 5 s after the last. Not narrowed to the services found: hop
 * records name the service the developer set (`service=fs-hono`), while ordinary lines carry the
 * collector's container name (`fs-web-hono-bserve`), so a service filter would miss them. Each
 * line is then named after the hop service whose records came from the same source.
 */
export async function logLinesFor(
  traceId: TraceId,
  result: WindowResult,
  tenant: Tenant,
  now: number,
  query: HopQueryFn = loki.queryRange,
): Promise<TraceLogLine[]> {
  assertTraceId(traceId);
  const times = [...result.records.map((r) => r.timeMs), ...result.links.map((l) => l.timeMs)];
  if (times.length === 0) return [];
  const start = Math.min(...times) - LOG_PAD_MS;
  // A hop still running may log after its last record, so then the window runs to now.
  const last = Math.max(...times) + LOG_PAD_MS;
  const end = hasOpenHop(result) ? Math.max(last, now) : last;
  const entries = await query(`{service=~".+", kind!="hop"} |= "${traceId}"`, { start, end, limit: LOG_PAGE }, tenant);
  const bySource = serviceBySource(result.records);
  return entries.map((e) => named(toTraceLogLine(toRaw(e)), e, bySource)).sort((a, b) => a.timeMs - b.timeMs);
}

/** Source name -> the service its hop records name. A source whose records name several services keeps its own name. */
export function serviceBySource(records: readonly HopRecord[]): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const r of records) {
    if (!r.source) continue;
    const set = seen.get(r.source) ?? new Set<string>();
    set.add(r.service);
    seen.set(r.source, set);
  }
  const out = new Map<string, string>();
  for (const [source, names] of seen) if (names.size === 1) out.set(source, [...names][0]);
  return out;
}

function named(line: TraceLogLine, entry: loki.LogEntry, bySource: ReadonlyMap<string, string>): TraceLogLine {
  const source = sourceOf(entry.labels, entry.line);
  const service = source ? bySource.get(source) : undefined;
  return service ? { ...line, service } : line;
}

function hasOpenHop(result: WindowResult): boolean {
  const ended = new Set(result.records.filter((r) => r.hop === "in_end" || r.hop === "out_end").map((r) => r.hopId));
  return result.records.some((r) => (r.hop === "in" || r.hop === "out") && !ended.has(r.hopId));
}

/** Logs-only view: hop records off. All services, last 24 hours. */
export async function logsOnly(traceId: TraceId, tenant: Tenant, now: number, query: HopQueryFn = loki.queryRange): Promise<TraceLogLine[]> {
  assertTraceId(traceId);
  const entries = await query(`{service=~".+", kind!="hop"} |= "${traceId}"`, { start: now - DAY, end: now, limit: LOG_PAGE }, tenant);
  return entries.map((e) => toTraceLogLine(toRaw(e))).sort((a, b) => a.timeMs - b.timeMs);
}

