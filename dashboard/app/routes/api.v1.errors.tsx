import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireApiKey, apiJson } from "~/lib/apikey.server";
import { listErrorGroups } from "~/lib/errors.server";

// GET /api/v1/errors?status=open|resolved|ignored|all&service=&limit= — error groups.
// Each group includes its latest `sample` (stack + context), so no detail call needed.
export async function loader({ request }: LoaderFunctionArgs) {
  const { orgId } = await requireApiKey(request);
  const u = new URL(request.url);
  const status = u.searchParams.get("status") || "open";
  const service = u.searchParams.get("service") || "all";
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit")) || 100, 1), 500);
  const errors = await listErrorGroups(orgId, { status, service, limit });
  return apiJson({ errors, count: errors.length });
}
