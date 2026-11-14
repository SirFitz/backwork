/**
 * "Why was this slow?" (BAC-70): one plain sentence naming where a request's time went, so nobody
 * has to read the Path card to find out. Built from hop records only (never log lines), so the
 * request view's two tree builds (before and after the logs arrive) give the same verdict. Pure:
 * it runs in the browser on every request view and is tested with plain objects. Feature 8
 * (request diff) reuses it.
 *
 * Rules, first match wins (docs/insights/03-why-slow.md, "As built" for what changed):
 * 1. No head hop, or the head is open or stalled: Unknown.
 * 2. The head failed: Failed (the red Alert box explains; no verdict line).
 * 3. A repeat group (BAC-68) takes CULPRIT_SHARE of the head's time: RepeatedCalls.
 * 4. One database or cache call does: SlowCall.
 * 5. Waiting on other services takes WAITING_SHARE: Waiting, naming the longest destination.
 * 6. One call to another service takes CULPRIT_SHARE: SlowCall.
 * 7. The service's own code takes OWN_SHARE: OwnTime.
 * 8. Otherwise Fast. A request under FAST_US is Fast too unless rules 3 to 6 name a culprit that
 *    took at least FAST_MIN_CULPRIT_US: own time on a fast request is no news.
 * A shown verdict gains "waiting for a database connection" when the request's database calls
 * report a wait of at least DB_WAIT_SHARE of their time (BAC-79, `cache-pool.ts`).
 *
 * Shares are of the head hop's duration and use wall-clock time, so overlapping calls never make a
 * share pass 100 percent; summed call time is only ever named as "call time". Calls that ran
 * together count their union (clipped to the head); calls that ran one after another count their
 * summed time, because stored end times are written in bursts and their intervals can look
 * overlapped (BAC-68 "As built"). Own code is the head's time less its calls' summed time when they
 * fit inside it, for the same reason.
 */
import { headHop, isFailed, lengthUs, mergeIntervals, timeSplit, type IntervalMs } from "./tree";
import { Repetition, type RepeatGroup, type RepeatReport } from "./repeated";
import { storeLabel } from "./store-label";
import { fmtUs } from "./time-format";
import { connectionWait, connectionWaitClause } from "./cache-pool";
import { HopDir, HopState, type Hop, type HopId, type RequestTree } from "./types";

// ---------------------------------------------------------------- fixed values

export const VerdictKind = {
  /** One repeat group dominates. */
  RepeatedCalls: "repeated_calls",
  /** A single call dominates. */
  SlowCall: "slow_call",
  /** Time spent waiting on other services. */
  Waiting: "waiting",
  /** The service itself (its own code). */
  OwnTime: "own_time",
  /** The request failed: the Alert box explains it, no verdict line. */
  Failed: "failed",
  /** Nothing stands out: no verdict line. */
  Fast: "fast",
  /** Open or stalled: there is no timing to explain yet. */
  Unknown: "unknown",
} as const;
export type VerdictKind = (typeof VerdictKind)[keyof typeof VerdictKind];

/** A request shorter than this, in microseconds, is fast: it gets a verdict only for a clear culprit. */
export const FAST_US = 200_000;
/** On a fast request, the culprit must have taken at least this long, microseconds, to be named. */
export const FAST_MIN_CULPRIT_US = 10_000;
/** A repeat group or a single call taking at least this share of the head's time is the culprit. */
export const CULPRIT_SHARE = 0.4;
/** Waiting on other services is the verdict from this share of the head's time. */
export const WAITING_SHARE = 0.5;
/** The service's own code is the verdict from this share of the head's time. */
export const OWN_SHARE = 0.5;
/** The second sentence names the next contributor only above this share. */
export const DETAIL_MIN_SHARE = 0.15;
/** A hop on the culprit's path (its callers, and the service that answered it) shifted by more than
 *  this, milliseconds, adds the clock note. */
