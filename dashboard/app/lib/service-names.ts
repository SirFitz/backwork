// One service, one name (BAC-51 follow-up). Since hop records are named by their own `service`
// field, a service's hop records carry `service=<its name>` while its ordinary lines carry the
// collector's container name (`service=<source>`); every line carries `source=<container>`.
// Hop records hold both names, so they teach a map from source to service. With it, a filter
// for a service selects every line of its sources, and a list or a row shows one name.
// Pure: the map is learned in service-names.server.ts.

/** One learned pair: lines from `source` belong to the service its hop records name. */
export interface SourcePair {
  source: string;
  service: string;
}

export interface ServiceNames {
  /** source -> service, only where every hop record of that source names the same service. */
  bySource: ReadonlyMap<string, string>;
  /** service -> its sources, sorted. */
  sourcesOf: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_NAMES: ServiceNames = { bySource: new Map(), sourcesOf: new Map() };

/** Build the map; a source whose hop records name more than one service is left out (ambiguous). */
export function buildServiceNames(pairs: readonly SourcePair[]): ServiceNames {
  const seen = new Map<string, Set<string>>();
  for (const { source, service } of pairs) {
    if (!source || !service) continue;
    const set = seen.get(source) ?? new Set<string>();
    set.add(service);
    seen.set(source, set);
  }
  const bySource = new Map<string, string>();
  const sources = new Map<string, string[]>();
  for (const [source, names] of seen) {
    if (names.size !== 1) continue;
    const service = [...names][0];
    bySource.set(source, service);
    sources.set(service, [...(sources.get(service) ?? []), source]);
  }
  const sourcesOf = new Map<string, readonly string[]>();
  for (const [service, list] of sources) sourcesOf.set(service, [...list].sort());
  return { bySource, sourcesOf };
}

/** The name a person sees for a line: its service's own name when its source is known. */
export function displayService(labels: Readonly<Record<string, string>>, names: ServiceNames): string {
  const source = labels.source;
  if (source) {
    const service = names.bySource.get(source);
    if (service) return service;
  }
  return labels.service || source || "unknown";
}

/** One entry per service: a label value that is a known source is replaced by its service. */
export function serviceList(labelValues: readonly string[], names: ServiceNames): string[] {
  const out = new Set<string>();
  for (const v of labelValues) out.add(names.bySource.get(v) ?? v);
  for (const service of names.sourcesOf.keys()) out.add(service);
  return [...out].sort();
}

/** A regex alternation that matches exactly these values (LogQL regexes are fully anchored). */
function alternation(values: readonly string[]): string {
  return values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

/**
 * The stream matcher for "lines of service N": its sources when the map knows any (hop records
 * and ordinary lines together), else `service="N"` as before.
 */
export function serviceMatcher(service: string, names: ServiceNames): string {
  const sources = names.sourcesOf.get(service);
  if (sources && sources.length) return `source=~${JSON.stringify(alternation(sources))}`;
  return `service=${JSON.stringify(service)}`;
}
