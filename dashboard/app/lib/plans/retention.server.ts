// Expiry and the storage cap for metered organisations. Loki holds the data, so this asks it to
// delete: older than the plan's retention, and the oldest hours when an organisation holds more
// than its storage limit. Runs every few hours inside the dashboard; every call is idempotent.
import { billing } from "~/lib/billing/index.server";
import { ne } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { orgs } from "~/db/schema";
import { config } from "~/lib/config.server";
import { limitsFor, type Limits } from "./limits";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const RUN_EVERY_MS = 6 * HOUR_MS;
const FIRST_RUN_AFTER_MS = 2 * 60_000;
/** The stack's longest retention is 30 days, so older data cannot exist (and Loki refuses queries longer than 721 h). */
const LOOKBACK_MS = 30 * DAY_MS;
/** Trim down to this share of the cap, so the next hours of ingest do not trip it again at once. */
const CAP_TARGET = 0.9;
/** Granularity of the storage walk: the cap is met to within this much of the newest data. */
const BUCKET_SECONDS = 6 * 3600;

export interface VolumePoint {
  tsMs: number;
  bytes: number;
}

/** The two things this job needs from Loki. */
export interface LokiOps {
  /** Stored bytes per `stepSeconds` bucket for a LogQL stream selector, oldest first. */
  volume(query: string, startMs: number, endMs: number, stepSeconds: number): Promise<VolumePoint[]>;
  /** Ask the compactor to delete a stream's lines between two unix-second times. */
  remove(query: string, startSeconds: number, endSeconds: number): Promise<void>;
}

/** Unix seconds of "now minus days", rounded down to the hour so repeated runs ask for the same thing. */
export function expiryEnd(nowMs: number, days: number): number {
  return Math.floor((nowMs - days * DAY_MS) / HOUR_MS) * 3600;
}

/**
 * Where to cut so what remains fits the cap: the start of the oldest bucket to keep, in ms, or null
 * when everything already fits. Keeps the newest buckets whose total stays within CAP_TARGET x cap.
 */
export function capCutoff(points: readonly VolumePoint[], capBytes: number): number | null {
  const total = points.reduce((n, p) => n + p.bytes, 0);
  if (total <= capBytes) return null;
  const newestFirst = [...points].sort((a, b) => b.tsMs - a.tsMs);
  let kept = 0;
  let cutoff = newestFirst[0].tsMs;
  for (const p of newestFirst) {
    if (kept + p.bytes > capBytes * CAP_TARGET) break;
    kept += p.bytes;
    cutoff = p.tsMs;
  }
  return cutoff;
}

const selector = (orgId: string, kind?: "hop" | "log"): string => `{org_id="${orgId}"${kind ? `,kind="${kind}"` : ""}}`;

export interface PurgeReport {
  orgId: string;
  expired: string[];
  capCutoffMs: number | null;
}

/** Expire by age, then trim to the storage cap, for one organisation. */
export async function purgeOrg(orgId: string, limits: Limits, loki: LokiOps, nowMs: number): Promise<PurgeReport> {
  // Rounded to the day so a repeat run asks for the same range and Loki sees a duplicate, not a new request.
  const startS = Math.floor((nowMs - LOOKBACK_MS) / DAY_MS) * 86400;
  const expired: string[] = [];
  const ages: Array<["hop" | "log", number | null]> = [["hop", limits.hopDays], ["log", limits.logDays]];
  for (const [kind, days] of ages) {
    if (days === null) continue;
    await loki.remove(selector(orgId, kind), startS, expiryEnd(nowMs, days));
    expired.push(`${kind}:${days}d`);
  }
  let cut: number | null = null;
  if (limits.storageBytes !== null) {
    // One cheap total first; the bucket walk (about 140 index reads) only when over the cap.
    const total = (await loki.volume(selector(orgId), nowMs - LOOKBACK_MS, nowMs, LOOKBACK_MS / 1000)).reduce((n, p) => n + p.bytes, 0);
    if (total > limits.storageBytes) {
      cut = capCutoff(await loki.volume(selector(orgId), nowMs - LOOKBACK_MS, nowMs, BUCKET_SECONDS), limits.storageBytes);
      if (cut !== null) await loki.remove(selector(orgId), startS, Math.floor(cut / 1000));
    }
  }
  return { orgId, expired, capCutoffMs: cut };
}

