import { describe, expect, test } from "bun:test";
import { Via } from "~/lib/hops/types";
import {
  EDGE_MAX_WIDTH_PX,
  EDGE_MIN_WIDTH_PX,
  EdgeTone,
  NodeKind,
  boxesOverlap,
  buildMap,
  edgeTone,
  edgeWidthPx,
  listRows,
  neighbourEdges,
  type MapConnectionInput,
  type MapFigures,
  type MapInput,
  type ServiceMap,
} from "~/lib/hops/service-map";

const f = (rate: number, errorShare = 0, p95: number | null = 0.05): MapFigures => ({ rate, errorShare, p50: p95, p95, p99: p95 });
const conn = (service: string, peer: string, via: Via | null = Via.Http, figures: MapFigures = f(1)): MapConnectionInput => ({ service, peer, via, figures });

function input(connections: MapConnectionInput[], peers: Record<string, string> = {}, extra: Partial<MapInput> = {}): MapInput {
  const names = new Set<string>();
  for (const c of connections) names.add(c.service);
  for (const s of Object.values(peers)) names.add(s);
  return {
    services: [...names].map((service) => ({ service, figures: f(2) })),
    knownServices: [...names],
    connections,
    peerServices: new Map(Object.entries(peers)),
    ...extra,
  };
}

const node = (m: ServiceMap, id: string) => {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};

function noOverlaps(m: ServiceMap): void {
  const drawn = m.nodes.filter((n) => !n.hidden);
  for (let i = 0; i < drawn.length; i++) for (let j = i + 1; j < drawn.length; j++) expect(boxesOverlap(drawn[i], drawn[j])).toBe(false);
}

describe("layout", () => {
  test("a chain of three services gives three layers", () => {
    const m = buildMap(input([conn("a", "b.host"), conn("b", "c.host")], { "b.host": "b", "c.host": "c" }));
    expect([node(m, "svc:a").layer, node(m, "svc:b").layer, node(m, "svc:c").layer]).toEqual([0, 1, 2]);
    expect(m.edges.every((e) => e.drawn)).toBe(true);
    noOverlaps(m);
  });

  test("a diamond puts the two middle services in one layer and the sink after them", () => {
    const m = buildMap(input([conn("a", "b"), conn("a", "c"), conn("b", "d"), conn("c", "d")], { b: "b", c: "c", d: "d" }));
    expect(node(m, "svc:b").layer).toBe(1);
    expect(node(m, "svc:c").layer).toBe(1);
    expect(node(m, "svc:d").layer).toBe(2);
    expect(node(m, "svc:b").order).not.toBe(node(m, "svc:c").order);
    noOverlaps(m);
  });

  test("a cycle does not hang and keeps the back edge in the list only", () => {
    const m = buildMap(input([conn("a", "b"), conn("b", "c"), conn("c", "a")], { a: "a", b: "b", c: "c" }));
    const back = m.edges.filter((e) => !e.drawn);
    expect(back.length).toBe(1);
    expect(listRows(m).length).toBe(3);
    for (const e of m.edges.filter((x) => x.drawn)) expect(node(m, e.to).layer).toBeGreaterThan(node(m, e.from).layer);
  });

  test("two entry services both start in layer 0", () => {
    const m = buildMap(input([conn("web", "api"), conn("cron", "api")], { api: "api" }));
    expect(node(m, "svc:web").layer).toBe(0);
    expect(node(m, "svc:cron").layer).toBe(0);
    expect(node(m, "svc:api").layer).toBe(1);
    noOverlaps(m);
  });

  test("past the node cap the quietest nodes are hidden and counted", () => {
    const conns = Array.from({ length: 45 }, (_, i) => conn("hub", `ext-${String(i).padStart(2, "0")}.example`, Via.Http, f(i + 1)));
    const m = buildMap(input(conns));
    expect(m.nodes.filter((n) => !n.hidden).length).toBe(40);
    expect(m.hiddenNodes).toBe(6);
    expect(node(m, "ext:ext-00.example").hidden).toBe(true);
    expect(m.edges.filter((e) => !e.drawn).length).toBe(6);
    expect(listRows(m).length).toBe(45);
    noOverlaps(m);
  });

  test("the same input in any order gives the same map", () => {
    const conns = [conn("a", "b"), conn("a", "db1", Via.Db), conn("b", "cache1", Via.Cache), conn("c", "b"), conn("b", "ext.example"), conn("c", "db1", Via.Db)];
    const peers = { b: "b" };
    const first = buildMap(input(conns, peers));
    const shuffled = buildMap({ ...input([...conns].reverse(), peers), services: input(conns, peers).services.slice().reverse() });
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(first));
  });

  test("stores sit together in the last layer", () => {
    const m = buildMap(input([conn("a", "b"), conn("a", "a-db", Via.Db), conn("b", "redis", Via.Cache)], { b: "b" }));
    expect(node(m, "store:a-db").layer).toBe(2);
    expect(node(m, "store:redis").layer).toBe(2);
    noOverlaps(m);
  });
});

