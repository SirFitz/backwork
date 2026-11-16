// Server side of the environment picker (BAC-89): the org's projects (cached) and the scope a
// data page reads.
import { asc, eq } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { projects } from "~/db/schema";
import { cached } from "~/lib/cache.server";
import { requireOrg, type OrgContext } from "~/lib/auth/context.server";
import { tenantOf, type Tenant } from "~/lib/tenant.server";
import { ENV_COOKIE, ENV_PARAM, EnvSource, parseEnvCookie, pickEnv, readCookie, type EnvChoice, type EnvOption } from "~/lib/env";

/** Projects change rarely (the Projects page); a short cache keeps the shell and every loader off Postgres. */
const OPTIONS_TTL_MS = 30_000;

export function envOptionsKey(orgId: string): string {
  return `env-options:${orgId}`;
}

/** The organisation's projects in creation order. */
export function orgEnvOptions(orgId: string): Promise<EnvOption[]> {
  return cached(envOptionsKey(orgId), OPTIONS_TTL_MS, async () => {
    await ensureSchema();
    return db
      .select({ id: projects.id, slug: projects.slug, name: projects.name })
      .from(projects)
      .where(eq(projects.orgId, orgId))
      .orderBy(asc(projects.createdAt), asc(projects.slug));
  });
}

/** What a data page reads: the tenant limited to the chosen project, and the picker's state. */
export interface Scope {
  tenant: Tenant;
  choice: EnvChoice;
  options: EnvOption[];
  /** The chosen project's slug, or null for organisation-wide reads (no projects, or the platform org). */
  env: string | null;
}

/** The scope for this request. A failure to list projects degrades to organisation-wide reads. */
export async function resolveScope(request: Request, orgId: string): Promise<Scope> {
  const base = tenantOf(orgId);
  if (base.platform) return { tenant: base, choice: { option: null, source: EnvSource.None }, options: [], env: null };
  const options = await orgEnvOptions(orgId).catch((): EnvOption[] => []);
  const url = new URL(request.url);
  const remembered = parseEnvCookie(readCookie(request.headers.get("cookie"), ENV_COOKIE))[orgId];
  const choice = pickEnv(options, url.searchParams.get(ENV_PARAM), remembered);
  const env = choice.option?.slug ?? null;
  return { tenant: tenantOf(orgId, env), choice, options, env };
}

/** requireOrg plus the environment scope: the one call a data page's loader makes. */
export async function requireScope(request: Request): Promise<{ ctx: OrgContext } & Scope> {
  const ctx = await requireOrg(request);
  return { ctx, ...(await resolveScope(request, ctx.org.id)) };
}
