// Billing for organisations (BAC-57). One organisation = one customer of the `backwork` Inkress
// merchant, with at most one subscription. The no-card trial, the hosted checkout, plan changes,
// cancelling, the card-update link, and "look again at Inkress" (reconcile) that webhooks and
// page loads both call. Dependencies come in as parameters so the rules are testable.
import { ulid } from "ulid";
import { Billing, PlanId } from "~/components/site/plans";
import { UNMETERED } from "~/lib/plans/limits";
import type { InkressBilling } from "./inkress.server";
import { effectivePlan, emptyRow, inkressPlanFor, priceMatches, trialEnd, trialExpired } from "./rules";
import type { BillingStore } from "./store.server";
import {
  AccountStatus,
  InkressOrderStatus,
  InkressSubscriptionStatus,
  type BillingRow,
  type Customer,
  type InkressPeriod,
  type InkressPlan,
  type PaidPlanId,
} from "./types";

/** Why a billing action was refused, in words the owner can read. */
export class BillingRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingRefusal";
  }
}

export interface BillingDeps {
  inkress: InkressBilling;
  store: BillingStore;
  now: () => Date;
  /** False when the Inkress keys are not set. */
  configured: boolean;
  /** Where the hosted checkout returns the customer to (the Billing page). */
  returnUrl: string;
}

const REFERENCE_PREFIX = "bw-";
const REFERENCE_ORG = /^bw-([0-9A-Za-z]{10,40})-/;

/** The organisation a checkout reference was made for. */
export function orgOfReference(reference: string | null | undefined): string | null {
  const m = reference ? REFERENCE_ORG.exec(reference) : null;
  return m ? m[1] : null;
}