export const SKEW_NOTE_MS = 50;

export const TRUNCATED_NOTE = "Some records were not loaded, so this may understate it.";
export const SKEW_NOTE = "Timings across services may be off by a few milliseconds.";
export const UNFINISHED_SENTENCE = "This request has not finished, so there is no timing to explain yet.";

// ---------------------------------------------------------------- types

export interface Verdict {
  kind: VerdictKind;
  /** Plain English with units; empty for Failed and Fast. */
  sentence: string;
  /** The hop, or the first call of a group, to open and scroll to. */
  culpritHopId: HopId | null;
  /** 0..1 of the head hop's time. */
  share: number;
  /** A second sentence: the next biggest contributor, or null. */
  detail: string | null;
}

/** One thing the head's time went on, for the culprit and the "next biggest" clause. */
interface Contributor {
  key: string;
  us: number;
  hopId: HopId | null;
  /** "select plans, 14 times" / "waiting on commerce-risk". */
  name: string;
  /** Repeat-group clause carries its own count, so it omits the duration. */
  showUs: boolean;
}

// ---------------------------------------------------------------- helpers

/** Percent, whole, between 0 and 100. */
function pct(share: number): number {
  return Math.min(100, Math.max(0, Math.round(share * 100)));
}

/** The hops that are request time: the head and everything under it not made in the background
 *  or after the response. */
function onPath(head: Hop): Hop[] {
  const out: Hop[] = [];
  const stack: Hop[] = [head];
  while (stack.length) {
    const h = stack.pop() as Hop;
    out.push(h);
    for (const c of h.children) if (!c.handoff && !c.afterResponse) stack.push(c);
  }
  return out;
}

/** Who answered an outbound call: the receiving service, else the recorded peer. */
function destinationOf(hop: Hop): string {
  const receiver = hop.children.find((c) => c.dir === HopDir.In);
  return receiver?.service ?? hop.peer ?? hop.op ?? hop.via;
}

function clippedUs(hops: readonly Hop[], startMs: number, endMs: number): number {
  const iv = hops.map((h): IntervalMs => [Math.max(h.startMs, startMs), Math.min(h.endMs ?? h.startMs, endMs)]);
  return lengthUs(mergeIntervals(iv));
}

function groupName(g: RepeatGroup): string {
  const n = `${g.atLeast ? "at least " : ""}${g.count} times`;
  return `${g.label}, ${n}`;
}

function callName(h: Hop, head: Hop): string {
  const label = storeLabel(h);
  return h.service === head.service ? label : `${label} in ${h.service}`;
}

function clause(c: Contributor, headUs: number): string {
  const share = `${pct(c.us / headUs)} percent`;
  return c.showUs ? `${c.name} (${share}, ${fmtUs(c.us)})` : `${c.name} (${share})`;
}

function skewed(culprit: HopId | null, tree: RequestTree): boolean {
  if (!culprit) return false;
  const byId = new Map<string, Hop>();
  for (const h of tree.hops) if (!byId.has(h.hopId)) byId.set(h.hopId, h);
  let h = byId.get(culprit);
  // The service that answered a call is on its path too: its clock is the one that may differ.
  if (h?.children.some((c) => c.dir === HopDir.In && Math.abs(c.skewMs) > SKEW_NOTE_MS)) return true;
  const seen = new Set<string>();
  while (h && !seen.has(h.hopId)) {
    if (Math.abs(h.skewMs) > SKEW_NOTE_MS) return true;
    seen.add(h.hopId);
    h = h.parentHop ? byId.get(h.parentHop) : undefined;
  }
  return false;
}

const quiet = (kind: VerdictKind): Verdict => ({ kind, sentence: "", culpritHopId: null, share: 0, detail: null });

// ---------------------------------------------------------------- the verdict

/**
 * Where one request's time went. `repeats` is `detectRepeats(tree, truncated)` for the same tree;
 * its `truncated` flag adds the "may understate it" note.
 */
