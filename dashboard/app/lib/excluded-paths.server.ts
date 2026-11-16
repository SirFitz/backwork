// Excluded paths (BAC-82): storage, scope resolution and audit. Matching rules are in
// `excluded-paths.ts` (pure, shared with the agent config generator).
//
// Scopes are those of the switches: a row with `projectId = null` applies to every project of the
// organisation; `projectId` set applies to that project only. A project's effective list is the
// organisation's rows plus its own.

import { and, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { excludedPaths } from "~/db/schema";
import { logAudit } from "./audit.server";
import {
  ExcludedPathError,
  MAX_EXCLUDED_PATHS,
  compileExcludedPaths,
  normalizeExcludedPath,
  validateExcludedPath,
  type ExcludedPathMatcher,
} from "./excluded-paths";

/** Audit actions written on add and remove. */
export const ExcludedPathAudit = {
  Add: "excluded_path.add",
  Remove: "excluded_path.remove",
} as const;
export type ExcludedPathAudit = (typeof ExcludedPathAudit)[keyof typeof ExcludedPathAudit];

export interface ExcludedPathRow {
  id: string;
  orgId: string;
  /** null = every project of the organisation. */
  projectId: string | null;
  pattern: string;
  createdBy: string | null;
  createdAt: Date;
}

/** Thrown with an ExcludedPathError code as its message. */
export class ExcludedPathRefused extends Error {
  constructor(readonly code: ExcludedPathError) {
    super(code);
  }
}

/** Pure: the patterns that apply to one project (organisation rows first, then the project's), deduplicated. */
export function effectiveExcludedPaths(rows: readonly ExcludedPathRow[], projectId: string | null): string[] {
  const ordered = [...rows]
    .filter((r) => r.projectId === null || (projectId !== null && r.projectId === projectId))
    .sort((a, b) => (a.projectId === null) !== (b.projectId === null) ? (a.projectId === null ? -1 : 1) : a.pattern.localeCompare(b.pattern));
  return [...new Set(ordered.map((r) => r.pattern))];
}

const CACHE_TTL_MS = 10_000;
const rowCache = new Map<string, { at: number; rows: ExcludedPathRow[] }>();

/** Every excluded path of an organisation, all scopes. Cached 10 s for the ingest path. */
export async function getExcludedPaths(orgId: string, opts: { fresh?: boolean } = {}): Promise<ExcludedPathRow[]> {
  const hit = rowCache.get(orgId);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  await ensureSchema();
  const rows: ExcludedPathRow[] = await db
    .select({
      id: excludedPaths.id,
      orgId: excludedPaths.orgId,
      projectId: excludedPaths.projectId,
      pattern: excludedPaths.pattern,
      createdBy: excludedPaths.createdBy,
      createdAt: excludedPaths.createdAt,
    })
    .from(excludedPaths)
    .where(eq(excludedPaths.orgId, orgId));
  rowCache.set(orgId, { at: Date.now(), rows });
  return rows;
}

/** Compiled patterns for one project (ingest path). */
export async function getExcludedPathMatcher(orgId: string, projectId: string | null): Promise<ExcludedPathMatcher> {
  return compileExcludedPaths(effectiveExcludedPaths(await getExcludedPaths(orgId), projectId));
}

function scopeWhere(orgId: string, projectId: string | null) {
  return and(eq(excludedPaths.orgId, orgId), projectId === null ? isNull(excludedPaths.projectId) : eq(excludedPaths.projectId, projectId));
}

/**
 * Add a pattern at one scope and write the audit log. Callers must have checked the user may
 * manage data controls, and that `projectId` belongs to the organisation. Throws
 * ExcludedPathRefused on an invalid pattern, a duplicate, or a full list.
 */
export async function addExcludedPath(
  orgId: string,
  projectId: string | null,
  input: string,
  userId: string,
  request?: Request,
): Promise<string> {
  const pattern = normalizeExcludedPath(input);
  const err = validateExcludedPath(pattern);
  if (err) throw new ExcludedPathRefused(err);
  await ensureSchema();
  const existing = await db.select({ pattern: excludedPaths.pattern }).from(excludedPaths).where(scopeWhere(orgId, projectId));
  if (existing.some((e) => e.pattern === pattern)) throw new ExcludedPathRefused(ExcludedPathError.Duplicate);
  if (existing.length >= MAX_EXCLUDED_PATHS) throw new ExcludedPathRefused(ExcludedPathError.TooMany);
  const res = await db.execute(sql`INSERT INTO excluded_paths (id, org_id, project_id, pattern, created_by, created_at)
    VALUES (${ulid()}, ${orgId}, ${projectId}, ${pattern}, ${userId}, now())
    ON CONFLICT (org_id, (coalesce(project_id, '')), pattern) DO NOTHING`);
  rowCache.delete(orgId);
  if ((res.rowCount ?? 0) === 0) throw new ExcludedPathRefused(ExcludedPathError.Duplicate);
  await logAudit({ request, orgId, actorUserId: userId, action: ExcludedPathAudit.Add, target: { pattern, projectId } });
  return pattern;
}

/** Remove a pattern from one scope and write the audit log. Returns whether a row was removed. */
export async function removeExcludedPath(
  orgId: string,
  projectId: string | null,
  pattern: string,
  userId: string,
  request?: Request,
): Promise<boolean> {
  await ensureSchema();
  const removed = await db
    .delete(excludedPaths)
    .where(and(scopeWhere(orgId, projectId), eq(excludedPaths.pattern, pattern)))
    .returning({ id: excludedPaths.id });
  rowCache.delete(orgId);
  if (!removed.length) return false;
  await logAudit({ request, orgId, actorUserId: userId, action: ExcludedPathAudit.Remove, target: { pattern, projectId } });
  return true;
}
