// The billing service wired to the real database and Inkress. Routes and jobs import this.
import { billingFacts } from "~/lib/analytics/billing-facts";
import { trackFact } from "~/lib/analytics/server.server";
import { billingConfigured, config } from "~/lib/config.server";
import { createInkressBilling } from "./inkress.server";
import { createBilling, type BillingService } from "./service.server";
import { dbStore } from "./store.server";

let instance: BillingService | null = null;

export function billing(): BillingService {
  instance ??= createBilling({ inkress: createInkressBilling(), store: dbStore, now: () => new Date(), configured: billingConfigured(), returnUrl: `${config.publicUrl}/billing`, embedOrigin: new URL(config.publicUrl).origin, observe: (before, after) => billingFacts(before, after).forEach(trackFact) });
  return instance;
}
