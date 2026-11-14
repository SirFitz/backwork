// BAC-79: the Cache hits and Conn. wait cells as a person sees them: a percent, or a faint dash
// that says "no data" and why. Never "0%" for a route whose services do not report the fields.
import { describe, expect, test } from "bun:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShareCellText } from "~/components/insights/share-cell";
import { NO_CACHE_HITS_TIP, NO_CONN_WAIT_TIP, cacheHitsCell, connWaitCell } from "~/lib/hops/cache-pool";

const html = (cell: ReturnType<typeof cacheHitsCell>): string => renderToStaticMarkup(h(ShareCellText, { cell }));

describe("ShareCellText", () => {
  test("no data: a faint dash with the reason, no percent", () => {
    const out = html(cacheHitsCell(null));
    expect(out).toContain(">—<");
    expect(out).toContain('class="text-faint"');
    expect(out).toContain(`title="${NO_CACHE_HITS_TIP.replace("'", "&#x27;")}"`);
    expect(out).toContain("aria-label=\"no data:");
    expect(out).not.toContain("%");
    expect(html(connWaitCell(null))).toContain(NO_CONN_WAIT_TIP.replace("'", "&#x27;"));
  });
  test("a ratio: the percent, in the plain text colour", () => {
    const out = html(cacheHitsCell(0.3));
    expect(out).toBe('<span title="30% of one-key cache reads found a value, 70% missed">30%</span>');
  });
  test("all misses is 0%, which is data", () => {
    expect(html(cacheHitsCell(0))).toContain(">0%<");
  });
  test("a wait share", () => {
    expect(html(connWaitCell(0.72))).toBe('<span title="72% of database time was spent waiting for a connection">72%</span>');
  });
});
