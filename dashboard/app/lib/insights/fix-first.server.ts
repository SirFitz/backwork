// Insights > Fix first (BAC-74), server side: reads the four sources of the list in parallel
// (route totals from VictoriaMetrics, the slow queries board and the repeats scan from Loki, the
// compare with last week), each on its own so one failing source never empties the list, ranks
// them with the pure `rankFixFirst`, and serves the result from the stale-while-revalidate cache.

import { cachedStale } from "~/lib/cache.server";
import type { Tenant } from "~/lib/tenant.server";
import { allRoutesScope, routesByTotalTime, servicesScope, totalTimeBy, type RouteTotalRow } from "~/lib/hops/metrics.server";
import { slowQueries, type SlowQueries } from "~/lib/hops/slow-queries.server";
import { scanRepeats, type RepeatScan } from "~/lib/hops/repeats.server";
import { compareServices } from "~/lib/hops/compare.server";
import { COMPARE_OFFSET, compareLookbackSeconds } from "~/lib/hops/compare";
import { PerfRange } from "~/lib/hops/figures";
import { SlowWindow } from "~/lib/hops/slow-queries";
import {
  FIX_FRESH_MS,
  FIX_ROUTE_LIMIT,
  FIX_WINDOW_MS,
  FixKind,
  FixWindow,
  SourceState,
  rankFixFirst,
  type FixInputs,
  type FixItem,
  type FixRegressionInput,
} from "~/lib/insights/fix-first";

/** A result younger than this is served as is: defined in the pure module, which the page uses too. */
export { FIX_FRESH_MS };
/** An older result, up to this age, is served at once while a new one is read (10 minutes). */
export const FIX_MAX_STALE_MS = 10 * 60_000;

export interface FixFirstResult {
  /** Ranked, largest impact first (at most `FIX_MAX_ROWS`). */
  items: FixItem[];
  sources: Record<FixKind, SourceState>;
  /** Why a source is unavailable, when it is. */
  errors: Partial<Record<FixKind, string>>;
  /** The repeats scan hit its record cap. */
  repeatsSampled: boolean;
  window: FixWindow;
  /** When the sources answered (epoch ms). */
  computedAt: number;
}

/** The four readers, injectable for tests. */
export interface FixSources {
  routes: (tenant: Tenant, window: FixWindow) => Promise<RouteTotalRow[]>;
  queries: (tenant: Tenant, window: FixWindow) => Promise<SlowQueries>;
  repeats: (tenant: Tenant, window: FixWindow, now: number) => Promise<RepeatScan>;
  regressions: (tenant: Tenant, window: FixWindow) => Promise<FixRegressionInput[]>;
}

const PERF_RANGE: Record<FixWindow, PerfRange> = { [FixWindow.H1]: PerfRange.H1, [FixWindow.H6]: PerfRange.H6 };
const SLOW_WINDOW: Record<FixWindow, SlowWindow> = { [FixWindow.H1]: SlowWindow.H1, [FixWindow.H6]: SlowWindow.H6 };

export const defaultFixSources: FixSources = {
  routes: (tenant, window) => routesByTotalTime(allRoutesScope(), PERF_RANGE[window], tenant, undefined, FIX_ROUTE_LIMIT),
  queries: (tenant, window) => slowQueries(tenant, SLOW_WINDOW[window]),
  repeats: (tenant, window, now) => scanRepeats(tenant, FIX_WINDOW_MS[window], undefined, now),
  regressions: (tenant, window) => regressionInputs(tenant, window),
};

/** Services against last week, with the time their requests took in both windows. */
export async function regressionInputs(tenant: Tenant, window: FixWindow): Promise<FixRegressionInput[]> {
  const range = PERF_RANGE[window];
  const lookback = compareLookbackSeconds(range);
  if (lookback === null) return [];
  const scope = servicesScope();
  const [rows, now, before] = await Promise.all([
    compareServices(range, tenant),
    totalTimeBy(scope, range, tenant),
    totalTimeBy(scope, range, tenant, undefined, COMPARE_OFFSET, lookback),
  ]);
  return rows.map((row) => ({ row, totalNowS: now.get(row.service) ?? null, totalBeforeS: before.get(row.service) ?? null }));
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

function settle<T>(p: () => Promise<T>): Promise<Outcome<T>> {
  return p().then(
    (value): Outcome<T> => ({ ok: true, value }),
    (e: unknown): Outcome<T> => ({ ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "unavailable" }),
  );
}

/** The list without the cache. */
export async function computeFixFirst(tenant: Tenant, window: FixWindow, now: number = Date.now(), sources: FixSources = defaultFixSources): Promise<FixFirstResult> {
  const [routes, queries, repeats, regressions] = await Promise.all([
    settle(() => sources.routes(tenant, window)),
    settle(() => sources.queries(tenant, window)),
    settle(() => sources.repeats(tenant, window, now)),
    settle(() => sources.regressions(tenant, window)),
  ]);
  const states: Record<FixKind, SourceState> = {
    [FixKind.Route]: SourceState.Ok,
    [FixKind.Query]: SourceState.Ok,
    [FixKind.Repeat]: SourceState.Ok,
    [FixKind.Regression]: SourceState.Ok,
  };
  const errors: Partial<Record<FixKind, string>> = {};
  const mark = (kind: FixKind, o: Outcome<unknown>): void => {
    if (!o.ok) {
      states[kind] = SourceState.Unavailable;
      errors[kind] = o.error;
    }
  };
  mark(FixKind.Route, routes);
  mark(FixKind.Query, queries);
  mark(FixKind.Repeat, repeats);
  mark(FixKind.Regression, regressions);
  if (queries.ok && queries.value.statementsOff && queries.value.rows.length === 0) states[FixKind.Query] = SourceState.Off;
  if (repeats.ok && repeats.value.statementsOff) states[FixKind.Repeat] = SourceState.Off;
  const repeatsSampled = repeats.ok && repeats.value.truncated;
  const input: FixInputs = {
    window,
    routes: routes.ok ? routes.value : null,
    queries: queries.ok ? queries.value.rows : null,
    repeats: repeats.ok && !repeats.value.statementsOff ? repeats.value.rows : null,
    repeatsSampled,
    regressions: regressions.ok ? regressions.value : null,
  };
  return { items: rankFixFirst(input), sources: states, errors, repeatsSampled, window, computedAt: now };
}

export function fixFirstKey(tenant: Tenant, window: FixWindow): string {
  return `fixfirst:${tenant.platform ? "platform" : tenant.orgId}:${window}`;
}

/** The list for one organisation and window, behind the stale-while-revalidate cache. */
export function fixFirst(
  tenant: Tenant,
  window: FixWindow,
  sources: FixSources = defaultFixSources,
  clock: () => number = Date.now,
): Promise<FixFirstResult> {
  return cachedStale(fixFirstKey(tenant, window), FIX_FRESH_MS, FIX_MAX_STALE_MS, () => computeFixFirst(tenant, window, clock(), sources), clock);
}
