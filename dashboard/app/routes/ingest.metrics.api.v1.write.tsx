import type { ActionFunctionArgs } from "@remix-run/node";
import { config } from "~/lib/config.server";
import { resolveIngestToken } from "~/lib/tenant.server";

// Authenticated Prometheus remote-write proxy for external agents (Vector
// host_metrics or a vmagent scraping cAdvisor). The bearer token resolves to an
// org + project; we forward the (snappy-protobuf) body untouched to VM and let
// VM stamp org_id + project via extra_label, so a tenant's metrics are isolated
// without decoding the payload. (Legacy INGEST_TOKEN -> platform.)
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const tenant = await resolveIngestToken(token);
  if (!tenant) return new Response("unauthorized", { status: 401 });

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
  } catch (e: any) {
    return new Response("metrics backend error: " + (e?.message || e), { status: 502 });
  }
}
