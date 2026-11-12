import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { projects } from "~/db/schema";

// The platform org owns backwork's own telemetry (the stack collector reads only
// backwork's containers, which carry no org_id). It is UNFILTERED: it sees every
// series and stream. Every other org is scoped to its own org_id label, stamped
// at ingest and filtered at query time.
export type Tenant = { orgId: string; platform: boolean };

export function platformOrgId(): string {
  return process.env.PLATFORM_ORG_ID || "";
}

export function tenantOf(orgId: string): Tenant {
  return { orgId, platform: orgId === platformOrgId() };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Resolve an ingest bearer token to its org + project.
 *  Falls back to the legacy global INGEST_TOKEN → platform org. */
export async function resolveIngestToken(token: string): Promise<{ orgId: string; projectId: string | null; project: string } | null> {
  if (!token) return null;
  const legacy = process.env.INGEST_TOKEN;
  if (legacy && token === legacy) {
    return { orgId: platformOrgId(), projectId: null, project: "platform" };
  }
  await ensureSchema();
  const hash = hashToken(token);
  const rows = await db.select().from(projects).where(eq(projects.ingestTokenHash, hash)).limit(1);
  if (!rows.length) return null;
  return { orgId: rows[0].orgId, projectId: rows[0].id, project: rows[0].slug };
}
