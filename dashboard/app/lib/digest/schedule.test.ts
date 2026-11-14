import { describe, expect, test } from "bun:test";
import { DAY_MS, DIGEST_DUE_WINDOW_MS, Weekday, dueCheck, localTimeHint, nextInstant, periodStart, scheduleText, scheduledInstant } from "./schedule";

const HOUR = 3_600_000;
// Saturday 14 Nov 2026, 12:00 UTC
const SAT_NOON = Date.UTC(2026, 10, 14, 12);

describe("scheduled instant", () => {
  test("the latest occurrence at or before now", () => {
    const day = new Date(SAT_NOON).getUTCDay();
    const at = scheduledInstant(SAT_NOON, Weekday.Monday, 8);
    expect(new Date(at).getUTCDay()).toBe(Weekday.Monday);
    expect(new Date(at).getUTCHours()).toBe(8);
    expect(at).toBeLessThanOrEqual(SAT_NOON);
    expect(at).toBe(Date.UTC(2026, 10, 9, 8));
    expect(day).toBe(Weekday.Saturday);
  });

  test("today at the hour, once the hour has come", () => {
    const sat = Weekday.Saturday;
    expect(scheduledInstant(SAT_NOON, sat, 12)).toBe(SAT_NOON);
    expect(scheduledInstant(SAT_NOON, sat, 11)).toBe(SAT_NOON - HOUR);
    // 13:00 today has not come yet: last week's
    expect(scheduledInstant(SAT_NOON, sat, 13)).toBe(SAT_NOON + HOUR - 7 * DAY_MS);
  });

  test("week boundaries: Sunday 00:00 and Saturday 23:00", () => {
    const sunMidnight = Date.UTC(2026, 10, 15, 0);
    expect(scheduledInstant(sunMidnight, Weekday.Sunday, 0)).toBe(sunMidnight);
    expect(scheduledInstant(sunMidnight - 1, Weekday.Sunday, 0)).toBe(sunMidnight - 7 * DAY_MS);
    expect(scheduledInstant(sunMidnight, Weekday.Saturday, 23)).toBe(sunMidnight - HOUR);
  });

  test("UTC only: the instant does not move across a daylight saving change", () => {
    // Europe and the US change clocks in late October and early November; UTC never does.
    const before = scheduledInstant(Date.UTC(2026, 9, 20, 9), Weekday.Monday, 8);
    const after = scheduledInstant(Date.UTC(2026, 10, 3, 9), Weekday.Monday, 8);
    expect(new Date(before).getUTCHours()).toBe(8);
    expect(new Date(after).getUTCHours()).toBe(8);
    expect((after - before) % (7 * DAY_MS)).toBe(0);
  });

  test("period start is the scheduled UTC day", () => {
    expect(periodStart(Date.UTC(2026, 10, 9, 23, 30))).toBe("2026-11-09");
  });
});

describe("due window", () => {
  const sched = Date.UTC(2026, 10, 9, 8); // Monday 9 Nov 08:00 UTC
  test("due from the hour for 24 hours", () => {
    expect(dueCheck(sched, Weekday.Monday, 8)).toEqual({ scheduledMs: sched, periodStart: "2026-11-09", due: true });
    expect(dueCheck(sched + 15 * 60_000, Weekday.Monday, 8).due).toBe(true);
    expect(dueCheck(sched + DIGEST_DUE_WINDOW_MS - 1, Weekday.Monday, 8).due).toBe(true);
  });
  test("a run missed by more than 24 hours is skipped, not sent late", () => {
    const late = dueCheck(sched + DIGEST_DUE_WINDOW_MS, Weekday.Monday, 8);
    expect(late.due).toBe(false);
    expect(late.periodStart).toBe("2026-11-09");
  });
  test("just before the hour belongs to last week and is not due", () => {
    const r = dueCheck(sched - 1, Weekday.Monday, 8);
    expect(r.periodStart).toBe("2026-11-02");
    expect(r.due).toBe(false);
  });
  test("the next week is a new period", () => {
    expect(dueCheck(sched + 7 * DAY_MS, Weekday.Monday, 8).periodStart).toBe("2026-11-16");
  });
});

describe("wording", () => {
  test("schedule text in UTC", () => {
    expect(scheduleText(Weekday.Monday, 8)).toBe("Mondays at 08:00 UTC");
  });
  test("local hint keeps the day when it is the same", () => {
    expect(localTimeHint(Weekday.Monday, 8, SAT_NOON, "America/Jamaica")).toBe("03:00 your time");
    expect(localTimeHint(Weekday.Monday, 8, SAT_NOON, "UTC")).toBe("08:00 your time");
  });
  test("local hint names the day when it differs", () => {
    expect(localTimeHint(Weekday.Monday, 2, SAT_NOON, "America/Jamaica")).toBe("Sundays at 21:00 your time");
    expect(localTimeHint(Weekday.Monday, 22, SAT_NOON, "Asia/Tokyo")).toBe("Tuesdays at 07:00 your time");
  });
  test("next instant", () => {
    expect(nextInstant(SAT_NOON, Weekday.Saturday, 12)).toBe(SAT_NOON);
    expect(nextInstant(SAT_NOON, Weekday.Saturday, 11)).toBe(SAT_NOON - HOUR + 7 * DAY_MS);
  });
});
