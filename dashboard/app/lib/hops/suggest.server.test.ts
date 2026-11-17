// BAC-93: the switch per scope, the schema from a board, and the board's hints (pure parts of the
// server module; the loaders around them are exercised on the local stack).
import { describe, expect, test } from "bun:test";
import { COLLECTOR_FEATURES, FEATURES, Feature, resolveAll, snapshotVersion, type ControlRow } from "~/lib/controls.server";
import type { QueryRow } from "./slow-queries";
import { SlowWindow } from "./slow-queries";
import type { SlowQueries } from "./slow-queries.server";
import { hintsForBoard, rowKeyOf, schemaFromBoard, suggestionsOn } from "./suggest.server";
import { cleanNames, parseSuggestResponse, wantedFrom, wantedHref } from "./suggest-wire";
import { statementShape, shapeId } from "./stmt-shape";

const row = (p: Partial<ControlRow> & Pick<ControlRow, "enabled">): ControlRow => ({
  orgId: "o1", projectId: null, service: null, feature: Feature.Suggestions, updatedBy: null, updatedAt: new Date(0), ...p,
});

describe("the suggestions switch", () => {
  test("on unless a row switches it off, at the organisation, project or service level", () => {
    expect(suggestionsOn([], [], "api")).toBe(true);
    expect(suggestionsOn([row({ enabled: false })], ["p1"], "api")).toBe(false);
    const project = [row({ enabled: false, projectId: "p1" })];
    expect(suggestionsOn(project, ["p1"], "api")).toBe(false);
    expect(suggestionsOn(project, ["p2"], "api")).toBe(true);
    const service = [row({ enabled: false, projectId: "p1", service: "api" })];
    expect(suggestionsOn(service, ["p1"], "api")).toBe(false);
    expect(suggestionsOn(service, ["p1"], "web")).toBe(true);
    expect(suggestionsOn(service, ["p1"], null)).toBe(true);
  });
  test("a request that crossed projects needs it on in each", () => {
    expect(suggestionsOn([row({ enabled: false, projectId: "p2" })], ["p1", "p2"], "api")).toBe(false);
  });
  test("it is a dashboard switch: the agent and the ingest proxy never see it", () => {
    expect(FEATURES).toContain(Feature.Suggestions);
    expect(COLLECTOR_FEATURES).not.toContain(Feature.Suggestions);
    const all = resolveAll([row({ enabled: false })], "p1", "api");
    expect(Object.keys(all)).not.toContain("suggestions");
    // Switching it off changes nothing an agent is told: the snapshot's version is the same.
    const content = { project: resolveAll([], "p1", null), services: {}, patterns: [], serviceNames: {}, excludedPaths: [] };
    const off = { ...content, project: resolveAll([row({ enabled: false })], "p1", null) };
    expect(snapshotVersion(off)).toBe(snapshotVersion(content));
  });
});

const ORDERS = statementShape("select o.id, o.total from orders o where o.merchant_id = 4 and o.status = 'paid'");
const q = (shape: string, over: Partial<QueryRow> = {}): QueryRow => ({
  shapeId: shapeId(shape), shape, sample: shape, service: "shop-api", peer: null, table: "orders", calls: 900, totalS: 120, p95S: 0.3, p95Approx: false, shareOfDb: 0.6, ...over,
});
const peers = [0.01, 0.02, 0.015].map((p95S, i) => q(`select ${i} from t${i} where a = ?`, { p95S, shareOfDb: 0.1, calls: 50, table: `t${i}` }));
const board = (rows: QueryRow[]): SlowQueries => ({ rows, window: SlowWindow.H6, computedAt: 1000, statementsOff: false, groupLimited: false });

describe("schemaFromBoard and hintsForBoard", () => {
  test("the schema comes from the board's shapes, weighted by calls", () => {
    const r = schemaFromBoard(board([q(ORDERS), ...peers]));
    expect(r.schema.tables[0].name).toBe("orders");
    expect(r.schema.tables[0].columns.merchant_id.where).toBe(900);
    expect(schemaFromBoard(board([])).schema.tables).toEqual([]);
  });
  test("a hint for the slow row, by row key, and none for a service that is switched off", () => {
    const rows = [q(ORDERS), ...peers];
    const { schema } = schemaFromBoard(board(rows));
    const on = hintsForBoard(rows, schema, () => true);
    expect(Object.keys(on)).toEqual([rowKeyOf(rows[0])]);
    expect(on[rowKeyOf(rows[0])].sketch).toBe("create index on orders (merchant_id, status)");
    expect(hintsForBoard(rows, schema, () => false)).toEqual({});
  });
});

describe("the wire", () => {
  test("names are cleaned, deduplicated, sorted and capped", () => {
    expect(cleanNames("b,a,b,,c d")).toEqual(["a", "b"]);
    expect(cleanNames(null)).toEqual([]);
    expect(cleanNames(Array.from({ length: 100 }, (_, i) => `s${i}`).join(",")).length).toBe(40);
  });
  test("the query string round-trips", () => {
    const w = { projects: ["prod"], services: ["api", "web"], tables: ["orders"] };
    expect(wantedFrom(new URL(`http://x${wantedHref(w)}`))).toEqual(w);
  });
  test("a response is checked before it is read", () => {
    expect(parseSuggestResponse(null)).toBeNull();
    expect(parseSuggestResponse({ on: "x" })).toBeNull();
    const ok = parseSuggestResponse({ on: { api: true, junk: 3 }, context: { schema: { tables: [], relations: [] }, rows: [] }, contextError: null });
    expect(ok?.on).toEqual({ api: true });
    expect(ok?.context?.rows).toEqual([]);
    expect(parseSuggestResponse({ on: {}, context: { schema: 1, rows: [] } })?.context).toBeNull();
  });
});
