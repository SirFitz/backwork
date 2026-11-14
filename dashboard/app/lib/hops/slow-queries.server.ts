// Slow queries board (BAC-69), server side: runs the statement LogQL of `slow-queries.ts` against
// Loki for one organisation, merges the record formats by statement shape, and looks up the routes
// that call one statement. Both reads sit behind the stale-while-revalidate cache, so a page that
// has a value never waits for Loki.
import * as loki from "~/lib/loki.server";
import { cachedStale } from "~/lib/cache.server";
import { Feature, getControls, resolveEffective } from "~/lib/controls.server";
import type { Tenant } from "~/lib/tenant.server";
import { parseHopRecord } from "./parse";
import {
  RECORD_FORMATS,
  ROUTE_SAMPLE_LIMIT,
  SLOW_GROUP_LIMIT,
  SLOW_MEASURES,
  SLOW_WINDOW_MS,
  SlowMeasure,
  groupCallingRoutes,
  inboundEndLogql,
  mergeByShape,
  parentBatches,
  rawGroups,
  SLOW_FRESH_MS,
  slowQueryLogql,
  statementCallsLogql,
  type InboundEnd,
  type MeasureSample,
  type QueryRow,
  type SampledCall,
  type SlowWindow,
  type StatementRoutes,
} from "./slow-queries";

export { SlowWindow } from "./slow-queries";
export type { QueryRow, StatementRoutes } from "./slow-queries";

/** A board result younger than this is served without asking Loki: defined in the pure module, which the page uses too. */
export { SLOW_FRESH_MS };
/** A board result older than this is not shown; the page waits for a new one (15 minutes). */
export const SLOW_MAX_STALE_MS = 15 * 60_000;
/** The routes of one statement are kept this long (5 minutes). */
export const ROUTES_TTL_MS = 5 * 60_000;
/** Inbound end records read per routes lookup batch. */
export const ROUTE_INBOUND_LIMIT = 500;

export interface SlowQueries {
  rows: QueryRow[];
  window: SlowWindow;
  /** When Loki answered (epoch ms): the page says "from N minutes ago" when it is old. */
  computedAt: number;
  /** The organisation's Query text switch is off, so no statements are stored. */
  statementsOff: boolean;
  /** A query came back at the group cap: the list is the top of a longer one. */
  groupLimited: boolean;
}

/** Runs one LogQL metric query over a window (`loki.metricInstant`). */
export type MetricRunner = (query: string, window: loki.TimeWindowMs, tenant: Tenant) => Promise<loki.MetricSample[]>;

/** Is the Query text switch off for the whole organisation? */
export type StatementsOffReader = (orgId: string) => Promise<boolean>;

export const statementsOffForOrg: StatementsOffReader = async (orgId) =>
  !resolveEffective(await getControls(orgId), null, null, Feature.Statements);

/** Runs one LogQL log query (`loki.queryRange`). */
export type LogRunner = (query: string, opts: { start: number; end: number; limit: number }, tenant: Tenant) => Promise<loki.LogEntry[]>;

const defaultMetricRunner: MetricRunner = (query, window, tenant) => loki.metricInstant(query, window, tenant);
const defaultLogRunner: LogRunner = (query, opts, tenant) => loki.queryRange(query, opts, tenant);

