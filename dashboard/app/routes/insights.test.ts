import { describe, expect, test } from "bun:test";
import { INSIGHT_TABS, InsightTab, visibleInsightTabs, type InsightTabDef } from "./insights";

describe("Insights tabs", () => {
  test("in plan order: Fix first, Slow queries, Repeated calls, Service map", () => {
    expect(INSIGHT_TABS.map((t) => t.label)).toEqual(["Fix first", "Slow queries", "Repeated calls", "Service map"]);
  });

  test("only tabs whose route exists are shown; today that is Fix first", () => {
    expect(visibleInsightTabs().map((t) => t.key)).toEqual([InsightTab.FixFirst]);
  });

  test("flipping ready shows a tab in its place", () => {
    const flipped: InsightTabDef[] = INSIGHT_TABS.map((t) => (t.key === InsightTab.ServiceMap ? { ...t, ready: true } : t));
    expect(visibleInsightTabs(flipped).map((t) => t.to)).toEqual(["/insights", "/insights/map"]);
  });
});
