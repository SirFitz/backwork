// Pure. Cache hit ratio and connection wait (BAC-79, docs/insights/12-cache-and-pool.md): the
// figures and the words the Performance table, the request view and the verdict show. The fields
// come from the proposed HOP-25 (`hit`, `cache_hit_n`, `cache_miss_n`) and HOP-26 (`wait_us`,
// `db_wait_us`). A service that does not report them shows "no data", never 0 percent.
import { fmtUs, plural } from "./time-format";
import { Via, type Hop, type StoreTotals } from "./types";

/** The verdict names connection waiting when it is at least this share of the database time. */
export const DB_WAIT_SHARE = 0.3;

/** What a missing figure reads as. */
export const NO_DATA = "no data";
/** Tooltip on the Cache hits cell of a route whose services report no hits or misses. */
export const NO_CACHE_HITS_TIP = "This route's services do not report cache hits yet";
/** Tooltip on the Conn. wait cell of a route whose services report no connection wait. */
export const NO_CONN_WAIT_TIP = "This route's services do not report connection waits yet";
/** Request view fact label on database calls that waited. */
export const WAITED_FACT = "Waited for a connection";
/** Request view fact label on one-key cache reads. */
export const CACHE_READ_FACT = "Cache read";

/** Whether a cache read found a value. */
export const CacheRead = { Hit: "hit", Miss: "miss" } as const;
export type CacheRead = (typeof CacheRead)[keyof typeof CacheRead];

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Hits over reads (hits plus misses), 0..1. Null when there were no reads to count: a route with
 *  misses and no hit series is 0, a route with neither is no data. */
export function hitRatio(hits: number | null, reads: number | null): number | null {
  if (!finite(reads) || reads <= 0) return null;
  const h = finite(hits) ? hits : 0;
  return Math.min(1, Math.max(0, h / reads));
}

/** A wait share as read from VictoriaMetrics, 0..1, or null when there is none. */
export function waitShare(value: number | null): number | null {
  return finite(value) ? Math.min(1, Math.max(0, value)) : null;
}

/** Whole percent, e.g. "38%". */
export function fmtPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** One table cell's text and tooltip. */
export interface ShareCell {
  /** The figure, or null for no data (drawn as a dash). */
  text: string | null;
  title: string;
}

export function cacheHitsCell(ratio: number | null): ShareCell {
  if (ratio === null) return { text: null, title: NO_CACHE_HITS_TIP };
  return { text: fmtPercent(ratio), title: `${fmtPercent(ratio)} of one-key cache reads found a value, ${fmtPercent(1 - ratio)} missed` };
}

export function connWaitCell(share: number | null): ShareCell {
  if (share === null) return { text: null, title: NO_CONN_WAIT_TIP };
  return { text: fmtPercent(share), title: `${fmtPercent(share)} of database time was spent waiting for a connection` };
}

// ---------------------------------------------------------------- request view

/** Muted words after a database call's row text: "waited 4.1 ms". Null when it did not wait or
 *  the wait is not reported. */
export function waitSuffix(hop: Hop): string | null {
  return hop.via === Via.Db && hop.waitUs !== null && hop.waitUs > 0 ? `waited ${fmtUs(hop.waitUs)}` : null;
}

/** The same for a group of calls drawn as one row: their waits added up ("waited 44.8 ms in all"),
 *  or null when none of them waited. */
export function waitSuffixOf(hops: readonly Hop[]): string | null {
  let us = 0;
  for (const h of hops) if (h.via === Via.Db && h.waitUs !== null && h.waitUs > 0) us += h.waitUs;
  return us > 0 ? `waited ${fmtUs(us)} in all` : null;
}

/** "hit" or "miss" for a one-key cache read that reported it. */
export function cacheReadOf(hop: Hop): CacheRead | null {
  if (hop.via !== Via.Cache || hop.hit === null) return null;
  return hop.hit ? CacheRead.Hit : CacheRead.Miss;
}

/** Detail facts of a data-store call: the connection wait and the cache read result, where reported. */
export function storeCallFacts(hop: Hop): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const waited = hop.via === Via.Db && hop.waitUs !== null && hop.waitUs > 0 ? hop.waitUs : null;
  if (waited !== null) {
    const of = hop.durationUs ? `, ${fmtPercent(waited / hop.durationUs)} of the call` : "";
    out.push([WAITED_FACT, `${fmtUs(waited)}${of}`]);
  }
  const read = cacheReadOf(hop);
  if (read) out.push([CACHE_READ_FACT, read === CacheRead.Hit ? "hit, a value was found" : "miss, nothing was found"]);
  return out;
}

/** The inbound hop's data-store chips: calls and time per store, then hits and misses and the
 *  connection wait where the service reports them. */
export function storeTotalsChips(totals: StoreTotals | null): string[] {
  if (!totals || (!totals.dbCalls && !totals.cacheCalls)) return [];
  const out: string[] = [];
  if (totals.dbCalls) out.push(`${plural(totals.dbCalls, "database call", "database calls")} · ${fmtUs(totals.dbUs)}`);
  if (totals.cacheCalls) out.push(`${plural(totals.cacheCalls, "cache call", "cache calls")} · ${fmtUs(totals.cacheUs)}`);
  if (totals.cacheHits !== null || totals.cacheMisses !== null) {
    out.push(`${plural(totals.cacheHits ?? 0, "hit", "hits")}, ${plural(totals.cacheMisses ?? 0, "miss", "misses")}`);
  }
  if (totals.dbWaitUs !== null && totals.dbWaitUs > 0) out.push(`${fmtUs(totals.dbWaitUs)} waiting for connections`);
  return out;
}

// ---------------------------------------------------------------- verdict

/** Connection waiting among database calls that report it. */
export interface ConnectionWait {
  waitUs: number;
  /** Summed duration of the database calls that report a wait. */
  dbUs: number;
  /** waitUs / dbUs, 0..1. */
  share: number;
}

/** Waiting over the reporting database calls in `hops`, or null when none reports a wait. */
export function connectionWait(hops: readonly Hop[]): ConnectionWait | null {
  let waitUs = 0;
  let dbUs = 0;
  let any = false;
  for (const h of hops) {
    if (!h.isStore || h.via !== Via.Db || h.waitUs === null || h.durationUs === null) continue;
    any = true;
    waitUs += h.waitUs;
    dbUs += h.durationUs;
  }
  if (!any || dbUs <= 0) return null;
  return { waitUs, dbUs, share: Math.min(1, waitUs / dbUs) };
}

/** The verdict's clause when waiting is at least DB_WAIT_SHARE of the database time, else null. */
export function connectionWaitClause(w: ConnectionWait | null): string | null {
  if (!w || w.waitUs <= 0 || w.share < DB_WAIT_SHARE) return null;
  return `Of the database time, ${Math.round(w.share * 100)} percent (${fmtUs(w.waitUs)}) was spent waiting for a database connection.`;
}