export function whyItWasSlow(tree: RequestTree, repeats: RepeatReport, now: number): Verdict {
  const head = headHop(tree);
  if (!head || head.state !== HopState.Finished || head.durationUs === null || head.endMs === null) {
    return { kind: VerdictKind.Unknown, sentence: UNFINISHED_SENTENCE, culpritHopId: null, share: 0, detail: null };
  }
  if (isFailed(head)) return quiet(VerdictKind.Failed);
  const headUs = head.durationUs;
  if (headUs <= 0) return quiet(VerdictKind.Fast);
  const startMs = head.startMs;
  const endMs = head.startMs + headUs / 1000;
  const split = timeSplit(head, now);
  const path = onPath(head);
  const pathIds = new Set<string>(path.map((h) => h.hopId));

  // Repeat groups made on the request path, by wall-clock time.
  const byId = new Map<string, Hop>();
  for (const h of path) byId.set(h.hopId, h);
  const groups = repeats.groups.filter((g) => pathIds.has(g.parentHopId));
  const grouped = new Set<string>();
  const groupC: Array<Contributor & { group: RepeatGroup }> = groups.map((g) => {
    for (const id of g.hopIds) grouped.add(id);
    // Calls that ran one after another took their summed time (stored end times come in bursts,
    // so their intervals can look overlapped); calls that ran together took their union.
    const members = g.hopIds.map((id) => byId.get(id)).filter((h): h is Hop => h !== undefined);
    const us = g.repetition === Repetition.Sequential ? Math.min(g.totalUs, headUs) : clippedUs(members, startMs, endMs);
    return { key: `group:${g.key}`, us, hopId: g.hopIds[0] ?? null, name: groupName(g), showUs: false, group: g };
  });
  // Single database and cache calls not already in a group.
  const storeC: Contributor[] = path
    .filter((h) => h.isStore && h !== head && !grouped.has(h.hopId))
    .map((h) => ({ key: `call:${h.hopId}`, us: clippedUs([h], startMs, endMs), hopId: h.hopId, name: callName(h, head), showUs: true }));
  // Calls to other services the head made, by destination.
  const outCalls = head.children.filter((c) => c.dir === HopDir.Out && !c.isStore && !c.handoff && !c.afterResponse && c.endMs !== null);
  const byDest = new Map<string, Hop[]>();
  for (const c of outCalls) {
    const d = destinationOf(c);
    const list = byDest.get(d);
    if (list) list.push(c);
    else byDest.set(d, [c]);
  }
  const destC: Contributor[] = [...byDest].map(([d, calls]) => {
    const longest = calls.reduce((a, c) => ((c.durationUs ?? 0) > (a.durationUs ?? 0) ? c : a));
    return { key: `dest:${d}`, us: clippedUs(calls, startMs, endMs), hopId: longest.hopId, name: `waiting on ${d}`, showUs: true };
  });
  // Own code: the head's time less its calls' summed time when those fit inside it, else the split's
  // union-based figure (which bursty end times inflate when calls ran one after another).
  const callSumUs = split.dbSumUs + split.cacheSumUs + split.waitingUs;
  const ownUs = callSumUs <= headUs ? Math.min(split.ownUs, headUs - callSumUs) : split.ownUs;
  const ownC: Contributor = { key: "own", us: ownUs, hopId: head.hopId, name: `${head.service}'s own code`, showUs: true };

  const biggest = <T extends Contributor>(list: readonly T[]): T | null =>
    list.reduce<T | null>((a, c) => (a === null || c.us > a.us || (c.us === a.us && c.key < a.key) ? c : a), null);
  const share = (us: number): number => Math.min(1, us / headUs);

  let kind: VerdictKind = VerdictKind.Fast;
  let culprit: Contributor | null = null;
  let sentence = "";
  let excluded = new Set<string>();
  const total = fmtUs(headUs);

  const topGroup = biggest(groupC);
  const topStore = biggest(storeC);
  const topDest = biggest(destC);
  if (topGroup && share(topGroup.us) >= CULPRIT_SHARE) {
    const g = topGroup.group;
    const how = g.repetition === Repetition.Sequential ? "one after another" : "together";
    const spent = g.repetition === Repetition.Sequential ? `${fmtUs(g.totalUs)} in all` : `${fmtUs(g.totalUs)} of call time`;
    kind = VerdictKind.RepeatedCalls;
    culprit = topGroup;
    sentence = `${pct(share(topGroup.us))} percent of the ${total} went on ${g.label}, run ${g.atLeast ? "at least " : ""}${g.count} times ${how} (${spent}).`;
    excluded = new Set([topGroup.key]);
  } else if (topStore && share(topStore.us) >= CULPRIT_SHARE) {
    kind = VerdictKind.SlowCall;
    culprit = topStore;
    sentence = `One call took ${pct(share(topStore.us))} percent of the ${total}: ${topStore.name}, ${fmtUs(topStore.us)}.`;
    excluded = new Set([topStore.key]);
  } else if (topDest && share(split.waitingUs) >= WAITING_SHARE) {
    kind = VerdictKind.Waiting;
    culprit = { ...topDest, us: split.waitingUs };
    const lead = `${pct(share(split.waitingUs))} percent of the ${total} was spent waiting on`;
    const name = topDest.name.slice("waiting on ".length);
    sentence = destC.length === 1
      ? `${lead} ${name} (${fmtUs(topDest.us)}).`
      : `${lead} other services, the longest on ${name} (${fmtUs(topDest.us)}).`;
    excluded = new Set(destC.map((c) => c.key));
  } else if (topDest && share(topDest.us) >= CULPRIT_SHARE) {
    kind = VerdictKind.SlowCall;
    culprit = topDest;
    const name = topDest.name.slice("waiting on ".length);
    sentence = `One call took ${pct(share(topDest.us))} percent of the ${total}: ${name}, ${fmtUs(topDest.us)}.`;
    excluded = new Set([topDest.key]);
  } else if (share(ownUs) >= OWN_SHARE) {
    kind = VerdictKind.OwnTime;
    culprit = ownC;
    sentence = `Most of the ${total} (${pct(share(ownUs))} percent, ${fmtUs(ownUs)}) was spent inside ${head.service} itself, not waiting on anything.`;
    excluded = new Set([ownC.key]);
  }

  if (!culprit) return quiet(VerdictKind.Fast);
  if (headUs < FAST_US && (kind === VerdictKind.OwnTime || culprit.us < FAST_MIN_CULPRIT_US)) return quiet(VerdictKind.Fast);

  const rest = [...groupC, ...storeC, ...destC, ownC].filter((c) => !excluded.has(c.key) && share(c.us) > DETAIL_MIN_SHARE);
  const next = biggest(rest);
  const notes: string[] = [];
  // BAC-79: database calls that report a connection wait (proposed HOP-26) say how much of their
  // time was waiting, once that is at least DB_WAIT_SHARE of it.
  const waitClause = connectionWaitClause(connectionWait(path));
  if (waitClause) notes.push(waitClause);
  if (repeats.truncated) notes.push(TRUNCATED_NOTE);
  if (skewed(culprit.hopId, tree)) notes.push(SKEW_NOTE);
  return {
    kind,
    sentence: [sentence, ...notes].join(" "),
    culpritHopId: culprit.hopId,
    share: share(culprit.us),
    detail: next ? `The next biggest is ${clause(next, headUs)}.` : null,
  };
}

/** The request view shows a line for these kinds only. */
export function verdictShown(v: Verdict): boolean {
  return v.kind !== VerdictKind.Fast && v.kind !== VerdictKind.Failed && v.sentence !== "";
}
