// Compare with last week (BAC-73, insights plan 06 section A). Pure: the verdict rules, the
// lookback that keeps last week's windows inside VictoriaMetrics' retention, and the chip
// wording, shared by the query layer (compare.server.ts) and the Performance and Overview pages.

import { windowSeconds } from "~/lib/hops/counter-window";
import { PerfRange } from "~/lib/hops/figures";
import type { Figures } from "~/lib/hops/metrics.server";

/** How a service or route compares with the same hours last week. */
export const CompareVerdict = {
  Slower: "slower",
  MoreErrors: "more_errors",
  Same: "same",
  Faster: "faster",
  NoBaseline: "no_baseline",
} as const;
export type CompareVerdict = (typeof CompareVerdict)[keyof typeof CompareVerdict];
export const COMPARE_VERDICTS: readonly CompareVerdict[] = Object.values(CompareVerdict);

/** "Last week" is the same range ending this long ago, as a PromQL offset. */
export const COMPARE_OFFSET = "7d";
export const COMPARE_OFFSET_SECONDS = 7 * 86400;
/** VictoriaMetrics keeps hop series this long (`-retentionPeriod=14d`). */
export const METRICS_RETENTION_SECONDS = 14 * 86400;
/** Kept between the oldest sample a last-week query reads and the retention edge. */
export const RETENTION_MARGIN_SECONDS = 3600;
/** The counter lookback used for the current window (counter-window.ts). */
export const CURRENT_LOOKBACK_SECONDS = 7 * 86400;

/** Both windows need this many requests before a verdict other than "no baseline". */
export const MIN_REQUESTS = 30;
/** Slower: p95 at least 1.5 times last week's and at least 100 ms more. */
export const SLOWER_FACTOR = 1.5;
export const SLOWER_MIN_RISE_S = 0.1;
/** Faster: p95 at most 0.67 times last week's and at least 100 ms less. */
export const FASTER_FACTOR = 0.67;
export const FASTER_MIN_DROP_S = 0.1;
/** More errors: error share at least 5 points higher and at least twice last week's. */
export const ERROR_RISE_MIN_POINTS = 0.05;
export const ERROR_RISE_FACTOR = 2;
/** Floating point slack so that 0.3 against 0.2 counts as exactly 1.5x and 100 ms. */
const EPSILON = 1e-9;

/** Ranges that can be compared exactly: 7 d cannot (its lookback would leave retention). */
export const COMPARE_RANGES: readonly PerfRange[] = [PerfRange.H1, PerfRange.H6, PerfRange.H24];

export function canCompare(range: PerfRange): boolean {
  return COMPARE_RANGES.includes(range);
}

/**
 * Counter lookback for last week's window: `min(7d, 14d - 7d - range - 1h)`, so that
 * `offset + range + lookback` stays an hour inside retention. Null for a range that cannot be
 * compared (7 d).
 */
export function compareLookbackSeconds(range: PerfRange): number | null {
  if (!canCompare(range)) return null;
  const room = METRICS_RETENTION_SECONDS - COMPARE_OFFSET_SECONDS - windowSeconds(range) - RETENTION_MARGIN_SECONDS;
  return Math.min(CURRENT_LOOKBACK_SECONDS, room);
}

/** One service (method and op null) or one route, now and the same hours last week. */
export interface CompareRow {
  /** service, method and op joined, unique within a table */
  key: string;
  service: string;
  method: string | null;
  op: string | null;
  now: Figures;
  /** null when nothing was recorded last week */
  before: Figures | null;
  requestsNow: number;
  requestsBefore: number;
  /** now.p95 / before.p95, null without both */
  p95Ratio: number | null;
  /** seconds, now.p95 - before.p95 */
  p95RiseS: number | null;
  /** share points (0..1), now.errorShare - before.errorShare */
  errorRise: number | null;
  verdict: CompareVerdict;
}

export function compareKey(service: string, method: string | null, op: string | null): string {
  return [service, method ?? "", op ?? ""].join("\u0000");
}

