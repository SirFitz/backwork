// Renders the fix-first list to HTML: skeleton, empty, partial (source notes) and full states.
// Plain `.ts` with createElement, like map-graph.test.ts.
import { describe, expect, test } from "bun:test";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { FixList, FixListSkeleton, SourceNotes } from "~/components/insights/fix-list";
import { FIX_PAGE_ROWS, FixKind, FixWindow, SourceState, rankFixFirst, type FixRouteInput } from "~/lib/insights/fix-first";

const render = (el: ReactElement): string => renderToStaticMarkup(h(MemoryRouter, null, el));
const route = (op: string, totalS: number): FixRouteInput => ({ service: "shop-api", method: "GET", op, totalS, requests: 100, failed: 0, p95S: 0.07, storeShare: 0.8 });
const ok = { [FixKind.Route]: SourceState.Ok, [FixKind.Query]: SourceState.Ok, [FixKind.Repeat]: SourceState.Ok, [FixKind.Regression]: SourceState.Ok };

describe("fix list", () => {
  test("skeleton rows first", () => {
    const html = render(h(FixListSkeleton, { rows: 4 }));
    expect(html).toContain(`aria-busy="true"`);
    expect(html.match(/h-\[38px\]/g)).toHaveLength(4);
  });

  test("empty list says nothing stands out", () => {
    const html = render(h(FixList, { items: [], window: FixWindow.H1, shown: FIX_PAGE_ROWS, onMore: () => {}, filtered: false }));
    expect(html).toContain("Nothing stands out in the last hour.");
  });

  test("full list: ranked 38 px rows linking to the filtered view, with Show more", () => {
    const items = rankFixFirst({ window: FixWindow.H1, routes: Array.from({ length: 20 }, (_, i) => route(`/r${i}`, 20 - i)), queries: [], repeats: [], repeatsSampled: false, regressions: [] });
    const html = render(h(FixList, { items, window: FixWindow.H1, shown: FIX_PAGE_ROWS, onMore: () => {}, filtered: false }));
    expect(html.match(/<li>/g)).toHaveLength(FIX_PAGE_ROWS);
    expect(html).toContain("h-[38px]");
    expect(html).toContain(`href="/requests?service=shop-api&amp;method=GET&amp;route=%2Fr0&amp;range=1h"`);
    expect(html).toContain("20.00 s of request time in the last hour");
    expect(html).toContain("Show 5 more");
    expect(html).not.toContain("—");
  });

  test("partial: a note per source that did not contribute, none when all are ok", () => {
    expect(render(h(SourceNotes, { sources: ok, errors: {} }))).toBe("");
    const html = render(h(SourceNotes, { sources: { ...ok, [FixKind.Query]: SourceState.Off, [FixKind.Route]: SourceState.Unavailable }, errors: { [FixKind.Route]: "fetch failed" }, repeatsSampled: true }));
    expect(html).toContain("Slow queries off");
    expect(html).toContain(`title="fetch failed"`);
    expect(html).toContain("Route figures unavailable.");
    expect(html).toContain("Repeated calls sampled");
  });
});
