import type { ActionFunctionArgs } from "@remix-run/node";
import { config } from "~/lib/config.server";
import { getControls } from "~/lib/controls.server";
import { hopMetricsAllowed } from "~/lib/ingest/enforce.server";
import { resolveIngestToken } from "~/lib/tenant.server";

// Authenticated Prometheus remote-write proxy for the backwork agent's hop
// metrics. The bearer token resolves to an
// org + project; we forward the (snappy-protobuf) body untouched to VM and let
// VM stamp org_id + project via extra_label, so a tenant's metrics are isolated
// without decoding the payload. (Legacy INGEST_TOKEN -> platform.)
// The agent sends its hop metrics to this endpoint with ?kind=hop; those are
// not saved while the project's "Performance figures" or "Hop records" switch
// is off (design 19.1). Per-service switches are enforced by the agent.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const tenant = await resolveIngestToken(token);
  if (!tenant) return new Response("unauthorized", { status: 401 });
  if (new URL(request.url).searchParams.get("kind") === "hop") {
    const rows = await getControls(tenant.orgId);
    if (!hopMetricsAllowed(rows, tenant.projectId)) return new Response(null, { status: 204 });
  }

  const url =
    `${config.vmUrl}/api/v1/write` +
    `?extra_label=org_id=${encodeURIComponent(tenant.orgId)}` +
    `&extra_label=project=${encodeURIComponent(tenant.project)}`;
  const body = Buffer.from(await request.arrayBuffer());
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": request.headers.get("content-type") || "application/x-protobuf",
        "content-encoding": request.headers.get("content-encoding") || "snappy",
      },
      body: new Uint8Array(body),
    });
    return new Response(await res.text(), { status: res.status });
  } catch (e: unknown) {
    return new Response("metrics backend error: " + (e instanceof Error ? e.message : String(e)), { status: 502 });
  }
}