/** The verdict for one row (thresholds above, same family as the Overview's `detectJumps`). */
export function classify(now: Figures, before: Figures | null, reqNow: number, reqBefore: number): CompareVerdict {
  if (!before || reqNow < MIN_REQUESTS || reqBefore < MIN_REQUESTS) return CompareVerdict.NoBaseline;
  const p95Known = now.p95 !== null && before.p95 !== null && before.p95 > 0;
  if (p95Known && now.p95 !== null && before.p95 !== null) {
    const rise = now.p95 - before.p95;
    if (now.p95 + EPSILON >= SLOWER_FACTOR * before.p95 && rise + EPSILON >= SLOWER_MIN_RISE_S) return CompareVerdict.Slower;
  }
  const errRise = now.errorShare - before.errorShare;
  if (errRise + EPSILON >= ERROR_RISE_MIN_POINTS && now.errorShare + EPSILON >= ERROR_RISE_FACTOR * before.errorShare) {
    return CompareVerdict.MoreErrors;
  }
  if (p95Known && now.p95 !== null && before.p95 !== null) {
    const drop = before.p95 - now.p95;
    if (now.p95 <= FASTER_FACTOR * before.p95 + EPSILON && drop + EPSILON >= FASTER_MIN_DROP_S) return CompareVerdict.Faster;
  }
  return CompareVerdict.Same;
}

/** Build a row from the two windows' figures. */
export function compareRow(
  service: string,
  method: string | null,
  op: string | null,
  now: Figures,
  before: Figures | null,
  requestsNow: number,
  requestsBefore: number,
): CompareRow {
  const both = before !== null && now.p95 !== null && before.p95 !== null;
  return {
    key: compareKey(service, method, op),
    service,
    method,
    op,
    now,
    before,
    requestsNow,
    requestsBefore,
    p95Ratio: both && before.p95 !== null && before.p95 > 0 && now.p95 !== null ? now.p95 / before.p95 : null,
    p95RiseS: both && before.p95 !== null && now.p95 !== null ? now.p95 - before.p95 : null,
    errorRise: before ? now.errorShare - before.errorShare : null,
    verdict: classify(now, before, requestsNow, requestsBefore),
  };
}

/** Tone of a chip: amber for slower or more errors, neutral otherwise (never red: a finding,
 *  not an outage). */
export const ChipTone = { Warn: "warn", Neutral: "neutral" } as const;
export type ChipTone = (typeof ChipTone)[keyof typeof ChipTone];

export interface CompareChip {
  text: string;
  tone: ChipTone;
  /** hover text with both figures */
  detail: string;
}

function ms(seconds: number): string {
  const v = seconds * 1000;
  return v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v).toLocaleString("en-GB")} ms`;
}

function ratio(r: number): string {
  return `${r >= 10 ? Math.round(r) : r.toFixed(1)}x`;
}

/** The "vs last week" chip: "2.1x slower", "4 points more errors", "no baseline". */
export function compareChip(row: CompareRow): CompareChip {
  const p95Now = row.now.p95 === null ? "no p95" : `p95 ${ms(row.now.p95)}`;
  const p95Before = row.before?.p95 == null ? "no p95" : `p95 ${ms(row.before.p95)}`;
  const detail = row.before
    ? `${p95Now} now, ${p95Before} the same hours last week; ${Math.round(row.requestsNow).toLocaleString("en-GB")} requests now, ${Math.round(row.requestsBefore).toLocaleString("en-GB")} then`
    : "nothing recorded the same hours last week";
  switch (row.verdict) {
    case CompareVerdict.Slower:
      return { text: `${ratio(row.p95Ratio ?? 0)} slower`, tone: ChipTone.Warn, detail };
    case CompareVerdict.MoreErrors: {
      const points = Math.round((row.errorRise ?? 0) * 100);
      return { text: `${points} ${points === 1 ? "point" : "points"} more errors`, tone: ChipTone.Warn, detail };
    }
    case CompareVerdict.Faster:
      return { text: `${ratio(1 / (row.p95Ratio ?? 1))} faster`, tone: ChipTone.Neutral, detail };
    case CompareVerdict.Same:
      return { text: "about the same", tone: ChipTone.Neutral, detail };
    case CompareVerdict.NoBaseline:
      return { text: "no baseline", tone: ChipTone.Neutral, detail: row.before ? `fewer than ${MIN_REQUESTS} requests in one of the windows; ${detail}` : detail };
  }
}

/** The rows that belong on the Overview: slower or failing more than last week. */
export function regressions(rows: readonly CompareRow[]): CompareRow[] {
  return rows
    .filter((r) => r.verdict === CompareVerdict.Slower || r.verdict === CompareVerdict.MoreErrors)
    .sort((a, b) => (b.p95Ratio ?? 0) - (a.p95Ratio ?? 0) || a.service.localeCompare(b.service));
}
