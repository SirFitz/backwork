import type { ActionFunctionArgs } from "@remix-run/node";
import { resolveIngestToken } from "~/lib/tenant.server";
import { recordError, type IncomingError } from "~/lib/errors.server";

// Authenticated error-reporting endpoint (CMP-1). Apps POST a JSON exception here
// with their project ingest token; we fingerprint + group it under that tenant.
// Body: a single error object, or { errors: [...] }, or a bare array.
//   { type, message, stack, service, level, context, release, environment, fingerprint? }
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const tenant = await resolveIngestToken(token);
  if (!tenant) return json({ error: "unauthorized" }, 401);

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const list: IncomingError[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.errors)
      ? (parsed as any).errors
      : parsed && typeof parsed === "object"
        ? [parsed as IncomingError]
        : [];

  if (!list.length) return json({ error: "no error objects in payload" }, 400);
  if (list.length > 100) list.length = 100; // bound a single request

  let accepted = 0;
  const ids: string[] = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    try {
      const { groupId } = await recordError(tenant.orgId, tenant.project, e);
      accepted++;
      if (!ids.includes(groupId)) ids.push(groupId);
    } catch {
      /* skip the bad event, keep ingesting the rest */
    }
  }
  return json({ accepted, groups: ids.length });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
