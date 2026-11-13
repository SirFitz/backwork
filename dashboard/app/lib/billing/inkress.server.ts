// The Inkress contracts billing uses, on the `backwork` merchant. Reads and checkout links go out
// on the platform key; plan changes need a key bound to the merchant itself. Every response is
// checked here, so the rest of billing only sees typed values. Ported from FleekSite's
// platform billing client (fs-revamp app/lib/billing/inkress.server.ts), cut to what backwork needs.
import { config } from "~/lib/config.server";
import {
  InkressSubscriptionStatus,
  type Customer,
  type InkressOrder,
  type InkressPeriod,
  type InkressPlan,
  type InkressSubscription,
} from "./types";
import { sellsOf } from "./rules";

export class InkressBillingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Inkress's machine-readable refusal (e.g. `already_on_plan`), when it gave one. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "InkressBillingError";
  }
}

export enum Credential {
  Platform = "platform",
  Merchant = "merchant",
}

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface InkressTransport {
  request(method: HttpMethod, path: string, body: unknown, credential: Credential): Promise<unknown>;
}

export function apiUrl(path: string): string {
  const base = config.billing.mode === "live" ? "https://api.inkress.com" : "https://api-dev.inkress.com";
  return `${base}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function int(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function when(v: unknown): Date | null {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function bad(what: string): never {
  throw new InkressBillingError(`Inkress sent an unexpected ${what}`, 502);
}

/** fetch against the Inkress API as the backwork merchant. */
export const httpTransport: InkressTransport = {
  async request(method, path, body, credential) {
    const token = credential === Credential.Merchant ? config.billing.secretKey : config.billing.platformKey;
    if (!token) throw new InkressBillingError("Billing keys are not configured", 0);
    const response = await fetch(apiUrl(path), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": `m-${config.billing.merchant}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed: unknown = await response.json().catch(() => null);
    if (!isObject(parsed) || typeof parsed.state !== "string") throw new InkressBillingError(`Inkress returned ${response.status}`, response.status);
    if (!response.ok || parsed.state !== "ok") {
      const r = parsed.result;
      const reason = typeof r === "string" ? r : isObject(r) && r.reason !== undefined ? String(r.reason) : "Inkress refused the request";
      const code = isObject(r) && r.code !== undefined ? String(r.code) : null;
      throw new InkressBillingError(reason, response.status, code);
    }
    return parsed.result;
  },
};

function entriesOf(result: unknown): Json[] {
  if (!isObject(result) || !Array.isArray(result.entries)) return bad("list");
  return result.entries.filter(isObject);
}

export function toPlan(raw: Json): InkressPlan | null {
  const uid = text(raw.uid);
  const price = int(raw.flat_rate);
  if (!uid || price === null) return null;
  const currency = text(raw.currency_code) ?? (isObject(raw.currency) ? text(raw.currency.code) : null) ?? "USD";
  const data = isObject(raw.data) ? raw.data : null;
  return {
    uid,
    name: text(raw.name) ?? "",
    price,
    currency,
    sells: sellsOf({ name: text(raw.name) ?? "", billingCycle: int(raw.billing_cycle), data }),
  };
}

export function toSubscription(raw: Json): InkressSubscription {
  const uid = text(raw.uid);
  const status = int(raw.status);
  if (!uid || status === null) return bad("subscription");
  const plan = isObject(raw.billing_plan) ? raw.billing_plan : null;
  const meta = isObject(raw.meta_data) ? raw.meta_data : null;
  const data = isObject(raw.data) ? raw.data : null;
  const pending = data && isObject(data.pending_plan_change) ? text(data.pending_plan_change.plan_uid) : null;
  return {
    uid,
    status: status as InkressSubscriptionStatus,
    planUid: (plan && text(plan.uid)) ?? "",
    currentPeriodEnd: when(raw.current_period_end),
    // Hosted checkout links the card it captured; trust Inkress's own answer when it gives one.
    cardOnFile: raw.card_on_file !== false,
    orderId: int(raw.order_id),
    orgId: meta ? text(meta.backwork_org_id) : null,
    pendingPlanUid: pending,
  };
}

function toPeriod(raw: Json): InkressPeriod | null {
  const id = int(raw.id);
  if (id === null) return null;
  const order = isObject(raw.order) ? raw.order : null;
  return {
    id,
    status: int(raw.status) ?? 0,
    start: when(raw.start_date),
    end: when(raw.end_date),
    total: (order && int(order.total)) ?? 0,
    orderStatus: order ? int(order.status) : null,
    paymentUrl: text(raw.payment_url),
    cancelCode: text(raw.cancel_code),
  };
}

