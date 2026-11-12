// What went wrong in a request that did not stop (frame 3's lead sentence, BAC-41 row 4).
// A request can finish "ok" with no gaps and still have failed underneath: calls answered with
// an error, jobs that had to be retried. Counted from the hop records only. Pure.
import { HopDir, Outcome, Via, type Hop, type RequestTree } from "~/lib/hops/types";

/** Calls to one destination, some of which failed. */
export interface FailedCalls {
  /** The service that answered (from the linked inbound hop), else the recorded peer. */
  destination: string;
  failed: number;
  total: number;
  /** Status codes of the failed calls that had one, most frequent first. */
  statuses: number[];
  /** Failed calls with no status (timeouts, connection errors). */
  withoutStatus: number;
}

export interface RetriedJobs {
  /** Jobs that ran more than once (an inbound job hop with attempt above 1). */
  jobs: number;
  /** Extra attempts in all. */
  retries: number;
}

export interface RequestProblems {
  failedCalls: FailedCalls[];
  retried: RetriedJobs | null;
}

/** An outbound call failed: its outcome is error, or it was answered 500 or above. */
export function callFailed(hop: Pick<Hop, "dir" | "outcome" | "status">): boolean {
  return hop.dir === HopDir.Out && (hop.outcome === Outcome.Error || (hop.status !== null && hop.status >= 500));
}

function destinationOf(hop: Hop): string {
  const receiver = hop.children.find((c) => c.dir === HopDir.In);
  return receiver?.service ?? hop.peer ?? hop.op ?? hop.via;
}

export function requestProblems(tree: RequestTree): RequestProblems {
  const byDest = new Map<string, { failed: number; total: number; statuses: Map<number, number>; withoutStatus: number }>();
  for (const h of tree.hops) {
    if (h.dir !== HopDir.Out || h.endMs === null) continue;
    const dest = destinationOf(h);
    const e = byDest.get(dest) ?? { failed: 0, total: 0, statuses: new Map<number, number>(), withoutStatus: 0 };
    e.total += 1;
    if (callFailed(h)) {
      e.failed += 1;
      if (h.status !== null && h.status >= 500) e.statuses.set(h.status, (e.statuses.get(h.status) ?? 0) + 1);
      else if (h.status === null) e.withoutStatus += 1;
    }
    byDest.set(dest, e);
  }
  const failedCalls: FailedCalls[] = [...byDest]
    .filter(([, e]) => e.failed > 0)
    .map(([destination, e]) => ({
      destination,
      failed: e.failed,
      total: e.total,
      statuses: [...e.statuses].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([s]) => s),
      withoutStatus: e.withoutStatus,
    }))
    .sort((a, b) => b.failed - a.failed || a.destination.localeCompare(b.destination));

  // A job retried: inbound job hops with attempt above 1, counted once per job (its parent call).
  const retriedParents = new Map<string, number>();
  for (const h of tree.hops) {
    if (h.dir !== HopDir.In || h.via !== Via.Job || h.attempt === null || h.attempt <= 1) continue;
    const key = h.parentHop ?? h.hopId;
    retriedParents.set(key, (retriedParents.get(key) ?? 0) + 1);
  }
  const retries = [...retriedParents.values()].reduce((a, n) => a + n, 0);
  return { failedCalls, retried: retriedParents.size ? { jobs: retriedParents.size, retries } : null };
}

/** "63 of 90 calls to commerce-payments were answered with an error (500)". */
export function failedCallsSentence(f: FailedCalls): string {
  const calls = f.total === 1 ? "call" : "calls";
  const head = f.failed === f.total ? (f.total === 1 ? `The call to ${f.destination}` : `All ${f.total} ${calls} to ${f.destination}`) : `${f.failed} of ${f.total} ${calls} to ${f.destination}`;
  const verb = f.failed === 1 && f.failed === f.total ? "was" : f.failed === 1 ? "was" : "were";
  if (f.statuses.length && !f.withoutStatus) return `${head} ${verb} answered with an error (${f.statuses.join(", ")}).`;
  if (!f.statuses.length) return `${head} failed without an answer.`;
  return `${head} failed: answered with an error (${f.statuses.join(", ")}) or not answered.`;
}

/** "3 jobs it queued failed and were retried (5 retries)". */
export function retriedSentence(r: RetriedJobs): string {
  const jobs = r.jobs === 1 ? "A job it queued failed and was retried" : `${r.jobs} jobs it queued failed and were retried`;
  return r.retries > r.jobs ? `${jobs} (${r.retries} retries).` : `${jobs}.`;
}
