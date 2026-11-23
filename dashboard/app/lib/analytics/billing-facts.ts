// What a billing row change means for the business, as analytics facts (BAC-103). Pure: the billing service
// calls it with the row before and after an action or a "look again at Inkress", and hands the facts on.
import { AccountStatus, type BillingRow } from "~/lib/billing/types";
import { CheckoutFailureStage, ServerEvent, type ServerFact } from "./events";

export function billingFacts(before: BillingRow, after: BillingRow): ServerFact[] {
  const facts: ServerFact[] = [];

  if (after.trialPlan !== null && before.trialPlan === null) {
    facts.push({ name: ServerEvent.TrialStarted, props: { plan: after.trialPlan }, dedupeKey: `trial:${after.orgId}` });
  }

  if (after.checkoutReference !== null && after.checkoutReference !== before.checkoutReference && after.checkoutPlan && after.checkoutBilling) {
    facts.push({ name: ServerEvent.CheckoutOpened, props: { plan: after.checkoutPlan, billing: after.checkoutBilling } });
  }

  const newSubscription = after.subscriptionUid !== null && after.subscriptionUid !== before.subscriptionUid;
  if (newSubscription && after.plan && after.billing) {
    facts.push({
      name: ServerEvent.SubscriptionStarted,
      props: { plan: after.plan, billing: after.billing, after_trial: before.status === AccountStatus.Trialing },
      dedupeKey: `sub:${after.subscriptionUid}`,
    });
  } else if (before.checkoutReference !== null && after.checkoutReference === null && !newSubscription) {
    // The open checkout ended without a subscription: Inkress marked its order failed or cancelled.
    facts.push({ name: ServerEvent.CheckoutFailed, props: { stage: CheckoutFailureStage.Payment }, dedupeKey: `checkout:${before.checkoutReference}` });
  }

  if (after.status === AccountStatus.PastDue && before.status !== AccountStatus.PastDue) {
    facts.push({ name: ServerEvent.RenewalDeclined, props: {}, dedupeKey: `declined:${after.orgId}:${after.periodEnd?.toISOString() ?? "none"}` });
  }

  if (after.cancelAtPeriodEnd && !before.cancelAtPeriodEnd && after.subscriptionUid !== null) {
    facts.push({ name: ServerEvent.SubscriptionCancelled, props: {}, dedupeKey: `cancel:${after.subscriptionUid}` });
  }
  return facts;
}
