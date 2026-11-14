/**
 * Two requests side by side (BAC-75, insights plan 08): which calls took longer, which ran more
 * times, which only one of them made. Pure, so it runs in the browser on the comparison page and
 * is tested with plain records.
 *
 * Alignment is by content, never by hop id (ids differ per request). Each Path card row (CP-26,
 * `buildPathNodes`) gets a key from what it is:
 * - a database or cache call: the calling service, via, command, table, host and statement shape
 *   (`shapeId(statementShape(stmt))`); every call of one key under one parent is one row carrying
 *   its call count, so 14 lookups on one side and 2 on the other line up as "×14 against ×2";
 * - a call to another service and the hop it reached: caller, via, method, the service reached and
 *   its route;
 * - any other hop: service, via, method and route (or host);
 * - a top-level hop: service, direction and via only, so two different routes still line up at
 *   the top (with a warning).
 * Keys are joined down the path, so a call matches only under a matching parent. Identical
 * siblings that are not store calls (two calls to one service route) are told apart by their
 * occurrence index among siblings of the same key, in start order: a heuristic, stable when the
 * order is the same in both requests.
 */
import { callLabel } from "./concurrency";
import { buildPathNodes, rowUs, type PathNode } from "./path-rows";
import { shapeId, statementShape } from "./stmt-shape";
import { pipelineOps, storeLabel } from "./store-label";
import { fmtUs } from "./time-format";
import { headHop, storeCallCounts } from "./tree";
import { HopDir, HopState, StoreKind, Via, type Hop, type RequestTree, type UnrecordedStoreCalls } from "./types";

// ---------------------------------------------------------------- constants

/** A row is slower (or faster) when its time differs by at least this much, microseconds... */
export const DIFF_MIN_US = 10_000;
/** ...and by at least this share of its time in the other request (B for slower, A for faster). */
export const DIFF_MIN_SHARE = 0.25;
/** A row ran more (or fewer) times when the call counts differ by at least this many. */
export const CALLS_DIFF_MIN = 3;
/** Largest contributors listed under "What differs". */
export const TOP_ROWS = 6;
/** Sentences in the lead, at most. */
export const MAX_SENTENCES = 3;
/** Clauses in the "It also ..." sentence, at most. */
export const MAX_ALSO_CLAUSES = 2;
/** The difference is "most of" the total from this share of it. */
export const MOST_SHARE = 0.5;
/** The totals are "about the same" within DIFF_MIN_US or this share of B's time, whichever is more. */
export const SAME_TOTAL_SHARE = 0.1;

/** How a row differs. */
export const DiffKind = {
  Same: "same",
  Slower: "slower",
  Faster: "faster",
  OnlyA: "only_a",
  OnlyB: "only_b",
  MoreCalls: "more_calls",
  FewerCalls: "fewer_calls",
} as const;
export type DiffKind = (typeof DiffKind)[keyof typeof DiffKind];

/** The comparison as the page names it in sentences. */
export const DEFAULT_OTHER_NAME = "the typical request";
/** B when the viewer chose it by ID. */
export const CHOSEN_OTHER_NAME = "the other request";
/** `/requests/:id/vs/typical`: compare with a typical request of the same route, found by the loader. */
export const TYPICAL_PARAM = "typical";
/** The comparison page's empty state when no typical request qualifies (`typicalRequest`). */
export const NO_TYPICAL_SENTENCE = "No other requests of this route in the last hour to compare with.";

// ---------------------------------------------------------------- types

/** One side of a row: its time and how many calls it stands for (1, or the group size). */
export interface DiffCell {
  durationUs: number;
  calls: number;
}

export interface DiffRow {
  /** The row's content path (see the header): unique within the comparison. */
  key: string;
  /** 8 hex of the key, for element ids and links. */
  id: string;
  /** The parent row's key; null at the top. */
  parentKey: string | null;
  /** `storeLabel` for store calls, else "service METHOD route" (or the call's label). */
  label: string;
  depth: number;
  a: DiffCell | null;
  b: DiffCell | null;
  /** a minus b, a missing side counting as 0, microseconds. */
  deltaUs: number;
  kind: DiffKind;
  /** The row has rows under it. */
  hasChildren: boolean;
  /** A database or cache call (or the calls not recorded one by one). */
  store: boolean;
  /** What this row adds to the difference by itself: its delta less its rows' deltas for a row
   *  with rows under it (0 when they explain more than it), the whole delta for a leaf or for the
   *  top of a part only one request has, 0 inside such a part. */
  contributionUs: number;
}

