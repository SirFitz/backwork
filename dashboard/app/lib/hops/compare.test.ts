import { describe, expect, test } from "bun:test";
import {
  CompareVerdict,
  MIN_REQUESTS,
  canCompare,
  classify,
  compareChip,
  compareLookbackSeconds,
  compareRow,
  regressions,
} from "./compare";
import { PerfRange } from "./figures";
import type { Figures } from "./metrics.server";

const fig = (p95: number | null, errorShare = 0, rate = 1): Figures => ({ rate, errorShare, p50: null, p95, p99: null });

describe("classify", () => {
  test("slower needs 1.5x and 100 ms: 1.49x is the same, 1.5x is slower", () => {
    expect(classify(fig(0.298), fig(0.2), 100, 100)).toBe(CompareVerdict.Same);
    expect(classify(fig(0.3), fig(0.2), 100, 100)).toBe(CompareVerdict.Slower);
  });
  test("slower needs a rise of at least 100 ms: 99 ms is the same", () => {
    expect(classify(fig(0.199), fig(0.1), 100, 100)).toBe(CompareVerdict.Same);
    expect(classify(fig(0.2), fig(0.1), 100, 100)).toBe(CompareVerdict.Slower);
    // 3x but only 40 ms more
    expect(classify(fig(0.06), fig(0.02), 100, 100)).toBe(CompareVerdict.Same);
  });
  test("both windows need 30 requests", () => {
    expect(MIN_REQUESTS).toBe(30);
    expect(classify(fig(0.9), fig(0.1), 29, 100)).toBe(CompareVerdict.NoBaseline);
    expect(classify(fig(0.9), fig(0.1), 100, 29)).toBe(CompareVerdict.NoBaseline);
    expect(classify(fig(0.9), fig(0.1), 30, 30)).toBe(CompareVerdict.Slower);
  });
  test("no last week is no baseline", () => {
    expect(classify(fig(0.9), null, 1000, 0)).toBe(CompareVerdict.NoBaseline);
  });
  test("more errors: 5 points higher and at least twice", () => {
    expect(classify(fig(0.1, 0.07), fig(0.1, 0.02), 100, 100)).toBe(CompareVerdict.MoreErrors);
    expect(classify(fig(0.1, 0.069), fig(0.1, 0.02), 100, 100)).toBe(CompareVerdict.Same);
    // 6 points more but not twice
    expect(classify(fig(0.1, 0.16), fig(0.1, 0.1), 100, 100)).toBe(CompareVerdict.Same);
  });
  test("faster: at most 0.67x and 100 ms lower", () => {
    expect(classify(fig(0.201), fig(0.3), 100, 100)).toBe(CompareVerdict.Same);
    expect(classify(fig(0.2), fig(0.5), 100, 100)).toBe(CompareVerdict.Faster);
    expect(classify(fig(0.01), fig(0.05), 100, 100)).toBe(CompareVerdict.Same);
  });
  test("a missing p95 never makes a latency verdict", () => {
    expect(classify(fig(null), fig(0.1), 100, 100)).toBe(CompareVerdict.Same);
    expect(classify(fig(0.5), fig(null), 100, 100)).toBe(CompareVerdict.Same);
  });
});

describe("lookback", () => {
  test("min(7d, 14d - 7d - range - 1h) for 1h, 6h and 24h", () => {
    expect(compareLookbackSeconds(PerfRange.H1)).toBe(7 * 86400 - 2 * 3600);
    expect(compareLookbackSeconds(PerfRange.H6)).toBe(7 * 86400 - 7 * 3600);
    expect(compareLookbackSeconds(PerfRange.H24)).toBe(7 * 86400 - 25 * 3600);
  });
  test("7d cannot be compared", () => {
    expect(canCompare(PerfRange.D7)).toBe(false);
    expect(compareLookbackSeconds(PerfRange.D7)).toBeNull();
  });
  test("offset, range and lookback stay an hour inside 14 days", () => {
    for (const r of [PerfRange.H1, PerfRange.H6, PerfRange.H24]) {
      const range = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 0 }[r];
      expect(7 * 86400 + range + (compareLookbackSeconds(r) ?? 0)).toBeLessThanOrEqual(14 * 86400 - 3600);
    }
  });
});

describe("rows and chips", () => {
  test("a row carries ratio, rise and error rise", () => {
    const r = compareRow("shop-api", "GET", "/shop", fig(0.74, 0.03), fig(0.31, 0.01), 1820, 1700);
    expect(r.verdict).toBe(CompareVerdict.Slower);
    expect(r.p95Ratio).toBeCloseTo(2.387, 3);
    expect(r.p95RiseS).toBeCloseTo(0.43, 6);
    expect(r.errorRise).toBeCloseTo(0.02, 6);
    expect(compareChip(r)).toMatchObject({ text: "2.4x slower", tone: "warn" });
    expect(compareChip(r).detail).toContain("p95 740 ms now, p95 310 ms the same hours last week");
  });
  test("chip wording for every verdict, never red", () => {
    expect(compareChip(compareRow("a", null, null, fig(0.1, 0.09), fig(0.1, 0.01), 100, 100))).toMatchObject({ text: "8 points more errors", tone: "warn" });
    expect(compareChip(compareRow("a", null, null, fig(0.1), fig(0.4), 100, 100))).toMatchObject({ text: "4.0x faster", tone: "neutral" });
    expect(compareChip(compareRow("a", null, null, fig(0.1), fig(0.1), 100, 100))).toMatchObject({ text: "about the same", tone: "neutral" });
    expect(compareChip(compareRow("a", null, null, fig(0.1), null, 100, 0))).toMatchObject({ text: "no baseline", tone: "neutral" });
    expect(compareChip(compareRow("a", null, null, fig(0.1), fig(0.1), 10, 100)).detail).toContain("fewer than 30 requests");
  });
  test("regressions keep slower and more errors, biggest ratio first", () => {
    const rows = [
      compareRow("same", null, null, fig(0.1), fig(0.1), 100, 100),
      compareRow("a", null, null, fig(0.5), fig(0.3), 100, 100),
      compareRow("b", null, null, fig(0.9), fig(0.2), 100, 100),
      compareRow("c", null, null, fig(0.1, 0.5), fig(0.1, 0.01), 100, 100),
    ];
    expect(regressions(rows).map((r) => r.service)).toEqual(["b", "a", "c"]);
  });
});
