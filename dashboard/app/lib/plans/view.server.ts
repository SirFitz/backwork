// What the Settings page shows about the organisation's plan and what it holds.
import { PLANS } from "~/components/site/plans";
import { isCapped, type Limits } from "./limits";
import { bucketsSince, loadBuckets, orgLimits } from "./usage.server";

export interface PlanView {
  name: string;
  /** True: the organisation keeps a rolling window and the oldest data is dropped as new arrives. */
  rolling: boolean;
  requests: { held: number; cap: number | null };
  bytes: { held: number; cap: number | null };
  /** Unix seconds of the oldest data still counted, or null when nothing is counted yet. */
  since: number | null;
  hopDays: number | null;
  logDays: number | null;
}

function nameOf(l: Limits): string {
  return PLANS.find((p) => p.id === l.plan)?.name ?? l.plan;
}

/** The plan card, or null for an organisation with no limits (nothing to show). */
export async function loadPlanView(orgId: string, nowMs: number = Date.now()): Promise<PlanView | null> {
  const limits = await orgLimits(orgId);
  if (!limits) return null;
  const buckets = isCapped(limits) ? await loadBuckets(orgId, bucketsSince(nowMs)) : [];
  return {
    name: nameOf(limits),
    rolling: isCapped(limits),
    requests: { held: buckets.reduce((n, b) => n + b.requests, 0), cap: limits.maxRequests },
    bytes: { held: buckets.reduce((n, b) => n + b.bytes, 0), cap: limits.maxBytes },
    since: buckets.length ? buckets[0].startS : null,
    hopDays: limits.hopDays,
    logDays: limits.logDays,
  };
}
