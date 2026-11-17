// Query suggestions for one request (BAC-93): the switches for its services and the context the
// rules use (the observed schema around its tables, the Slow queries rows of its services). A
// resource route the request view calls after it has rendered, so the page never waits for it and
// the request loader gains no query. Nothing here is computed from the request's records.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { requireOrg } from "~/lib/auth/context.server";
import { switchesFor, requestContext } from "~/lib/hops/suggest.server";
import { wantedFrom, type SuggestResponse } from "~/lib/hops/suggest-wire";
import { tenantOf } from "~/lib/tenant.server";
import { withBudget } from "~/lib/with-budget";

/** The figures behind the evidence may take a Loki query the first time; the rules do not wait longer than this (ms). */
export const CONTEXT_BUDGET_MS = 2500;

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const want = wantedFrom(new URL(request.url));
  const on = await switchesFor(ctx.org.id, want.projects, want.services);
  if (!want.services.some((s) => on[s])) return json<SuggestResponse>({ on, context: null, contextError: null }, { headers: { "Cache-Control": "private, no-store" } });
  // One environment: its figures; several or none: the organisation's.
  const tenant = tenantOf(ctx.org.id, want.projects.length === 1 ? want.projects[0] : null);
  let context: SuggestResponse["context"] = null;
  let contextError: string | null = null;
  try {
    context = await withBudget(requestContext(tenant, want.services.filter((s) => on[s]), want.tables), CONTEXT_BUDGET_MS);
    if (context === null) contextError = "The query figures are still being read.";
  } catch (e) {
    contextError = e instanceof Error ? e.message.slice(0, 160) : "unavailable";
  }
  return json<SuggestResponse>({ on, context, contextError }, { headers: { "Cache-Control": "private, no-store" } });
}
