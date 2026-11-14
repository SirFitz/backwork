// Request tree from hop records (design 7.3 and 7.4). Pure: no Loki or Remix,
// so the same function runs on the server and, as log lines arrive, in the browser.
import {
  GapKind,
  HopDir,
  HopKind,
  HopState,
  Outcome,
  StoreKind,
  Via,
  type Gap,
  type Hop,
  type HopId,
  type HopRecord,
  type LinkedId,
  type RequestTree,
  type TimeSplit,
  type TraceId,
  type TraceLogLine,
  type UnrecordedStoreCalls,
} from "./types";
import { collapsePipelines, commandCount, commandUs } from "./pipeline";

/** A hop with no end record becomes stalled after this long (design 7.3 step 5). */
export const STALL_AFTER_MS = 60_000;

/** Gaps that mean something went wrong, counted in the request's "gaps" fact. The others are notes. */
export const FAULT_GAPS: readonly GapKind[] = [GapKind.Stopped, GapKind.NoReceiver];

export function isStoreVia(via: Via): boolean {
  return via === Via.Db || via === Via.Cache;
}

interface RecordPair {
  start: HopRecord | null;
  end: HopRecord | null;
}

function pairRecords(records: readonly HopRecord[]): Map<HopId, RecordPair> {
  const pairs = new Map<HopId, RecordPair>();
  const sorted = [...records].sort((a, b) => a.timeMs - b.timeMs);
  for (const r of sorted) {
    const pair = pairs.get(r.hopId) ?? { start: null, end: null };
    const isEnd = r.hop === HopKind.InEnd || r.hop === HopKind.OutEnd;
    // The first record of each kind wins; a repeated line (re-shipped log) changes nothing.
    if (isEnd) pair.end ??= r;
    else pair.start ??= r;
    pairs.set(r.hopId, pair);
  }
  return pairs;
}

function hopFromPair(id: HopId, pair: RecordPair, now: number): Hop {
  const base = (pair.start ?? pair.end) as HopRecord;
  const end = pair.end;
  const dir = base.hop === HopKind.In || base.hop === HopKind.InEnd ? HopDir.In : HopDir.Out;
  const durationUs = end?.durationUs ?? null;
  // A hop with an end record only (always so for data-store hops, HOP-19) started duration earlier.
  const startMs = pair.start ? pair.start.timeMs : (end as HopRecord).timeMs - (durationUs ?? 0) / 1000;
  const endMs = end ? (pair.start && durationUs !== null ? startMs + durationUs / 1000 : end.timeMs) : null;
  const state = end ? HopState.Finished : now - startMs < STALL_AFTER_MS ? HopState.Open : HopState.Stalled;
  return {
    hopId: id,
    dir,
    via: base.via,
    service: base.service,
    adapter: base.adapter,
    method: base.method,
    op: base.op,
    path: base.path ?? end?.path ?? null,
    host: base.host ?? end?.host ?? null,
    synthetic: base.synthetic === true || end?.synthetic === true,
    peer: base.peer,
    // Data-store hops have an end record only (HOP-19); the end record carries both fields.
    table: end?.table ?? base.table,
    stmt: end?.stmt ?? base.stmt,
    parentHop: base.parentHop,
    parentId: base.parentId,
    hopSent: base.hopSent,
    tracer: base.tracer,
    handoff: base.handoff || (end?.handoff ?? false),
    attempt: base.attempt,
    state,
    outcome: end?.outcome ?? null,
    status: end?.status ?? null,
    error: end?.error ?? null,
    startMs,
    endMs,
    durationUs,
    totals: end?.totals ?? null,
    fields: end?.fields ?? [],
    linkedIds: [],
    logs: [],
    gaps: [],
    unrecorded: [],
    isStore: isStoreVia(base.via),
    pipeline: null,
    afterResponse: false,
    skewMs: 0,
    children: [],
  };
}

function byStart(a: Hop, b: Hop): number {
  return a.startMs - b.startMs || a.hopId.localeCompare(b.hopId);
}

/** End of a hop's window for placement and time sums: its end, or now while it runs. */
function windowEnd(hop: Hop, now: number): number {
  return hop.endMs ?? now;
}

function gap(kind: GapKind, hop: Hop, label: string, detail: string | null = null): Gap {
  return { kind, hopId: hop.hopId, label, detail };
}

