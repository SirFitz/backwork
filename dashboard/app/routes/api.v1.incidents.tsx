import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireApiKey, apiJson } from "~/lib/apikey.server";
import { getIncidents } from "~/lib/analysis.server";
import { tenantOf } from "~/lib/tenant.server";

// GET /api/v1/incidents — current detected incidents for the org.
export async function loader({ request }: LoaderFunctionArgs) {
  const { orgId } = await requireApiKey(request);
  const incidents = await getIncidents(tenantOf(orgId));
  return apiJson({ incidents, count: incidents.length });
}