export interface DiffSide {
  traceId: string;
  method: string | null;
  op: string | null;
  startMs: number | null;
  durationUs: number | null;
  status: number | null;
  finished: boolean;
  services: string[];
  /** Database, cache and outbound calls. */
  calls: number;
  truncated: boolean;
}

export interface SplitDelta {
  dbUs: number;
  cacheUs: number;
  waitingUs: number;
  ownUs: number;
}

export interface RequestDiff {
  a: DiffSide;
  b: DiffSide;
  totalDeltaUs: number;
  splitDelta: SplitDelta;
  /** Aligned, in A's path order, B's rows that A lacks after their matched siblings. */
  rows: DiffRow[];
  /** The largest contributors by |contributionUs|, at most TOP_ROWS. */
  top: DiffRow[];
  /** Plain sentences, at most MAX_SENTENCES. */
  sentences: string[];
  /** Different routes, records cut at the fetch limit, a request still running. */
  warnings: string[];
}

export interface DiffOptions {
  aTruncated?: boolean;
  bTruncated?: boolean;
  /** How the sentences name B: "the typical request" (default) or "the other request". */
  otherName?: string;
}

// ---------------------------------------------------------------- entries (one side)

interface Entry {
  key: string;
  label: string;
  durationUs: number;
  calls: number;
  store: boolean;
  kids: readonly PathNode[];
  unrecorded: readonly UnrecordedStoreCalls[];
}

const SEP = "|";
/** Between a parent's key and its row's in `DiffRow.key`: a route can hold any printable text. */
const LEVEL = "\n";

function storeKey(h: Hop): string {
  const shape = h.via === Via.Db && h.stmt !== null ? shapeId(statementShape(h.stmt)) : "";
  return ["s", h.service, h.via, h.op ?? "", h.table ?? "", h.peer ?? "", shape, pipelineOps(h) ?? ""].join(SEP);
}

function hopName(h: Hop): string {
  return [h.service, h.method, h.op].filter(Boolean).join(" ");
}

function nodeKey(n: PathNode, top: boolean): string {
  const h = n.hop;
  if (top) return ["r", h.service, h.dir, h.via].join(SEP);
  if (n.call) return ["c", n.call.service, n.call.via, n.call.method ?? "", h.service, h.op ?? ""].join(SEP);
  if (h.isStore) return storeKey(h);
  if (h.dir === HopDir.In) return ["i", h.service, h.via, h.method ?? "", h.op ?? ""].join(SEP);
  return ["o", h.service, h.via, h.method ?? "", h.peer ?? h.op ?? ""].join(SEP);
}

function nodeLabel(n: PathNode): string {
  const h = n.hop;
  if (h.isStore) return storeLabel(h);
  if (n.call || h.dir === HopDir.In) return hopName(h);
  return callLabel(h);
}

const UNRECORDED_LABEL: Record<StoreKind, string> = {
  [StoreKind.Db]: "database calls not recorded one by one",
  [StoreKind.Cache]: "cache calls not recorded one by one",
};

/** The rows under one parent: store calls of one key added up, other siblings by occurrence. */
function entriesOf(nodes: readonly PathNode[], unrecorded: readonly UnrecordedStoreCalls[], top: boolean): Entry[] {
  const out: Entry[] = [];
  const stores = new Map<string, Entry>();
  const seen = new Map<string, number>();
  for (const n of nodes) {
    const storeLeaf = n.members !== null || (n.hop.isStore && n.kids.length === 0);
    if (storeLeaf && !top) {
      const key = storeKey(n.hop);
      const calls = n.members?.length ?? 1;
      const known = stores.get(key);
      if (known) {
        known.durationUs += rowUs(n);
        known.calls += calls;
        continue;
      }
      const e: Entry = { key, label: storeLabel(n.hop), durationUs: rowUs(n), calls, store: true, kids: [], unrecorded: [] };
      stores.set(key, e);
      out.push(e);
      continue;
    }
    const base = nodeKey(n, top);
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    out.push({ key: nth ? `${base}#${nth}` : base, label: nodeLabel(n), durationUs: rowUs(n), calls: 1, store: n.hop.isStore, kids: n.kids, unrecorded: n.hop.unrecorded });
  }
  for (const u of unrecorded) {
    out.push({ key: ["u", u.store].join(SEP), label: UNRECORDED_LABEL[u.store], durationUs: u.us, calls: u.calls, store: true, kids: [], unrecorded: [] });
  }
  return out;
}

