// Service map (BAC-76), pure. Turns the outbound connection figures (caller service, peer, via) and
// the learned peer-to-service pairs into a graph of services, data stores and external peers, and
// lays it out left to right in layers. No Loki, Remix or database imports: the route renders it
// and tests run it with plain objects.
import { Via } from "~/lib/hops/types";

/** What a node on the map stands for. */
export const NodeKind = {
  /** A service that reports hop records. */
  Service: "service",
  /** A database or cache, keyed by the peer host the callers name. */
  Store: "store",
  /** A host or queue not matched to any service (a third party, or a service without Correlator). */
  External: "external",
} as const;
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];

/** How an edge's line is toned: by error share only, never by latency. */
export const EdgeTone = {
  Neutral: "neutral",
  Warn: "warn",
  Err: "err",
} as const;
export type EdgeTone = (typeof EdgeTone)[keyof typeof EdgeTone];

/** Error share from which an edge is amber (the services table's `errorTone` uses the same). */
export const EDGE_WARN_SHARE = 0.01;
/** Error share from which an edge is red. */
export const EDGE_ERR_SHARE = 0.05;
/** At most this many nodes are drawn; the list view always has everything. */
export const MAX_DRAWN_NODES = 40;
/** Horizontal distance between layers, in SVG pixels. */
export const LAYER_GAP_PX = 280;
/** Vertical distance between rows inside a layer, in SVG pixels. */
export const ROW_GAP_PX = 96;
/** Node box size, in SVG pixels. */
export const NODE_WIDTH_PX = 200;
export const NODE_HEIGHT_PX = 56;
/** Empty space around the drawing, in SVG pixels. */
export const MAP_PADDING_PX = 16;
/** Edge line width range, in SVG pixels (scaled by the log of the call rate). */
export const EDGE_MIN_WIDTH_PX = 1.5;
export const EDGE_MAX_WIDTH_PX = 5;
/** Ordering sweeps (down then up) used to reduce crossings. */
export const ORDER_SWEEPS = 2;

/** Rate, error share and latency of a node or an edge (seconds, per second, 0..1). */
export interface MapFigures {
  rate: number;
  errorShare: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface MapNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Inbound figures for a service, the summed incoming calls for a store or external peer;
   *  null for a service with no inbound figures in the range (a worker that only calls out). */
  figures: MapFigures | null;
  /** For a store: the via its callers use (db or cache). */
  via: Via | null;
  /** Peer hosts or queue names that resolve to this node. */
  peers: string[];
  /** Not drawn (past the node cap); still in the list. */
  hidden: boolean;
  layer: number;
  order: number;
  /** Top-left corner of the node box, in SVG pixels. */
  x: number;
  y: number;
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  /** The via of the merged calls, null when they mix. */
  via: Via | null;
  /** Peer hosts or queue names the caller addressed (several when parallel edges merged). */
  peers: string[];
  figures: MapFigures;
  tone: EdgeTone;
  /** Drawn on the graph; false for edges that close a cycle or touch a hidden node (list only). */
  drawn: boolean;
}

export interface ServiceMap {
  nodes: MapNode[];
  edges: MapEdge[];
  /** Size of the drawing (drawn nodes only), in SVG pixels. */
  width: number;
  height: number;
  /** Distinct peers that could not be matched to a service (External nodes). */
  unresolvedPeers: number;
  /** Nodes past the cap, listed but not drawn. */
  hiddenNodes: number;
}

export interface MapServiceInput {
  service: string;
  figures: MapFigures | null;
}

export interface MapConnectionInput {
  service: string;
  peer: string;
  via: Via | null;
  figures: MapFigures;
}

export interface MapInput {
  /** Services with inbound figures in the range. */
  services: readonly MapServiceInput[];
  /** Every service known to report hops (a peer named like one resolves to it). */
  knownServices: readonly string[];
  connections: readonly MapConnectionInput[];
  /** Peer host or queue name to the service that answered it. */
  peerServices: ReadonlyMap<string, string>;
  maxNodes?: number;
}

const serviceId = (s: string): string => `svc:${s}`;
const storeId = (peer: string): string => `store:${peer}`;
const externalId = (peer: string): string => `ext:${peer}`;

function isStore(via: Via | null): boolean {
  return via === Via.Db || via === Via.Cache;
}

