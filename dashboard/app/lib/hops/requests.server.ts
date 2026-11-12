// Requests list rows from inbound HTTP hop records (design 8, Requests; hop records only since
// Romario's 2026-11-12 decision to drop Jaeger). A row is one inbound HTTP hop: a request that
// crossed four services shows as one row per service, all opening the same request view.

import * as loki from "~/lib/loki.server";
import type { Tenant } from "~/lib/tenant.server";
import { parseHopRecord } from "~/lib/hops/parse";
import { HopKind, Outcome, Via, type HopRecord } from "~/lib/hops/types";
import { isLabelValue } from "~/lib/hops/metrics.server";

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
export function inboundEndQuery(service: string | null): string {
  const sel = service ? `{kind="hop",service=${JSON.stringify(service)}}` : `{kind="hop"}`;
  return `${sel} |= "in_end" |~ "via\\\\W{1,4}http"`;
}

/** Pure: one row per valid inbound HTTP end record. */
export function rowsFromRecords(records: readonly HopRecord[]): RequestListRow[] {
  const out: RequestListRow[] = [];
  for (const r of records) {
    if (r.hop !== HopKind.InEnd || r.via !== Via.Http || r.durationUs === null) continue;
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
  opts: { service: string | null; sinceMs: number; before: number }
): Promise<HopPage> {
  const service = opts.service && isLabelValue(opts.service) ? opts.service : null;
  const entries = await loki.queryRange(inboundEndQuery(service), { start: opts.sinceMs, end: opts.before, limit: PAGE_SIZE }, tenant);
  const records: HopRecord[] = [];
  for (const e of entries) {
    const rec = parseHopRecord({ ts: e.ts, line: e.line, labels: e.labels });
    if (rec) records.push(rec);
  }
  const rows = rowsFromRecords(records).sort((a, b) => b.startMs - a.startMs);
  // Loki returned a full page: there may be more lines before the oldest one.
  const oldest = entries.length ? Math.min(...entries.map((e) => e.ts)) : null;
  return { rows, next: entries.length >= PAGE_SIZE && oldest !== null ? oldest : null };
}
