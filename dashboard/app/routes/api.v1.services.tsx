import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireApiKey, apiJson } from "~/lib/apikey.server";
import { parseRange, servicesTable } from "~/lib/hops/metrics.server";
import { HEALTH_PARAM, healthChecksFrom } from "~/lib/hops/health";
import { tenantOf } from "~/lib/tenant.server";

/** One service as the read API returns it: the Performance page's services row. */
interface ServiceFigures {
  service: string;
  /** inbound requests and jobs per second */
  rate: number;
  /** share of them that failed, 0..1 */
  error_share: number;
  /** latency in seconds, null without samples */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** share of request time spent in databases and caches, 0..1 */
  store_share: number | null;
  in_progress: number;
}

// GET /api/v1/services?range=1h|6h|24h|7d&health=1: request figures per service from hop
// records (health checks left out unless health=1).
export async function loader({ request }: LoaderFunctionArgs) {
  const { orgId } = await requireApiKey(request);
  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("range") ?? "1h");
  const rows = await servicesTable(range, tenantOf(orgId), undefined, undefined, healthChecksFrom(url.searchParams.get(HEALTH_PARAM)));
  const services: ServiceFigures[] = rows.map((r) => ({
    service: r.service,
    rate: r.rate,
    error_share: r.errorShare,
    p50: r.p50,
    p95: r.p95,
    p99: r.p99,
    store_share: r.storeShare,
    in_progress: r.inProgress,
  }));
  return apiJson({ range, services, count: services.length });
}
