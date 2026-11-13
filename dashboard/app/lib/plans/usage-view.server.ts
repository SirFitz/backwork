// What the Usage page shows: this month's intake against the plan, and what a Free plan holds now.
import { PLANS, PlanId } from "~/components/site/plans";
import { extraFor, type Extra } from "./extras";
import { isCapped } from "./limits";
import { monthFirstDay, monthUsage, type MonthUsage } from "./month";
import { firstCountedDay, loadDaily, orgLimits } from "./usage.server";
import { loadPlanView, type PlanView } from "./view.server";

const GIB = 1024 ** 3;

export interface UsageView {
  planName: string;
  /** True: the plan keeps a rolling window (its allowance caps what is held, not what arrives in a month). */
  rolling: boolean;
  month: MonthUsage;
  /** What the plan includes each month, when it is billed by use; null otherwise. */
  included: { requests: number; bytes: number } | null;
  /** The cost of what went past the allowance, at the published rates; null when the plan has none. */
  extra: Extra | null;
  /** What a rolling plan holds now. */
  held: PlanView | null;
  /** The first day anything was counted, or null when nothing has been. */
  firstCounted: string | null;
}

/** The Usage page's data, or null for an organisation that is not metered. */
export async function loadUsageView(orgId: string, nowMs: number = Date.now()): Promise<UsageView | null> {
  const limits = await orgLimits(orgId);
  if (!limits) return null;
  const plan = PLANS.find((p) => p.id === (limits.plan as PlanId));
  const rolling = isCapped(limits);
  const [rows, firstCounted, held] = await Promise.all([
    loadDaily(orgId, monthFirstDay(nowMs)),
    firstCountedDay(orgId),
    rolling ? loadPlanView(orgId, nowMs) : Promise.resolve(null),
  ]);
  const month = monthUsage(rows, nowMs);
  const allowance = !rolling && plan?.allowance ? plan.allowance : null;
  return {
    planName: plan?.name ?? String(limits.plan),
    rolling,
    month,
    included: allowance ? { requests: allowance.requestsPerMonth, bytes: Math.round(allowance.logGbPerMonth * GIB) } : null,
    extra: plan && !rolling ? extraFor(plan, month.requests, month.bytes) : null,
    held,
    firstCounted,
  };
}
