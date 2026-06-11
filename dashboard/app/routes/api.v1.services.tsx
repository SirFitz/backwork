import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireApiKey, apiJson } from "~/lib/apikey.server";
import { serviceHealth } from "~/lib/analysis.server";
import { tenantOf } from "~/lib/tenant.server";

// GET /api/v1/services — per-service health for the org.
export async function loader({ request }: LoaderFunctionArgs) {
  const { orgId } = await requireApiKey(request);
  const services = await serviceHealth(tenantOf(orgId));
  return apiJson({ services, count: services.length });
}
