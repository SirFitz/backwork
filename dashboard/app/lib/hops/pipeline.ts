// A redis MULTI block as one call (BAC-63). Pure.
//
// Cache adapters write one record per command, MULTI and EXEC included (ioredis: "pipelines and
// multi count one hop per command"). The block is sent in one write and every command settles when
// its replies arrive, so the records share one window and near-identical durations. Drawn one by
// one they read as five calls of the same length, and the request's totals, the table and the time
// split stop agreeing. The block becomes one hop spanning the first command's start to the last
// one's end, its commands listed on it.
//
// Plain pipelines (no MULTI) leave no marker in the records and are left as recorded.
import { BlockOp, HopState, Outcome, Via, type Hop } from "./types";

/** Log times are whole milliseconds: the commands of one block land within this of each other. */
const SLACK_MS = 1;

const CLOSERS: readonly string[] = [BlockOp.Exec, BlockOp.Discard];

function isCommand(h: Hop): boolean {
  return h.isStore && h.via === Via.Cache && h.children.length === 0 && h.state === HopState.Finished && h.endMs !== null;
}

/** Same client: the commands of one block share service, adapter and server. */
function sameClient(a: Hop, b: Hop): boolean {
  return a.service === b.service && a.adapter === b.adapter && a.peer === b.peer;
}

function end(h: Hop): number {
  return h.endMs as number;
}

/** The commands that belong to `multi`'s block, MULTI first and the closer last; null when it has no closer. */
function blockOf(multi: Hop, pool: readonly Hop[]): Hop[] | null {
  const closer = pool
    .filter((h) => h !== multi && CLOSERS.includes(h.op ?? "") && sameClient(h, multi) && end(h) >= end(multi) - SLACK_MS)
    .sort((a, b) => end(a) - end(b))[0];
  if (!closer) return null;
  const inside = pool.filter((h) =>
    h !== multi && h !== closer && sameClient(h, multi)
    && h.op !== BlockOp.Multi && !CLOSERS.includes(h.op ?? "")
    && h.startMs >= multi.startMs - SLACK_MS
    && end(h) >= end(multi) - SLACK_MS && end(h) <= end(closer) + SLACK_MS);
  // Replies come back in command order; equal times keep start order.
  inside.sort((a, b) => end(a) - end(b) || a.startMs - b.startMs);
  return [multi, ...inside, closer];
}

/** One hop for the whole block. */
function mergeBlock(cmds: readonly Hop[]): Hop {
  const first = cmds[0];
  const startMs = Math.min(...cmds.map((c) => c.startMs));
  const endMs = Math.max(...cmds.map(end));
  const failed = cmds.find((c) => c.outcome === Outcome.Error);
  return {
    ...first,
    op: BlockOp.Multi,
    startMs,
    endMs,
    durationUs: Math.round((endMs - startMs) * 1000),
    outcome: failed ? Outcome.Error : first.outcome,
    error: failed?.error ?? null,
    handoff: cmds.some((c) => c.handoff),
    skewMs: Math.max(...cmds.map((c) => c.skewMs)),
    linkedIds: cmds.flatMap((c) => c.linkedIds),
    pipeline: { ops: cmds.map((c) => c.op ?? ""), commandUs: cmds.reduce((a, c) => a + (c.durationUs ?? 0), 0) },
    children: [],
  };
}

/**
 * Replace each MULTI block among `parent`'s children with one hop. Children stay in start order.
 * Returns the command hops that were folded away, for the caller's indexes.
 */
export function collapsePipelines(parent: Hop): Hop[] {
  let pool = parent.children.filter(isCommand);
  if (!pool.some((h) => h.op === BlockOp.Multi)) return [];
  const replaced = new Map<Hop, Hop | null>();
  const multis = pool.filter((h) => h.op === BlockOp.Multi).sort((a, b) => a.startMs - b.startMs);
  for (const multi of multis) {
    if (!pool.includes(multi)) continue;
    const cmds = blockOf(multi, pool);
    if (!cmds) continue;
    const merged = mergeBlock(cmds);
    for (const c of cmds) replaced.set(c, c === multi ? merged : null);
    pool = pool.filter((h) => !cmds.includes(h));
  }
  if (!replaced.size) return [];
  const folded: Hop[] = [];
  const kids: Hop[] = [];
  for (const c of parent.children) {
    if (!replaced.has(c)) kids.push(c);
    else {
      folded.push(c);
      const merged = replaced.get(c);
      if (merged) kids.push(merged);
    }
  }
  parent.children = kids.sort((a, b) => a.startMs - b.startMs || a.hopId.localeCompare(b.hopId));
  return folded;
}

/** How many command records a hop stands for: a block's commands, else one. */
export function commandCount(h: Hop): number {
  return h.pipeline ? h.pipeline.ops.length : 1;
}

/** The commands' own durations added up (what the request's totals counted for this hop). */
export function commandUs(h: Hop): number {
  return h.pipeline ? h.pipeline.commandUs : h.durationUs ?? 0;
}
