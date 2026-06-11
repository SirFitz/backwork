import type { LoaderFunctionArgs } from "@remix-run/node";
import { eq } from "drizzle-orm";
import { db } from "~/db/index.server";
import { orgs } from "~/db/schema";
import { requireApiKey, apiJson } from "~/lib/apikey.server";

// GET /api/v1/me — verify a key + see which org it belongs to.
export async function loader({ request }: LoaderFunctionArgs) {
  const { orgId } = await requireApiKey(request);
  const o = await db.select({ id: orgs.id, name: orgs.name, slug: orgs.slug }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  return apiJson({ ok: true, org: o[0] ?? { id: orgId } });
}