// ---- Loki over HTTP -------------------------------------------------------------------------

function isVector(v: unknown): v is { data: { result: Array<{ value: [number, string] }> } } {
  const d = (v as { data?: { result?: unknown } } | null)?.data;
  return Array.isArray(d?.result);
}

/** Loki's volume_range does not bucket on every build, so read the instant volume one slice at a time. */
async function sliceVolume(query: string, startMs: number, endMs: number): Promise<number> {
  const qs = new URLSearchParams({ query, start: String(Math.floor(startMs * 1e6)), end: String(Math.floor(endMs * 1e6)) });
  const res = await fetch(`${config.lokiUrl}/loki/api/v1/index/volume?${qs}`);
  if (!res.ok) throw new Error(`loki volume ${res.status}`);
  const body: unknown = await res.json();
  if (!isVector(body)) return 0;
  return body.data.result.reduce((n, r) => n + Number(r.value[1]), 0);
}

export const lokiOps: LokiOps = {
  async volume(query, startMs, endMs, stepSeconds) {
    const out: VolumePoint[] = [];
    const step = Math.max(1, Math.round(stepSeconds)) * 1000;
    for (let t = startMs; t < endMs; t += step) out.push({ tsMs: t, bytes: await sliceVolume(query, t, Math.min(t + step, endMs)) });
    return out;
  },
  async remove(query, startSeconds, endSeconds) {
    if (endSeconds <= startSeconds) return;
    const qs = new URLSearchParams({ query, start: String(startSeconds), end: String(endSeconds) });
    const res = await fetch(`${config.lokiUrl}/loki/api/v1/delete?${qs}`, { method: "POST" });
    // Asking again for a range already queued is not a failure.
    if (!res.ok && res.status !== 400) throw new Error(`loki delete ${res.status}`);
  },
};

// ---- the schedule ---------------------------------------------------------------------------

/** Purge every metered organisation. One organisation failing does not stop the rest. */
export async function runPlanRetention(loki: LokiOps = lokiOps, nowMs: number = Date.now()): Promise<PurgeReport[]> {
  await ensureSchema();
  const rows = await db
    .select({ id: orgs.id, plan: orgs.plan, requestsLimit: orgs.requestsLimit, storageLimitBytes: orgs.storageLimitBytes })
    .from(orgs)
    .where(ne(orgs.plan, "unmetered"));
  const reports: PurgeReport[] = [];
  for (const r of rows) {
    const limits = limitsFor(r);
    if (!limits) continue;
    try {
      const report = await purgeOrg(r.id, limits, loki, nowMs);
      reports.push(report);
      console.log(JSON.stringify({ msg: "plan retention", ...report }));
    } catch (e: unknown) {
      console.error(JSON.stringify({ msg: "plan retention failed", orgId: r.id, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return reports;
}

declare global {
  // eslint-disable-next-line no-var
  var __bwPlanJobs: boolean | undefined;
}

/** Start the schedule once per process. Safe to call on every request. */
export function startPlanJobs(): void {
  if (globalThis.__bwPlanJobs) return;
  globalThis.__bwPlanJobs = true;
  const run = (): void => {
    void runPlanRetention().catch((e: unknown) => console.error("plan retention", e));
    // Trials that ran out go back to Free (BAC-57).
    void billing().settleTrials().catch((e: unknown) => console.error("billing: settle trials", e));
  };
  setTimeout(run, FIRST_RUN_AFTER_MS).unref();
  setInterval(run, RUN_EVERY_MS).unref();
}
