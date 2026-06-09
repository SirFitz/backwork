import type { ActionFunctionArgs } from "@remix-run/node";
import { config } from "~/lib/config.server";
import { resolveIngestToken } from "~/lib/tenant.server";
import { tagTraces } from "~/lib/otlp-tag.server";

// Authenticated OTLP/HTTP trace ingest. An app's OpenTelemetry exporter posts to
// <PUBLIC_URL>/otlp/v1/traces with `Authorization: Bearer <token>` (legacy
// INGEST_TOKEN or a per-project token); we verify the token, stamp an enforced
// org_id onto the spans, and forward to Jaeger's OTLP receiver.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const tenant = await resolveIngestToken(token);
  if (!tenant) return new Response("unauthorized", { status: 401 });
  const ct = request.headers.get("content-type") || "application/x-protobuf";
  let body: Buffer = Buffer.from(await request.arrayBuffer());
  if (ct.includes("protobuf")) body = tagTraces(body, tenant.orgId);
  try {
    const res = await fetch(`${config.otlpHttp}/v1/traces`, {
      method: "POST",
      headers: { "content-type": ct },
      body: new Uint8Array(body),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return new Response(buf, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "application/x-protobuf" },
    });
  } catch (e: any) {
    return new Response("otlp backend error: " + (e?.message || e), { status: 502 });
  }
}
