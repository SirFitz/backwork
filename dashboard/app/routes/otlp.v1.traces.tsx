import type { ActionFunctionArgs } from "@remix-run/node";
import { config } from "~/lib/config.server";

// Authenticated OTLP/HTTP trace ingest. An app's OpenTelemetry exporter posts to
// <PUBLIC_URL>/otlp/v1/traces with `Authorization: Bearer <INGEST_TOKEN>`; we
// verify the token and forward the (protobuf or JSON) payload to Jaeger's OTLP
// receiver, so apps can ship traces without exposing Jaeger directly.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const expected = config.ingestToken;
  const auth = request.headers.get("authorization") || "";
  if (!expected || auth !== `Bearer ${expected}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = Buffer.from(await request.arrayBuffer());
  try {
    const res = await fetch(`${config.otlpHttp}/v1/traces`, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") || "application/x-protobuf" },
      body,
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