describe("edge resolution", () => {
  test("a known peer resolves to its service and parallel edges merge", () => {
    const m = buildMap(input([conn("shop", "pay.internal", Via.Http, f(3, 0, 0.1)), conn("shop", "pay-lb.internal", Via.Http, f(1, 0.04, 0.3))], { "pay.internal": "pay", "pay-lb.internal": "pay" }));
    expect(m.edges.length).toBe(1);
    const e = m.edges[0];
    expect(e.from).toBe("svc:shop");
    expect(e.to).toBe("svc:pay");
    expect(e.figures.rate).toBe(4);
    expect(e.figures.p95).toBeCloseTo((3 * 0.1 + 1 * 0.3) / 4, 9);
    expect(e.figures.errorShare).toBeCloseTo(0.01, 9);
    expect(e.peers.sort()).toEqual(["pay-lb.internal", "pay.internal"]);
    expect(m.unresolvedPeers).toBe(0);
  });

  test("a peer named like a known service resolves without a learned pair", () => {
    const m = buildMap({ ...input([conn("shop", "pay")]), knownServices: ["shop", "pay"] });
    expect(m.edges[0].to).toBe("svc:pay");
  });

  test("db and cache peers become store nodes shared by their callers", () => {
    const m = buildMap(input([conn("a", "redis.internal", Via.Cache, f(2)), conn("b", "redis.internal", Via.Cache, f(1)), conn("a", "a-db", Via.Db)]));
    const redis = node(m, "store:redis.internal");
    expect(redis.kind).toBe(NodeKind.Store);
    expect(redis.via).toBe(Via.Cache);
    expect(redis.figures?.rate).toBe(3);
    expect(node(m, "store:a-db").label).toBe("a-db");
  });

  test("unknown peers become external nodes and are counted", () => {
    const m = buildMap(input([conn("pay", "acquirer.example"), conn("api", "notifications", Via.Job)]));
    expect(node(m, "ext:acquirer.example").kind).toBe(NodeKind.External);
    expect(m.unresolvedPeers).toBe(2);
  });

  test("a self edge is dropped", () => {
    const m = buildMap(input([conn("api", "api.internal")], { "api.internal": "api" }));
    expect(m.edges.length).toBe(0);
  });

  test("tone follows error share at 1 and 5 percent, never latency", () => {
    expect(edgeTone(0.0099)).toBe(EdgeTone.Neutral);
    expect(edgeTone(0.01)).toBe(EdgeTone.Warn);
    expect(edgeTone(0.0499)).toBe(EdgeTone.Warn);
    expect(edgeTone(0.05)).toBe(EdgeTone.Err);
    const slow = buildMap(input([conn("a", "b", Via.Http, f(1, 0, 30))], { b: "b" }));
    expect(slow.edges[0].tone).toBe(EdgeTone.Neutral);
  });

  test("width scales with the log of the rate inside its range", () => {
    expect(edgeWidthPx(1, 1, 100)).toBe(EDGE_MIN_WIDTH_PX);
    expect(edgeWidthPx(100, 1, 100)).toBe(EDGE_MAX_WIDTH_PX);
    const mid = edgeWidthPx(10, 1, 100);
    expect(mid).toBeGreaterThan(EDGE_MIN_WIDTH_PX);
    expect(mid).toBeLessThan(EDGE_MAX_WIDTH_PX);
  });

  test("callers and callees of a node", () => {
    const m = buildMap(input([conn("a", "b"), conn("b", "db", Via.Db), conn("c", "b", Via.Http, f(5))], { b: "b" }));
    const { callers, callees } = neighbourEdges(m, "svc:b");
    expect(callers.map((e) => e.from)).toEqual(["svc:c", "svc:a"]);
    expect(callees.map((e) => e.to)).toEqual(["store:db"]);
  });

  test("an empty input gives an empty drawing", () => {
    const m = buildMap({ services: [], knownServices: [], connections: [], peerServices: new Map() });
    expect(m).toMatchObject({ nodes: [], edges: [], width: 0, height: 0 });
  });
});
