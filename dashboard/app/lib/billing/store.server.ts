// Persistence for billing: the org_billing row, handled webhook deliveries, and writing the
// plan an organisation gets onto the org itself (which the ingest limits read).
import { and, eq, lte, ne } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { billingEvents, orgBilling, orgs } from "~/db/schema";
import type { PlanId } from "~/components/site/plans";
import { UNMETERED } from "~/lib/plans/limits";
import { invalidate } from "~/lib/cache.server";
import { AccountStatus, type BillingRow } from "./types";
import { isBilling, isPaidPlanId } from "./rules";

export interface BillingStore {
  get(orgId: string): Promise<BillingRow | null>;
  save(row: BillingRow): Promise<void>;
  orgForSubscription(uid: string): Promise<string | null>;
  /** True the first time an event key is recorded. */
  recordEvent(key: string, orgId: string | null, type: string): Promise<boolean>;
  /** Forget a recorded event, so a failed delivery is handled when Inkress retries it. */
  forgetEvent(key: string): Promise<void>;
  /** The organisation's current plan value (`unmetered` for orgs that are not billed), or null if unknown. */
  orgPlan(orgId: string): Promise<string | null>;
  setOrgPlan(orgId: string, plan: PlanId): Promise<void>;
  trialsEndedBy(now: Date): Promise<string[]>;
}

function toRow(r: typeof orgBilling.$inferSelect): BillingRow {
  const status = (Object.values(AccountStatus) as string[]).includes(r.status) ? (r.status as AccountStatus) : AccountStatus.None;
  return {
    orgId: r.orgId,
    status,
    trialPlan: isPaidPlanId(r.trialPlan) ? r.trialPlan : null,
    trialEndsAt: r.trialEndsAt,
    plan: isPaidPlanId(r.plan) ? r.plan : null,
    billing: isBilling(r.billing) ? r.billing : null,
    subscriptionUid: r.subscriptionUid,
    periodEnd: r.periodEnd,
    pendingPlan: isPaidPlanId(r.pendingPlan) ? r.pendingPlan : null,
    pendingBilling: isBilling(r.pendingBilling) ? r.pendingBilling : null,
    cardOnFile: r.cardOnFile,
    cancelAtPeriodEnd: r.cancelAtPeriodEnd,
    checkoutReference: r.checkoutReference,
    checkoutPlan: isPaidPlanId(r.checkoutPlan) ? r.checkoutPlan : null,
    checkoutBilling: isBilling(r.checkoutBilling) ? r.checkoutBilling : null,
  };
}

export const dbStore: BillingStore = {
  async get(orgId) {
    await ensureSchema();
    const rows = await db.select().from(orgBilling).where(eq(orgBilling.orgId, orgId)).limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  },

  async save(row) {
    await ensureSchema();
    const values = { ...row, updatedAt: new Date() };
    await db.insert(orgBilling).values(values).onConflictDoUpdate({ target: orgBilling.orgId, set: values });
  },

  async orgForSubscription(uid) {
    await ensureSchema();
    const rows = await db.select({ orgId: orgBilling.orgId }).from(orgBilling).where(eq(orgBilling.subscriptionUid, uid)).limit(1);
    return rows[0]?.orgId ?? null;
  },

  async recordEvent(key, orgId, type) {
    await ensureSchema();
    const rows = await db.insert(billingEvents).values({ eventKey: key, orgId, type }).onConflictDoNothing().returning({ k: billingEvents.eventKey });
    return rows.length > 0;
  },

  async forgetEvent(key) {
    await ensureSchema();
    await db.delete(billingEvents).where(eq(billingEvents.eventKey, key));
  },

  async orgPlan(orgId) {
    await ensureSchema();
    const rows = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    return rows[0]?.plan ?? null;
  },

  async setOrgPlan(orgId, plan) {
    await ensureSchema();
    // An unmetered organisation (backwork's own, internal apps) is never moved onto a plan.
    await db.update(orgs).set({ plan, updatedAt: new Date() }).where(and(eq(orgs.id, orgId), ne(orgs.plan, UNMETERED)));
    invalidate(`plan:${orgId}`);
  },

  async trialsEndedBy(now) {
    await ensureSchema();
    const rows = await db
      .select({ orgId: orgBilling.orgId })
      .from(orgBilling)
      .where(and(eq(orgBilling.status, AccountStatus.Trialing), lte(orgBilling.trialEndsAt, now)));
    return rows.map((r) => r.orgId);
  },
};
