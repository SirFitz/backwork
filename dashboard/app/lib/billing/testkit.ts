// In-memory stand-ins for the billing store and the Inkress client, used by the billing tests.
import { Billing, PlanId } from "~/components/site/plans";
import type { InkressBilling } from "./inkress.server";
import type { BillingStore } from "./store.server";
import { AccountStatus, InkressOrderStatus, InkressSubscriptionStatus, type BillingRow, type InkressPeriod, type InkressPlan, type InkressSubscription } from "./types";

export class MemoryStore implements BillingStore {
  rows = new Map<string, BillingRow>();
  events = new Set<string>();
  orgPlans = new Map<string, string>();
  async get(orgId: string) { return this.rows.get(orgId) ?? null; }
  async save(row: BillingRow) { this.rows.set(row.orgId, { ...row }); }
  async orgForSubscription(uid: string) { return [...this.rows.values()].find((r) => r.subscriptionUid === uid)?.orgId ?? null; }
  async recordEvent(key: string) { if (this.events.has(key)) return false; this.events.add(key); return true; }
  async forgetEvent(key: string) { this.events.delete(key); }
  async orgPlan(orgId: string) { return this.orgPlans.get(orgId) ?? null; }
  async setOrgPlan(orgId: string, plan: PlanId) { if (this.orgPlans.get(orgId) !== "unmetered") this.orgPlans.set(orgId, plan); }
  async trialsEndedBy(now: Date) {
    return [...this.rows.values()].filter((r) => r.status === AccountStatus.Trialing && r.trialEndsAt && r.trialEndsAt <= now).map((r) => r.orgId);
  }
}

export const PLAN_LIST: InkressPlan[] = [
  { uid: "p-team-m", name: "Team monthly", price: 29, currency: "USD", sells: { plan: PlanId.Team, billing: Billing.Monthly } },
  { uid: "p-team-y", name: "Team yearly", price: 290, currency: "USD", sells: { plan: PlanId.Team, billing: Billing.Yearly } },
  { uid: "p-biz-m", name: "Business monthly", price: 99, currency: "USD", sells: { plan: PlanId.Business, billing: Billing.Monthly } },
  { uid: "p-biz-y", name: "Business yearly", price: 990, currency: "USD", sells: { plan: PlanId.Business, billing: Billing.Yearly } },
];

/** A scriptable Inkress: tests set what it will answer and read what it was asked. */
export class FakeInkress {
  plans = PLAN_LIST;
  orders = new Map<string, { id: number; status: InkressOrderStatus }>();
  subscriptions = new Map<string, InkressSubscription>();
  periods: InkressPeriod[] = [];
  calls: string[] = [];
  planChangeRefusal: string | null = null;
  failReads = false;
  nextOrder = 100;

  /** The pretend customer pays the checkout whose reference they were sent. */
  pay(reference: string, planUid: string, orgId: string, periodEnd: Date): InkressSubscription {
    const order = this.orders.get(reference);
    if (!order) throw new Error("no such checkout");
    order.status = InkressOrderStatus.Paid;
    const sub: InkressSubscription = {
      uid: `sub-${order.id}`, status: InkressSubscriptionStatus.Active, planUid, currentPeriodEnd: periodEnd,
      cardOnFile: true, orderId: order.id, orgId, pendingPlanUid: null,
    };
    this.subscriptions.set(sub.uid, sub);
    return sub;
  }

  api: InkressBilling = {
    plans: async () => { this.calls.push("plans"); if (this.failReads) throw new Error("down"); return this.plans; },
    subscriptionLink: async (i) => {
      this.calls.push(`link ${i.planUid}`);
      const order = { id: this.nextOrder++, status: InkressOrderStatus.Pending };
      this.orders.set(i.reference, order);
      return { id: order.id, status: order.status, paymentUrl: `https://pay.test/${order.id}` };
    },
    subscription: async (uid) => { this.calls.push(`sub ${uid}`); const s = this.subscriptions.get(uid); if (!s) throw new Error("404"); return s; },
    subscriptionForOrder: async (orderId) => [...this.subscriptions.values()].find((s) => s.orderId === orderId) ?? null,
    periods: async () => this.periods,
    orderByReference: async (ref) => { const o = this.orders.get(ref); return o ? { id: o.id, status: o.status, paymentUrl: null } : null; },
    cardUpdateLink: async (uid) => `https://card.test/${uid}`,
    cancel: async (uid, code) => {
      this.calls.push(`cancel ${uid} ${code}`);
      const s = this.subscriptions.get(uid);
      if (s) this.subscriptions.set(uid, { ...s, status: InkressSubscriptionStatus.Cancelled });
    },
    planChange: async (uid, planUid) => {
      this.calls.push(`plan-change ${uid} ${planUid}`);
      if (this.planChangeRefusal) return { scheduled: false, refusal: this.planChangeRefusal };
      const s = this.subscriptions.get(uid);
      if (s) this.subscriptions.set(uid, { ...s, pendingPlanUid: planUid });
      return { scheduled: true, refusal: null };
    },
    cancelPlanChange: async (uid) => {
      const s = this.subscriptions.get(uid);
      if (s) this.subscriptions.set(uid, { ...s, pendingPlanUid: null });
    },
  };
}