/** Edge tone from its error share. */
export function edgeTone(errorShare: number): EdgeTone {
  if (errorShare >= EDGE_ERR_SHARE) return EdgeTone.Err;
  if (errorShare >= EDGE_WARN_SHARE) return EdgeTone.Warn;
  return EdgeTone.Neutral;
}

/** Line width for an edge of `rate` calls per second among edges from `minRate` to `maxRate`. */
export function edgeWidthPx(rate: number, minRate: number, maxRate: number): number {
  const lo = Math.log1p(Math.max(0, minRate));
  const hi = Math.log1p(Math.max(0, maxRate));
  if (hi - lo <= 1e-9) return (EDGE_MIN_WIDTH_PX + EDGE_MAX_WIDTH_PX) / 2;
  const t = (Math.log1p(Math.max(0, rate)) - lo) / (hi - lo);
  return EDGE_MIN_WIDTH_PX + Math.min(1, Math.max(0, t)) * (EDGE_MAX_WIDTH_PX - EDGE_MIN_WIDTH_PX);
}

function weighted(a: number | null, ar: number, b: number | null, br: number): number | null {
  if (a === null) return b;
  if (b === null) return a;
  const w = ar + br;
  return w > 0 ? (a * ar + b * br) / w : Math.max(a, b);
}

/** Merge the figures of parallel calls: rates and failures sum, latency is weighted by calls. */
export function mergeFigures(a: MapFigures, b: MapFigures): MapFigures {
  const rate = a.rate + b.rate;
  const failed = a.errorShare * a.rate + b.errorShare * b.rate;
  return {
    rate,
    errorShare: rate > 0 ? Math.min(1, failed / rate) : 0,
    p50: weighted(a.p50, a.rate, b.p50, b.rate),
    p95: weighted(a.p95, a.rate, b.p95, b.rate),
    p99: weighted(a.p99, a.rate, b.p99, b.rate),
  };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Resolve connections to edges, create store and external nodes, cap and lay out the graph. */
export function buildMap(input: MapInput): ServiceMap {
  const known = new Set(input.knownServices);
  const nodes = new Map<string, MapNode>();
  const node = (id: string, kind: NodeKind, label: string, via: Via | null): MapNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, kind, label, figures: null, via, peers: [], hidden: false, layer: 0, order: 0, x: 0, y: 0 };
      nodes.set(id, n);
    }
    return n;
  };
  for (const s of [...input.services].sort((a, b) => byText(a.service, b.service))) {
    node(serviceId(s.service), NodeKind.Service, s.service, null).figures = s.figures;
  }

  const edges = new Map<string, MapEdge>();
  const connections = [...input.connections].sort((a, b) => byText(a.service, b.service) || byText(a.peer, b.peer) || byText(a.via ?? "", b.via ?? ""));
  for (const c of connections) {
    if (!c.service || !c.peer || c.figures.rate <= 0) continue;
    const from = node(serviceId(c.service), NodeKind.Service, c.service, null);
    let to: MapNode;
    if (isStore(c.via)) {
      to = node(storeId(c.peer), NodeKind.Store, c.peer, c.via);
      to.figures = to.figures ? mergeFigures(to.figures, c.figures) : { ...c.figures };
    } else {
      const resolved = input.peerServices.get(c.peer) ?? (known.has(c.peer) ? c.peer : null);
      if (resolved) {
        to = node(serviceId(resolved), NodeKind.Service, resolved, null);
      } else {
        to = node(externalId(c.peer), NodeKind.External, c.peer, null);
        to.figures = to.figures ? mergeFigures(to.figures, c.figures) : { ...c.figures };
      }
    }
    if (!to.peers.includes(c.peer)) to.peers.push(c.peer);
    if (to.id === from.id) continue; // a service calling itself through its own host
    const id = `${from.id}->${to.id}`;
    const prev = edges.get(id);
    if (prev) {
      prev.figures = mergeFigures(prev.figures, c.figures);
      if (prev.via !== c.via) prev.via = null;
      if (!prev.peers.includes(c.peer)) prev.peers.push(c.peer);
      prev.tone = edgeTone(prev.figures.errorShare);
    } else {
      edges.set(id, { id, from: from.id, to: to.id, via: c.via, peers: [c.peer], figures: { ...c.figures }, tone: edgeTone(c.figures.errorShare), drawn: true });
    }
  }

  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()].sort((a, b) => byText(a.id, b.id));
  const hiddenNodes = capNodes(nodeList, edgeList, input.maxNodes ?? MAX_DRAWN_NODES);
  const { width, height } = layout(nodeList, edgeList);
  return {
    nodes: nodeList.sort((a, b) => a.layer - b.layer || a.order - b.order || byText(a.id, b.id)),
    edges: edgeList,
    width,
    height,
    unresolvedPeers: nodeList.filter((n) => n.kind === NodeKind.External).length,
    hiddenNodes,
  };
}

