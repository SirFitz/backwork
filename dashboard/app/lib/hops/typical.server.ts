// A typical request of the same route, to compare a request with (BAC-75, insights plan 08).
// Recent inbound end records of the same service, method and route over the last hour; the one
// nearest the route's median duration, among those within 0.8x to 1.25x of it; with fewer than
// TYPICAL_MIN_CANDIDATES to choose from, the fastest. The head itself never counts, and failed
// requests are compared only with failed ones.
import * as loki from "~/lib/loki.server";
import type { Tenant } from "~/lib/tenant.server";
import { parseHopRecord } from "./parse";
import { inboundEndQuery, isFailedRow, rowsFromRecords, type RequestListRow } from "./requests.server";
import { HealthChecks, isHealthCheckOp } from "./health";
import { isLabelValue } from "./metrics.server";
import type { HopQueryFn } from "./query.server";
import type { RequestSummary } from "./tree";
import type { HopRecord } from "./types";

/** How far back the candidates are searched, milliseconds. */
export const TYPICAL_WINDOW_MS = 60 * 60 * 1000;
/** Inbound end records read per search. */
export const TYPICAL_RECORD_LIMIT = 200;
/** With fewer candidates than this, the median means little: the fastest is taken instead. */
export const TYPICAL_MIN_CANDIDATES = 5;
/** Candidates kept around the median: from this share of it... */
export const TYPICAL_LOW_SHARE = 0.8;
/** ...to this share of it. */
export const TYPICAL_HIGH_SHARE = 1.25;

/** The page's empty state when nothing qualifies. */
export const NO_TYPICAL_SENTENCE = "No other requests of this route in the last hour to compare with.";

export interface TypicalPick {
  traceId: string;
  durationMs: number;
}

/** The request being compared, as far as choosing its comparison needs. */
export type TypicalHead = Pick<RequestSummary, "traceId" | "service" | "method" | "op" | "failed">;

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Pure: the comparison among listed rows (see the header), or null when none qualifies. */
export function pickTypical(rows: readonly RequestListRow[], head: TypicalHead): TypicalPick | null {
  const seen = new Set<string>([head.traceId]);
  const candidates: RequestListRow[] = [];
  for (const r of rows) {
    if (r.service !== head.service || r.method !== (head.method ?? "") || r.route !== (head.op ?? "")) continue;
    if (isFailedRow(r) !== head.failed || seen.has(r.traceID)) continue;
    seen.add(r.traceID);
    candidates.push(r);
  }
  if (candidates.length === 0) return null;
  const byDuration = [...candidates].sort((a, b) => a.durationMs - b.durationMs || a.traceID.localeCompare(b.traceID));
  const pick = (r: RequestListRow): TypicalPick => ({ traceId: r.traceID, durationMs: r.durationMs });
  if (byDuration.length < TYPICAL_MIN_CANDIDATES) return pick(byDuration[0]);
  const mid = median(byDuration.map((r) => r.durationMs));
  const near = byDuration.filter((r) => r.durationMs >= TYPICAL_LOW_SHARE * mid && r.durationMs <= TYPICAL_HIGH_SHARE * mid);
  // The median of a non-empty list always has a member within 0.8x to 1.25x of it, except when
  // the two middle values straddle it widely: then the nearest of all.
  const pool = near.length ? near : byDuration;
  let best = pool[0];
  for (const r of pool) if (Math.abs(r.durationMs - mid) < Math.abs(best.durationMs - mid)) best = r;
  return pick(best);
}

/** A typical request of the head's route from the last hour, or null when there is none. */
export async function typicalRequest(
  tenant: Tenant,
  head: TypicalHead,
  now: number,
  query: HopQueryFn = loki.queryRange,
): Promise<TypicalPick | null> {
  if (!head.op || !isLabelValue(head.service)) return null;
  const health = isHealthCheckOp(head.op) ? HealthChecks.Shown : HealthChecks.Hidden;
  const logql = inboundEndQuery(head.service, health, head.failed, head.op);
  const entries = await query(logql, { start: now - TYPICAL_WINDOW_MS, end: now, limit: TYPICAL_RECORD_LIMIT }, tenant);
  const records: HopRecord[] = [];
  for (const e of entries) {
    const rec = parseHopRecord({ ts: e.ts, line: e.line, labels: e.labels });
    if (rec) records.push(rec);
  }
  return pickTypical(rowsFromRecords(records, health), head);
}
