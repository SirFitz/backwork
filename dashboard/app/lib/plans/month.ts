// The calendar month (UTC) an organisation's usage is read over. Pure: no database here.

/** What one organisation took in on one UTC day. `day` is YYYY-MM-DD. */
export interface DayCount {
  day: string;
  requests: number;
  bytes: number;
}

export interface MonthUsage {
  /** First day of the month, YYYY-MM-DD. */
  first: string;
  /** The day the figures were read on, YYYY-MM-DD. */
  today: string;
  /** Every day of the month in order, zero where nothing was counted. */
  days: DayCount[];
  requests: number;
  bytes: number;
}

const DAY_MS = 86_400_000;

/** The UTC day of a time, YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** First day of the UTC month a time falls in, YYYY-MM-DD. */
export function monthFirstDay(ms: number): string {
  return `${utcDay(ms).slice(0, 8)}01`;
}

/** Every day of the UTC month a time falls in, in order. */
export function monthDays(ms: number): string[] {
  const d = new Date(ms);
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const out: string[] = [];
  for (let t = first; t < next; t += DAY_MS) out.push(utcDay(t));
  return out;
}

/** The month so far: each day of the month with what was counted on it, and the totals. */
export function monthUsage(rows: readonly DayCount[], nowMs: number): MonthUsage {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const days = monthDays(nowMs).map((day): DayCount => ({ day, requests: byDay.get(day)?.requests ?? 0, bytes: byDay.get(day)?.bytes ?? 0 }));
  return {
    first: monthFirstDay(nowMs),
    today: utcDay(nowMs),
    days,
    requests: days.reduce((n, d) => n + d.requests, 0),
    bytes: days.reduce((n, d) => n + d.bytes, 0),
  };
}
