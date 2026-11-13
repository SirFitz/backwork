// Keeps limited organisations inside their plan. Loki holds the data, so this asks it to delete:
// anything older than the plan's retention, and, for an organisation with a rolling window, everything
// older than the point that leaves its newest `maxRequests` requests and `maxBytes` of data
// (lib/plans/window.ts). Collection never stops; the oldest data is what goes. Runs every few
// minutes inside the dashboard, and every call is safe to repeat.
import { ne } from "drizzle-orm";
import { billing } from "~/lib/billing/index.server";
import { db, ensureSchema } from "~/db/index.server";
import { orgs } from "~/db/schema";
import { config } from "~/lib/config.server";
import { isCapped, limitsFor, type Limits } from "./limits";
import { bucketsSince, loadBuckets, pruneBuckets } from "./usage.server";
import { windowCutoff, type Bucket } from "./window";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TRIM_EVERY_MS = 10 * 60_000;
const TRIALS_EVERY_MS = 6 * HOUR_MS;
const FIRST_RUN_AFTER_MS = 2 * 60_000;
/** The stack's longest retention is 30 days, so older data cannot exist (and Loki refuses queries longer than 721 h). */
const LOOKBACK_MS = 30 * DAY_MS;
/** A repeat run re-asks for this much before the last cut, in case a delete was lost. */
const OVERLAP_S = 2 * 3600;

/** The one thing this job needs from Loki. */
export interface LokiOps {
  /** Ask the compactor to delete a stream's lines between two unix-second times. */
  remove(query: string, startSeconds: number, endSeconds: number): Promise<void>;
}

/** The counters this job reads and forgets. */
export interface BucketStore {
  load(orgId: string, sinceS: number): Promise<Bucket[]>;
  prune(orgId: string, beforeS: number): Promise<void>;
}

/** Unix seconds of "now minus days", rounded down to the hour so repeated runs ask for the same thing. */
export function expiryEnd(nowMs: number, days: number): number {
  return Math.floor((nowMs - days * DAY_MS) / HOUR_MS) * 3600;
}

const selector = (orgId: string, kind?: "hop" | "log"): string => `{org_id="${orgId}"${kind ? `,kind="${kind}"` : ""}}`;

export interface TrimReport {
  orgId: string;
  expired: string[];
  /** Unix seconds: everything older was deleted. Null when the window fits. */
  cutoffS: number | null;
}

/** Delete a limited organisation's expired data and anything outside its rolling window. */
export async function trimOrg(
  orgId: string,
  limits: Limits,
  loki: LokiOps,
  store: BucketStore,
  nowMs: number,
  lastCutS: Map<string, number> = new Map(),
): Promise<TrimReport> {
  // Rounded to the day so a repeat run asks for the same range and Loki sees a duplicate, not a new request.
  const fullStartS = Math.floor((nowMs - LOOKBACK_MS) / DAY_MS) * 86400;
  const expired: string[] = [];
  const ages: Array<["hop" | "log", number | null]> = [["hop", limits.hopDays], ["log", limits.logDays]];
  for (const [kind, days] of ages) {
    if (days === null) continue;
    await loki.remove(selector(orgId, kind), fullStartS, expiryEnd(nowMs, days));
    expired.push(`${kind}:${days}d`);
  }
  let cutoffS: number | null = null;
  if (isCapped(limits)) {
    const buckets = await store.load(orgId, bucketsSince(nowMs));
    cutoffS = windowCutoff(buckets, limits.maxRequests, limits.maxBytes);
    if (cutoffS !== null) {
      // The first cut after a restart sweeps the whole lookback (data older than the counters is still there);
      // later cuts only need the stretch since the last one.
      const previous = lastCutS.get(orgId);
      const startS = previous === undefined ? fullStartS : Math.max(fullStartS, previous - OVERLAP_S);
      await loki.remove(selector(orgId), startS, cutoffS);
      lastCutS.set(orgId, cutoffS);
      await store.prune(orgId, cutoffS);
    }
  }
  return { orgId, expired, cutoffS };
}

// ---- Loki over HTTP -------------------------------------------------------------------------

export const lokiOps: LokiOps = {
  async remove(query, startSeconds, endSeconds) {
    if (endSeconds <= startSeconds) return;
    const qs = new URLSearchParams({ query, start: String(startSeconds), end: String(endSeconds) });
    const res = await fetch(`${config.lokiUrl}/loki/api/v1/delete?${qs}`, { method: "POST" });
    // Asking again for a range already queued is not a failure.
    if (!res.ok && res.status !== 400) throw new Error(`loki delete ${res.status}`);
  },
};

const dbStore: BucketStore = { load: loadBuckets, prune: pruneBuckets };
const lastCut = new Map<string, number>();

// ---- the schedule ---------------------------------------------------------------------------

/** Trim every limited organisation. One organisation failing does not stop the rest. */
export async function runPlanTrim(loki: LokiOps = lokiOps, store: BucketStore = dbStore, nowMs: number = Date.now()): Promise<TrimReport[]> {
  await ensureSchema();
  const rows = await db
    .select({ id: orgs.id, plan: orgs.plan, requestsLimit: orgs.requestsLimit, storageLimitBytes: orgs.storageLimitBytes })
    .from(orgs)
    .where(ne(orgs.plan, "unmetered"));
  const reports: TrimReport[] = [];
  for (const r of rows) {
    const limits = limitsFor(r);
    if (!limits) continue;
    try {
      const report = await trimOrg(r.id, limits, loki, store, nowMs, lastCut);
      reports.push(report);
      if (report.cutoffS !== null) console.log(JSON.stringify({ msg: "plan trim", ...report }));
    } catch (e: unknown) {
      console.error(JSON.stringify({ msg: "plan trim failed", orgId: r.id, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return reports;
}

declare global {
  // eslint-disable-next-line no-var
  var __bwPlanJobs: boolean | undefined;
}

/** Start the schedules once per process. Safe to call on every request. */
export function startPlanJobs(): void {
  if (globalThis.__bwPlanJobs) return;
  globalThis.__bwPlanJobs = true;
  const trim = (): void => void runPlanTrim().catch((e: unknown) => console.error("plan trim", e));
  // Trials that ran out go back to Free (BAC-57).
  const trials = (): void => void billing().settleTrials().catch((e: unknown) => console.error("billing: settle trials", e));
  setTimeout(trim, FIRST_RUN_AFTER_MS).unref();
  setTimeout(trials, FIRST_RUN_AFTER_MS).unref();
  setInterval(trim, TRIM_EVERY_MS).unref();
  setInterval(trials, TRIALS_EVERY_MS).unref();
}
