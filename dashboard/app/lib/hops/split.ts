// Split one trace into the separate requests that share its trace ID. Pure.
//
// A trace ID is not always one request: a page's GET and the POST its form sends can carry the
// same ID, minutes apart. Each inbound HTTP or RPC hop with no caller in the trace starts its own
// request. Everything else (jobs, calls, stray hops) belongs to the request it came from, or
// failing that the latest request that had begun by then.
import { HopKind, Via, type HopId, type HopRecord, type LinkedId, type TraceLogLine } from "./types";

/** The records, log lines and linked IDs of one request inside a trace. */
export interface RequestPart {
  /** Start of the request's first hop record, epoch ms. */
  startMs: number;
  records: HopRecord[];
  logs: TraceLogLine[];
  links: LinkedId[];
}

function isRequestStart(r: HopRecord): boolean {
  return (r.hop === HopKind.In || r.hop === HopKind.InEnd) && (r.via === Via.Http || r.via === Via.Rpc);
}

/** The hop at the top of `id`'s parent chain, within the trace (a cycle stops at the repeat). */
function rootOf(id: HopId, parents: ReadonlyMap<HopId, HopId | null>): HopId {
  const seen = new Set<HopId>();
  let cur = id;
  while (!seen.has(cur)) {
    seen.add(cur);
    const p = parents.get(cur);
    if (!p || !parents.has(p)) return cur;
    cur = p;
  }
  return cur;
}

/** Index of the last start at or before `timeMs`; the first when it precedes them all. */
function partAt(starts: readonly number[], timeMs: number): number {
  let idx = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= timeMs) idx = i;
  return idx;
}

/** One part per request, in start order; a trace with at most one request comes back whole. */
export function splitRequests(
  records: readonly HopRecord[],
  logs: readonly TraceLogLine[],
  links: readonly LinkedId[],
): RequestPart[] {
  const parents = new Map<HopId, HopId | null>();
  const hopStart = new Map<HopId, number>();
  const startRoots = new Set<HopId>();
  for (const r of records) {
    if (!parents.has(r.hopId) || r.hop === HopKind.In || r.hop === HopKind.Out) parents.set(r.hopId, r.parentHop);
    hopStart.set(r.hopId, Math.min(hopStart.get(r.hopId) ?? Infinity, r.timeMs));
  }
  for (const r of records) {
    if (isRequestStart(r) && rootOf(r.hopId, parents) === r.hopId) startRoots.add(r.hopId);
  }
  const whole = (): RequestPart[] => [{
    startMs: records.length ? Math.min(...records.map((r) => r.timeMs)) : 0,
    records: [...records], logs: [...logs], links: [...links],
  }];
  if (startRoots.size < 2) return whole();

  const anchors = [...startRoots].sort((a, b) => (hopStart.get(a) ?? 0) - (hopStart.get(b) ?? 0) || a.localeCompare(b));
  const starts = anchors.map((a) => hopStart.get(a) ?? 0);
  const indexOfRoot = new Map(anchors.map((a, i) => [a, i] as const));
  const parts: RequestPart[] = anchors.map((_, i) => ({ startMs: starts[i], records: [], logs: [], links: [] }));

  // A hop goes with its own root's request; a root that starts no request goes by start time.
  const partOfHop = (id: HopId): number => {
    const root = rootOf(id, parents);
    return indexOfRoot.get(root) ?? partAt(starts, hopStart.get(root) ?? 0);
  };
  for (const r of records) parts[partOfHop(r.hopId)].records.push(r);
  for (const l of links) parts[l.hopId && parents.has(l.hopId) ? partOfHop(l.hopId) : partAt(starts, l.timeMs)].links.push(l);
  for (const line of logs) parts[partAt(starts, line.timeMs)].logs.push(line);
  return parts;
}
