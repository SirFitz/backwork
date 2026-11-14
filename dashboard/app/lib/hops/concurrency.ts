/**
 * Calls that could run together (BAC-71): calls one hop made back to back, each starting as soon
 * as the one before ended, so the code between them did almost no work. If they do not depend on
 * each other, running them together would take only as long as the longest. We cannot see data
 * dependencies, so the finding is always worded as a possibility. Pure: runs in the browser on
 * the request view.
 *
 * - Only the direct outbound calls of one inbound hop are compared: they share that service's
 *   clock (stores carry the caller's times; for an HTTP call the caller-side out hop is used, not
 *   the callee's inbound hop), so clock skew across services does not matter.
 * - Calls made in the background (`handoff`) or after the response are not request time.
 * - Calls in a repeat group (feature 1: the N+1 has its own hint) and cache commands sent as one
 *   plain pipeline break a chain: they are reported elsewhere or already ran together.
 * - Calls that overlap already ran together and break a chain.
 */
import { BATCH_MIN_CALLS, Repetition, callShapeKey, classifyRepetition, detectRepeats, type RepeatReport } from "./repeated";
import { storeLabel } from "./store-label";
import { fmtUs } from "./time-format";
import { HopDir, Via, type Hop, type HopId, type RequestTree } from "./types";

// ---------------------------------------------------------------- thresholds

/** A call follows the previous one when it starts no more than this after it ended, microseconds. */
export const GAP_US = 2_000;
/** ...and no earlier than this before it ended (whole-millisecond sources make touching calls look
 *  overlapped), milliseconds. */
export const OVERLAP_SLACK_MS = 1;
/** Two calls whose starts are within this many milliseconds were started together, not in turn. */
export const STARTED_TOGETHER_MS = 0.1;
/** A chain is reported only when running it together could save at least this, microseconds. */
export const MIN_SAVED_US = 20_000;
/** Chains longer than this are a loop, not a few independent calls, and are not reported. */
export const MAX_CHAIN_CALLS = 12;
/** The chip on the Path card's rows. */
export const PARALLEL_CHIP = "could run together";

// ---------------------------------------------------------------- types

/** Data dependencies are not recorded: whether the calls are independent is never known. */
export const Independence = { Unknown: "unknown" } as const;
export type Independence = (typeof Independence)[keyof typeof Independence];

export interface ParallelCandidate {
  /** The inbound hop that made the calls. */
  parentHopId: HopId;
  service: string;
  /** 2 to MAX_CHAIN_CALLS sibling calls, in start order, that ran back to back. */
  hopIds: HopId[];
  /** "get redis.internal", "select orders", "POST payments.internal". */
  labels: string[];
  /** From the first call's start to the last call's end: the time they took one after another,
   *  microseconds. */
  serialUs: number;
  /** The longest of them: what running them together would take, microseconds. */
  parallelUs: number;
  /** serialUs minus parallelUs, microseconds. */
  savedUs: number;
  independent: Independence;
}

export interface ParallelOptions {
  minSavedUs: number;
  maxCalls: number;
}

const DEFAULTS: ParallelOptions = { minSavedUs: MIN_SAVED_US, maxCalls: MAX_CHAIN_CALLS };

// ---------------------------------------------------------------- detection

/** How a call is named in the sentence: "select orders", "get redis.internal", "POST
 *  commerce-payments" (the service it reached, else the host it called). */
export function callLabel(h: Hop): string {
  if (h.isStore) return storeLabel(h);
  const reached = h.children.find((k) => k.dir === HopDir.In)?.service ?? null;
  const where = reached ?? h.peer ?? h.op ?? h.via;
  return h.method ? `${h.method} ${where}` : where;
}

function isRequestCall(h: Hop): boolean {
  return h.dir === HopDir.Out && !h.handoff && !h.afterResponse && h.endMs !== null && h.durationUs !== null;
}

/** Cache commands of one shape and client sent as one plain pipeline (feature 1's `Batched`). */
function batchedCalls(calls: readonly Hop[]): Set<HopId> {
  const byShape = new Map<string, Hop[]>();
  for (const c of calls) {
    if (c.via !== Via.Cache) continue;
    const k = `${c.service}\u0000${c.adapter ?? ""}\u0000${callShapeKey(c)}`;
    const list = byShape.get(k);
    if (list) list.push(c);
    else byShape.set(k, [c]);
  }
  const out = new Set<HopId>();
  for (const list of byShape.values()) {
    if (list.length < BATCH_MIN_CALLS) continue;
    const spans = list.map((c) => ({ startMs: c.startMs, endMs: c.endMs ?? c.startMs }));
    if (classifyRepetition(spans, true) === Repetition.Batched) for (const c of list) out.add(c.hopId);
  }
  return out;
}

