// Requests list rows from inbound HTTP hop records (design 8 and 20: hop records only). A row is
// one inbound HTTP hop: a request that crossed four services shows as one row per service, all
// opening the same request view. Health checks are left out unless shown (`health.ts`).

import * as loki from "~/lib/loki.server";
import type { Tenant } from "~/lib/tenant.server";
import { parseHopRecord } from "~/lib/hops/parse";
import { HopKind, Outcome, Via, type HopRecord } from "~/lib/hops/types";
import { isLabelValue } from "~/lib/hops/metrics.server";
import { HealthChecks, LOGQL_NOT_HEALTH_CHECK, isHealthCheckOp } from "~/lib/hops/health";

/** One inbound HTTP hop, as listed. */
export interface RequestListRow {
  traceID: string;
  service: string;
  method: string;
  route: string;
  status: number | null;
  durationMs: number;
  startMs: number;
  error: boolean;
}

/** Rows per page (design 13). */
export const PAGE_SIZE = 100;

/** LogQL for the newest inbound end records, optionally for one service. The line filters only
 *  narrow the scan; `parseHopRecord` decides. */
export function inboundEndQuery(service: string | null, health: HealthChecks = HealthChecks.Hidden, onlyFailed = false): string {
  const sel = service ? `{kind="hop",service=${JSON.stringify(service)}}` : `{kind="hop"}`;
  const notHealth = health === HealthChecks.Hidden ? ` ${LOGQL_NOT_HEALTH_CHECK}` : "";
  const failed = onlyFailed ? ` ${LOGQL_FAILED}` : "";
  return `${sel} |= "in_end" |~ "via\\\\W{1,4}http"${notHealth}${failed}`;
}

/** Narrows a scan to failed records: outcome error or a 5xx status (`isFailedRow` decides). */
export const LOGQL_FAILED = `|~ "outcome\\\\W{1,4}error|status\\\\W{1,4}5[0-9][0-9]"`;

/** A row the Overview lists as failed: the hop ended in error or answered 5xx. */
export function isFailedRow(row: RequestListRow): boolean {
  return row.error || (row.status !== null && row.status >= 500);
}

/** Pure: one row per valid inbound HTTP end record. */
export function rowsFromRecords(records: readonly HopRecord[], health: HealthChecks = HealthChecks.Hidden): RequestListRow[] {
  const out: RequestListRow[] = [];
  for (const r of records) {
    if (r.hop !== HopKind.InEnd || r.via !== Via.Http || r.durationUs === null) continue;
    if (health === HealthChecks.Hidden && isHealthCheckOp(r.op)) continue;
    const durationMs = r.durationUs / 1000;
    out.push({
      traceID: r.traceId,
      service: r.service,
      method: r.method ?? "",
      route: r.op ?? "",
      status: r.status,
      durationMs,
      startMs: r.timeMs - durationMs,
      error: r.outcome === Outcome.Error,
    });
  }
  return out;
}

export interface HopPage {
  rows: RequestListRow[];
  /** Pass as `before` to load the next older page; null when the range is exhausted. */
  next: number | null;
}

/** One page of inbound HTTP hop rows ending before `before` (epoch ms), within `sinceMs`. */
export async function hopRequestPage(
  tenant: Tenant,
  opts: { service: string | null; sinceMs: number; before: number; health?: HealthChecks; onlyFailed?: boolean; limit?: number }
): Promise<HopPage> {
  const service = opts.service && isLabelValue(opts.service) ? opts.service : null;
  const health = opts.health ?? HealthChecks.Hidden;
  const limit = opts.limit ?? PAGE_SIZE;
  const query = inboundEndQuery(service, health, opts.onlyFailed === true);
  const entries = await loki.queryRange(query, { start: opts.sinceMs, end: opts.before, limit }, tenant);
  const records: HopRecord[] = [];
  for (const e of entries) {
    const rec = parseHopRecord({ ts: e.ts, line: e.line, labels: e.labels });
    if (rec) records.push(rec);
  }
  const all = rowsFromRecords(records, health);
  const rows = (opts.onlyFailed ? all.filter(isFailedRow) : all).sort((a, b) => b.startMs - a.startMs);
  // Loki returned a full page: there may be more lines before the oldest one.
  const oldest = entries.length ? Math.min(...entries.map((e) => e.ts)) : null;
  return { rows, next: entries.length >= limit && oldest !== null ? oldest : null };
}
