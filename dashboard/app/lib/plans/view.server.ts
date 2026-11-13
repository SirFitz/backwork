// What the Settings page shows about the organisation's plan and this month's usage.
import { PLANS } from "~/components/site/plans";
import { currentPeriod, pausedReason, type Limits, type PausedBecause } from "./limits";
import { orgLimits, orgUsageNow } from "./usage.server";

export interface PlanView {
  name: string;
  period: string;
  requests: { used: number; limit: number | null };
  bytes: { used: number; limit: number | null };
  paused: PausedBecause | null;
  /** Free pauses at the limit; paid plans carry on and bill the extra. */
  pausesAtLimit: boolean;
  hopDays: number | null;
  logDays: number | null;
}

function nameOf(l: Limits): string {
  return PLANS.find((p) => p.id === l.plan)?.name ?? l.plan;
}

/** The plan card, or null for an unmetered organisation (nothing to show). */
export async function loadPlanView(orgId: string): Promise<PlanView | null> {
  const limits = await orgLimits(orgId);
  if (!limits) return null;
  const period = currentPeriod();
  const usage = await orgUsageNow(orgId, period);
  return {
    name: nameOf(limits),
    period,
    requests: { used: usage.requests, limit: limits.requestsPerMonth },
    bytes: { used: usage.bytes, limit: limits.storageBytes },
    paused: pausedReason(limits, usage),
    pausesAtLimit: limits.pauseAtLimit,
    hopDays: limits.hopDays,
    logDays: limits.logDays,
  };
}
