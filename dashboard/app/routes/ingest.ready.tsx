import { config } from "~/lib/config.server";

// GET /ingest/ready: the readiness check Vector's Loki sink makes at start (it requests
// `<endpoint>/ready`, and the agent's endpoint is `<backwork>/ingest`). Answers 200 when the
// log store behind the ingest proxy is ready, 503 otherwise. No token needed: it says nothing
// about any organisation.
const TIMEOUT_MS = 2000;

export async function loader(): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.lokiUrl}/ready`, { signal: ctrl.signal });
    return text(res.ok ? 200 : 503, res.ok ? "ready" : "log store not ready");
  } catch {
    return text(503, "log store unreachable");
  } finally {
    clearTimeout(timer);
  }
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}
