// The Insights tab strip (BAC-67). The definitions live in the route; a test beside it would be
// picked up as a route by Remix, so it sits here.
import { describe, expect, test } from "bun:test";
import { INSIGHT_TABS, InsightTab, visibleInsightTabs, type InsightTabDef } from "~/routes/insights";

describe("Insights tabs", () => {
  test("in plan order: Fix first, Slow queries, Repeated calls, Service map", () => {
    expect(INSIGHT_TABS.map((t) => t.label)).toEqual(["Fix first", "Slow queries", "Repeated calls", "Service map"]);
  });

  test("only tabs whose route exists are shown", () => {
    expect(visibleInsightTabs().map((t) => t.key)).toContain(InsightTab.FixFirst);
    expect(visibleInsightTabs().map((t) => t.key)).toContain(InsightTab.RepeatedCalls);
  });

  test("flipping ready shows a tab in its place", () => {
    const flipped: InsightTabDef[] = INSIGHT_TABS.map((t) => (t.key === InsightTab.ServiceMap ? { ...t, ready: true } : t));
    expect(visibleInsightTabs(flipped).map((t) => t.to)).toContain("/insights/map");
  });
});
