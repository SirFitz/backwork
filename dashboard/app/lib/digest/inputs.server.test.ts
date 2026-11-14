import { describe, expect, test } from "bun:test";
import { AlertEventKind } from "~/lib/alert-state.server";
import { FixKind, FixWindow, SourceState } from "~/lib/insights/fix-first";
import { DigestSource, loadDigestInput, weekAlertEvents, type DigestSources } from "./inputs.server";

const NOW = Date.UTC(2026, 10, 16, 8, 5);
const WEEK = 7 * 86_400_000;

function sources(over: Partial<DigestSources> = {}, seen: string[] = []): DigestSources {
  return {
    fixFirst: async (t) => {
      seen.push(`fix:${t.orgId}`);
      return {
        items: [],
        sources: { [FixKind.Route]: SourceState.Ok, [FixKind.Query]: SourceState.Unavailable, [FixKind.Repeat]: SourceState.Ok, [FixKind.Regression]: SourceState.Ok },
        errors: {},
        repeatsSampled: false,
        window: FixWindow.H6,
        computedAt: NOW,
      };
    },
    compare: async (t) => (seen.push(`compare:${t.orgId}`), []),
    repeats: async (t) => (seen.push(`repeats:${t.orgId}`), { rows: [], recordsRead: 0, truncated: true, windowMs: 0, statementsOff: false }),
    errors: async (orgId) => (seen.push(`errors:${orgId}`), { groups: [], weekCounts: new Map() }),
    alerts: async (orgId) => (seen.push(`alerts:${orgId}`), { rules: [], events: [] }),
    deploys: async (orgId, from, to) => (seen.push(`deploys:${orgId}:${to - from}`), []),
    usage: async (orgId) => (seen.push(`usage:${orgId}`), null),
    ...over,
  };
}

describe("loadDigestInput", () => {
  test("every source is read for the organisation itself, over the last week", async () => {
    const seen: string[] = [];
    const input = await loadDigestInput({ orgId: "org-a", orgName: "A", now: NOW }, sources({}, seen), 1000, "https://bw.test/");
    expect(seen.sort()).toEqual(["alerts:org-a", "compare:org-a", `deploys:org-a:${WEEK}`, "errors:org-a", "fix:org-a", "repeats:org-a", "usage:org-a"]);
    expect(input.weekStart).toBe(NOW - WEEK);
    expect(input.insightsUrl).toBe("https://bw.test/insights");
    expect(input.repeatsSampled).toBe(true);
    // the fix-first list's own failed source is named
    expect(input.unavailable).toEqual(["slow queries"]);
  });

  test("a failing or slow source is named and the rest still load", async () => {
    const input = await loadDigestInput(
      { orgId: "org-a", orgName: "A", now: NOW },
      sources({
        compare: async () => {
          throw new Error("vm down");
        },
        errors: () => new Promise(() => {}), // never answers
      }),
      50,
    );
    expect(input.unavailable).toContain(DigestSource.Compare);
    expect(input.unavailable).toContain(DigestSource.Errors);
    expect(input.regressions).toEqual([]);
    expect(input.errorGroups).toEqual([]);
  });
});

describe("weekAlertEvents", () => {
  test("firings this week paired with the resolve that followed", () => {
    const ev = (id: string, ruleId: string, kind: AlertEventKind, at: number) => ({ id, ruleId, kind, value: 1, at, delivered: null });
    const out = weekAlertEvents(
      {
        rules: [{ id: "r1", name: "Slow checkout" }],
        events: [
          ev("1", "r1", AlertEventKind.Firing, NOW - WEEK - 1000),
          ev("2", "r1", AlertEventKind.Resolved, NOW - WEEK + 1000),
          ev("3", "r1", AlertEventKind.Firing, NOW - 3600_000),
          ev("4", "r1", AlertEventKind.Resolved, NOW - 1800_000),
          ev("5", "r2", AlertEventKind.Firing, NOW - 60_000),
        ],
      },
      NOW - WEEK,
    );
    expect(out).toEqual([
      { rule: "Slow checkout", firedAt: NOW - 3600_000, resolvedAt: NOW - 1800_000 },
      { rule: "a deleted rule", firedAt: NOW - 60_000, resolvedAt: null },
    ]);
  });
});