export function createBilling(deps: BillingDeps) {
  const { inkress, store } = deps;

  const requireConfigured = (): void => {
    if (!deps.configured) throw new BillingRefusal("Billing is not switched on yet.");
  };

  /** Is this organisation one we bill? Unmetered organisations are granted by agreement. */
  async function requireBilled(orgId: string): Promise<void> {
    const plan = await store.orgPlan(orgId);
    if (plan === null) throw new BillingRefusal("Organisation not found.");
    if (plan === UNMETERED) throw new BillingRefusal("This organisation is included by agreement and is not billed.");
  }

  /** Save the row and put the plan it earns onto the organisation (once billing has been involved). */
  async function settle(row: BillingRow): Promise<BillingRow> {
    await store.save(row);
    const engaged = row.status !== AccountStatus.None || row.plan !== null || row.trialPlan !== null;
    if (engaged && (await store.orgPlan(row.orgId)) !== UNMETERED) {
      await store.setOrgPlan(row.orgId, effectivePlan(row, deps.now()));
    }
    return row;
  }

  async function plansCached(): Promise<InkressPlan[]> {
    return inkress.plans();
  }

  /** Read the organisation's subscription (or its open checkout) at Inkress and bring the row up to date. */
  async function reconcile(orgId: string): Promise<BillingRow> {
    let row = (await store.get(orgId)) ?? emptyRow(orgId);

    if (deps.configured) {
      // A checkout that was paid: its subscription becomes ours (replacing a cancelled one).
      if (row.checkoutReference) {
        const order = await inkress.orderByReference(row.checkoutReference);
        if (order && order.status === InkressOrderStatus.Paid) {
          const found = await inkress.subscriptionForOrder(order.id);
          if (found) {
            row = { ...row, subscriptionUid: found.uid, checkoutReference: null, checkoutPlan: null, checkoutBilling: null, cancelAtPeriodEnd: false };
          }
        } else if (order && (order.status === InkressOrderStatus.Failed || order.status === InkressOrderStatus.Cancelled)) {
          row = { ...row, checkoutReference: null, checkoutPlan: null, checkoutBilling: null };
        }
      }

      if (row.subscriptionUid) {
        const [sub, plans] = await Promise.all([inkress.subscription(row.subscriptionUid), plansCached()]);
        const sells = plans.find((p) => p.uid === sub.planUid)?.sells ?? null;
        const pending = sub.pendingPlanUid ? (plans.find((p) => p.uid === sub.pendingPlanUid)?.sells ?? null) : null;
        let status = row.status;
        if (sub.status === InkressSubscriptionStatus.Active) {
          status = AccountStatus.Active;
          // Inkress retries a declined renewal itself; the newest period tells us it is declined.
          const latest = (await inkress.periods(sub.uid))[0];
          if (latest && isDeclined(latest, deps.now())) status = AccountStatus.PastDue;
        } else if (sub.status === InkressSubscriptionStatus.Cancelled) {
          status = AccountStatus.Cancelled;
        }
        row = {
          ...row,
          status,
          plan: sells?.plan ?? row.plan,
          billing: sells?.billing ?? row.billing,
          periodEnd: sub.currentPeriodEnd ?? row.periodEnd,
          cardOnFile: sub.cardOnFile,
          pendingPlan: pending?.plan ?? null,
          pendingBilling: pending?.billing ?? null,
          cancelAtPeriodEnd: sub.status === InkressSubscriptionStatus.Cancelled ? true : row.cancelAtPeriodEnd,
        };
      }
    }

    // A trial that ran out without a subscription ends (the trial plan is kept as a record of it).
    if (trialExpired(row, deps.now()) && !row.subscriptionUid) row = { ...row, status: AccountStatus.None };
    return settle(row);
  }

  return {
    reconcile,

    /** The row as it stands, without asking Inkress. */
    async current(orgId: string): Promise<BillingRow> {
      const row = (await store.get(orgId)) ?? emptyRow(orgId);
      if (trialExpired(row, deps.now()) && !row.subscriptionUid) return settle({ ...row, status: AccountStatus.None });
      return row;
    },

    /** Start the 14-day trial of a paid plan. No card; once only per organisation. */
    async startTrial(orgId: string, plan: PaidPlanId): Promise<BillingRow> {
      await requireBilled(orgId);
      const row = (await store.get(orgId)) ?? emptyRow(orgId);
      if (row.trialPlan !== null || row.plan !== null) throw new BillingRefusal("This organisation has already had a trial or a paid plan.");
      const now = deps.now();
      return settle({ ...row, status: AccountStatus.Trialing, trialPlan: plan, trialEndsAt: trialEnd(now) });
    },

    /** A hosted Inkress checkout for a paid plan. Returns where to send the owner. */
    async checkout(orgId: string, plan: PaidPlanId, billing: Billing, customer: Customer): Promise<{ url: string }> {
      requireConfigured();
      await requireBilled(orgId);
      const row = await reconcile(orgId);
      if (row.status === AccountStatus.Active || row.status === AccountStatus.PastDue) {
        throw new BillingRefusal("This organisation already has a subscription. Change plan instead.");
      }
      const target = inkressPlanFor(await plansCached(), plan, billing);
      if (!target) throw new BillingRefusal("That plan is not on sale right now.");
      // Never send a customer to a price different from the one shown.
      if (!priceMatches(target, plan, billing)) throw new BillingRefusal("The price of that plan is being updated. Try again shortly.");
      const reference = `${REFERENCE_PREFIX}${orgId}-${ulid()}`;
      const order = await inkress.subscriptionLink({
        planUid: target.uid,
        reference,
        title: `backwork ${plan === PlanId.Team ? "Team" : "Business"} (${billing})`,
        orgId,
        returnUrl: deps.returnUrl,
        customer,
      });
      if (!order.paymentUrl) throw new BillingRefusal("Inkress did not return a checkout page. Try again.");
      await settle({ ...row, checkoutReference: reference, checkoutPlan: plan, checkoutBilling: billing });
      return { url: order.paymentUrl };
    },

    /** Move a paying organisation to another plan or cycle at the end of its paid period. */
    async changePlan(orgId: string, plan: PaidPlanId, billing: Billing): Promise<BillingRow> {
      requireConfigured();
      const row = await reconcile(orgId);
      if (!row.subscriptionUid || (row.status !== AccountStatus.Active && row.status !== AccountStatus.PastDue)) {
        throw new BillingRefusal("There is no active subscription to change.");
      }
      if (row.plan === plan && row.billing === billing) throw new BillingRefusal("That is already your plan.");
      const target = inkressPlanFor(await plansCached(), plan, billing);
      if (!target || !priceMatches(target, plan, billing)) throw new BillingRefusal("That plan is not on sale right now.");
      const result = await inkress.planChange(row.subscriptionUid, target.uid);
      if (!result.scheduled) throw new BillingRefusal(planChangeRefusal(result.refusal));
      return reconcile(orgId);
    },

    /** Drop a scheduled plan change. */
    async keepPlan(orgId: string): Promise<BillingRow> {
      requireConfigured();
      const row = await store.get(orgId);
      if (!row?.subscriptionUid) throw new BillingRefusal("There is no subscription.");
      await inkress.cancelPlanChange(row.subscriptionUid);
      return reconcile(orgId);
    },

    /** Stop renewing at the end of the paid period; the plan stays until then. */
    async cancel(orgId: string): Promise<BillingRow> {
      requireConfigured();
      const row = await reconcile(orgId);
      if (!row.subscriptionUid || (row.status !== AccountStatus.Active && row.status !== AccountStatus.PastDue)) {
        throw new BillingRefusal("There is no active subscription to cancel.");
      }
      const code = (await inkress.periods(row.subscriptionUid))[0]?.cancelCode;
      if (!code) throw new BillingRefusal("Inkress cannot cancel this subscription right now. Try again shortly.");
      await inkress.cancel(row.subscriptionUid, code);
      return reconcile(orgId);
    },

    /** Where the owner replaces the card on file. */
    async cardUpdateUrl(orgId: string): Promise<string> {
      requireConfigured();
      const row = await store.get(orgId);
      if (!row?.subscriptionUid) throw new BillingRefusal("There is no subscription.");
      return inkress.cardUpdateLink(row.subscriptionUid);
    },

    /** Invoices for the page: periods, newest first. Empty without a subscription. */
    async invoices(orgId: string): Promise<InkressPeriod[]> {
      const row = await store.get(orgId);
      if (!deps.configured || !row?.subscriptionUid) return [];
      return inkress.periods(row.subscriptionUid);
    },

    /** Plans for sale with their Inkress prices (null when billing is off or Inkress is unreachable). */
    async plansForSale(): Promise<InkressPlan[]> {
      return deps.configured ? plansCached() : [];
    },

    /** End every trial that has run out. Returns how many organisations moved back to Free. */
    async settleTrials(): Promise<number> {
      const ids = await store.trialsEndedBy(deps.now());
      for (const id of ids) await reconcile(id);
      return ids.length;
    },
  };
}

export type BillingService = ReturnType<typeof createBilling>;

/** A renewal period whose order failed, or is unpaid well after it was due. */
function isDeclined(period: InkressPeriod, now: Date): boolean {
  if (period.orderStatus === InkressOrderStatus.Failed) return true;
  return period.orderStatus === InkressOrderStatus.Pending && !!period.start && now.getTime() - period.start.getTime() > 86_400_000;
}

function planChangeRefusal(code: string | null): string {
  switch (code) {
    case "already_on_plan":
      return "That is already your plan.";
    case "renewal_in_progress":
      return "Your renewal is being processed. Try again in a few minutes.";
    case "dunning_in_progress":
      return "Your last payment did not go through. Update your card first, then change plan.";
    default:
      return "Inkress could not schedule that change. Try again, or contact support.";
  }
}
