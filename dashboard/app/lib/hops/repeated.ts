/**
 * Repeated calls inside one request (BAC-68): the same database query or cache command issued
 * many times by one hop, whether the calls ran one after another (the N+1 shape) or together, and
 * what they cost. The request view marks them on the Path card; the Insights board and later
 * features (why slow, chatty, fix first, request diff) read the same groups. Pure, so it runs in
 * the browser on every request view and is tested with plain objects.
 *
 * - Only the direct store children of an inbound hop count, and not those made in the background
 *   (`handoff`) or after the response: they are not request time.
 * - "Same call" is `callShapeKey`: the statement's shape (`statementShape`) for the database, the
 *   command for the cache. The Path view folds by the same key, so its "xN" row and the finding
 *   always agree.
 * - A plain Redis pipeline (cache calls started together on one client) is one round trip already:
 *   it is classed as batched and never reported.
 */
import { statementShape } from "./stmt-shape";
import { pipelineOps, storeLabel } from "./store-label";
import { fmtUs } from "./time-format";
import { HopDir, StoreKind, Via, type Hop, type HopId, type RequestTree } from "./types";

// ---------------------------------------------------------------- fixed values

/** How repeated calls ran against each other. */
export const Repetition = {
  /** One after another: each waited for the one before (the N+1 shape). */
  Sequential: "sequential",
  /** Overlapping: sent together, answered together. */
  Concurrent: "concurrent",
  /** Cache commands started together on one client: a plain pipeline, one round trip. Not reported. */
  Batched: "batched",
} as const;
export type Repetition = (typeof Repetition)[keyof typeof Repetition];

/** The marker a repeated call carries on the Path card. */
export const RepeatChip = {
  /** Database queries run one after another. */
  NPlusOne: "N+1",
  /** Everything else that repeats. */
  Repeated: "repeated",
} as const;
export type RepeatChip = (typeof RepeatChip)[keyof typeof RepeatChip];

/** A database query issued at least this many times by one hop is a finding. */
export const REPEAT_MIN_DB = 5;
/** Cache commands that ran together need this many before they are a finding (they are cheap). */
export const REPEAT_MIN_CACHE = 10;
/** Cache commands that ran one after another are a finding from this many (each waited a round trip). */
export const REPEAT_MIN_CACHE_SEQUENTIAL = 5;
/** Two calls are "one after another" when the second starts no earlier than this before the first
 *  ended: some sources write whole milliseconds, so touching calls can look overlapped. */
export const SLACK_MS = 1;
/** Calls are sequential when at least this share of consecutive pairs ran one after another. */
export const SEQUENTIAL_SHARE = 0.8;
/** Cache commands whose starts all fall within this many milliseconds were sent in one write. */
export const BATCH_WINDOW_MS = 2;
/** A pipeline needs at least this many commands to be told apart from chance. */
export const BATCH_MIN_CALLS = 5;

// ---------------------------------------------------------------- types

export interface RepeatGroup {
  /** `${parentHopId}|${shapeKey}`: unique within a request. */
  key: string;
  parentHopId: HopId;
  service: string;
  kind: StoreKind;
  /** "select plans", "set redis.internal". */
  label: string;
  table: string | null;
  /** `statementShape(stmt)`; null for cache commands and when the statement was not recorded. */
  shape: string | null;
  peer: string | null;
  op: string | null;
  count: number;
  /** The calls' durations added up, microseconds. */
  totalUs: number;
  /** What fetching them together could save: the total minus the first call (sequential) or minus
   *  the longest call (concurrent), microseconds, never negative. */
  wastedUs: number;
  repetition: Repetition;
  /** In start order. */
  hopIds: HopId[];
  /** The count is a floor: the request's records were cut at the fetch limit, or the hop made more
   *  calls of this kind than were recorded one by one (HOP-19). */
  atLeast: boolean;
  /** False when the calls were matched by command and table only, the statement being absent
   *  (Query text off, or records older than spec 13.2). */
  statementKnown: boolean;
}

