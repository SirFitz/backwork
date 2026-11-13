import { describe, expect, test } from "bun:test";
import { UNMETERED, isCapped, limitsFor } from "./limits";

const row = (plan: string, requestsLimit: number | null = null, storageLimitBytes: number | null = null) => ({ plan, requestsLimit, storageLimitBytes });

describe("limitsFor", () => {
  test("Free keeps the newest 100,000 requests and 1 GiB, hop records and logs 3 days", () => {
    expect(limitsFor(row("free"))).toEqual({ plan: "free", maxRequests: 100_000, maxBytes: 1024 ** 3, hopDays: 3, logDays: 3 });
  });
  test("a paid plan has retention days but no window", () => {
    const l = limitsFor(row("team"))!;
    expect(isCapped(l)).toBe(false);
    expect(l.hopDays).toBe(30);
  });
  test("an override caps any plan", () => {
    const l = limitsFor(row("team", 500, null))!;
    expect(l.maxRequests).toBe(500);
    expect(l.maxBytes).toBeNull();
    expect(isCapped(l)).toBe(true);
  });
  test("unmetered, unknown and Enterprise are not limited", () => {
    expect(limitsFor(row(UNMETERED))).toBeNull();
    expect(limitsFor(row("gold"))).toBeNull();
    expect(limitsFor(row("enterprise"))).toBeNull();
  });
});
