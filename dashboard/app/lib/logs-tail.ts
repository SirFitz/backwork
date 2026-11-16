/** Live tail for the Logs page (BAC-83): the page asks only for lines newer than the newest one it shows,
 *  and appends them, instead of reloading the whole list on every poll. */

/** Lines kept in the browser; the oldest are dropped past this. */
export const MAX_LINES_KEPT = 2000;

/** How often the page asks for new lines, while the tab is visible and Live is on. */
export const TAIL_POLL_MS = 10_000;

/** One log line as the page shows it. `tsNs` is Loki's own nanosecond timestamp, as a string. */
export interface LogLine {
  ts: number;
  tsNs: string;
  level: string;
  service: string;
  message: string;
  traceId: string | null;
}

/** A `since` value is a nanosecond epoch timestamp: digits only, at most 22 of them. Anything else is ignored. */
export function parseSince(raw: string | null): string | null {
  if (raw === null) return null;
  const v = raw.trim();
  return /^\d{1,22}$/.test(v) ? v : null;
}

/** Milliseconds to the nanosecond string Loki uses. */
export function msToNs(ms: number): string {
  return (BigInt(Math.floor(ms)) * 1_000_000n).toString();
}

/** Stable identity of a line, used as its React key and to drop the repeats a `since` query returns
 *  (Loki's start bound is inclusive, so the newest line shown comes back once). */
export function lineKey(l: LogLine): string {
  return `${l.tsNs}\u0000${l.service}\u0000${l.message}`;
}

/** The newest timestamp in a newest-first list, or `fallback` when the list is empty. */
export function newestNs(lines: readonly LogLine[], fallback: string): string {
  let best = BigInt(fallback);
  for (const l of lines) {
    const n = BigInt(l.tsNs);
    if (n > best) best = n;
  }
  return best.toString();
}

/** Puts new lines (any order) on top of a newest-first list: repeats are dropped, the result is
 *  newest first, and the oldest lines past `cap` are cut. `added` counts the lines that were new. */
export function mergeNewLines(
  shown: readonly LogLine[],
  incoming: readonly LogLine[],
  cap: number = MAX_LINES_KEPT,
): { lines: LogLine[]; added: number } {
  const seen = new Set(shown.map(lineKey));
  const fresh: LogLine[] = [];
  for (const l of incoming) {
    const k = lineKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(l);
  }
  if (fresh.length === 0) return { lines: shown.slice(0, cap), added: 0 };
  fresh.sort((a, b) => (BigInt(b.tsNs) > BigInt(a.tsNs) ? 1 : BigInt(b.tsNs) < BigInt(a.tsNs) ? -1 : 0));
  return { lines: [...fresh, ...shown].slice(0, cap), added: fresh.length };
}