export interface RepeatReport {
  /** Most wasted time first. */
  groups: RepeatGroup[];
  /** The calls in all groups added up (a MULTI block counts as one call). */
  repeatedCalls: number;
  wastedUs: number;
  truncated: boolean;
}

/** The timing of one call, epoch milliseconds. */
export interface CallSpan {
  startMs: number;
  endMs: number;
}

// ---------------------------------------------------------------- shape

/**
 * Which store calls count as the same call: database calls by host, table and statement shape (or
 * command, when the statement is absent); cache calls by host and command (a MULTI block by its
 * commands). Shared with the Path view's folding.
 */
export function callShapeKey(h: Pick<Hop, "via" | "op" | "peer" | "table" | "stmt"> & Partial<Pick<Hop, "pipeline">>): string {
  const sep = "\u0000";
  if (h.via === Via.Db) {
    const what = h.stmt !== null ? `s:${statementShape(h.stmt)}` : `o:${h.op ?? ""}`;
    return [h.via, h.peer ?? "", h.table ?? "", what].join(sep);
  }
  return [h.via, h.peer ?? "", h.op ?? "", pipelineOps(h) ?? ""].join(sep);
}

// ---------------------------------------------------------------- timing

/**
 * How a set of repeated calls ran. `batchable` is true for cache commands from one client: started
 * all within BATCH_WINDOW_MS, at least BATCH_MIN_CALLS of them, they were one pipeline.
 * Otherwise sequential when at least SEQUENTIAL_SHARE of consecutive pairs (in start order) ran
 * one after another, within SLACK_MS; concurrent when they did not.
 */
export function classifyRepetition(calls: readonly CallSpan[], batchable: boolean): Repetition {
  const sorted = [...calls].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (sorted.length < 2) return Repetition.Sequential;
  if (batchable && sorted.length >= BATCH_MIN_CALLS && sorted[sorted.length - 1].startMs - sorted[0].startMs <= BATCH_WINDOW_MS) {
    return Repetition.Batched;
  }
  let after = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].startMs >= sorted[i - 1].endMs - SLACK_MS) after++;
  return after / (sorted.length - 1) >= SEQUENTIAL_SHARE ? Repetition.Sequential : Repetition.Concurrent;
}

/** What doing the calls at once could save, microseconds (see `RepeatGroup.wastedUs`). `durationsUs`
 *  in start order. */
export function wastedUsOf(repetition: Repetition, durationsUs: readonly number[]): number {
  if (!durationsUs.length || repetition === Repetition.Batched) return 0;
  const total = durationsUs.reduce((a, d) => a + d, 0);
  const keep = repetition === Repetition.Sequential ? durationsUs[0] : Math.max(...durationsUs);
  return Math.max(0, total - keep);
}

/** True when a group of this kind, size and timing is a finding. */
export function qualifies(kind: StoreKind, count: number, repetition: Repetition): boolean {
  if (repetition === Repetition.Batched) return false;
  if (kind === StoreKind.Db) return count >= REPEAT_MIN_DB;
  return count >= (repetition === Repetition.Sequential ? REPEAT_MIN_CACHE_SEQUENTIAL : REPEAT_MIN_CACHE);
}

// ---------------------------------------------------------------- detection

function oneClient(calls: readonly Hop[]): boolean {
  const first = calls[0];
  return calls.every((c) => c.service === first.service && c.adapter === first.adapter && c.peer === first.peer);
}

