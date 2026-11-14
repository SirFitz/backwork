import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireApiKey, apiJson } from "~/lib/apikey.server";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, listDeploys, type Deploy } from "~/lib/deploys.server";
import { isLabelValue } from "~/lib/hops/metrics.server";

/** One deploy as the read API returns it. */
interface DeployItem {
  id: string;
  service: string;
  version: string | null;
  commit: string | null;
  environment: string | null;
  url: string | null;
  actor: string | null;
  /** ISO 8601 */
  deployed_at: string;
  project_id: string | null;
}

function item(d: Deploy): DeployItem {
  return {
    id: d.id,
    service: d.service,
    version: d.version,
    commit: d.commit,
    environment: d.environment,
    url: d.url,
    actor: d.actor,
    deployed_at: new Date(d.deployedAt).toISOString(),
    project_id: d.projectId,
  };
}

// GET /api/v1/deploys?service=&since=<ISO 8601>&limit=<1..200> (BAC-73): reported deploys,
// newest first.
export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const { orgId } = await requireApiKey(request);
  const url = new URL(request.url);
  const serviceParam = url.searchParams.get("service");
  if (serviceParam !== null && !isLabelValue(serviceParam)) return apiJson({ error: "service: not a service name" }, 400);
  const sinceParam = url.searchParams.get("since");
  const sinceMs = sinceParam === null ? null : Date.parse(sinceParam);
  if (sinceMs !== null && !Number.isFinite(sinceMs)) return apiJson({ error: "since: expected an ISO 8601 time" }, 400);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam === null ? DEFAULT_LIST_LIMIT : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) return apiJson({ error: `limit: a whole number from 1 to ${MAX_LIST_LIMIT}` }, 400);
  const rows = await listDeploys(orgId, { service: serviceParam, sinceMs, limit });
  const deploys = rows.map(item);
  return apiJson({ deploys, count: deploys.length });
}