function toOrder(raw: unknown): InkressOrder {
  if (!isObject(raw)) return bad("order");
  const id = int(raw.id);
  if (id === null) return bad("order");
  const urls = isObject(raw.payment_urls) ? raw.payment_urls : null;
  return {
    id,
    status: int(raw.status) ?? 0,
    paymentUrl: urls ? (text(urls.short_link) ?? text(urls.payment_url)) : null,
  };
}

export interface PlanChangeResult {
  scheduled: boolean;
  /** Inkress's refusal code when it did not schedule the change. */
  refusal: string | null;
}

export function createInkressBilling(transport: InkressTransport = httpTransport) {
  const get = (path: string, credential = Credential.Platform) => transport.request("GET", path, undefined, credential);
  const post = (path: string, body: unknown, credential = Credential.Platform) => transport.request("POST", path, body, credential);
  const sub = (uid: string) => encodeURIComponent(uid);

  return {
    /** Active plans on the merchant that sell a backwork plan, in US dollars. */
    async plans(): Promise<InkressPlan[]> {
      const result = await get("/billing_plans?status=1&page_size=100");
      return entriesOf(result)
        .filter((raw) => !(isObject(raw.data) && raw.data.is_listed === false))
        .map(toPlan)
        .filter((p): p is InkressPlan => p !== null && p.sells !== null && p.currency === "USD");
    },

    /** A hosted checkout that starts the organisation's subscription; Inkress captures the card there. */
    async subscriptionLink(input: { planUid: string; reference: string; title: string; orgId: string; returnUrl: string; customer: Customer }): Promise<InkressOrder> {
      const result = await post("/billing_subscriptions/link", {
        plan_id: input.planUid,
        reference_id: input.reference,
        title: input.title,
        // return_url is where the hosted checkout sends the customer afterwards.
        meta_data: { backwork_org_id: input.orgId, return_url: input.returnUrl },
        customer: { email: input.customer.email, first_name: input.customer.firstName, last_name: input.customer.lastName },
      });
      return toOrder(result);
    },

    async subscription(uid: string): Promise<InkressSubscription> {
      const result = await get(`/billing_subscriptions/${sub(uid)}`);
      return isObject(result) ? toSubscription(result) : bad("subscription");
    },

    /** The subscription a paid checkout created, if Inkress has made it yet. */
    async subscriptionForOrder(orderId: number): Promise<InkressSubscription | null> {
      const first = entriesOf(await get(`/billing_subscriptions?order_id=${orderId}`))[0];
      return first ? toSubscription(first) : null;
    },

    /** Periods, newest first. */
    async periods(uid: string): Promise<InkressPeriod[]> {
      return entriesOf(await get(`/billing_subscriptions/${sub(uid)}/periods?page_size=24`))
        .map(toPeriod)
        .filter((p): p is InkressPeriod => p !== null)
        .sort((a, b) => b.id - a.id);
    },

    /** The order made with `reference`, when Inkress has one. */
    async orderByReference(reference: string): Promise<InkressOrder | null> {
      const first = entriesOf(await get(`/orders?reference_id=${encodeURIComponent(reference)}`))[0];
      return first ? toOrder(first) : null;
    },

    /** A one-time link where the owner replaces the card on the subscription. */
    async cardUpdateLink(uid: string): Promise<string> {
      const result = await post(`/billing_subscriptions/${sub(uid)}/card-update-link`, {});
      const link = isObject(result) ? text(result.link) : null;
      return link ?? bad("card link");
    },

    /** Cancel at the end of the current period, with the latest period's cancel code. */
    async cancel(uid: string, cancelCode: string): Promise<void> {
      await post(`/billing_subscriptions/${sub(uid)}/cancel/${encodeURIComponent(cancelCode)}`, {});
    },

    /** Move the subscription to another plan at the end of the paid period, keeping its card. */
    async planChange(uid: string, planUid: string): Promise<PlanChangeResult> {
      try {
        await post(`/billing_subscriptions/${sub(uid)}/plan-change`, { plan_uid: planUid }, Credential.Merchant);
        return { scheduled: true, refusal: null };
      } catch (error) {
        if (error instanceof InkressBillingError && error.code) return { scheduled: false, refusal: error.code };
        throw error;
      }
    },

    /** Drop a plan change that has not applied yet. */
    async cancelPlanChange(uid: string): Promise<void> {
      await transport.request("DELETE", `/billing_subscriptions/${sub(uid)}/plan-change`, undefined, Credential.Merchant);
    },
  };
}

export type InkressBilling = ReturnType<typeof createInkressBilling>;
