/**
 * Chatty requests (BAC-71): requests that made an unusual number of database and cache calls. The
 * Requests list flags rows from the totals on each inbound end record (HOP-20), the request view
 * flags the whole request from its own counts. Pure: no `.server` imports, so the list and the
 * request view run it in the browser; the list's row type is matched structurally (`ChattyInput`).
 *
 * - Absolute: at least CHATTY_CALLS calls in one request is always chatty.
 * - Relative (list only): among the loaded rows, at least CHATTY_MIN_SAMPLE rows of the same
 *   service, method and route, and this row made at least CHATTY_FACTOR times their median and at
 *   least CHATTY_RELATIVE_MIN_CALLS calls. The sample is the loaded page, not a baseline; the
 *   wording says so.
 * - Rows without totals are never flagged.
 */
import { storeCallCounts } from "./tree";
import { plural } from "./time-format";
import type { RequestTree, StoreTotals } from "./types";

// ---------------------------------------------------------------- thresholds

/** Database plus cache calls in one request from which it is always chatty. */
export const CHATTY_CALLS = 50;
/** A row is chatty when it made at least this many times its route's median among loaded rows. */
export const CHATTY_FACTOR = 3;
/** Rows of the same route that must be loaded before the relative test is used. */
export const CHATTY_MIN_SAMPLE = 8;
/** The relative test never flags a row below this many calls (3 times a median of 1 is noise). */
export const CHATTY_RELATIVE_MIN_CALLS = 10;

// ---------------------------------------------------------------- types

/** Why a request is chatty. */
export const ChattyReason = {
  /** At least CHATTY_CALLS calls. */
  Absolute: "absolute",
  /** Well above its route's median among the loaded rows. */
  Relative: "relative",
} as const;
export type ChattyReason = (typeof ChattyReason)[keyof typeof ChattyReason];

/** The marker text on the list and the request header. */
export const CHATTY_BADGE = "chatty";

export interface ChattyVerdict {
  chatty: boolean;
  /** Database plus cache calls; 0 when the row has no totals. */
  calls: number;
  reason: ChattyReason | null;
  /** The median calls of the row's route among the loaded rows; null when the sample is too small
   *  (or for a whole request, which has no sample). */
  routeMedian: number | null;
  /** Database time as a share of the request's duration, 0 to 1; null when unknown. */
  dbShare: number | null;
}

/** What the list test reads from a row (`RequestListRow` satisfies it). */
export interface ChattyInput {
  service: string;
  method: string;
  route: string;
  totals: StoreTotals | null;
  durationMs: number;
}

/** The loaded rows' calls for one route. */
export interface RouteSample {
  rows: number;
  median: number;
}

// ---------------------------------------------------------------- figures

/** Database plus cache calls on a row; null without totals. */
export function callsOf(row: Pick<ChattyInput, "totals">): number | null {
  return row.totals ? row.totals.dbCalls + row.totals.cacheCalls : null;
}

/** The middle value; the mean of the two middle values for an even count; null when empty. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function routeKey(row: Pick<ChattyInput, "service" | "method" | "route">): string {
  return `${row.service}\u0000${row.method}\u0000${row.route}`;
}

/** Each route's sample among the rows with totals, by service, method and route. */
export function routeSamples(rows: readonly ChattyInput[]): Map<string, RouteSample> {
  const calls = new Map<string, number[]>();
  for (const r of rows) {
    const n = callsOf(r);
    if (n === null) continue;
    const k = routeKey(r);
    const list = calls.get(k);
    if (list) list.push(n);
    else calls.set(k, [n]);
  }
  const out = new Map<string, RouteSample>();
  for (const [k, list] of calls) out.set(k, { rows: list.length, median: median(list) ?? 0 });
  return out;
}

function dbShareOf(totals: StoreTotals | null, durationUs: number): number | null {
  if (!totals || durationUs <= 0) return null;
  return Math.min(1, totals.dbUs / durationUs);
}

function verdict(calls: number, sample: RouteSample | null, dbShare: number | null): ChattyVerdict {
  const routeMedian = sample && sample.rows >= CHATTY_MIN_SAMPLE ? sample.median : null;
  let reason: ChattyReason | null = null;
  if (calls >= CHATTY_CALLS) reason = ChattyReason.Absolute;
  else if (routeMedian !== null && calls >= CHATTY_RELATIVE_MIN_CALLS && calls >= CHATTY_FACTOR * routeMedian) reason = ChattyReason.Relative;
  return { chatty: reason !== null, calls, reason, routeMedian, dbShare };
}

const NOT_KNOWN: ChattyVerdict = { chatty: false, calls: 0, reason: null, routeMedian: null, dbShare: null };

// ---------------------------------------------------------------- verdicts

/** One list row against the loaded rows (`samples` from `routeSamples(rows)`). */
export function chattyRowIn(row: ChattyInput, samples: ReadonlyMap<string, RouteSample>): ChattyVerdict {
  const calls = callsOf(row);
  if (calls === null) return NOT_KNOWN;
  return verdict(calls, samples.get(routeKey(row)) ?? null, dbShareOf(row.totals, row.durationMs * 1000));
}

/** One list row against the loaded rows. For many rows use `chattyRows`, which samples once. */
export function chattyRow(row: ChattyInput, rows: readonly ChattyInput[]): ChattyVerdict {
  return chattyRowIn(row, routeSamples(rows));
}

/** Every row's verdict, in the rows' order. */
export function chattyRows(rows: readonly ChattyInput[]): ChattyVerdict[] {
  const samples = routeSamples(rows);
  return rows.map((r) => chattyRowIn(r, samples));
}

/** A whole request: every database and cache call it made (recorded or only counted), absolute
 *  test only (one request has no route sample). */
export function chattyRequest(tree: RequestTree): ChattyVerdict {
  const counts = storeCallCounts(tree);
  const s = tree.split;
  const dbShare = s && s.totalUs > 0 ? Math.min(1, s.dbUs / s.totalUs) : null;
  return verdict(counts.db + counts.cache, null, dbShare);
}

// ---------------------------------------------------------------- list helpers

/** The rows whose verdict is chatty (`verdicts` in the rows' order, from `chattyRows`). */
export function onlyChatty<T>(rows: readonly T[], verdicts: readonly ChattyVerdict[]): T[] {
  return rows.filter((_, i) => verdicts[i]?.chatty === true);
}

/** Most calls first; rows without totals last, in their order. */
export function byMostCalls<T extends Pick<ChattyInput, "totals">>(rows: readonly T[]): T[] {
  return rows
    .map((r, i) => ({ r, i, n: callsOf(r) }))
    .sort((a, b) => (b.n ?? -1) - (a.n ?? -1) || a.i - b.i)
    .map((x) => x.r);
}

// ---------------------------------------------------------------- words

/** The badge's title: "142 database and cache calls; this route's median is 12 among the loaded
 *  requests." */
export function chattySentence(v: ChattyVerdict): string {
  const head = plural(v.calls, "database and cache call", "database and cache calls");
  if (v.reason === ChattyReason.Relative && v.routeMedian !== null) {
    return `${head}; this route's median is ${Math.round(v.routeMedian * 10) / 10} among the loaded requests.`;
  }
  return `${head} in one request (${CHATTY_CALLS} or more is a lot).`;
}
