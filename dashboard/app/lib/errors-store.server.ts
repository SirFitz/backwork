/** Postgres side of the derived-error sink (BAC-85): one statement per call, never one per event. */
import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { errorEvents, errorGroups } from "~/db/schema";
import { DerivedErrorSink, type DerivedErrorStore, type EventWrite, type GroupWrite, type UpsertedGroup } from "~/lib/errors-sink";

/** A fresh occurrence reopens a resolved group (regression); an ignored one stays muted. Same rule as recordError. */
const REOPEN = sql`CASE WHEN ${errorGroups.status} = 'ignored' THEN 'ignored' ELSE 'open' END`;

export const pgDerivedErrorStore: DerivedErrorStore = {
  async upsertGroups(orgId: string, project: string, groups: readonly GroupWrite[]): Promise<UpsertedGroup[]> {
    await ensureSchema();
    const rows = await db
      .insert(errorGroups)
      .values(
        groups.map((g) => ({
          id: ulid(), orgId, project, fingerprint: g.fingerprint, source: g.source, type: g.type, message: g.title,
          service: g.service, level: g.level, status: "open" as const, count: g.count,
          sample: g.sample as unknown as Record<string, unknown>, firstSeen: g.firstAt, lastSeen: g.lastAt,
        })),
      )
      .onConflictDoUpdate({
        target: [errorGroups.orgId, errorGroups.project, errorGroups.fingerprint],
        set: {
          count: sql`${errorGroups.count} + excluded.count`,
          lastSeen: sql`greatest(${errorGroups.lastSeen}, excluded.last_seen)`,
          sample: sql`excluded.sample`,
          message: sql`excluded.message`,
          type: sql`excluded.type`,
          level: sql`excluded.level`,
          status: REOPEN,
        },
      })
      .returning({ id: errorGroups.id, fingerprint: errorGroups.fingerprint, inserted: sql<boolean>`(xmax = 0)` });
    return rows.map((r) => ({ id: r.id, fingerprint: r.fingerprint, inserted: r.inserted === true }));
  },

  async updateGroups(orgId: string, project: string, groups: readonly GroupWrite[]): Promise<UpsertedGroup[]> {
    await ensureSchema();
    const data = JSON.stringify(
      groups.map((g) => ({ fingerprint: g.fingerprint, n: g.count, last_seen: g.lastAt.toISOString(), sample: g.sample, message: g.title, type: g.type })),
    );
    const res = await db.execute<{ id: string; fingerprint: string }>(sql`
      UPDATE error_groups AS g SET
        count = g.count + v.n,
        last_seen = greatest(g.last_seen, v.last_seen),
        sample = v.sample, message = v.message, type = v.type,
        status = CASE WHEN g.status = 'ignored' THEN 'ignored' ELSE 'open' END
      FROM jsonb_to_recordset(${data}::jsonb) AS v(fingerprint text, n integer, last_seen timestamptz, sample jsonb, message text, type text)
      WHERE g.org_id = ${orgId} AND g.project = ${project} AND g.fingerprint = v.fingerprint
      RETURNING g.id, g.fingerprint`);
    return res.rows.map((r) => ({ id: r.id, fingerprint: r.fingerprint, inserted: false }));
  },

  async insertEvents(orgId: string, events: readonly EventWrite[]): Promise<void> {
    await ensureSchema();
    await db.insert(errorEvents).values(
      events.map((e) => ({ id: ulid(), groupId: e.groupId, orgId, source: e.source, createdAt: e.createdAt, payload: e.payload as unknown as Record<string, unknown> })),
    );
  },
};

declare global {
  // eslint-disable-next-line no-var
  var __bwDerivedErrorSink: DerivedErrorSink | undefined;
}

/** The process-wide sink (one per server process, so its caps hold across requests). */
export function derivedErrorSink(): DerivedErrorSink {
  if (!globalThis.__bwDerivedErrorSink) globalThis.__bwDerivedErrorSink = new DerivedErrorSink(pgDerivedErrorStore);
  return globalThis.__bwDerivedErrorSink;
}
