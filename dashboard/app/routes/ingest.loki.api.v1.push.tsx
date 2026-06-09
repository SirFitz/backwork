import type { ActionFunctionArgs } from "@remix-run/node";
import { config } from "~/lib/config.server";
import { resolveIngestToken } from "~/lib/tenant.server";

// Authenticated proxy for external agents: Vector's loki sink posts here as
// <endpoint>/loki/api/v1/push. The bearer token resolves to an org + project;
// we stamp every stream with org_id + project labels so the data is isolated to
// that tenant, then forward to the internal Loki. (Legacy INGEST_TOKEN → platform.)
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const tenant = await resolveIngestToken(token);
  if (!tenant) return new Response("unauthorized", { status: 401 });

  const ct = request.headers.get("content-type") || "application/json";
  let body = await request.text();

  // Tag streams with the tenant. Loki push JSON: { streams: [{ stream: {labels}, values }] }.
  if (ct.includes("json")) {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed.streams)) {
        for (const s of parsed.streams) {
          s.stream = { ...(s.stream || {}), org_id: tenant.orgId, project: tenant.project };
        }
        body = JSON.stringify(parsed);
      }
    } catch {
      // non-JSON-shaped body: forward untagged (only the platform view would see it)
    }
  }

  try {
    const res = await fetch(`${config.lokiUrl}/loki/api/v1/push`, {
      method: "POST",
      headers: { "content-type": ct },
      body,
    });
    return new Response(await res.text(), { status: res.status });
  } catch (e: any) {
    return new Response("ingest backend error: " + (e?.message || e), { status: 502 });
  }
}
