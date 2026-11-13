// Usage counters and the gate in front of ingest. Metered organisations only: an unmetered
// organisation costs no database read or write per push.
import { eq, sql } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { orgUsage, orgs } from "~/db/schema";
import { cached } from "~/lib/cache.server";
import { currentPeriod, limitsFor, pausedReason, type Limits, type PausedBecause, type Usage } from "./limits";

const PLAN_TTL_MS = 30_000;
const USAGE_TTL_MS = 5_000;

/** The limits of an organisation, or null when it is not metered. Cached briefly. */
export function orgLimits(orgId: string): Promise<Limits | null> {
  return cached(`plan:${orgId}`, PLAN_TTL_MS, async () => {
    await ensureSchema();
    const rows = await db
      .select({ plan: orgs.plan, requestsLimit: orgs.requestsLimit, storageLimitBytes: orgs.storageLimitBytes })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    return rows.length ? limitsFor(rows[0]) : null;
  });
}

/** What the organisation has collected so far this month. Cached briefly. */
export function orgUsageNow(orgId: string, period: string = currentPeriod()): Promise<Usage> {
  return cached(`usage:${orgId}:${period}`, USAGE_TTL_MS, async () => {
    const rows = await db
      .select({ requests: orgUsage.requests, bytes: orgUsage.bytes })
      .from(orgUsage)
      .where(sql`${orgUsage.orgId} = ${orgId} AND ${orgUsage.period} = ${period}`)
      .limit(1);
    return rows[0] ?? { requests: 0, bytes: 0 };
  });
}

/** Add what a push brought in. One atomic upsert; the totals come back. */
export async function addUsage(orgId: string, add: Usage, period: string = currentPeriod()): Promise<Usage> {
  const res = await db.execute(sql`
    INSERT INTO org_usage (org_id, period, requests, bytes) VALUES (${orgId}, ${period}, ${add.requests}, ${add.bytes})
    ON CONFLICT (org_id, period) DO UPDATE
      SET requests = org_usage.requests + EXCLUDED.requests, bytes = org_usage.bytes + EXCLUDED.bytes, updated_at = now()
    RETURNING requests, bytes`);
  const row = res.rows[0] as { requests: string | number; bytes: string | number };
  return { requests: Number(row.requests), bytes: Number(row.bytes) };
}

export interface Gate {
  limits: Limits | null;
  /** Set when collection is paused for this organisation. */
  paused: PausedBecause | null;
}

/** Is the organisation allowed to push right now? Checked before the body is read. */
export async function gateFor(orgId: string): Promise<Gate> {
  const limits = await orgLimits(orgId);
  if (!limits) return { limits: null, paused: null };
  return { limits, paused: pausedReason(limits, await orgUsageNow(orgId)) };
}
