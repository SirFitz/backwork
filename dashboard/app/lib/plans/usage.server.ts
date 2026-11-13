// What a limited organisation takes in, per 5-minute bucket, and the lookup of its limits.
// Unlimited organisations cost no database read or write per push beyond the cached plan lookup.
import { eq, sql } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { orgBuckets, orgs } from "~/db/schema";
import { cached } from "~/lib/cache.server";
import { isCapped, limitsFor, type Limits } from "./limits";
import { bucketStart, type Bucket } from "./window";

const PLAN_TTL_MS = 30_000;
/** Counters older than this are not needed: nothing is kept longer than the stack's 30-day retention. */
const KEEP_BUCKETS_DAYS = 31;

/** The limits of an organisation, or null when it has none. Cached briefly. */
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

/** Does this organisation hold a rolling window? Only then are its pushes counted. */
export async function isWindowed(orgId: string): Promise<boolean> {
  const l = await orgLimits(orgId);
  return l !== null && isCapped(l);
}

/** Add what a push brought in to its 5-minute bucket. One atomic upsert. */
export async function addToBucket(orgId: string, add: { requests: number; bytes: number }, atMs: number = Date.now()): Promise<void> {
  await db.execute(sql`
    INSERT INTO org_buckets (org_id, bucket, requests, bytes) VALUES (${orgId}, ${bucketStart(atMs)}, ${add.requests}, ${add.bytes})
    ON CONFLICT (org_id, bucket) DO UPDATE
      SET requests = org_buckets.requests + EXCLUDED.requests, bytes = org_buckets.bytes + EXCLUDED.bytes`);
}

/** The organisation's buckets since a time (unix seconds), oldest first. */
export async function loadBuckets(orgId: string, sinceS: number): Promise<Bucket[]> {
  const res = await db.execute(sql`
    SELECT bucket, requests, bytes FROM org_buckets WHERE org_id = ${orgId} AND bucket >= ${sinceS} ORDER BY bucket`);
  return (res.rows as Array<{ bucket: string | number; requests: string | number; bytes: string | number }>).map((r) => ({
    startS: Number(r.bucket),
    requests: Number(r.requests),
    bytes: Number(r.bytes),
  }));
}

/** Forget counters older than a time (unix seconds): what they counted has been deleted. */
export async function pruneBuckets(orgId: string, beforeS: number): Promise<void> {
  await db.execute(sql`DELETE FROM org_buckets WHERE org_id = ${orgId} AND bucket < ${beforeS}`);
}

/** The oldest counters worth loading. */
export function bucketsSince(nowMs: number): number {
  return Math.floor(nowMs / 1000) - KEEP_BUCKETS_DAYS * 86400;
}
