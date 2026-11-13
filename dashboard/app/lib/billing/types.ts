// Billing (BAC-57): an organisation is a customer of the `backwork` Inkress merchant, with at
// most one subscription to one paid plan. The fixed value sets and shapes billing modules share.
import type { Billing, PlanId } from "~/components/site/plans";

/** The organisation's standing with backwork. */
export enum AccountStatus {
  /** No paid plan and no trial. */
  None = "none",
  /** Inside the no-card trial of a paid plan. */
  Trialing = "trialing",
  Active = "active",
  /** Inkress could not collect the last renewal and is retrying. */
  PastDue = "past_due",
  /** The subscription ended; the paid plan runs to the end of the paid period. */
  Cancelled = "cancelled",
}

/** The plans a customer can pay for. */
export type PaidPlanId = PlanId.Team | PlanId.Business;

/** Inkress subscription status codes (admin-sdk data-mappings). */
export enum InkressSubscriptionStatus {
  Pending = 1,
  Active = 2,
  Cancelled = 3,
}

/** Inkress order status codes. */
export enum InkressOrderStatus {
  Pending = 1,
  Failed = 2,
  Paid = 3,
  Cancelled = 5,
  Refunded = 11,
}

/** Inkress `billing_cycle` 3 is monthly; any other cycle on a listed plan is yearly. */
export const INKRESS_MONTHLY_CYCLE = 3;

export const BILLING_CURRENCY = "USD";
export const TRIAL_DAYS = 14;

/** A listed plan on the `backwork` merchant. */
export interface InkressPlan {
  uid: string;
  name: string;
  /** Major units. */
  price: number;
  currency: string;
  /** Which backwork plan and cycle it sells, or null when it is not one we sell. */
  sells: { plan: PaidPlanId; billing: Billing } | null;
}

export interface InkressSubscription {
  uid: string;
  status: InkressSubscriptionStatus;
  planUid: string;
  currentPeriodEnd: Date | null;
  cardOnFile: boolean;
  orderId: number | null;
  /** The organisation the subscription was created for (our meta_data tag). */
  orgId: string | null;
  pendingPlanUid: string | null;
}

export interface InkressPeriod {
  id: number;
  status: number;
  start: Date | null;
  end: Date | null;
  total: number;
  orderStatus: number | null;
  paymentUrl: string | null;
  cancelCode: string | null;
}

export interface InkressOrder {
  id: number;
  status: number;
  paymentUrl: string | null;
}

/** The `org_billing` row. */
export interface BillingRow {
  orgId: string;
  status: AccountStatus;
  trialPlan: PaidPlanId | null;
  trialEndsAt: Date | null;
  plan: PaidPlanId | null;
  billing: Billing | null;
  subscriptionUid: string | null;
  periodEnd: Date | null;
  pendingPlan: PaidPlanId | null;
  pendingBilling: Billing | null;
  cardOnFile: boolean;
  cancelAtPeriodEnd: boolean;
  /** The reference of the checkout the owner last opened, until its subscription is found. */
  checkoutReference: string | null;
  checkoutPlan: PaidPlanId | null;
  checkoutBilling: Billing | null;
}

export interface Customer {
  email: string;
  firstName: string;
  lastName: string;
}
