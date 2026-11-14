import { describe, expect, test } from "bun:test";
import { withBudget } from "./with-budget";

const after = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

describe("withBudget", () => {
  test("a value inside the budget is returned", async () => {
    expect(await withBudget(after(5, "ok"), 200)).toBe("ok");
  });
  test("a value after the budget is null, and the promise still settles for the next caller", async () => {
    const slow = after(60, "late");
    expect(await withBudget(slow, 10)).toBeNull();
    expect(await slow).toBe("late");
  });
  test("a rejection inside the budget rejects", async () => {
    await expect(withBudget(Promise.reject(new Error("boom")), 200)).rejects.toThrow("boom");
  });
  test("a rejection after the budget is swallowed (no unhandled rejection)", async () => {
    const failing = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late boom")), 30));
    expect(await withBudget(failing, 5)).toBeNull();
    await new Promise((r) => setTimeout(r, 60));
  });
});
