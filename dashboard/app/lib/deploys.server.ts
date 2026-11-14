// Deploy markers (BAC-73, insights plan 06 section B): the `deploys` table (created in the
// foundation's DDL), the report endpoint's handling and the reads the Performance Trend card,
// the Overview and the read API use. Validation is pure (`deploys.ts`).

import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { resolveIngestToken, tenantOf } from "~/lib/tenant.server";
import { rateLimit } from "~/lib/auth/security.server";
import { serviceNamesWithin } from "~/lib/service-names.server";
import { canonicalName } from "~/lib/service-names";
import {
  DEPLOY_RATE_LIMIT_CALLS,
  DEPLOY_RATE_LIMIT_WINDOW_MS,
  parseDeployPayload,
  type Deploy,
  type ValidDeploy,
} from "~/lib/deploys";
export * from "~/lib/deploys";

/** How long a report waits for the service-name map before storing the name as sent. */
export const NAMES_WAIT_MS = 1500;
/** Rows the read API returns by default, and at most. */
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/** Audit action names of this feature. */
export const DeployAuditAction = { Delete: "deploy.delete" } as const;
export type DeployAuditAction = (typeof DeployAuditAction)[keyof typeof DeployAuditAction];

interface DeployDbRow extends Record<string, unknown> {
  id: string;
  project_id: string | null;
  service: string;
  version: string | null;
  commit_sha: string | null;
  environment: string | null;
  url: string | null;
  actor: string | null;
  deployed_at: Date | string;
}

function toDeploy(r: DeployDbRow): Deploy {
  return {
    id: r.id,
    projectId: r.project_id,
    service: r.service,
    version: r.version,
    commit: r.commit_sha,
    environment: r.environment,
    url: r.url,
    actor: r.actor,
    deployedAt: new Date(r.deployed_at).getTime(),
  };
}

const COLUMNS = sql`id, project_id, service, version, commit_sha, environment, url, actor, deployed_at`;

// ---------------------------------------------------------------- writes

/**
 * Store validated reports. A report whose commit is already stored for the same service (or
 * repeated within the call) is ignored. Returns how many rows were added.
 */
export async function recordDeploys(orgId: string, projectId: string | null, deploys: readonly ValidDeploy[]): Promise<number> {
  await ensureSchema();
  let added = 0;
  for (const d of deploys) {
    const at = new Date(d.atMs).toISOString();
    const res = await db.execute(sql`
      INSERT INTO deploys (id, org_id, project_id, service, version, commit_sha, environment, url, actor, deployed_at)
      SELECT ${ulid()}, ${orgId}, ${projectId}, ${d.service}, ${d.version}, ${d.commit}, ${d.environment}, ${d.url}, ${d.actor}, ${at}::timestamptz
      WHERE ${d.commit}::text IS NULL OR NOT EXISTS (
        SELECT 1 FROM deploys WHERE org_id = ${orgId} AND service = ${d.service} AND commit_sha = ${d.commit})`);
    added += res.rowCount ?? 0;
  }
  return added;
}

/** Delete one deploy of this organisation; true when a row went. */
export async function deleteDeploy(orgId: string, id: string): Promise<boolean> {
  await ensureSchema();
  const res = await db.execute(sql`DELETE FROM deploys WHERE org_id = ${orgId} AND id = ${id}`);
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------- reads

/** Deploys between two instants (ms, inclusive), oldest first; every service when `service` is null. */
export async function deploysBetween(orgId: string, service: string | null, fromMs: number, toMs: number): Promise<Deploy[]> {
  await ensureSchema();
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const res = await db.execute<DeployDbRow>(sql`
    SELECT ${COLUMNS} FROM deploys
    WHERE org_id = ${orgId} AND deployed_at >= ${from}::timestamptz AND deployed_at <= ${to}::timestamptz
      AND (${service}::text IS NULL OR service = ${service})
    ORDER BY deployed_at ASC, id ASC`);
  return res.rows.map(toDeploy);
}

/** The newest deploy of one service, or null. */
export async function latestDeploy(orgId: string, service: string): Promise<Deploy | null> {
  await ensureSchema();
  const res = await db.execute<DeployDbRow>(sql`
    SELECT ${COLUMNS} FROM deploys WHERE org_id = ${orgId} AND service = ${service}
    ORDER BY deployed_at DESC, id DESC LIMIT 1`);
  return res.rows[0] ? toDeploy(res.rows[0]) : null;
}

export interface DeployFilter {
  service: string | null;
  /** ms; only deploys at or after it */
  sinceMs: number | null;
  /** only this project's deploys */
  projectId?: string | null;
  limit: number;
}

/** Newest first, for the read API and the Projects page. */
export async function listDeploys(orgId: string, f: DeployFilter): Promise<Deploy[]> {
  await ensureSchema();
  const since = f.sinceMs === null ? null : new Date(f.sinceMs).toISOString();
  const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(f.limit)));
  const projectId = f.projectId ?? null;
  const res = await db.execute<DeployDbRow>(sql`
    SELECT ${COLUMNS} FROM deploys
    WHERE org_id = ${orgId}
      AND (${f.service}::text IS NULL OR service = ${f.service})
      AND (${since}::timestamptz IS NULL OR deployed_at >= ${since}::timestamptz)
      AND (${projectId}::text IS NULL OR project_id = ${projectId})
    ORDER BY deployed_at DESC, id DESC LIMIT ${limit}`);
  return res.rows.map(toDeploy);
}

// ---------------------------------------------------------------- the report endpoint

export interface IngestTenant {
  orgId: string;
  projectId: string | null;
}

/** What the report endpoint needs, injectable for tests. */
export interface DeployIngestDeps {
  resolveToken: (token: string) => Promise<IngestTenant | null>;
  /** source -> service map of the organisation, to store the service's own name */
  names: (orgId: string) => Promise<ReadonlyMap<string, string>>;
  record: (orgId: string, projectId: string | null, deploys: readonly ValidDeploy[]) => Promise<number>;
  limit: (key: string) => { ok: boolean; retryAfter: number };
  now: () => number;
}

export const deployIngestDeps: DeployIngestDeps = {
  resolveToken: resolveIngestToken,
  names: async (orgId) => (await serviceNamesWithin(tenantOf(orgId), NAMES_WAIT_MS)).bySource,
  record: recordDeploys,
  limit: (key) => rateLimit(key, DEPLOY_RATE_LIMIT_CALLS, DEPLOY_RATE_LIMIT_WINDOW_MS),
  now: Date.now,
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** `POST /ingest/deploys` with a project ingest token: validate, map names, store. */
export async function handleDeployIngest(request: Request, deps: DeployIngestDeps = deployIngestDeps): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { allow: "POST" });
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const tenant = token ? await deps.resolveToken(token) : null;
  if (!tenant) return json({ error: "unauthorized" }, 401);

  const limited = deps.limit(`deploy:${tenant.projectId ?? tenant.orgId}`);
  if (!limited.ok) return json({ error: "too many deploy reports, try again later" }, 429, { "retry-after": String(limited.retryAfter) });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const parsed = parseDeployPayload(body, deps.now());
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const bySource = await deps.names(tenant.orgId).catch((): ReadonlyMap<string, string> => new Map());
  const deploys = parsed.deploys.map((d) => ({ ...d, service: canonicalName(d.service, bySource) }));
  const accepted = await deps.record(tenant.orgId, tenant.projectId, deploys);
  return json({ accepted });
}
