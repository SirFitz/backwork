// Events from the `backwork` Inkress merchant (subscription.*, card_charge.*). Each carries a stable
// `id` (deduped here) and a JWT signed with the merchant's secret; only a verified token is trusted.
// An event only says "look again": the organisation it concerns is reconciled from Inkress itself, so
// a replayed or reordered delivery cannot move a plan the wrong way.
import { json } from "@remix-run/node";
import { config } from "~/lib/config.server";
import { verifyHs256 } from "./jwt.server";
import { orgOfReference, type BillingService } from "./service.server";
import type { BillingStore } from "./store.server";

interface Delivery {
  id: string;
  type: string;
  jwt: string;
}

function isDelivery(v: unknown): v is Delivery {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === "string" && d.id.length > 0 && d.id.length <= 160 && typeof d.type === "string" && d.type.length <= 64 && typeof d.jwt === "string" && d.jwt.length > 0;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** The organisation a verified event concerns: its subscription, else our tag on it, else the checkout reference. */
async function orgOf(claims: Record<string, unknown>, store: BillingStore): Promise<string | null> {
  const data = obj(claims.data);
  const subscription = obj(data?.subscription);
  const charge = obj(data?.charge);
  const order = obj(data?.order);
  const uid = str(subscription?.uid) ?? str(charge?.subscription_uid);
  if (uid) {
    const known = await store.orgForSubscription(uid);
    if (known) return known;
  }
  const tagged = str(obj(subscription?.meta_data)?.backwork_org_id) ?? str(obj(data?.meta_data)?.backwork_org_id);
  if (tagged) return tagged;
  return orgOfReference(str(claims.reference_id) ?? str(data?.reference_id) ?? str(order?.reference_id));
}

export interface WebhookDeps {
  service: BillingService;
  store: BillingStore;
  secret?: string;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export async function handleBillingWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false }, { status: 405 });
  const secret = deps.secret ?? config.billing.webhookSecret;
  if (!secret) return json({ ok: false }, { status: 503 });

  const body: unknown = await request.json().catch(() => null);
  if (!isDelivery(body)) return json({ ok: false }, { status: 400 });
  const claims = verifyHs256(body.jwt, secret);
  if (!claims) return json({ ok: false }, { status: 401 });
  // The signed token must describe the same event as the envelope.
  if (typeof claims.id === "string" && claims.id !== body.id) return json({ ok: false }, { status: 401 });

  const orgId = await orgOf(claims, deps.store);
  if (!(await deps.store.recordEvent(body.id, orgId, body.type))) return json({ ok: true, duplicate: true });
  if (!orgId) {
    deps.log?.("billing webhook for an unknown organisation", { type: body.type });
    return json({ ok: true, ignored: true });
  }
  try {
    await deps.service.reconcile(orgId);
  } catch (error) {
    deps.log?.("billing webhook reconcile failed", { orgId, error: String(error) });
    // 500 so Inkress retries the delivery; the event key is released so the retry is handled.
    await deps.store.forgetEvent(body.id);
    return json({ ok: false }, { status: 500 });
  }
  return json({ ok: true });
}
