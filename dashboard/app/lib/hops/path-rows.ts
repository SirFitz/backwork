/**
 * The rows of the Path card (CP-26): which hops are shown, which are folded away by default, and
 * what a folded row says about what is inside it. Pure, so it is tested without a browser.
 *
 * - An outbound call to another service and the inbound hop it reached are one row (they are the
 *   same call seen from both sides).
 * - Repeated store calls of one shape (`callShapeKey`, BAC-68) under the same hop fold into one
 *   row ("select … x160").
 * - Everything below the first service's own hops is folded, except what went wrong or took a
 *   large share of the request.
 */
import { callShapeKey } from "./repeated";
import { FAULT_GAPS } from "./tree";
import { GapKind, HopDir, HopState, Outcome, StoreKind, Via, type Hop, type HopId } from "./types";

/** A shape repeated at least this many times under one hop folds into one row. */
export const GROUP_MIN = 3;
/** A folded row opens by itself when it took at least this share of the request. */
export const SLOW_SHARE = 0.25;

export interface PathNode {
  /** Unique within the card; the key of the fold state. */
  key: string;
  /** The hop the row is about: the callee of a merged pair, the first call of a group. */
  hop: Hop;
  /** The outbound call merged into this row, when the row is a merged pair. */
  call: Hop | null;
  /** The repeated calls, when the row is a group. */
  members: Hop[] | null;
  kids: PathNode[];
}

export interface VisibleRow {
  node: PathNode;
  depth: number;
  /** There is something to open or fold. */
  expandable: boolean;
  expanded: boolean;
  /** What a folded row holds, e.g. "3 database calls · 1 call". Null when open or empty. */
  summary: string | null;
  /** Not a hop row: what follows a hop's children (calls not recorded one by one, a receiver that
   *  never answered). Drawn after the hop's children, or straight after it when it is folded. */
  tail: boolean;
}

/** Store calls fold by the repeated-call detector's key (BAC-68), so the "xN" row and the finding
 *  agree: statement shape for the database, command for the cache. */
function shapeKey(h: Hop): string {
  return callShapeKey(h);
}

/** A call out of a service that reached exactly one inbound hop and nothing went wrong between them. */
function isMergeable(h: Hop): boolean {
  return h.dir === HopDir.Out && !h.isStore && !h.handoff && h.gaps.length === 0
    && h.children.length === 1 && h.children[0].dir === HopDir.In;
}

function nodeOf(h: Hop): PathNode {
  if (isMergeable(h)) {
    const callee = h.children[0];
    return { key: callee.hopId, hop: callee, call: h, members: null, kids: kidsOf(callee) };
  }
  return { key: h.hopId, hop: h, call: null, members: null, kids: kidsOf(h) };
}

/** A store call that can join a group: a leaf with nothing wrong recorded on it. */
function groupable(h: Hop): boolean {
  return h.isStore && h.children.length === 0 && h.gaps.length === 0;
}

/**
 * Children in the order they started. Consecutive store calls of one shape (nothing else between
 * them) fold into one row when there are at least GROUP_MIN of them (BAC-87). A repeat after any
 * other call starts a new run, so rows never leave their place in time and calls made apart, often
 * by different code, are never shown as one group. The request-wide repeated finding counts all.
 */
function kidsOf(parent: Hop): PathNode[] {
  const out: PathNode[] = [];
  const kids = parent.children;
  let i = 0;
  while (i < kids.length) {
    const c = kids[i];
    if (!groupable(c)) {
      out.push(nodeOf(c));
      i++;
      continue;
    }
    const k = shapeKey(c);
    let j = i + 1;
    while (j < kids.length && groupable(kids[j]) && shapeKey(kids[j]) === k) j++;
    const run = kids.slice(i, j);
    if (run.length >= GROUP_MIN) out.push({ key: `group-${run[0].hopId}`, hop: run[0], call: null, members: run, kids: run.map(nodeOf) });
    else out.push(...run.map(nodeOf));
    i = j;
  }
  return out;
}

export function buildPathNodes(roots: readonly Hop[]): PathNode[] {
  return roots.map(nodeOf);
}

