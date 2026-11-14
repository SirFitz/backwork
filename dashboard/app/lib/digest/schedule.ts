// Weekly digest schedule (BAC-77). Pure: no database, Loki or Remix here, so the settings card
// can show the local-time hint in the browser and the tests can pick any `now`.
//
// A digest is set by a weekday and an hour in UTC. The scheduled instant "for the current week"
// is the latest occurrence at or before `now`; the run is due for 24 hours after it. A digest
// missed by more than that is skipped, never sent late, and the next week proceeds. UTC has no
// daylight saving, so the instant never moves with the seasons.

/** One day, ms. */
export const DAY_MS = 86_400_000;
/** One week, ms. */
export const WEEK_MS = 7 * DAY_MS;
/** A digest is sent this long after its scheduled instant at the latest (24 hours), ms. */
export const DIGEST_DUE_WINDOW_MS = DAY_MS;
/** How often each process checks whether a digest is due (15 minutes), ms. */
export const DIGEST_TICK_MS = 15 * 60_000;
/** First check after the process starts (1 minute), ms. */
export const DIGEST_FIRST_TICK_MS = 60_000;
/** A failed run is tried again once its last attempt is this old (1 hour), ms. */
export const DIGEST_RETRY_AFTER_MS = 60 * 60_000;
/** Attempts per week, the first included. */
export const DIGEST_MAX_ATTEMPTS = 3;

/** Weekday numbers as stored (`digest_settings.weekday`, 0 is Sunday, as `Date.getUTCDay`). */
export const Weekday = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 } as const;
export type Weekday = (typeof Weekday)[keyof typeof Weekday];
export const WEEKDAYS: readonly Weekday[] = Object.values(Weekday);

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  [Weekday.Sunday]: "Sunday",
  [Weekday.Monday]: "Monday",
  [Weekday.Tuesday]: "Tuesday",
  [Weekday.Wednesday]: "Wednesday",
  [Weekday.Thursday]: "Thursday",
  [Weekday.Friday]: "Friday",
  [Weekday.Saturday]: "Saturday",
};

/** The stored defaults (foundation DDL): Mondays at 08:00 UTC. */
export const DEFAULT_WEEKDAY: Weekday = Weekday.Monday;
export const DEFAULT_HOUR_UTC = 8;

export function isWeekday(v: number): v is Weekday {
  return Number.isInteger(v) && v >= 0 && v <= 6;
}

export function isHourUtc(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= 23;
}

/** The latest instant at or before `now` that falls on `weekday` at `hourUtc`:00 UTC (epoch ms). */
export function scheduledInstant(now: number, weekday: Weekday, hourUtc: number): number {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc);
  let at = today - ((d.getUTCDay() - weekday + 7) % 7) * DAY_MS;
  if (at > now) at -= WEEK_MS;
  return at;
}

/** The UTC day of an instant, YYYY-MM-DD (`digest_runs.period_start`). */
export function periodStart(scheduledMs: number): string {
  return new Date(scheduledMs).toISOString().slice(0, 10);
}

export interface DueCheck {
  /** The scheduled instant of the current week (epoch ms). */
  scheduledMs: number;
  /** `digest_runs.period_start` for it. */
  periodStart: string;
  /** Inside the 24 hours after the scheduled instant. */
  due: boolean;
}

/** Is a digest set for `weekday` at `hourUtc` due at `now`? The caller still checks the stored run. */
export function dueCheck(now: number, weekday: Weekday, hourUtc: number): DueCheck {
  const scheduledMs = scheduledInstant(now, weekday, hourUtc);
  return { scheduledMs, periodStart: periodStart(scheduledMs), due: now >= scheduledMs && now < scheduledMs + DIGEST_DUE_WINDOW_MS };
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** "Mondays at 08:00 UTC". */
export function scheduleText(weekday: Weekday, hourUtc: number): string {
  return `${WEEKDAY_LABEL[weekday]}s at ${two(hourUtc)}:00 UTC`;
}

/** The next occurrence at or after `now` (epoch ms). */
export function nextInstant(now: number, weekday: Weekday, hourUtc: number): number {
  const last = scheduledInstant(now, weekday, hourUtc);
  return last === now ? now : last + WEEK_MS;
}

/** The same instant in a time zone, for the hint under the settings: "03:00 your time", or
 *  "Sundays at 22:00 your time" when the local day differs. `timeZone` undefined is the
 *  browser's own zone. Uses the next occurrence, so a zone's current daylight saving applies. */
export function localTimeHint(weekday: Weekday, hourUtc: number, now: number, timeZone?: string): string {
  const at = new Date(nextInstant(now, weekday, hourUtc));
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).formatToParts(at);
  const part = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? "";
  const hour = part("hour") === "24" ? "00" : part("hour");
  const time = `${hour}:${part("minute")}`;
  const day = part("weekday");
  return day === WEEKDAY_LABEL[weekday] ? `${time} your time` : `${day}s at ${time} your time`;
}
