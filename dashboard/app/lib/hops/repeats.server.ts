// Insights > Repeated calls (BAC-68): the queries that most often repeat inside one request, across
// the requests of the last 15 minutes. One Loki read of database end records, grouped in
// TypeScript: per request and calling hop by statement shape, then per (service, table, shape).
// The grouping and timing rules are the request view's (`repeated.ts`), so a query listed here is
// flagged the same way when its example request is opened.
import * as loki from "~/lib/loki.server";
import type { Tenant } from "~/lib/tenant.server";
import { cachedStale } from "~/lib/cache.server";
import { parseHopRecord } from "~/lib/hops/parse";
import { RECORD_LIMIT, type RecordQueryFn } from "~/lib/hops/attention.server";
import { REPEAT_MIN_DB, Repetition, classifyRepetition, wastedUsOf } from "~/lib/hops/repeated";
import { shapeId, statementShape } from "~/lib/hops/stmt-shape";
import { storeLabel } from "~/lib/hops/store-label";
import { HopKind, Via, type HopId, type HopRecord, type TraceId } from "~/lib/hops/types";

export { RECORD_LIMIT };

/** The window the board looks at. */
export const REPEATS_WINDOW_MS = 15 * 60_000;
/** A scan younger than this is served as is. */
export const REPEATS_FRESH_MS = 30_000;
/** An older scan, up to this age, is served at once while a fresh one is read. */
export const REPEATS_MAX_STALE_MS = 5 * 60_000;

/** Database end records. Line filters only narrow; `parseHopRecord` decides. */
export const DB_RECORDS_QUERY = `{kind="hop"} |= "out_end" |~ "\\\\bvia\\\\W{1,6}db(?:\\\\\\\\?\\"|\\\\s|$)"`;

export interface RepeatRow {
  shapeId: string;
  shape: string;
  /** "select plans". */
  label: string;
  service: string;
  table: string | null;
  /** Requests (calling hops) in which the shape ran at least REPEAT_MIN_DB times. */
  requests: number;
  /** The median repeat count of those requests. */
  medianRepeats: number;
  /** Of those requests, the ones whose calls ran one after another. */
  sequentialRequests: number;
  /** The calls' durations added up, microseconds. */
  totalUs: number;
  /** What fetching them together could have saved, microseconds (`RepeatGroup.wastedUs`). */
  wastedUs: number;
  /** The most recent request with the repeat. */
  exampleTraceId: TraceId;
  exampleAtMs: number;
}

export interface RepeatScan {
  /** Most wasted time first. */
  rows: RepeatRow[];
  recordsRead: number;
  /** The read hit RECORD_LIMIT: only the newest records of the window were checked. */
  truncated: boolean;
  windowMs: number;
  /** Database records were read but none carried statement text (Query text off). */
  statementsOff: boolean;
}

interface Call {
  startMs: number;
  endMs: number;
  durationUs: number;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The rows of the board from database end records (pure; `scanRepeats` reads and caches). */
export function aggregateRepeats(records: readonly HopRecord[], fromMs: number): { rows: RepeatRow[]; statementsOff: boolean } {
  const seen = new Set<HopId>();
  const byCall = new Map<string, { rec: HopRecord; shape: string; calls: Call[] }>();
  let dbRecords = 0;
  let withStatement = 0;
  for (const r of records) {
    if (r.hop !== HopKind.OutEnd || r.via !== Via.Db || seen.has(r.hopId)) continue;
    seen.add(r.hopId);
    dbRecords++;
    if (r.stmt === null) continue;
    withStatement++;
    if (r.parentHop === null || r.durationUs === null || r.handoff || r.timeMs < fromMs) continue;
    const shape = statementShape(r.stmt);
    const key = `${r.traceId}|${r.parentHop}|${r.service}|${r.peer ?? ""}|${r.table ?? ""}|${shape}`;
    const call: Call = { startMs: r.timeMs - r.durationUs / 1000, endMs: r.timeMs, durationUs: r.durationUs };
    const g = byCall.get(key);
    if (g) g.calls.push(call);
    else byCall.set(key, { rec: r, shape, calls: [call] });
  }
  const rows = new Map<string, RepeatRow & { counts: number[] }>();
  for (const { rec, shape, calls } of byCall.values()) {
    if (calls.length < REPEAT_MIN_DB) continue;
    calls.sort((a, b) => a.startMs - b.startMs);
    const repetition = classifyRepetition(calls, false);
    const durations = calls.map((c) => c.durationUs);
    const endMs = Math.max(...calls.map((c) => c.endMs));
    const key = `${rec.service}|${rec.table ?? ""}|${shape}`;
    const row = rows.get(key) ?? {
      shapeId: shapeId(shape), shape, label: storeLabel(rec), service: rec.service, table: rec.table,
      requests: 0, medianRepeats: 0, sequentialRequests: 0, totalUs: 0, wastedUs: 0,
      exampleTraceId: rec.traceId, exampleAtMs: endMs, counts: [],
    };
    row.requests++;
    row.counts.push(calls.length);
    if (repetition === Repetition.Sequential) row.sequentialRequests++;
    row.totalUs += durations.reduce((a, d) => a + d, 0);
    row.wastedUs += wastedUsOf(repetition, durations);
    if (endMs > row.exampleAtMs) {
      row.exampleAtMs = endMs;
      row.exampleTraceId = rec.traceId;
    }
    rows.set(key, row);
  }
  const out: RepeatRow[] = [...rows.values()].map(({ counts, ...row }) => ({ ...row, medianRepeats: median(counts) }));
  out.sort((a, b) => b.wastedUs - a.wastedUs || b.requests - a.requests || a.shape.localeCompare(b.shape));
  return { rows: out, statementsOff: dbRecords > 0 && withStatement === 0 };
}

const keyOf = (tenant: Tenant, windowMs: number): string => `repeats:${tenant.platform ? "platform" : tenant.orgId}:${windowMs}`;

/** The board's rows for the last `windowMs`, behind a stale-while-revalidate cache. */
export function scanRepeats(
  tenant: Tenant,
  windowMs: number = REPEATS_WINDOW_MS,
  read: RecordQueryFn = loki.queryRange,
  now: number = Date.now(),
): Promise<RepeatScan> {
  return cachedStale(keyOf(tenant, windowMs), REPEATS_FRESH_MS, REPEATS_MAX_STALE_MS, async (): Promise<RepeatScan> => {
    const entries = await read(DB_RECORDS_QUERY, { start: now - windowMs, end: now, limit: RECORD_LIMIT }, tenant);
    const records: HopRecord[] = [];
    for (const e of entries) {
      const r = parseHopRecord({ ts: e.tsExactMs ?? e.ts, line: e.line, labels: e.labels });
      if (r) records.push(r);
    }
    const { rows, statementsOff } = aggregateRepeats(records, now - windowMs);
    return { rows, recordsRead: entries.length, truncated: entries.length >= RECORD_LIMIT, windowMs, statementsOff };
  });
}
