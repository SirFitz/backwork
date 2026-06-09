import type { ActionFunctionArgs } from "@remix-run/node";
import { config } from "~/lib/config.server";

// Authenticated proxy for external agents: Vector's loki sink posts here as
// <endpoint>/loki/api/v1/push. We check the bearer token and forward to the
// internal Loki, so the only public surface is the dashboard.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const expected = config.ingestToken;
  const auth = request.headers.get("authorization") || "";
  if (!expected || auth !== `Bearer ${expected}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await request.text();
  try {
    const res = await fetch(`${config.lokiUrl}/loki/api/v1/push`, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") || "application/json" },
      body,
    });
    return new Response(await res.text(), { status: res.status });
  } catch (e: any) {
    return new Response("ingest backend error: " + (e?.message || e), { status: 502 });
  }
}