/** Hide all but the `max` busiest nodes (own rate plus the rate of the edges touching them).
 *  Returns how many were hidden. */
function capNodes(nodes: MapNode[], edges: MapEdge[], max: number): number {
  if (nodes.length <= max) return 0;
  const traffic = new Map<string, number>(nodes.map((n) => [n.id, n.figures?.rate ?? 0]));
  for (const e of edges) {
    traffic.set(e.from, (traffic.get(e.from) ?? 0) + e.figures.rate);
    traffic.set(e.to, (traffic.get(e.to) ?? 0) + e.figures.rate);
  }
  const ranked = [...nodes].sort((a, b) => (traffic.get(b.id) ?? 0) - (traffic.get(a.id) ?? 0) || byText(a.id, b.id));
  for (const n of ranked.slice(max)) n.hidden = true;
  return ranked.length - max;
}

/**
 * Lay out the drawn nodes in layers, left to right, and mark which edges are drawn. Mutates the
 * nodes (layer, order, x, y) and edges (drawn). Cycles are broken by leaving out the back edges a
 * depth first search finds (they stay in the list); layer is the longest path from an entry
 * service; stores take the last layer; order inside a layer follows the median position of
 * neighbours over `ORDER_SWEEPS` sweeps. Deterministic for the same nodes and edges in any order.
 */
