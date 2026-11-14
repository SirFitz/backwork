import { describe, expect, test } from "bun:test";
import { isBusy, isSubmittingOwn, type PendingNavigation } from "./pending";

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const submitting = (fields: Record<string, string>): PendingNavigation => ({ state: "submitting", formData: form(fields) });

describe("isSubmittingOwn", () => {
  const team = { intent: "checkout", plan: "team", billing: "monthly" };
  const business = { intent: "checkout", plan: "business", billing: "monthly" };

  test("only the pressed plan reads as pending", () => {
    const nav = submitting(team);
    expect(isSubmittingOwn(nav, team)).toBe(true);
    expect(isSubmittingOwn(nav, business)).toBe(false);
    expect(isBusy(nav)).toBe(true);
  });

  test("stays pending while the action's redirect loads", () => {
    expect(isSubmittingOwn({ state: "loading", formData: form(team) }, team)).toBe(true);
  });

  test("a plain navigation or idle state marks nothing pending", () => {
    expect(isSubmittingOwn({ state: "idle" }, team)).toBe(false);
    expect(isSubmittingOwn({ state: "loading" }, team)).toBe(false);
  });

  test("a plain navigation is not busy, a submission is", () => {
    expect(isBusy({ state: "loading" })).toBe(false);
    expect(isBusy(submitting(team))).toBe(true);
    expect(isBusy({ state: "idle" })).toBe(false);
  });

  test("buttons with no plan field match only forms without one", () => {
    expect(isSubmittingOwn(submitting({ intent: "cancel" }), { intent: "cancel", plan: undefined })).toBe(true);
    expect(isSubmittingOwn(submitting(team), { intent: "checkout", plan: undefined })).toBe(false);
  });
});