/** True when `next` started in turn after `prev`: not before it ended (within the slack), not long
 *  after (GAP_US), and not together with it. */
export function follows(prev: Pick<Hop, "startMs" | "endMs">, next: Pick<Hop, "startMs">): boolean {
  const end = prev.endMs ?? prev.startMs;
  return next.startMs >= end - OVERLAP_SLACK_MS && next.startMs <= end + GAP_US / 1000 && next.startMs - prev.startMs > STARTED_TOGETHER_MS;
}

function candidateOf(parent: Hop, chain: readonly Hop[]): ParallelCandidate {
  const first = chain[0];
  const end = Math.max(...chain.map((c) => c.endMs ?? c.startMs));
  const serialUs = Math.round((end - first.startMs) * 1000);
  const parallelUs = Math.max(...chain.map((c) => c.durationUs ?? 0));
  return {
    parentHopId: parent.hopId,
    service: parent.service,
    hopIds: chain.map((c) => c.hopId),
    labels: chain.map(callLabel),
    serialUs,
    parallelUs,
    savedUs: Math.max(0, serialUs - parallelUs),
    independent: Independence.Unknown,
  };
}

/**
 * Every chain of at least two calls run back to back, without the saving floor or length cap
 * (`parallelCandidates` applies them). `repeats` defaults to feature 1's report for the tree.
 */
export function parallelChains(tree: RequestTree, repeats: RepeatReport = detectRepeats(tree, false)): ParallelCandidate[] {
  const repeated = new Set<HopId>();
  for (const g of repeats.groups) for (const id of g.hopIds) repeated.add(id);
  const out: ParallelCandidate[] = [];
  for (const parent of tree.hops) {
    if (parent.dir !== HopDir.In) continue;
    const calls = parent.children
      .filter(isRequestCall)
      .sort((a, b) => a.startMs - b.startMs || (a.endMs ?? 0) - (b.endMs ?? 0) || a.hopId.localeCompare(b.hopId));
    if (calls.length < 2) continue;
    const batched = batchedCalls(calls);
    let chain: Hop[] = [];
    const close = (): void => {
      if (chain.length >= 2) out.push(candidateOf(parent, chain));
      chain = [];
    };
    for (const c of calls) {
      if (repeated.has(c.hopId) || batched.has(c.hopId)) {
        close();
        continue;
      }
      const prev = chain[chain.length - 1];
      if (prev && !follows(prev, c)) close();
      chain.push(c);
    }
    close();
  }
  return out;
}

/** The chains worth reporting: saving at least MIN_SAVED_US, at most MAX_CHAIN_CALLS calls; largest
 *  saving first. */
export function parallelCandidates(tree: RequestTree, repeats?: RepeatReport, options: Partial<ParallelOptions> = {}): ParallelCandidate[] {
  const o = { ...DEFAULTS, ...options };
  return parallelChains(tree, repeats)
    .filter((c) => c.savedUs >= o.minSavedUs && c.hopIds.length <= o.maxCalls)
    .sort((a, b) => b.savedUs - a.savedUs || a.hopIds[0].localeCompare(b.hopIds[0]));
}

/** Each chained call's candidate, by hop id. */
export function candidatesByHop(candidates: readonly ParallelCandidate[]): Map<HopId, ParallelCandidate> {
  const out = new Map<HopId, ParallelCandidate>();
  for (const c of candidates) for (const id of c.hopIds) out.set(id, c);
  return out;
}

// ---------------------------------------------------------------- words

/** "3 calls from shop-api ran one after another (get redis.internal, get redis.internal, select
 *  orders, 41.0 ms). If they do not depend on each other, running them together could take about
 *  14.0 ms and save 27.0 ms." */
export function parallelSentence(c: ParallelCandidate): string {
  return (
    `${c.hopIds.length} calls from ${c.service} ran one after another (${c.labels.join(", ")}, ${fmtUs(c.serialUs)}). ` +
    `If they do not depend on each other, running them together could take about ${fmtUs(c.parallelUs)} and save ${fmtUs(c.savedUs)}.`
  );
}
