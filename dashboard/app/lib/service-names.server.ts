// Learns the source -> service map from hop records in Loki (each carries both labels), per
// organisation through the tenant scope; cached like the peer table.
import * as loki from "~/lib/loki.server";
import { cached } from "~/lib/cache.server";
import type { Tenant } from "~/lib/tenant.server";
import { EMPTY_NAMES, buildServiceNames, type ServiceNames, type SourcePair } from "~/lib/service-names";

/** Hop records of the last day, one series per (service, source). */
export const PAIRS_QUERY = 'sum by (service, source) (count_over_time({kind="hop", source=~".+"}[24h]))';
const TTL_MS = 120_000;

export type PairReader = (query: string, tenant: Tenant) => Promise<Array<Record<string, string>>>;

/** The map for this tenant; empty (old behaviour) when Loki cannot answer. */
export function serviceNames(tenant: Tenant, read: PairReader = loki.labelSets): Promise<ServiceNames> {
  const key = `service-names:${tenant.platform ? "platform" : tenant.orgId}`;
  return cached(key, TTL_MS, async () => {
    const rows = await read(PAIRS_QUERY, tenant);
    const pairs: SourcePair[] = rows
      .filter((r) => typeof r.source === "string" && typeof r.service === "string")
      .map((r) => ({ source: r.source, service: r.service }));
    return buildServiceNames(pairs);
  }).catch(() => EMPTY_NAMES);
}

/** The map, but never slower than `ms`: an ingest or a poll does not wait on Loki for long. */
export function serviceNamesWithin(tenant: Tenant, ms: number, read: PairReader = loki.labelSets): Promise<ServiceNames> {
  return Promise.race([serviceNames(tenant, read), new Promise<ServiceNames>((r) => setTimeout(() => r(EMPTY_NAMES), ms))]);
}
