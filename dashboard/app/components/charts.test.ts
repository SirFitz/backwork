import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { ThemeProvider } from "remix-themes";
import { TimeSeries, markersWithin, merge, type Series } from "./charts";

const a: Series = { name: "now", color: "blue", points: [{ t: 2, v: 20 }, { t: 1, v: 10 }] };
const b: Series = { name: "last week", color: "grey", points: [{ t: 1, v: 5 }, { t: 3, v: 7 }] };

/** Plain .ts (tsc leaves *.test.ts out), so elements are built without JSX. */
function themed(el: ReactElement): string {
  return renderToString(createElement(ThemeProvider, { specifiedTheme: null, themeAction: "/action/set-theme" }, el));
}

describe("TimeSeries data", () => {
  test("merge joins series and the overlay by instant, oldest first", () => {
    expect(merge([a, b])).toEqual([{ t: 1, now: 10, "last week": 5 }, { t: 2, now: 20 }, { t: 3, "last week": 7 }]);
  });
  test("markers outside the data's span are left out", () => {
    const data = merge([a]);
    expect(markersWithin([{ t: 0, label: "x" }, { t: 1, label: "v1" }, { t: 2, label: "v2" }, { t: 9, label: "y" }], data).map((m) => m.label)).toEqual(["v1", "v2"]);
    expect(markersWithin([{ t: 1, label: "v1" }], [])).toEqual([]);
  });
  test("renders on the server with and without markers and overlay (placeholder until hydrated)", () => {
    const plain = themed(createElement(TimeSeries, { series: [a], height: 120 }));
    const marked = themed(createElement(TimeSeries, { series: [a], overlay: b, markers: [{ t: 1, label: "v1", detail: "deploy v1" }], height: 120 }));
    expect(plain).toContain("height:120px");
    expect(marked).toBe(plain);
  });
});
