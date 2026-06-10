import { redirect } from "@remix-run/node";
import { eq } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { users, memberships, orgs, type Role, ROLE_RANK } from "~/db/schema";
import { getAuthSession } from "./session.server";

export type SessionUser = typeof users.$inferSelect;
export type OrgMembership = { orgId: string; orgName: string; orgSlug: string; role: Role };

export async function getUser(request: Request): Promise<SessionUser | null> {
  await ensureSchema();
  const s = await getAuthSession(request);
  const uid = s.get("userId");
  if (!uid) return null;
  const rows = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  const user = rows[0];
  if (!user) return null;
  // server-side session revocation: a logout or password change bumps the user's
  // token_version, invalidating older cookies. Sessions issued before this
  // feature (no "tv") are treated as stale and must re-authenticate once.
  if ((s.get("tv") ?? -1) !== user.tokenVersion) return null;
  return user;
}

async function loadMemberships(userId: string): Promise<OrgMembership[]> {
  return db
    .select({ orgId: orgs.id, orgName: orgs.name, orgSlug: orgs.slug, role: memberships.role })
    .from(memberships)
    .innerJoin(orgs, eq(memberships.orgId, orgs.id))
    .where(eq(memberships.userId, userId));
}

export async function requireUser(request: Request) {
  const user = await getUser(request);
  if (!user) {
    const next = new URL(request.url).pathname + new URL(request.url).search;
    throw redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return { user, memberships: await loadMemberships(user.id) };
}

export type OrgContext = {
  user: SessionUser;
  memberships: OrgMembership[];
  org: { id: string; name: string; slug: string };
  role: Role;
};

export async function requireOrg(request: Request): Promise<OrgContext> {
  const { user, memberships: mems } = await requireUser(request);
  if (mems.length === 0) throw redirect("/onboarding");
  const s = await getAuthSession(request);
  const activeId = s.get("activeOrgId");
  const active = mems.find((m) => m.orgId === activeId) ?? mems[0];
  return {
    user,
    memberships: mems,
    org: { id: active.orgId, name: active.orgName, slug: active.orgSlug },
    role: active.role,
  };
}

export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function requireRole(ctx: OrgContext, min: Role) {
  if (!hasRole(ctx.role, min)) {
    throw new Response("Forbidden: requires " + min, { status: 403 });
  }
}