function childrenOf(e: Entry | null): Entry[] {
  return e ? entriesOf(e.kids, e.unrecorded, false) : [];
}

// ---------------------------------------------------------------- alignment

/** How one aligned row differs (see the constants). */
export function rowKind(a: DiffCell | null, b: DiffCell | null): DiffKind {
  if (!a) return DiffKind.OnlyB;
  if (!b) return DiffKind.OnlyA;
  if (a.calls - b.calls >= CALLS_DIFF_MIN) return DiffKind.MoreCalls;
  if (b.calls - a.calls >= CALLS_DIFF_MIN) return DiffKind.FewerCalls;
  // Slower: A took longer by the floor, measured against B's time; faster is the mirror (B took
  // longer, measured against A's time).
  const delta = a.durationUs - b.durationUs;
  if (delta >= Math.max(DIFF_MIN_US, DIFF_MIN_SHARE * b.durationUs)) return DiffKind.Slower;
  if (-delta >= Math.max(DIFF_MIN_US, DIFF_MIN_SHARE * a.durationUs)) return DiffKind.Faster;
  return DiffKind.Same;
}

function cellOf(e: Entry | null): DiffCell | null {
  return e ? { durationUs: e.durationUs, calls: e.calls } : null;
}

function isOnly(kind: DiffKind): boolean {
  return kind === DiffKind.OnlyA || kind === DiffKind.OnlyB;
}

/** Keys of the rows at the top of a part only one request has (their parent is matched, or none). */
function onlyHeads(rows: readonly DiffRow[]): Set<string> {
  const kindOf = new Map(rows.map((r) => [r.key, r.kind] as const));
  const out = new Set<string>();
  for (const r of rows) if (isOnly(r.kind) && (r.parentKey === null || kindOf.get(r.parentKey) !== r.kind)) out.add(r.key);
  return out;
}

function align(as: readonly Entry[], bs: readonly Entry[], depth: number, parent: DiffRow | null, out: DiffRow[]): DiffRow[] {
  const byKey = new Map(bs.map((e) => [e.key, e] as const));
  const used = new Set<string>();
  const direct: DiffRow[] = [];
  const emit = (ea: Entry | null, eb: Entry | null): void => {
    const e = (ea ?? eb) as Entry;
    const key = parent ? `${parent.key}${LEVEL}${e.key}` : e.key;
    const a = cellOf(ea);
    const b = cellOf(eb);
    const deltaUs = (a?.durationUs ?? 0) - (b?.durationUs ?? 0);
    const kind = rowKind(a, b);
    const row: DiffRow = {
      key, id: shapeId(key), parentKey: parent?.key ?? null, label: e.label, depth, a, b, deltaUs, kind,
      hasChildren: false, store: e.store, contributionUs: 0,
    };
    out.push(row);
    direct.push(row);
    const kids = align(childrenOf(ea), childrenOf(eb), depth + 1, row, out);
    row.hasChildren = kids.length > 0;
    if (isOnly(kind)) {
      // The top of a part only one request has stands for all of it; inside it, nothing more.
      row.contributionUs = parent && parent.kind === kind ? 0 : deltaUs;
    } else if (!row.hasChildren) {
      row.contributionUs = deltaUs;
    } else {
      // Calls can overlap, so their deltas can explain more than the row's own: then nothing is left.
      const self = deltaUs - kids.reduce((t, k) => t + k.deltaUs, 0);
      row.contributionUs = Math.sign(self) === Math.sign(deltaUs) ? self : 0;
    }
  };
  for (const ea of as) {
    const eb = byKey.get(ea.key) ?? null;
    if (eb) used.add(eb.key);
    emit(ea, eb);
  }
  for (const eb of bs) if (!used.has(eb.key)) emit(null, eb);
  return direct;
}

// ---------------------------------------------------------------- sides and sentences

function sideOf(tree: RequestTree, truncated: boolean): DiffSide {
  const head = headHop(tree);
  const counts = storeCallCounts(tree);
  const outbound = tree.hops.filter((h) => h.dir === HopDir.Out && !h.isStore).length;
  return {
    traceId: tree.traceId,
    method: head?.method ?? null,
    op: head?.op ?? null,
    startMs: head?.startMs ?? null,
    durationUs: head?.durationUs ?? null,
    status: head?.status ?? null,
    finished: head?.state === HopState.Finished,
    services: [...tree.services],
    calls: counts.db + counts.cache + outbound,
    truncated,
  };
}

