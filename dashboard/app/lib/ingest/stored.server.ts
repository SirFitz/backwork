/**
 * What follows once enforced lines are stored, for every ingest path (the agent's Loki push,
 * the records intake, OTLP logs): error groups derived from the kept lines (BAC-85) and the
 * organisation's metered intake (the Usage page and, for a capped plan, the rolling window).
 * Called only after the store accepted the lines, so a retried post is not counted twice.
 */
import { isCapped } from "~/lib/plans/limits";
import { addToBucket, addToDaily, orgLimits } from "~/lib/plans/usage.server";
import { derivedErrorSink } from "~/lib/errors-store.server";
import type { EnforceResult } from "~/lib/ingest/enforce.server";

/** The tenant an ingest token resolves to (resolveIngestToken). */
export interface IngestTenant {
  orgId: string;
  projectId: string | null;
  /** Project slug, stamped on every stream and series as `project`. */
  project: string;
}

export async function afterStored(tenant: IngestTenant, result: Pick<EnforceResult, "errors" | "requests" | "bytes">): Promise<void> {
  // Off the request path, never awaited; failures are counted and swallowed inside the sink.
  derivedErrorSink().submit(tenant.orgId, tenant.project, result.errors);
  const limits = await orgLimits(tenant.orgId);
  if (!limits) return;
  const add = { requests: result.requests, bytes: result.bytes };
  await addToDaily(tenant.orgId, add).catch(() => undefined);
  if (isCapped(limits)) await addToBucket(tenant.orgId, add).catch(() => undefined);
}
