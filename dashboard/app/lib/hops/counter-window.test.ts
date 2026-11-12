import { describe, expect, test } from "bun:test";
import { COUNTER_LOOKBACK_SECONDS, windowIncrease, windowPerSecond, windowSeconds } from "./counter-window";

const X = 'backwork_hop_duration_seconds_count{dir="in"}';
const LB = COUNTER_LOOKBACK_SECONDS;

describe("windowSeconds", () => {
  test("PromQL durations", () => {
    expect(windowSeconds("15m")).toBe(900);
    expect(windowSeconds("1h")).toBe(3600);
    expect(windowSeconds("7d")).toBe(604800);
    expect(() => windowSeconds("6 hours")).toThrow();
  });
});

describe("windowIncrease: the window as the difference of two increases that start together", () => {
  test("one hour: [start - lookback, now] minus [start - lookback, start]", () => {
    expect(windowIncrease(X, "1h", ["service"])).toBe(
      `clamp_min((sum by (service) (increase(${X}[${3600 + LB}s])) - sum by (service) (increase(${X}[${LB}s] offset 3600s))) or sum by (service) (increase(${X}[${3600 + LB}s])), 0)`
    );
  });
  test("a window that ends in the past (the Overview's baseline)", () => {
    expect(windowIncrease(X, "3h", ["service"], "15m")).toBe(
      `clamp_min((sum by (service) (increase(${X}[${10800 + LB}s] offset 900s)) - sum by (service) (increase(${X}[${LB}s] offset ${900 + 10800}s))) or sum by (service) (increase(${X}[${10800 + LB}s] offset 900s)), 0)`
    );
  });
  test("no labels sums everything", () => {
    expect(windowIncrease(X, "1h", [])).toContain("sum (increase(");
  });
  test("per second divides by the window length and never uses rate()", () => {
    const q = windowPerSecond(X, "6h", ["service"]);
    expect(q.endsWith(" / 21600")).toBe(true);
    expect(q).not.toContain("rate(");
  });
});
