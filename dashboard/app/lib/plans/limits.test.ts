import { describe, expect, test } from "bun:test";
import { PausedBecause, UNMETERED, currentPeriod, limitsFor, pausedReason } from "./limits";

const row = (plan: string, requestsLimit: number | null = null, storageLimitBytes: number | null = null) => ({ plan, requestsLimit, storageLimitBytes });

describe("limitsFor", () => {
  test("Free is 100,000 requests and 1 GiB, pauses at the limit, keeps 3 days", () => {
    expect(limitsFor(row("free"))).toEqual({ plan: "free", requestsPerMonth: 100_000, storageBytes: 1024 ** 3, pauseAtLimit: true, hopDays: 3, logDays: 3 });
  });
  test("a paid plan is metered but never pauses", () => {
    const l = limitsFor(row("team"));
    expect(l?.requestsPerMonth).toBe(2_000_000);
    expect(l?.pauseAtLimit).toBe(false);
  });
  test("an override is a hard cap, whatever the plan", () => {
    const l = limitsFor(row("team", 500, null));
    expect(l?.requestsPerMonth).toBe(500);
    expect(l?.pauseAtLimit).toBe(true);
  });
  test("unmetered, unknown and Enterprise are not limited", () => {
    expect(limitsFor(row(UNMETERED))).toBeNull();
    expect(limitsFor(row("gold"))).toBeNull();
    expect(limitsFor(row("enterprise"))).toBeNull();
  });
});

describe("pausedReason", () => {
  const free = limitsFor(row("free"))!;
  test("open below both limits", () => expect(pausedReason(free, { requests: 99_999, bytes: 1 })).toBeNull());
  test("paused at the request limit", () => expect(pausedReason(free, { requests: 100_000, bytes: 0 })).toBe(PausedBecause.Requests));
  test("paused at the storage limit", () => expect(pausedReason(free, { requests: 0, bytes: 1024 ** 3 })).toBe(PausedBecause.Storage));
  test("a paid plan never pauses", () => expect(pausedReason(limitsFor(row("team"))!, { requests: 1e12, bytes: 1e15 })).toBeNull());
});

test("currentPeriod is the UTC month", () => {
  expect(currentPeriod(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
  expect(currentPeriod(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
});
