import type { LoaderFunctionArgs } from "@remix-run/node";
import { controlsTransformYaml } from "~/lib/agent/vector-config.server";
import { controlsSnapshot } from "~/lib/controls.server";
import { resolveIngestToken, tenantOf } from "~/lib/tenant.server";
import { relabelMap } from "~/lib/service-names";
import { serviceNamesWithin } from "~/lib/service-names.server";

// The agent's switches and filter patterns (design 19.1 "Agent"). The agent
// polls this with its project token every 30 s:
//   GET /ingest/controls                -> JSON ControlsSnapshot
//   GET /ingest/controls?format=vector  -> the bw_controls transform as Vector YAML
// The `x-backwork-controls-version` header changes whenever anything changes.
export async function loader({ request }: LoaderFunctionArgs) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const tenant = await resolveIngestToken(token);
  if (!tenant) return new Response("unauthorized", { status: 401 });
  // Source -> service names learned from hop records, so the agent stores ordinary lines under
  // the service's own name (BAC-51). Never waits on Loki for more than 3 s.
  const names = await serviceNamesWithin(tenantOf(tenant.orgId), 3000);
  const snap = await controlsSnapshot(tenant.orgId, tenant.projectId ?? "", relabelMap(names));
  const headers = { "x-backwork-controls-version": snap.version, "cache-control": "no-store" };
  if (new URL(request.url).searchParams.get("format") === "vector") {
    return new Response(controlsTransformYaml(snap), {
      status: 200,
      headers: { ...headers, "content-type": "application/yaml; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(snap), {
    status: 200,
    headers: { ...headers, "content-type": "application/json" },
  });
}
