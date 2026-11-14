// Service map data (BAC-76): VictoriaMetrics figures for services and their outbound calls, the
// learned peer-to-service pairs, and the pure graph from `service-map.ts`. Cached
// stale-while-revalidate so the page never waits on a refresh when it has a value.
import { cachedStale } from "~/lib/cache.server";
import * as loki from "~/lib/loki.server";
import type { Tenant } from "~/lib/tenant.server";
import { PerfRange } from "~/lib/hops/figures";
import { connectionsTable, inboundServices, servicesTable, vmClient, type PromClient } from "~/lib/hops/metrics.server";
import { learnPeers, peerServicesFor, peerStore, type LearnQueryFn, type PeerStore } from "~/lib/hops/peers.server";
import { buildMap, type ServiceMap } from "~/lib/hops/service-map";

/** Ranges the map offers (figures over 14 days of metrics at most; longer ranges are not offered). */
export const MAP_RANGES: readonly PerfRange[] = [PerfRange.H1, PerfRange.H6, PerfRange.H24];
export const DEFAULT_MAP_RANGE: PerfRange = PerfRange.H1;
/** A computed map is served as is for this long, in milliseconds. */
export const MAP_FRESH_MS = 30_000;
/** Past this age a map is no longer served while the next one is computed, in milliseconds. */
export const MAP_MAX_STALE_MS = 5 * 60_000;

export interface ServiceMapResult extends ServiceMap {
  /** When the figures were read (epoch ms), for the stale note. */
  computedAt: number;
  /** The peer scan or the peer store could not be read: unresolved peers may be services. */
  peersUnavailable: boolean;
}

export function parseMapRange(value: string | null | undefined): PerfRange {
  return MAP_RANGES.find((r) => r === value) ?? DEFAULT_MAP_RANGE;
}

/** Compute the map once (no cache). Peer learning or reading failing never fails the map. */
export async function computeServiceMap(
  range: PerfRange,
  tenant: Tenant,
  client: PromClient = vmClient,
  peers: PeerStore = peerStore,
  now: () => number = Date.now,
  read: LearnQueryFn = loki.queryRange,
): Promise<ServiceMapResult> {
  let peersUnavailable = false;
  await learnPeers(tenant, read, peers, now).catch(() => {
    peersUnavailable = true;
  });
  const [known, services, peerMap] = await Promise.all([
    inboundServices(tenant, client),
    servicesTable(range, tenant, client, now()),
    peerServicesFor(tenant.orgId, peers).catch(() => {
      peersUnavailable = true;
      return new Map<string, string>();
    }),
  ]);
  const connections = await connectionsTable(range, tenant, new Set(known), null, client);
  const map = buildMap({
    services: services.map((s) => ({ service: s.service, figures: { rate: s.rate, errorShare: s.errorShare, p50: s.p50, p95: s.p95, p99: s.p99 } })),
    knownServices: known,
    connections: connections.map((c) => ({ service: c.service, peer: c.peer, via: c.via, figures: { rate: c.rate, errorShare: c.errorShare, p50: c.p50, p95: c.p95, p99: c.p99 } })),
    peerServices: peerMap,
  });
  return { ...map, computedAt: now(), peersUnavailable };
}

/** The service map for a range, cached per organisation and range (fresh 30 s, served stale up to
 *  5 minutes while one refresh runs). */
export function serviceMap(
  range: PerfRange,
  tenant: Tenant,
  client: PromClient = vmClient,
  peers: PeerStore = peerStore,
  now: () => number = Date.now,
  read: LearnQueryFn = loki.queryRange,
): Promise<ServiceMapResult> {
  const key = `map:${tenant.platform ? "platform" : tenant.orgId}:${range}`;
  return cachedStale(key, MAP_FRESH_MS, MAP_MAX_STALE_MS, () => computeServiceMap(range, tenant, client, peers, now, read), now);
}