function hasProblem(h: Hop): boolean {
  return h.state !== HopState.Finished || h.outcome === Outcome.Error || h.gaps.some((g) => FAULT_GAPS.includes(g.kind));
}

function subtreeProblem(n: PathNode): boolean {
  return hasProblem(n.hop) || (n.call !== null && hasProblem(n.call)) || n.kids.some(subtreeProblem);
}

/** Microseconds the row stands for: a group's calls added up, a merged call as the caller saw it. */
export function rowUs(n: PathNode): number {
  if (n.members) return n.members.reduce((a, m) => a + (m.durationUs ?? 0), 0);
  return (n.call ?? n.hop).durationUs ?? 0;
}

function hasHiddenParts(n: PathNode): boolean {
  return n.kids.length > 0 || n.hop.unrecorded.length > 0;
}

function isOpenByDefault(n: PathNode, depth: number, headUs: number): boolean {
  if (depth === 0) return true;
  if (subtreeProblem(n)) return true;
  if (n.members) return false;
  return headUs > 0 && rowUs(n) >= SLOW_SHARE * headUs;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What is inside a folded row, in words. */
export function summaryOf(n: PathNode): string | null {
  let db = 0;
  let cache = 0;
  let calls = 0;
  const addStore = (h: Hop): void => {
    if (h.via === Via.Db) db++;
    else cache++;
  };
  const count = (k: PathNode): void => {
    if (k.members) {
      k.members.forEach(addStore);
      return;
    }
    const h = k.hop;
    if (h.isStore) addStore(h);
    else if (k.call || h.dir === HopDir.Out) calls++;
    for (const u of h.unrecorded) u.store === StoreKind.Db ? (db += u.calls) : (cache += u.calls);
    k.kids.forEach(count);
  };
  for (const u of n.hop.unrecorded) u.store === StoreKind.Db ? (db += u.calls) : (cache += u.calls);
  for (const k of n.kids) count(k);
  const parts: string[] = [];
  if (db) parts.push(plural(db, "database call", "database calls"));
  if (cache) parts.push(plural(cache, "cache call", "cache calls"));
  if (calls) parts.push(plural(calls, "call", "calls"));
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The rows to draw, top to bottom.
 * @param overrides what the viewer opened or folded by hand, by node key; it wins over the default
 * @param headUs duration of the request, for "took a large share of it"
 */
export function visibleRows(
  nodes: readonly PathNode[],
  overrides: ReadonlyMap<string, boolean>,
  headUs: number,
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const visit = (n: PathNode, depth: number): void => {
    const expandable = hasHiddenParts(n);
    const expanded = expandable && (overrides.get(n.key) ?? isOpenByDefault(n, depth, headUs));
    rows.push({ node: n, depth, expandable, expanded, summary: expandable && !expanded ? summaryOf(n) : null, tail: false });
    if (expanded) for (const k of n.kids) visit(k, depth + 1);
    // A receiver that never answered is a fault: it is never folded away.
    const noReceiver = n.hop.gaps.some((g) => g.kind === GapKind.NoReceiver);
    if ((expanded && n.hop.unrecorded.length > 0) || noReceiver) {
      rows.push({ node: n, depth, expandable: false, expanded: false, summary: null, tail: true });
    }
  };
  for (const n of nodes) visit(n, 0);
  return rows;
}

/** Every node that can be opened, for "expand all". */
export function expandableKeys(nodes: readonly PathNode[]): string[] {
  const keys: string[] = [];
  const visit = (n: PathNode): void => {
    if (hasHiddenParts(n)) keys.push(n.key);
    n.kids.forEach(visit);
  };
  nodes.forEach(visit);
  return keys;
}

/**
 * The keys of the nodes from a root down to the row that shows `hopId` (a group holding it counts
 * as that row), for "show me this call": open each, then scroll to the last. Null when no row has it.
 */
export function pathKeysTo(nodes: readonly PathNode[], hopId: HopId): string[] | null {
  for (const n of nodes) {
    if (n.hop.hopId === hopId || n.call?.hopId === hopId || n.members?.some((m) => m.hopId === hopId)) return [n.key];
    const below = pathKeysTo(n.kids, hopId);
    if (below) return [n.key, ...below];
  }
  return null;
}
