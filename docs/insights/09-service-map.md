# 09 Service map (BAC-76)

Wave 1. Depends on: foundation (nav tab shell). Feeds: none.

## Goal
**Insights > Service map**: who calls whom, with request rate, latency and error share on each link, so the slow or failing edge is visible at a glance, including calls to databases and caches.

## What exists (notes C section 3)
VictoriaMetrics already has the edges: `backwork_hop_duration_seconds{dir="out"}` carries `service`, `peer`, `via`; `connectionsTable(range, tenant, knownServices, selected)` returns rate, error share and p50/p95/p99 per `(service, peer, via)`. `peer` is a host or queue name, not a service. `peer_services` maps a peer to the service that answered it, but is only filled as a side effect of reads (the request view and the Overview attention scan), there is no bulk read, and it has no FK to organisations.

## Design

### Data
`lib/hops/service-map.server.ts`:
```ts
export function serviceMap(range: PerfRange, tenant: Tenant, client?, peers?: PeerStore, now?): Promise<ServiceMap>;
```
1. `inboundServices(tenant)` (nodes), `servicesTable(range, tenant)` for node figures (rate, errors, p95).
2. `connectionsTable(range, tenant, known, null)` for edges (all services; `selected` null).
3. Peer resolution: `peerServicesFor(orgId): Promise<Map<string, string>>` (new, in `peers.server.ts`: bulk read of `peer_services`, cached 30 s); `learnPeers(tenant)` (new): a Loki scan of recent `out` and `in` records using the existing `peerPairs` builder, writing new pairs through `peerStore.save`, run at most once per 5 minutes per org (`cachedStale`) so the map does not depend on someone having opened a request.
4. Cached with `cachedStale("map:<org>:<range>", 30 s, 5 min)`.

### Pure graph `lib/hops/service-map.ts`
```ts
export const NodeKind = { Service: "service", Store: "store", External: "external" } as const;
export interface MapNode { id: string; kind: NodeKind; label: string; figures: Figures | null; layer: number; order: number; x: number; y: number }
export interface MapEdge { id: string; from: string; to: string; via: Via | null; figures: Figures; tone: "neutral" | "warn" | "err" }
export interface ServiceMap { nodes: MapNode[]; edges: MapEdge[]; width: number; height: number; unresolvedPeers: number }
export function buildMap(input: MapInput): ServiceMap;      // resolves edges, creates store/external nodes, lays out
export function layout(nodes: MapNode[], edges: MapEdge[]): { width: number; height: number };
```
- **Edges**: a `(service, peer, via)` row becomes `service -> resolvedService` when `peerServices` knows the peer (merging parallel edges, summing rate, weighting latency by calls), a Store node keyed by peer host for `via` db or cache (label "db.internal", figures from the edge), otherwise an External node (dotted) labelled by the peer. Self-edges dropped.
- **Layout**: layered left to right. Break cycles by dropping the back edges found by a depth first search (kept in the list view); layer = longest path from an entry service (no inbound service edges); within a layer, order by the median position of neighbours, two sweeps; x = layer * 280, y = order * 96 (stores in the last layers, grouped); deterministic given sorted inputs; at most 40 nodes drawn (the rest summarised "and 7 more services in the list").
- **Tone** on edges: error share at least 1 percent `warn`, at least 5 percent `err` (the same thresholds as `errorTone` in `services-table.tsx`); latency never colours an edge.

## UI (`routes/insights.map.tsx`, flips the tab on)
- Title row "Service map" with the range segmented control (1 h, 6 h, 24 h) and a Graph / List toggle on the same row.
- **Graph** (desktop, `md` and up): one card, SVG sized to its container (`viewBox`), nodes are rounded rectangles with the name, req/s and p95; edges are straight or gently curved lines with arrowheads, width scaled by log of rate (1.5 to 5 px), error tone on the line, the p95 as a label on hover and on the line when the edge is selected. Click a node: a side panel (right 320 px column) lists its callers and callees with figures and links to Performance for that service; click an edge: shows its figures and a link to `/requests?service=`. Keyboard: nodes are buttons (Tab, Enter). No animation. Top layer not needed (no floating menus; the side panel is part of the layout).
- **List** (always on phone, and by toggle): a table From, To, Calls/s, Errors, p95, grouped by caller, store and external peers marked by a small text tag; this is also the accessible form of the graph.
- Empty: "No calls between services recorded in this range." Unresolved peers note: "3 hosts could not be matched to a service. Make sure they report to backwork." States: skeleton, error, stale note.
- Services in the DESIGN palette via `serviceColor` for node accent only.

## Files
New: `lib/hops/service-map.ts` (+ test), `lib/hops/service-map.server.ts` (+ test), `routes/insights.map.tsx`, `components/insights/map-graph.tsx`, `components/insights/map-list.tsx`. Changed: `lib/hops/peers.server.ts` (`peerServicesFor`, `learnPeers`, `PeerStore` gains a bulk read + test), `routes/insights.tsx` (flip tab).

## Tests
- Layout: chain of 3 gives 3 layers; diamond; a cycle does not hang and keeps the back edge in the list; two entries; 40-node cap with summary count; deterministic for shuffled input; no overlapping node boxes.
- Edge resolution: peer known resolves to the service and merges parallel edges (rate sums, latency weighted); db and cache peers become Store nodes; unknown peers External; self edge dropped; tone thresholds at 1 and 5 percent.
- `serviceMap` with a fake `PromClient` and fake `PeerStore`; `learnPeers` saves new pairs only and runs once per 5 minutes; DB test for `peerServicesFor`.
- Components: graph and list render the same edges; keyboard selection.

## Verification
Scenario stack (shop-api calling commerce services, a Postgres and a Redis peer): the graph shows the right layers, a degraded edge is amber when the scenario injects 2 percent errors, clicking a node shows its callers; List view equals the graph; phone shows the list; unknown peer shows as External; run `learnPeers` with an empty `peer_services` and see edges resolve without opening any request. 1440 and 390 screenshots, no sideways scroll on the page.

## Risks
Peers are hostnames; two services behind one host merge into one node (the peer map is keyed by peer, noted in the panel). A very chatty mesh may exceed 40 nodes; the list view always has everything. The graph is drawn from 14 days of VictoriaMetrics figures at most, ranges above 24 h are not offered.

## Out of scope
Editing the map, saving layouts, tracing a single request over the map, topology from queue message flows.
