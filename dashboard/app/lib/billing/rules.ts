// Pure billing rules: which plan an organisation is on, given its billing row and the time.
// No database, no Inkress.
import { Billing, PlanId, PLANS, priceFor } from "~/components/site/plans";
import { AccountStatus, INKRESS_MONTHLY_CYCLE, TRIAL_DAYS, type BillingRow, type InkressPlan, type PaidPlanId } from "./types";

const DAY_MS = 86_400_000;

export function isPaidPlanId(v: unknown): v is PaidPlanId {
  return v === PlanId.Team || v === PlanId.Business;
}

export function isBilling(v: unknown): v is Billing {
  return v === Billing.Monthly || v === Billing.Yearly;
}

export function trialEnd(from: Date): Date {
  return new Date(from.getTime() + TRIAL_DAYS * DAY_MS);
}

/** An empty billing row for an organisation that has never had a trial or a subscription. */
export function emptyRow(orgId: string): BillingRow {
  return {
    orgId,
    status: AccountStatus.None,
    trialPlan: null,
    trialEndsAt: null,
    plan: null,
    billing: null,
    subscriptionUid: null,
    periodEnd: null,
    pendingPlan: null,
    pendingBilling: null,
    cardOnFile: false,
    cancelAtPeriodEnd: false,
    checkoutReference: null,
    checkoutPlan: null,
    checkoutBilling: null,
  };
}

/**
 * The plan the organisation gets right now.
 * - paid and renewing (active, past due): its paid plan;
 * - cancelled: its paid plan until the paid period ends;
 * - trialing: the trial plan until the trial ends;
 * - otherwise Free.
 */
export function effectivePlan(row: BillingRow, now: Date): PlanId {
  if (row.plan && (row.status === AccountStatus.Active || row.status === AccountStatus.PastDue)) return row.plan;
  if (row.plan && row.status === AccountStatus.Cancelled && row.periodEnd && now < row.periodEnd) return row.plan;
  if (row.status === AccountStatus.Trialing && row.trialPlan && row.trialEndsAt && now < row.trialEndsAt) return row.trialPlan;
  return PlanId.Free;
}

/** Whole days left in a trial, or null when it is not running. */
export function trialDaysLeft(row: BillingRow, now: Date): number | null {
  if (row.status !== AccountStatus.Trialing || !row.trialEndsAt || now >= row.trialEndsAt) return null;
  return Math.ceil((row.trialEndsAt.getTime() - now.getTime()) / DAY_MS);
}

/** A trial that has run out without a subscription (so the row should settle to `none`). */
export function trialExpired(row: BillingRow, now: Date): boolean {
  return row.status === AccountStatus.Trialing && !!row.trialEndsAt && now >= row.trialEndsAt;
}

/** The Inkress plan that sells a backwork plan and cycle, or null. */
export function inkressPlanFor(plans: readonly InkressPlan[], plan: PaidPlanId, billing: Billing): InkressPlan | null {
  return plans.find((p) => p.sells?.plan === plan && p.sells.billing === billing) ?? null;
}

/**
 * Which backwork plan and cycle an Inkress plan sells. Reads the tags we put on its `data`
 * (backwork_plan, backwork_billing); falls back to the plan name ("Team monthly") and its cycle.
 */
export function sellsOf(input: { name: string; billingCycle: number | null; data: Record<string, unknown> | null }): InkressPlan["sells"] {
  const taggedPlan = input.data?.backwork_plan;
  const taggedBilling = input.data?.backwork_billing;
  if (isPaidPlanId(taggedPlan) && isBilling(taggedBilling)) return { plan: taggedPlan, billing: taggedBilling };
  const name = input.name.toLowerCase();
  const plan = name.startsWith("team") ? PlanId.Team : name.startsWith("business") ? PlanId.Business : null;
  if (!plan) return null;
  const billing = input.billingCycle === INKRESS_MONTHLY_CYCLE ? Billing.Monthly : Billing.Yearly;
  return { plan, billing };
}

/** What we show for a plan at a cycle, in major units: the public price list. */
export function listedPrice(plan: PaidPlanId, billing: Billing): number {
  const p = PLANS.find((x) => x.id === plan);
  const price = p ? priceFor(p, billing) : null;
  if (price === null) throw new Error(`plan ${plan} has no price`);
  return price;
}

/** Does Inkress charge what the price list shows? Never send a customer to a different price. */
export function priceMatches(inkress: InkressPlan, plan: PaidPlanId, billing: Billing): boolean {
  return inkress.currency === "USD" && Math.abs(inkress.price - listedPrice(plan, billing)) < 0.005;
}
