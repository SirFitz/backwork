import { describe, expect, test } from "bun:test";
import { PLANS, PlanId } from "~/components/site/plans";
import { extraFor } from "./extras";
import { monthDays, monthFirstDay, monthUsage, utcDay } from "./month";

const NOV_13 = Date.UTC(2026, 10, 13, 22, 30);
const plan = (id: PlanId) => PLANS.find((p) => p.id === id)!;

describe("month", () => {
  test("utcDay and the first day follow UTC, not the local zone", () => {
    expect(utcDay(Date.UTC(2026, 10, 30, 23, 59))).toBe("2026-11-30");
    expect(monthFirstDay(Date.UTC(2026, 10, 30, 23, 59))).toBe("2026-11-01");
    expect(monthFirstDay(Date.UTC(2026, 11, 1, 0, 0))).toBe("2026-12-01");
  });
  test("a month lists every day once, with February's length right", () => {
    expect(monthDays(NOV_13)).toHaveLength(30);
    expect(monthDays(NOV_13)[0]).toBe("2026-11-01");
    expect(monthDays(NOV_13)[29]).toBe("2026-11-30");
    expect(monthDays(Date.UTC(2028, 1, 10))).toHaveLength(29);
    expect(monthDays(Date.UTC(2026, 11, 31))).toHaveLength(31);
  });
  test("totals the month, zero-fills quiet days and ignores other months", () => {
    const u = monthUsage(
      [
        { day: "2026-10-31", requests: 999, bytes: 999 },
        { day: "2026-11-02", requests: 100, bytes: 1_000 },
        { day: "2026-11-13", requests: 50, bytes: 500 },
      ],
      NOV_13
    );
    expect(u.requests).toBe(150);
    expect(u.bytes).toBe(1_500);
    expect(u.today).toBe("2026-11-13");
    expect(u.days.find((d) => d.day === "2026-11-05")).toEqual({ day: "2026-11-05", requests: 0, bytes: 0 });
  });
});

describe("extraFor", () => {
  const team = plan(PlanId.Team); // 2M requests and 20 GB included, then $10 per million and $0.50 per GB
  test("nothing extra inside the allowance", () => {
    const e = extraFor(team, 2_000_000, 20 * 1024 ** 3)!;
    expect(e.cost).toBe(0);
    expect(e.breakdown).toBe("");
  });
  test("requests past the allowance cost the per-million rate", () => {
    const e = extraFor(team, 3_500_000, 0)!;
    expect(e.requests).toBe(1_500_000);
    expect(e.cost).toBe(15);
    expect(e.breakdown).toBe("1.5M requests × $10/M");
  });
  test("data past the allowance costs the per-GB rate, and both add up", () => {
    const e = extraFor(team, 2_500_000, 24 * 1024 ** 3)!;
    expect(e.cost).toBe(7); // 0.5M × $10 = 5, 4 GB × $0.50 = 2
    expect(e.breakdown).toBe("500k requests × $10/M + 4 GB × $0.50");
  });
  test("a plan without extra prices has no extra", () => {
    expect(extraFor(plan(PlanId.Free), 9_999_999, 1e12)).toBeNull();
    expect(extraFor(plan(PlanId.Enterprise), 1, 1)).toBeNull();
  });
});
