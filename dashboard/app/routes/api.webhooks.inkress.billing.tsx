import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { billing } from "~/lib/billing/index.server";
import { dbStore } from "~/lib/billing/store.server";
import { handleBillingWebhook } from "~/lib/billing/webhook.server";

export function loader() {
  return json({ ok: false }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  return handleBillingWebhook(request, {
    service: billing(),
    store: dbStore,
    log: (message, fields) => console.error(JSON.stringify({ msg: message, ...fields })),
  });
}