function walk(hops: readonly Hop[], visit: (h: Hop) => void): void {
  for (const h of hops) {
    visit(h);
    walk(h.children, visit);
  }
}

function hasStalledDescendant(hop: Hop): boolean {
  return hop.children.some((c) => c.state === HopState.Stalled || hasStalledDescendant(c));
}

function elapsedUs(hop: Hop, now: number): number {
  return hop.durationUs ?? Math.max(0, Math.round((now - hop.startMs) * 1000));
}

/** A time interval `[startMs, endMs]` in epoch milliseconds. */
export type IntervalMs = [number, number];

/** Log timestamps are whole milliseconds: a call that ends within this of its request's end
 *  record ended with it, not after it. */
const AFTER_RESPONSE_SLACK_MS = 1;

/** Overlapping or touching intervals joined, in start order. */
export function mergeIntervals(intervals: readonly IntervalMs[]): IntervalMs[] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: IntervalMs[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Parts of `from` not covered by `cut` (both merged). */
export function subtractIntervals(from: readonly IntervalMs[], cut: readonly IntervalMs[]): IntervalMs[] {
  const out: IntervalMs[] = [];
  for (const [a0, b] of from) {
    let a = a0;
    for (const [c, d] of cut) {
      if (d <= a || c >= b) continue;
      if (c > a) out.push([a, c]);
      a = Math.max(a, d);
      if (a >= b) break;
    }
    if (a < b) out.push([a, b]);
  }
  return out;
}

/** Total length of the intervals, in microseconds (the intervals are in milliseconds). */
export function lengthUs(intervals: readonly IntervalMs[]): number {
  return Math.round(intervals.reduce((t, [a, b]) => t + (b - a), 0) * 1000);
}

/**
 * Design 7.3 step 10, for the first inbound hop. Calls can overlap (an ORM's parallel preloads,
 * `Promise.all`), so each part is wall-clock time, not a sum of durations: the database is the
 * union of its calls' intervals, the cache what its calls add beyond that, waiting what calls to
 * other services add beyond both, and own code the rest. The parts never exceed the whole. The
 * summed durations and call counts are kept for "21 calls, 128 ms in total". Calls in the totals
 * but not recorded one by one have no interval; their time is added as-is, within what is left.
 */
export function timeSplit(hop: Hop, now: number): TimeSplit {
  const totalUs = elapsedUs(hop, now);
  const start = hop.startMs;
  const end = start + totalUs / 1000;
  const intervalsOf = (kids: readonly Hop[]): IntervalMs[] =>
    mergeIntervals(kids.map((c): IntervalMs => [Math.max(c.startMs, start), Math.min(c.endMs ?? windowEnd(c, now), end)]));
  // A call that ran on after the response is not part of the request's time.
  const inside = hop.children.filter((c) => !c.afterResponse && !c.handoff);
  const storeKids = inside.filter((c) => c.isStore);
  const dbKids = storeKids.filter((c) => c.via === Via.Db);
  const cacheKids = storeKids.filter((c) => c.via === Via.Cache);
  const recordedSum = (kids: readonly Hop[]): number => kids.reduce((a, c) => a + (c.durationUs ?? 0), 0);
  // One call per row (a MULTI block is one), plus the calls in the totals not recorded one by one.
  const missing = (store: StoreKind): UnrecordedStoreCalls | undefined => storeShortfall(hop).find((u) => u.store === store);
  const dbSumUs = recordedSum(dbKids) + (missing(StoreKind.Db)?.us ?? 0);
  const cacheSumUs = recordedSum(cacheKids) + (missing(StoreKind.Cache)?.us ?? 0);
  const dbCalls = dbKids.length + (missing(StoreKind.Db)?.calls ?? 0);
  const cacheCalls = cacheKids.length + (missing(StoreKind.Cache)?.calls ?? 0);

  const db = intervalsOf(dbKids);
  const cacheOnly = subtractIntervals(intervalsOf(cacheKids), db);
  const waits = subtractIntervals(
    subtractIntervals(intervalsOf(inside.filter((c) => c.dir === HopDir.Out && !c.isStore)), db),
    cacheOnly
  );
  let left = totalUs;
  const take = (us: number): number => {
    const got = Math.max(0, Math.min(us, left));
    left -= got;
    return got;
  };
  const dbUs = take(lengthUs(db) + Math.max(0, dbSumUs - recordedSum(dbKids)));
  const cacheUs = take(lengthUs(cacheOnly) + Math.max(0, cacheSumUs - recordedSum(cacheKids)));
  const waitingUs = take(lengthUs(waits));
  const ownUs = left;
  const background = hop.children.filter((c) => c.handoff);
  const backgroundUs = background.reduce((a, c) => a + (c.durationUs ?? 0), 0);
  return { totalUs, dbUs, cacheUs, waitingUs, ownUs, dbCalls, dbSumUs, cacheCalls, cacheSumUs, backgroundCalls: background.length, backgroundUs };
}

function storeShortfall(hop: Hop): UnrecordedStoreCalls[] {
  if (!hop.totals) return [];
  const out: UnrecordedStoreCalls[] = [];
  const kinds: Array<[StoreKind, Via, number, number]> = [
    [StoreKind.Db, Via.Db, hop.totals.dbCalls, hop.totals.dbUs],
    [StoreKind.Cache, Via.Cache, hop.totals.cacheCalls, hop.totals.cacheUs],
  ];
  for (const [store, via, calls, us] of kinds) {
    // The totals count every command, so a MULTI block counts as its commands here.
    const recorded = hop.children.filter((c) => c.isStore && c.via === via);
    const missing = calls - recorded.reduce((a, c) => a + commandCount(c), 0);
    if (missing <= 0) continue;
    const recordedUs = recorded.reduce((a, c) => a + commandUs(c), 0);
    out.push({ store, calls: missing, us: Math.max(0, us - recordedUs) });
  }
  return out;
}

function peerName(hop: Hop): string {
  return hop.peer ?? hop.op ?? hop.via;
}

function dedupeLinks(links: readonly LinkedId[]): LinkedId[] {
  const seen = new Set<string>();
  const out: LinkedId[] = [];
  for (const l of [...links].sort((a, b) => a.timeMs - b.timeMs)) {
    const key = `${l.name}\u0000${l.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/**
 * A call cannot start before the hop that made it. When its records say so, its start moves to the
 * parent's start and `skewMs` says by how much:
 * - wholly before the parent (a clock difference between machines, or a start record written late):
 *   the whole call moves later and keeps its duration;
 * - reaching into the parent from before (an ORM's queue time counted in the duration): only the
 *   start is clipped; the end stays where it was recorded, and the time split already counts it that way.
 * Parents are visited before their children, so a moved parent is the reference for its children.
 */
function alignToParents(flat: readonly Hop[], byId: ReadonlyMap<HopId, Hop>): void {
  for (const h of flat) {
    const parent = h.parentHop ? byId.get(h.parentHop) : undefined;
    if (!parent || parent === h) continue;
    const early = parent.startMs - h.startMs;
    if (early <= 0) continue;
    const whollyBefore = h.endMs !== null && h.endMs <= parent.startMs;
    h.startMs = parent.startMs;
    if (whollyBefore && h.endMs !== null) h.endMs += early;
    h.skewMs = early;
  }
  for (const h of flat) h.children.sort(byStart);
}

/**
 * Build the tree of one trace.
 * @param records hop records of the trace (parsed, any order)
 * @param logs ordinary log lines of the trace
 * @param now epoch ms, for open and stalled hops
 * @param links linked-ID lines of the trace
 * @param knownPeers peers some service of the organisation has answered as (design 9); null when
 *   not known, and then every unanswered call is a gap (design 7.4)
 */
export function buildRequestTree(
  records: readonly HopRecord[],
  logs: readonly TraceLogLine[],
  now: number,
  links: readonly LinkedId[] = [],
  knownPeers: ReadonlySet<string> | null = null,
): RequestTree {
  const traceId = (records[0]?.traceId ?? links[0]?.traceId ?? "") as TraceId;
  const byId = new Map<HopId, Hop>();
  for (const [id, pair] of pairRecords(records)) byId.set(id, hopFromPair(id, pair, now));

  // Steps 2-4: parents, roots, children in start order.
  const roots: Hop[] = [];
  for (const hop of byId.values()) {
    const parent = hop.parentHop ? byId.get(hop.parentHop) : undefined;
    if (parent && parent !== hop) parent.children.push(hop);
    else roots.push(hop);
  }
  for (const hop of byId.values()) hop.children.sort(byStart);
  roots.sort(byStart);
  const flat: Hop[] = [];
  walk(roots, (h) => flat.push(h));

  // Step 6: each log line under the innermost inbound hop of its service whose window holds it.
  const inbound = flat.filter((h) => h.dir === HopDir.In);
  const unplacedLogs: Record<string, TraceLogLine[]> = {};
  for (const line of [...logs].sort((a, b) => a.timeMs - b.timeMs)) {
    let best: Hop | null = null;
    for (const h of inbound) {
      if (h.service !== line.service) continue;
      if (line.timeMs < h.startMs || line.timeMs > windowEnd(h, now)) continue;
      if (!best || h.startMs >= best.startMs) best = h;
    }
    if (best) best.logs.push(line);
    else (unplacedLogs[line.service] ??= []).push(line);
  }
  // An outbound hop shows what its service logged while the call ran.
  for (const h of flat) {
    if (h.dir !== HopDir.Out || h.isStore) continue;
    const parent = h.parentHop ? byId.get(h.parentHop) : undefined;
    if (!parent || parent.dir !== HopDir.In) continue;
    const end = windowEnd(h, now);
    h.logs = parent.logs.filter((l) => l.timeMs >= h.startMs && l.timeMs <= end);
  }

  // A call cannot start before the hop that made it. When the records say so (a clock difference
  // between machines, or a start record written late), move the call, and what it made, later by
  // the difference and keep its duration, so the page never draws a child ahead of its parent.
  alignToParents(flat, byId);

  // A redis MULTI block is one call, not one per command (BAC-63).
  let collapsed = false;
  for (const h of flat) {
    for (const gone of collapsePipelines(h)) {
      byId.delete(gone.hopId);
      collapsed = true;
    }
    for (const c of h.children) if (c.pipeline) byId.set(c.hopId, c);
  }
  if (collapsed) {
    flat.length = 0;
    walk(roots, (h) => flat.push(h));
  }

  // Calls still running when the response went: drawn where they ran, out of the time split.
  for (const h of inbound) {
    if (h.endMs === null) continue;
    for (const c of h.children) {
      if (c.dir === HopDir.Out && !c.handoff && c.endMs !== null && c.endMs > h.endMs + AFTER_RESPONSE_SLACK_MS) c.afterResponse = true;
    }
  }

  // Step 8: calls past the record limit.
  for (const h of inbound) h.unrecorded = storeShortfall(h);

  // Step 9: linked IDs on the request and on the hop that recorded them.
  const linkedIds = dedupeLinks(links.filter((l) => l.traceId === traceId || traceId === ""));
  for (const l of linkedIds) if (l.hopId) byId.get(l.hopId)?.linkedIds.push(l);

  // Section 7.4: gaps.
  const gaps: Gap[] = [];
  const add = (g: Gap): void => {
    gaps.push(g);
    byId.get(g.hopId)?.gaps.push(g);
  };
  // Peers answered within this request count as known too.
  const answered = new Set<string>();
  for (const h of flat) if (h.dir === HopDir.Out && h.peer && h.children.some((c) => c.dir === HopDir.In)) answered.add(h.peer);
  const isKnownPeer = (h: Hop): boolean => knownPeers === null || (h.peer !== null && (knownPeers.has(h.peer) || answered.has(h.peer)));
  for (const h of flat) {
    if (h.state === HopState.Stalled && !hasStalledDescendant(h)) add(gap(GapKind.Stopped, h, "Stopped here"));
    if (h.dir === HopDir.Out && !h.isStore) {
      const received = h.children.some((c) => c.dir === HopDir.In);
      // A call still running has not been answered yet; only a finished call can be "never received".
      if (h.hopSent === true && !received && h.state === HopState.Finished) {
        if (isKnownPeer(h)) add(gap(GapKind.NoReceiver, h, `No record from ${peerName(h)}`, peerName(h)));
        else add(gap(GapKind.NotInstrumented, h, "Not instrumented yet", peerName(h)));
      }
      if (h.hopSent === false) add(gap(GapKind.NotLinked, h, "Not linked", peerName(h)));
    }
    if (h.dir === HopDir.In && h.parentHop && !byId.has(h.parentHop)) {
      add(gap(GapKind.OutsideCaller, h, "Called from outside this organisation"));
    }
    if (h.dir === HopDir.In && h.parentHop) {
      const parent = byId.get(h.parentHop);
      if (parent && parent.dir === HopDir.Out && !parent.tracer && h.parentId && parent.parentId && h.parentId !== parent.parentId) {
        add(gap(GapKind.TracerBetween, h, "Passed through a tracer-only service"));
      }
    }
  }
  // Retries (HOP-16): inbound siblings under one parent with different attempts.
  for (const h of flat) {
    const attempts = h.children.filter((c) => c.dir === HopDir.In && c.attempt !== null);
    const distinct = new Set(attempts.map((c) => c.attempt));
    if (distinct.size < 2) continue;
    const first = Math.min(...attempts.map((c) => c.attempt as number));
    for (const c of attempts) {
      if ((c.attempt as number) > first) add(gap(GapKind.Retry, c, `Retry ${(c.attempt as number) - first}`, String(c.attempt)));
    }
  }
  gaps.sort((a, b) => (byId.get(a.hopId)?.startMs ?? 0) - (byId.get(b.hopId)?.startMs ?? 0));

  const firstIn = flat.find((h) => h.dir === HopDir.In) ?? null;
  const starts = flat.map((h) => h.startMs);
  const ends = flat.map((h) => windowEnd(h, now));
  const services: string[] = [];
  for (const h of flat) if (!services.includes(h.service)) services.push(h.service);

  return {
    traceId,
    roots,
    hops: [...flat].sort(byStart),
    linkedIds,
    gaps,
    unplacedLogs,
    split: firstIn ? timeSplit(firstIn, now) : null,
    startMs: starts.length ? Math.min(...starts) : null,
    endMs: ends.length ? Math.max(...ends) : null,
    services,
  };
}

/** Count of fault gaps (the "gaps" fact on the page). */
export function faultCount(tree: RequestTree): number {
  return tree.gaps.filter((g) => FAULT_GAPS.includes(g.kind)).length;
}

/** The hop that names the request: the earliest inbound root, else the earliest root. */
export function headHop(tree: RequestTree): Hop | null {
  return tree.roots.find((h) => h.dir === HopDir.In) ?? tree.roots[0] ?? null;
}

/**
 * Database and cache call counts of the whole request: one per row the Path card shows (a MULTI
 * block is one), plus the calls the totals report that were not recorded one by one. Calls that
 * ended after the end record was written are in the rows but not the totals, so they still count.
 */
export function storeCallCounts(tree: RequestTree): { db: number; cache: number } {
  let db = 0;
  let cache = 0;
  for (const h of tree.hops) {
    if (h.dir !== HopDir.In) continue;
    const kids = h.children.filter((c) => c.isStore);
    const missing = (store: StoreKind): number => h.unrecorded.find((u) => u.store === store)?.calls ?? 0;
    db += kids.filter((c) => c.via === Via.Db).length + missing(StoreKind.Db);
    cache += kids.filter((c) => c.via === Via.Cache).length + missing(StoreKind.Cache);
  }
  // Data-store hops whose inbound hop is missing still count once each. Indexed by hop id (first
  // hop with an id wins, as the earlier `find` did) so a request with many calls stays linear.
  const byId = new Map<string, Hop>();
  for (const h of tree.hops) if (!byId.has(h.hopId)) byId.set(h.hopId, h);
  for (const h of tree.hops) {
    if (!h.isStore) continue;
    const parent = h.parentHop ? byId.get(h.parentHop) : undefined;
    if (parent && parent.dir === HopDir.In) continue;
    if (h.via === Via.Db) db++;
    else cache++;
  }
  return { db, cache };
}

/** True when the hop failed: an error outcome or a 5xx status. */
export function isFailed(hop: Hop): boolean {
  return hop.outcome === Outcome.Error || (hop.status !== null && hop.status >= 500);
}

/** One line about a request, for the search result. */
export interface RequestSummary {
  traceId: TraceId;
  service: string;
  method: string | null;
  op: string | null;
  via: Via;
  status: number | null;
  failed: boolean;
  /** The head hop is a monitor's (HOP-28); missing on summaries stored before BAC-80. */
  synthetic?: boolean;
  state: HopState;
  services: number;
  durationUs: number | null;
  startMs: number;
}

export function requestSummary(tree: RequestTree): RequestSummary | null {
  const head = headHop(tree);
  if (!head) return null;
  return {
    traceId: tree.traceId,
    service: head.service,
    method: head.method,
    op: head.op,
    via: head.via,
    status: head.status,
    failed: isFailed(head),
    synthetic: head.synthetic === true,
    state: head.state,
    services: tree.services.length,
    durationUs: head.durationUs,
    startMs: head.startMs,
  };
}