export function layout(nodes: MapNode[], edges: MapEdge[]): { width: number; height: number } {
  const drawn = nodes.filter((n) => !n.hidden).sort((a, b) => byText(a.id, b.id));
  const ids = new Set(drawn.map((n) => n.id));
  for (const e of edges) e.drawn = ids.has(e.from) && ids.has(e.to);
  const candidates = edges.filter((e) => e.drawn).sort((a, b) => byText(a.id, b.id));

  const out = new Map<string, MapEdge[]>(drawn.map((n) => [n.id, []]));
  const indeg = new Map<string, number>(drawn.map((n) => [n.id, 0]));
  for (const e of candidates) {
    out.get(e.from)?.push(e);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  // Break cycles: depth first from entries first (no incoming edges), then from anything left.
  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 on the stack, 2 done
  const visit = (start: string): void => {
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = out.get(top.id) ?? [];
      if (top.next >= list.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const e = list[top.next++];
      const s = state.get(e.to) ?? 0;
      if (s === 1) e.drawn = false;
      else if (s === 0) {
        state.set(e.to, 1);
        stack.push({ id: e.to, next: 0 });
      }
    }
  };
  for (const n of drawn) if ((indeg.get(n.id) ?? 0) === 0 && !state.get(n.id)) visit(n.id);
  for (const n of drawn) if (!state.get(n.id)) visit(n.id);

  // Longest path layering over the acyclic drawn edges (Kahn order).
  const dag = candidates.filter((e) => e.drawn);
  const preds = new Map<string, string[]>(drawn.map((n) => [n.id, []]));
  const succs = new Map<string, string[]>(drawn.map((n) => [n.id, []]));
  const remaining = new Map<string, number>(drawn.map((n) => [n.id, 0]));
  for (const e of dag) {
    preds.get(e.to)?.push(e.from);
    succs.get(e.from)?.push(e.to);
    remaining.set(e.to, (remaining.get(e.to) ?? 0) + 1);
  }
  const layerOf = new Map<string, number>(drawn.map((n) => [n.id, 0]));
  const queue = drawn.filter((n) => (remaining.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const to of succs.get(id) ?? []) {
      layerOf.set(to, Math.max(layerOf.get(to) ?? 0, (layerOf.get(id) ?? 0) + 1));
      const left = (remaining.get(to) ?? 0) - 1;
      remaining.set(to, left);
      if (left === 0) queue.push(to);
    }
  }
  // Stores sit together in the last layer, after every service and external peer.
  const kindOf = new Map(drawn.map((n) => [n.id, n.kind]));
  const stores = drawn.filter((n) => n.kind === NodeKind.Store);
  if (stores.length) {
    const others = drawn.filter((n) => n.kind !== NodeKind.Store && ((preds.get(n.id)?.length ?? 0) > 0 || (succs.get(n.id)?.length ?? 0) > 0));
    const last = others.length ? Math.max(...others.map((n) => layerOf.get(n.id) ?? 0)) + 1 : 1;
    for (const s of stores) layerOf.set(s.id, Math.max(last, layerOf.get(s.id) ?? 0));
  }

  // Order inside layers: start by kind then id, then median of neighbours, down then up.
  const layers: string[][] = [];
  for (const n of drawn) {
    const l = layerOf.get(n.id) ?? 0;
    (layers[l] ??= []).push(n.id);
  }
  for (let l = 0; l < layers.length; l++) layers[l] ??= [];
  const kindRank = (id: string): number => (kindOf.get(id) === NodeKind.Service ? 0 : kindOf.get(id) === NodeKind.External ? 1 : 2);
  for (const layer of layers) layer.sort((a, b) => kindRank(a) - kindRank(b) || byText(a, b));
  const pos = new Map<string, number>();
  const index = (): void => layers.forEach((layer) => layer.forEach((id, i) => pos.set(id, i)));
  index();
  const median = (ids: readonly string[]): number | null => {
    if (!ids.length) return null;
    const v = ids.map((id) => pos.get(id) ?? 0).sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const reorder = (layer: string[], neighbours: Map<string, string[]>): void => {
    const key = new Map(layer.map((id, i) => [id, median(neighbours.get(id) ?? []) ?? i]));
    layer.sort((a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0) || kindRank(a) - kindRank(b) || byText(a, b));
  };
  for (let s = 0; s < ORDER_SWEEPS; s++) {
    for (let l = 1; l < layers.length; l++) {
      reorder(layers[l], preds);
      index();
    }
    for (let l = layers.length - 2; l >= 0; l--) {
      reorder(layers[l], succs);
      index();
    }
  }

  const byId = new Map(drawn.map((n) => [n.id, n]));
  let rows = 0;
  layers.forEach((layer, l) => {
    rows = Math.max(rows, layer.length);
    layer.forEach((id, i) => {
      const n = byId.get(id);
      if (!n) return;
      n.layer = l;
      n.order = i;
      n.x = MAP_PADDING_PX + l * LAYER_GAP_PX;
      n.y = MAP_PADDING_PX + i * ROW_GAP_PX;
    });
  });
  const usedLayers = layers.filter((l) => l.length).length ? layers.length : 0;
  if (!usedLayers) return { width: 0, height: 0 };
  return {
    width: 2 * MAP_PADDING_PX + (usedLayers - 1) * LAYER_GAP_PX + NODE_WIDTH_PX,
    height: 2 * MAP_PADDING_PX + (rows - 1) * ROW_GAP_PX + NODE_HEIGHT_PX,
  };
}

/** Edges into a node (its callers) and out of it (what it calls), busiest first. */
export function neighbourEdges(map: ServiceMap, nodeId: string): { callers: MapEdge[]; callees: MapEdge[] } {
  const busiest = (a: MapEdge, b: MapEdge): number => b.figures.rate - a.figures.rate || byText(a.id, b.id);
  return {
    callers: map.edges.filter((e) => e.to === nodeId).sort(busiest),
    callees: map.edges.filter((e) => e.from === nodeId).sort(busiest),
  };
}

/** Edges for the list view: grouped by caller (in label order), busiest first inside a group. */
export function listRows(map: ServiceMap): MapEdge[] {
  const label = new Map(map.nodes.map((n) => [n.id, n.label]));
  return [...map.edges].sort((a, b) => byText(label.get(a.from) ?? a.from, label.get(b.from) ?? b.from) || b.figures.rate - a.figures.rate || byText(a.id, b.id));
}

/** True when two node boxes overlap (used by tests and as a guard in the graph). */
export function boxesOverlap(a: Pick<MapNode, "x" | "y">, b: Pick<MapNode, "x" | "y">): boolean {
  return a.x < b.x + NODE_WIDTH_PX && b.x < a.x + NODE_WIDTH_PX && a.y < b.y + NODE_HEIGHT_PX && b.y < a.y + NODE_HEIGHT_PX;
}