function routeName(s: DiffSide): string {
  return [s.method, s.op].filter(Boolean).join(" ") || "an unnamed route";
}

/** True when the totals differ by less than DIFF_MIN_US or SAME_TOTAL_SHARE of B, whichever is more. */
function aboutTheSame(totalDeltaUs: number, bUs: number): boolean {
  return Math.abs(totalDeltaUs) < Math.max(DIFF_MIN_US, SAME_TOTAL_SHARE * bUs);
}

function timesNote(r: DiffRow): string {
  const a = r.a as DiffCell;
  const b = r.b as DiffCell;
  const calls = a.calls !== b.calls || a.calls > 1 ? `, ×${a.calls} against ×${b.calls}` : "";
  return `${fmtUs(a.durationUs)} against ${fmtUs(b.durationUs)}${calls}`;
}

/** The lead's subject for the largest contributor. */
function leadClause(r: DiffRow, other: string): string {
  if (r.kind === DiffKind.OnlyA) return `${r.label}, which only this request ${r.store ? "ran" : "called"} (${fmtUs(r.a?.durationUs ?? 0)})`;
  if (r.kind === DiffKind.OnlyB) return `${r.label}, which only ${other} ${r.store ? "ran" : "called"} (${fmtUs(r.b?.durationUs ?? 0)})`;
  if (r.hasChildren) return `time in ${r.label} outside its calls`;
  return `${r.label} (${timesNote(r)})`;
}

/** One "It also ..." clause, or null when the row adds nothing worth a clause. */
function alsoClause(r: DiffRow, other: string): string | null {
  const a = r.a;
  const b = r.b;
  switch (r.kind) {
    case DiffKind.MoreCalls:
      return `made ${(a?.calls ?? 0) - (b?.calls ?? 0)} more calls to ${r.label}`;
    case DiffKind.FewerCalls:
      return `made ${(b?.calls ?? 0) - (a?.calls ?? 0)} fewer calls to ${r.label}`;
    case DiffKind.OnlyA:
      return `${r.store ? "ran" : "called"} ${r.label}, which ${other} did not`;
    case DiffKind.OnlyB:
      return `did not ${r.store ? "run" : "call"} ${r.label}, which ${other} did`;
    case DiffKind.Slower:
      return r.hasChildren ? null : `spent ${fmtUs(r.deltaUs)} longer in ${r.label}`;
    case DiffKind.Faster:
      return r.hasChildren ? null : `spent ${fmtUs(-r.deltaUs)} less in ${r.label}`;
    case DiffKind.Same:
      return null;
  }
}

const ALSO_ORDER: readonly DiffKind[] = [DiffKind.MoreCalls, DiffKind.FewerCalls, DiffKind.OnlyA, DiffKind.OnlyB, DiffKind.Slower, DiffKind.Faster];

function sentencesOf(d: Omit<RequestDiff, "sentences">, other: string): string[] {
  const aUs = d.a.durationUs ?? 0;
  const bUs = d.b.durationUs ?? 0;
  const same = aboutTheSame(d.totalDeltaUs, bUs);
  const verdict = same ? "about the same" : `${fmtUs(Math.abs(d.totalDeltaUs))} ${d.totalDeltaUs > 0 ? "more" : "less"}`;
  const out = [`This request took ${fmtUs(aUs)} and ${other} ${fmtUs(bUs)}: ${verdict}.`];
  const lead = d.top[0];
  if (!lead) {
    out.push(`They made the same calls, and none took ${fmtUs(DIFF_MIN_US)} more or less.`);
    return out;
  }
  const c = Math.abs(lead.contributionUs);
  const most = !same && Math.sign(lead.contributionUs) === Math.sign(d.totalDeltaUs) && c >= MOST_SHARE * Math.abs(d.totalDeltaUs);
  out.push(`${most ? "Most of the difference" : "The largest difference"}, ${fmtUs(c)}, is ${leadClause(lead, other)}.`);
  // Calls only one request made and call counts first, then the next biggest times.
  const heads = onlyHeads(d.rows);
  const rest = d.rows.filter((r) => r !== lead && r.kind !== DiffKind.Same && (!isOnly(r.kind) || heads.has(r.key)));
  const ranked = [...rest].sort((x, y) => ALSO_ORDER.indexOf(x.kind) - ALSO_ORDER.indexOf(y.kind) || Math.abs(y.contributionUs) - Math.abs(x.contributionUs));
  const clauses: string[] = [];
  for (const r of ranked) {
    const clause = alsoClause(r, other);
    if (clause) clauses.push(clause);
    if (clauses.length >= MAX_ALSO_CLAUSES) break;
  }
  if (clauses.length) out.push(`It also ${clauses.join(", and ")}.`);
  return out.slice(0, MAX_SENTENCES);
}

