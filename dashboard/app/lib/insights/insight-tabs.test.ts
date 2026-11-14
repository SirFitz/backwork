// The Insights tab strip (BAC-67). The definitions live in the route; a test beside it would be
// picked up as a route by Remix, so it sits here. It does not name which tabs are ready, so a
// feature PR that flips its flag never has to edit it.
import { describe, expect, test } from "bun:test";
import { INSIGHT_TABS, InsightTab, visibleInsightTabs, type InsightTabDef } from "~/routes/insights";

describe("Insights tabs", () => {
  test("in plan order: Fix first, Slow queries, Repeated calls, Service map", () => {
    expect(INSIGHT_TABS.map((t) => t.label)).toEqual(["Fix first", "Slow queries", "Repeated calls", "Service map"]);
  });

  test("only tabs whose route exists are shown, and Fix first is always one of them", () => {
    expect(visibleInsightTabs()).toEqual(INSIGHT_TABS.filter((t) => t.ready));
    expect(visibleInsightTabs().map((t) => t.key)).toContain(InsightTab.FixFirst);
  });

  test("flipping ready shows a tab in its place", () => {
    const none: InsightTabDef[] = INSIGHT_TABS.map((t) => ({ ...t, ready: t.key === InsightTab.FixFirst }));
    expect(visibleInsightTabs(none).map((t) => t.to)).toEqual(["/insights"]);
    const flipped: InsightTabDef[] = none.map((t) => (t.key === InsightTab.ServiceMap ? { ...t, ready: true } : t));
    expect(visibleInsightTabs(flipped).map((t) => t.to)).toEqual(["/insights", "/insights/map"]);
  });
});
