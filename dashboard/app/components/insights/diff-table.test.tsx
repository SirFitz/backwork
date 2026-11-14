// BAC-75: the comparison's list and table render their states (server-rendered, no browser).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CompareButton, DiffBar, DiffTable, TopDiffs, diffRowAnchor } from "./diff-table";
import { DiffKind, type DiffRow } from "~/lib/hops/diff";
import { HopDir, HopState, Via } from "~/lib/hops/types";

function row(over: Partial<DiffRow>): DiffRow {
  return {
    key: "r", id: "0000000a", parentKey: null, label: "shop-api GET /orders/:id", depth: 0,
    a: { durationUs: 422_000, calls: 1 }, b: { durationUs: 186_000, calls: 1 }, deltaUs: 236_000,
    kind: DiffKind.Slower, hasChildren: true, store: false, contributionUs: 0, ...over,
  };
}

const ROOT = row({});
const ORDERS = row({ key: "r\no", id: "0000000b", parentKey: "r", label: "select orders", depth: 1, a: { durationUs: 416_000, calls: 1 }, b: { durationUs: 180_000, calls: 1 }, hasChildren: false, store: true, contributionUs: 236_000 });
const GETS = row({ key: "r\ng", id: "0000000c", parentKey: "r", label: "get redis.internal", depth: 1, a: { durationUs: 1900, calls: 3 }, b: { durationUs: 1900, calls: 3 }, deltaUs: 0, kind: DiffKind.Same, hasChildren: false, store: true });

describe("TopDiffs", () => {
  test("lists contributors with both times and the signed difference", () => {
    const html = renderToStaticMarkup(<TopDiffs rows={[ORDERS]} onShow={() => {}} />);
    expect(html).toContain("What differs");
    expect(html).toContain("select orders");
    expect(html).toContain("416 ms against 180 ms");
    expect(html).toContain("+236 ms");
    expect(html).toContain("bg-warn/75");
  });
  test("empty: says nothing differs", () => {
    expect(renderToStaticMarkup(<TopDiffs rows={[]} onShow={() => {}} />)).toContain("both made the same calls");
  });
});

describe("DiffTable", () => {
  test("folded by default to differing rows and those above them", () => {
    const html = renderToStaticMarkup(<DiffTable rows={[ROOT, ORDERS, GETS]} focus={null} aName="This request" bName="Typical request" />);
    expect(html).toContain("2 of 3 rows differ");
    expect(html).toContain(`id="${diffRowAnchor(ORDERS.id)}"`);
    expect(html).not.toContain("get redis.internal");
    expect(html).toContain("Show all");
    expect(html).toContain("Typical request");
  });
  test("all alike: an empty note and the Show all control", () => {
    const html = renderToStaticMarkup(<DiffTable rows={[{ ...ROOT, kind: DiffKind.Same, deltaUs: 0 }]} focus={null} aName="This request" bName="Other request" />);
    expect(html).toContain("all 1 rows alike");
    expect(html).toContain("The two requests made the same calls");
  });
  test("group counts and one-sided rows are labelled", () => {
    const plans = row({ key: "r\np", id: "0000000d", parentKey: "r", label: "select plans", depth: 1, a: { durationUs: 21_000, calls: 14 }, b: { durationUs: 3000, calls: 2 }, deltaUs: 18_000, kind: DiffKind.MoreCalls, hasChildren: false, store: true });
    const pay = row({ key: "r\nc", id: "0000000e", parentKey: "r", label: "payments-api POST /pay", depth: 1, b: null, deltaUs: 422_000, kind: DiffKind.OnlyA, hasChildren: false });
    const html = renderToStaticMarkup(<DiffTable rows={[ROOT, plans, pay]} focus={null} aName="This request" bName="Typical request" />);
    expect(html).toContain("×14 against ×2");
    expect(html).toContain("only in this request");
    expect(html).toContain("none");
  });
});

describe("DiffBar and CompareButton", () => {
  test("a faster row is neutral and grows left", () => {
    const html = renderToStaticMarkup(<DiffBar deltaUs={-5000} scaleUs={10_000} />);
    expect(html).toContain("right:50%");
    expect(html).not.toContain("bg-warn");
  });
  test("no button for a request that is not a finished inbound HTTP request", () => {
    expect(renderToStaticMarkup(<CompareButton traceId="ab" head={{ dir: HopDir.In, via: Via.Job, state: HopState.Finished }} />)).toBe("");
    expect(renderToStaticMarkup(<CompareButton traceId="ab" head={{ dir: HopDir.In, via: Via.Http, state: HopState.Open }} />)).toBe("");
  });
});
