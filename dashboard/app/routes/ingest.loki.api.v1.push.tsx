import type { ActionFunctionArgs } from "@remix-run/node";
import { gunzipSync } from "node:zlib";
import { config } from "~/lib/config.server";
import { getCompiledFilter, getControls } from "~/lib/controls.server";
import { enforceStreams, type LokiStream } from "~/lib/ingest/enforce.server";
import { resolveIngestToken, tenantOf } from "~/lib/tenant.server";
import { serviceNamesWithin } from "~/lib/service-names.server";
import { isCapped } from "~/lib/plans/limits";
import { addToBucket, addToDaily, orgLimits } from "~/lib/plans/usage.server";
import { startPlanJobs } from "~/lib/plans/retention.server";

// Authenticated proxy for external agents: Vector's loki sink posts here as
// <endpoint>/loki/api/v1/push. The bearer token resolves to an org + project;
// every stream is stamped with org_id + project labels so the data is isolated
// to that tenant. Before forwarding to the internal Loki, the org's switches
// are enforced (a switched-off kind is not saved) and the sensitive-data
// filter runs again (design 19). Only JSON push bodies are accepted, since a
// body that cannot be read cannot be filtered. (Legacy INGEST_TOKEN → platform.)
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const tenant = await resolveIngestToken(token);
  if (!tenant) return new Response("unauthorized", { status: 401 });
  startPlanJobs();

  const ct = request.headers.get("content-type") || "application/json";
  if (!ct.includes("json")) {
    return new Response("unsupported push format: send JSON (Vector loki sink with compression: none)", { status: 415 });
  }
  let text: string;
  try {
    const buf = Buffer.from(await request.arrayBuffer());
    const enc = (request.headers.get("content-encoding") || "").toLowerCase();
    text = enc.includes("gzip") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  } catch {
    return new Response("unreadable body", { status: 400 });
  }
  let streams: LokiStream[];
  try {
    const parsed: unknown = JSON.parse(text);
    const s = (parsed as { streams?: unknown }).streams;
    if (!Array.isArray(s)) return new Response("body has no streams", { status: 400 });
    streams = s as LokiStream[];
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  const [rows, filter, names] = await Promise.all([
    getControls(tenant.orgId),
    getCompiledFilter(tenant.orgId),
    serviceNamesWithin(tenantOf(tenant.orgId), 1500),
  ]);
  const result = enforceStreams(streams, { projectId: tenant.projectId, rows, filter, serviceOf: names.bySource });
  for (const s of result.streams) s.stream = { ...s.stream, org_id: tenant.orgId, project: tenant.project };
  if (result.streams.length === 0) return new Response(null, { status: 204 });

  try {
    const res = await fetch(`${config.lokiUrl}/loki/api/v1/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streams: result.streams }),
    });
    // A metered organisation's intake is counted per day (the Usage page). A limited one also keeps a
    // rolling window: count what was stored per 5 minutes, and the trim job drops the oldest.
    if (res.ok) {
      const limits = await orgLimits(tenant.orgId);
      if (limits) {
        const add = { requests: result.requests, bytes: result.bytes };
        await addToDaily(tenant.orgId, add).catch(() => undefined);
        if (isCapped(limits)) await addToBucket(tenant.orgId, add).catch(() => undefined);
      }
    }
    // Loki answers a push with 204 and no body; a 204 response may not carry one, so build it empty.
    const upstream = await res.text();
    return new Response(upstream === "" || res.status === 204 ? null : upstream, { status: res.status });
  } catch (e: unknown) {
    return new Response("ingest backend error: " + (e instanceof Error ? e.message : String(e)), { status: 502 });
  }
}
