import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { projects } from "~/db/schema";

// The platform org owns backwork's own telemetry (the stack collector reads only
// backwork's containers, which carry no org_id). It is UNFILTERED: it sees every
// series and stream. Every other org is scoped to its own org_id label, stamped
// at ingest and filtered at query time.
//
// BAC-89: a tenant may also carry one project (environment). Every stream and hop series is
// stamped `project=<project slug>` at ingest, so a project-scoped tenant reads only that
// environment. Background jobs (alerts, digests, auto-pins, peer learning) keep using the
// org-wide tenant.
export type Tenant = {
  orgId: string;
  platform: boolean;
  /** The project slug every read is limited to; absent or null = the whole organisation. */
  project?: string | null;
};

export function platformOrgId(): string {
  return process.env.PLATFORM_ORG_ID || "";
}

/** The tenant for an organisation, optionally limited to one project (by slug). The platform
 *  org is never limited: its own telemetry carries no org or project labels. */
export function tenantOf(orgId: string, project?: string | null): Tenant {
  const platform = orgId === platformOrgId();
  return platform || !project ? { orgId, platform } : { orgId, platform, project };
}

/** A stable cache key part for a tenant: what it can read, so two scopes never share a cache entry. */
export function tenantKey(t: Tenant): string {
  if (t.platform) return "platform";
  return t.project ? `${t.orgId}/${t.project}` : t.orgId;
}

/** The label matchers that scope a selector to this tenant (empty for the platform org). */
export function scopeMatchers(t: Tenant): string[] {
  if (t.platform) return [];
  const m = [`org_id=${JSON.stringify(t.orgId)}`];
  if (t.project) m.push(`project=${JSON.stringify(t.project)}`);
  return m;
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