function warningsOf(a: DiffSide, b: DiffSide, other: string): string[] {
  const out: string[] = [];
  if (a.method !== b.method || a.op !== b.op) out.push(`These are different routes (${routeName(a)} and ${routeName(b)}), so their calls line up only in part.`);
  if (a.truncated) out.push("Some records of this request were not loaded, so it may have made more calls than shown.");
  if (b.truncated) out.push(`Some records of ${other} were not loaded, so it may have made more calls than shown.`);
  if (!a.finished) out.push("This request has not finished, so its times are still growing.");
  if (!b.finished) out.push(`${other.charAt(0).toUpperCase()}${other.slice(1)} has not finished, so its times are still growing.`);
  return out;
}

// ---------------------------------------------------------------- the diff

/**
 * Request A (this request) against request B (the typical one, or one the viewer chose).
 * Each tree is one request (`splitRequests` part) built by `buildRequestTree`.
 */
export function diffRequests(a: RequestTree, b: RequestTree, options: DiffOptions = {}): RequestDiff {
  const other = options.otherName ?? DEFAULT_OTHER_NAME;
  const sideA = sideOf(a, options.aTruncated ?? false);
  const sideB = sideOf(b, options.bTruncated ?? false);
  const rows: DiffRow[] = [];
  align(entriesOf(buildPathNodes(a.roots), [], true), entriesOf(buildPathNodes(b.roots), [], true), 0, null, rows);
  const heads = onlyHeads(rows);
  const qualifies = (r: DiffRow): boolean =>
    heads.has(r.key) || r.kind === DiffKind.MoreCalls || r.kind === DiffKind.FewerCalls || Math.abs(r.contributionUs) >= DIFF_MIN_US;
  const top = rows.filter(qualifies).sort((x, y) => Math.abs(y.contributionUs) - Math.abs(x.contributionUs)).slice(0, TOP_ROWS);
  const sa = a.split;
  const sb = b.split;
  const splitDelta: SplitDelta = {
    dbUs: (sa?.dbUs ?? 0) - (sb?.dbUs ?? 0),
    cacheUs: (sa?.cacheUs ?? 0) - (sb?.cacheUs ?? 0),
    waitingUs: (sa?.waitingUs ?? 0) - (sb?.waitingUs ?? 0),
    ownUs: (sa?.ownUs ?? 0) - (sb?.ownUs ?? 0),
  };
  const base = {
    a: sideA,
    b: sideB,
    totalDeltaUs: (sideA.durationUs ?? 0) - (sideB.durationUs ?? 0),
    splitDelta,
    rows,
    top,
    warnings: warningsOf(sideA, sideB, other),
  };
  return { ...base, sentences: sentencesOf(base, other) };
}

/** The rows the side by side table shows folded: those that differ, and the rows above them. */
export function differingRows(rows: readonly DiffRow[]): DiffRow[] {
  const keep = new Set<string>();
  const byKey = new Map(rows.map((r) => [r.key, r] as const));
  for (const r of rows) {
    if (r.kind === DiffKind.Same) continue;
    let cur: DiffRow | undefined = r;
    while (cur && !keep.has(cur.key)) {
      keep.add(cur.key);
      cur = cur.parentKey ? byKey.get(cur.parentKey) : undefined;
    }
  }
  return rows.filter((r) => keep.has(r.key));
}

/** A signed difference: "+236 ms", "-12.9 ms", "0.00 ms". */
export function fmtDeltaUs(us: number): string {
  if (us === 0) return fmtUs(0);
  return `${us > 0 ? "+" : "-"}${fmtUs(Math.abs(us))}`;
}

/** "×14 against ×2" for a row whose call counts differ or that stands for several calls; null otherwise. */
export function callsNote(r: Pick<DiffRow, "a" | "b">): string | null {
  const a = r.a?.calls ?? 0;
  const b = r.b?.calls ?? 0;
  if (a === b && a <= 1) return null;
  return `×${a} against ×${b}`;
}