/** The board without the cache: six queries (two formats by three measures) in parallel. */
export async function computeSlowQueries(
  tenant: Tenant,
  window: SlowWindow,
  now: number = Date.now(),
  run: MetricRunner = defaultMetricRunner,
  statementsOff: StatementsOffReader = statementsOffForOrg,
): Promise<SlowQueries> {
  const range: loki.TimeWindowMs = { start: now - SLOW_WINDOW_MS[window], end: now };
  const offP = statementsOff(tenant.orgId).catch(() => false);
  const runAll = (restrict: boolean, measures: readonly SlowMeasure[]) =>
    Promise.all(
      measures.map(async (measure) => {
        const perFormat = await Promise.all(RECORD_FORMATS.map((f) => run(slowQueryLogql(f, measure, window, undefined, restrict), range, tenant)));
        return { measure, perFormat };
      }),
    );
  const first = await runAll(false, SLOW_MEASURES);
  const samples: Record<SlowMeasure, MeasureSample[]> = { calls: [], total: [], p95: [] };
  let groupLimited = false;
  for (const { measure, perFormat } of first) {
    for (const list of perFormat) {
      if (list.length >= SLOW_GROUP_LIMIT) groupLimited = true;
      samples[measure].push(...list);
    }
  }
  if (groupLimited) {
    // Cut lists: read calls and p95 again for exactly the groups of the total-time list.
    const again = await runAll(true, [SlowMeasure.Calls, SlowMeasure.P95]);
    for (const { measure, perFormat } of again) samples[measure] = perFormat.flat();
  }
  return {
    rows: mergeByShape(rawGroups(samples)),
    window,
    computedAt: now,
    statementsOff: await offP,
    groupLimited,
  };
}

/** The board for one organisation and window, served from the stale-while-revalidate cache. */
export function slowQueries(
  tenant: Tenant,
  window: SlowWindow,
  now: number = Date.now(),
  run: MetricRunner = defaultMetricRunner,
  statementsOff: StatementsOffReader = statementsOffForOrg,
): Promise<SlowQueries> {
  return cachedStale(slowQueriesKey(tenant, window), SLOW_FRESH_MS, SLOW_MAX_STALE_MS, () =>
    computeSlowQueries(tenant, window, now, run, statementsOff),
  );
}

export function slowQueriesKey(tenant: Tenant, window: SlowWindow): string {
  return `slowq:${tenant.orgId}:${window}`;
}

/** The parsed hop records of a log query, newest first. */
function records(entries: readonly loki.LogEntry[]) {
  return entries
    .map((e) => parseHopRecord({ ts: e.ts, line: e.line, labels: e.labels }))
    .filter((r): r is NonNullable<typeof r> => r !== null);
}

/** Routes that call one statement, from up to `ROUTE_SAMPLE_LIMIT` sampled calls in the window. */
export async function computeRoutesFor(
  tenant: Tenant,
  row: Pick<QueryRow, "sample" | "service">,
  window: SlowWindow,
  now: number = Date.now(),
  query: LogRunner = defaultLogRunner,
): Promise<StatementRoutes> {
  const range = { start: now - SLOW_WINDOW_MS[window], end: now };
  const outs = records(await query(statementCallsLogql(row.sample, row.service), { ...range, limit: ROUTE_SAMPLE_LIMIT }, tenant));
  const calls: SampledCall[] = outs
    .filter((r) => r.hop === "out_end" && r.via === "db" && r.stmt === row.sample)
    .map((r) => ({ traceId: r.traceId, parentHop: r.parentHop, durationUs: r.durationUs }));
  const batches = parentBatches(calls);
  const inbound: InboundEnd[] = [];
  const found = await Promise.all(batches.map((ids) => query(inboundEndLogql(ids), { ...range, limit: ROUTE_INBOUND_LIMIT }, tenant)));
  for (const list of found) {
    for (const r of records(list)) {
      if (r.hop !== "in_end") continue;
      inbound.push({ hopId: r.hopId, service: r.service, method: r.method, op: r.op });
    }
  }
  return groupCallingRoutes(calls, inbound);
}

/** `computeRoutesFor` behind the cache, per organisation, window and statement. */
export function routesFor(
  tenant: Tenant,
  row: Pick<QueryRow, "sample" | "service" | "shapeId">,
  window: SlowWindow,
  query: LogRunner = defaultLogRunner,
): Promise<StatementRoutes> {
  const key = `slowq-routes:${tenant.orgId}:${window}:${row.service}:${row.shapeId}`;
  return cachedStale(key, ROUTES_TTL_MS, ROUTES_TTL_MS * 3, () => computeRoutesFor(tenant, row, window, Date.now(), query));
}