function groupOf(parent: Hop, calls: Hop[], shapeKey: string, truncated: boolean): RepeatGroup | null {
  const first = calls[0];
  const kind = first.via === Via.Db ? StoreKind.Db : StoreKind.Cache;
  const spans = calls.map((c) => ({ startMs: c.startMs, endMs: c.endMs ?? c.startMs }));
  const repetition = classifyRepetition(spans, kind === StoreKind.Cache && oneClient(calls));
  if (!qualifies(kind, calls.length, repetition)) return null;
  const durations = calls.map((c) => c.durationUs ?? 0);
  const shortfall = parent.unrecorded.some((u) => u.store === kind && u.calls > 0);
  return {
    key: `${parent.hopId}|${shapeKey}`,
    parentHopId: parent.hopId,
    service: first.service,
    kind,
    label: storeLabel(first),
    table: first.table,
    shape: kind === StoreKind.Db && first.stmt !== null ? statementShape(first.stmt) : null,
    peer: first.peer,
    op: first.op,
    count: calls.length,
    totalUs: durations.reduce((a, d) => a + d, 0),
    wastedUs: wastedUsOf(repetition, durations),
    repetition,
    hopIds: calls.map((c) => c.hopId),
    atLeast: truncated || shortfall,
    statementKnown: kind === StoreKind.Cache || first.stmt !== null,
  };
}

/**
 * The repeated calls of one request. `truncated` is the fetch's flag (`WindowResult.truncated`):
 * when the records were cut, every count is a floor.
 */
export function detectRepeats(tree: RequestTree, truncated: boolean): RepeatReport {
  const groups: RepeatGroup[] = [];
  for (const parent of tree.hops) {
    if (parent.dir !== HopDir.In) continue;
    const byShape = new Map<string, Hop[]>();
    for (const c of parent.children) {
      if (!c.isStore || c.handoff || c.afterResponse || c.endMs === null) continue;
      const k = callShapeKey(c);
      const list = byShape.get(k);
      if (list) list.push(c);
      else byShape.set(k, [c]);
    }
    for (const [k, calls] of byShape) {
      if (calls.length < Math.min(REPEAT_MIN_DB, REPEAT_MIN_CACHE_SEQUENTIAL)) continue;
      calls.sort((a, b) => a.startMs - b.startMs);
      const g = groupOf(parent, calls, k, truncated);
      if (g) groups.push(g);
    }
  }
  groups.sort((a, b) => b.wastedUs - a.wastedUs || b.count - a.count || a.key.localeCompare(b.key));
  return {
    groups,
    repeatedCalls: groups.reduce((a, g) => a + g.count, 0),
    wastedUs: groups.reduce((a, g) => a + g.wastedUs, 0),
    truncated,
  };
}

/** Each repeated call's group, by hop id. */
export function repeatsByHop(report: RepeatReport): Map<HopId, RepeatGroup> {
  const out = new Map<HopId, RepeatGroup>();
  for (const g of report.groups) for (const id of g.hopIds) out.set(id, g);
  return out;
}

// ---------------------------------------------------------------- words

function times(g: RepeatGroup): string {
  return `${g.atLeast ? "at least " : ""}${g.count} times`;
}

/** The finding as a sentence: "select plans ran 14 times, one after another, 62.0 ms in all." */
export function repeatSentence(g: RepeatGroup): string {
  const basis = g.statementKnown ? "" : " (matched by command and table: the query text was not recorded)";
  if (g.repetition === Repetition.Sequential) return `${g.label} ran ${times(g)}, one after another, ${fmtUs(g.totalUs)} in all${basis}.`;
  if (g.repetition === Repetition.Concurrent) return `${g.label} ran ${times(g)} together (about ${fmtUs(g.totalUs / Math.max(g.count, 1))} each)${basis}.`;
  return `${g.label} ran ${times(g)} in one batch${basis}.`;
}

/** A suggestion for calls that waited on each other; null when they already ran together. */
export function repeatHint(g: RepeatGroup): string | null {
  if (g.repetition !== Repetition.Sequential) return null;
  return g.kind === StoreKind.Db ? "Fetch them together with one query that takes a list of IDs." : "Use one multi-key command or a pipeline.";
}

/** "N+1" for database queries run one after another, "repeated" otherwise. */
export function repeatChip(g: RepeatGroup): RepeatChip {
  return g.kind === StoreKind.Db && g.repetition === Repetition.Sequential && g.count >= REPEAT_MIN_DB ? RepeatChip.NPlusOne : RepeatChip.Repeated;
}

/** The note a repeated-call row carries: "repeated 14 times". */
export function repeatNote(g: RepeatGroup): string {
  return `repeated ${times(g)}`;
}
