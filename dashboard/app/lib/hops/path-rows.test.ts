import { describe, expect, test } from "bun:test";
import { buildPathNodes, expandableKeys, GROUP_MIN, summaryOf, visibleRows } from "./path-rows";
import { GapKind, HopDir, HopState, Outcome, StoreKind, Via, type Hop, type HopId } from "./types";

let n = 0;
function mk(over: Partial<Hop>): Hop {
  n++;
  return {
    hopId: `h${n}` as HopId, dir: HopDir.Out, via: Via.Http, service: "api", adapter: null, method: null, op: null, path: null, peer: null,
    table: null, stmt: null, parentHop: null, parentId: "", hopSent: true, tracer: false, handoff: false, attempt: null,
    state: HopState.Finished, outcome: Outcome.Ok, status: 200, error: null, startMs: 0, endMs: 10, durationUs: 10000, totals: null,
    fields: [], linkedIds: [], logs: [], gaps: [], unrecorded: [], isStore: false, afterResponse: false, skewMs: 0, children: [],
    ...over,
  } as Hop;
}
const db = (table: string, us = 1000): Hop => mk({ via: Via.Db, isStore: true, op: "select", table, stmt: `select ${table}`, durationUs: us });
const none = new Map<string, boolean>();

/** root IN (100 ms) -> OUT call -> IN of another service (20 ms) -> 1 db call; plus own db calls. */
function sample() {
  const inner = mk({ dir: HopDir.In, service: "other", durationUs: 20000, children: [db("t")] });
  const call = mk({ dir: HopDir.Out, durationUs: 22000, children: [inner] });
  const root = mk({ dir: HopDir.In, durationUs: 100000, children: [db("a"), call, db("b")] });
  return { root, call, inner };
}

describe("path rows", () => {
  test("a call and the inbound hop it reached are one row, showing both sides", () => {
    const { root, call, inner } = sample();
    const rows = visibleRows(buildPathNodes([root]), none, 100000);
    const merged = rows.find((r) => r.node.hop === inner)!;
    expect(merged.node.call).toBe(call);
    expect(rows.some((r) => r.node.hop === call)).toBe(false);
  });

  test("the request's own hops show; a downstream service is folded with a summary of what is inside", () => {
    const { root, inner } = sample();
    const rows = visibleRows(buildPathNodes([root]), none, 100000);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 1]);
    const merged = rows.find((r) => r.node.hop === inner)!;
    expect(merged.expandable).toBe(true);
    expect(merged.expanded).toBe(false);
    expect(merged.summary).toBe("1 database call");
  });

  test("opening a folded row by hand shows its children, and it can be folded again", () => {
    const { root, inner } = sample();
    const opened = visibleRows(buildPathNodes([root]), new Map([[inner.hopId, true]]), 100000);
    expect(opened.length).toBe(5);
    expect(opened.find((r) => r.node.hop === inner)!.summary).toBeNull();
    const folded = visibleRows(buildPathNodes([root]), new Map([[inner.hopId, false]]), 100000);
    expect(folded.length).toBe(4);
  });

  test("a downstream service that took a large share of the request opens by itself", () => {
    const { root, inner } = sample();
    const rows = visibleRows(buildPathNodes([root]), none, 60000); // 22 ms of 60 ms
    expect(rows.find((r) => r.node.hop === inner)!.expanded).toBe(true);
  });

  test("a failed or unfinished call opens by itself so the problem is not hidden", () => {
    const { root, inner } = sample();
    inner.children[0].outcome = Outcome.Error;
    expect(visibleRows(buildPathNodes([root]), none, 100000).find((r) => r.node.hop === inner)!.expanded).toBe(true);
    inner.children[0].outcome = Outcome.Ok;
    inner.state = HopState.Stalled;
    expect(visibleRows(buildPathNodes([root]), none, 100000).find((r) => r.node.hop === inner)!.expanded).toBe(true);
  });

  test("an outbound call with a gap or a different shape is not merged", () => {
    const inner = mk({ dir: HopDir.In });
    const call = mk({ dir: HopDir.Out, children: [inner], handoff: true });
    const root = mk({ dir: HopDir.In, children: [call] });
    const rows = visibleRows(buildPathNodes([root]), new Map([[call.hopId, true]]), 10000);
    expect(rows.map((r) => r.node.hop)).toEqual([root, call, inner]);
  });

  test("repeated store calls of one shape fold into one row at the first one's place, with their total", () => {
    const calls = [db("pc"), db("user"), db("pc"), db("pc"), db("user"), db("pc")];
    const root = mk({ dir: HopDir.In, durationUs: 100000, children: calls });
    const nodes = buildPathNodes([root]);
    const rows = visibleRows(nodes, none, 100000);
    // pc x4 (grouped), user x2 (below the minimum, kept as they are)
    expect(rows.length).toBe(1 + 1 + 2);
    const group = rows[1];
    expect(group.node.members?.length).toBe(4);
    expect(group.expanded).toBe(false);
    expect(group.summary).toBe("4 database calls");
    expect(GROUP_MIN).toBe(3);
    const open = visibleRows(nodes, new Map([[group.node.key, true]]), 100000);
    expect(open.length).toBe(rows.length + 4);
  });

  test("calls recorded only as a count are part of a folded row's summary", () => {
    const inner = mk({ dir: HopDir.In, unrecorded: [{ store: StoreKind.Db, calls: 450, us: 345000 }], children: [db("t")] });
    const call = mk({ dir: HopDir.Out, children: [inner] });
    const root = mk({ dir: HopDir.In, children: [call] });
    const node = buildPathNodes([root])[0].kids[0];
    expect(summaryOf(node)).toBe("451 database calls");
  });

  test("a receiver that never answered adds a tail row even when its parent is folded", () => {
    const inner = mk({ dir: HopDir.In, children: [db("t")], gaps: [{ kind: GapKind.NoReceiver, hopId: "x" as HopId, label: "No receiver" } as Hop["gaps"][number]] });
    const call = mk({ dir: HopDir.Out, children: [inner] });
    const root = mk({ dir: HopDir.In, children: [call] });
    const rows = visibleRows(buildPathNodes([root]), none, 100000);
    expect(rows.filter((r) => r.tail).length).toBe(1);
    expect(rows.find((r) => r.node.hop === inner && !r.tail)!.expanded).toBe(true); // a fault opens it
  });

  test("a row with nothing inside has no fold", () => {
    const root = mk({ dir: HopDir.In, children: [db("a")] });
    const rows = visibleRows(buildPathNodes([root]), none, 1000);
    expect(rows[1].expandable).toBe(false);
    expect(expandableKeys(buildPathNodes([root]))).toEqual([root.hopId]);
  });
});
