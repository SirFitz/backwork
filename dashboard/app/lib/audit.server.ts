import { desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { auditLog } from "~/db/schema";
import { clientIp } from "./auth/security.server";

/** Append an immutable audit-log entry for a sensitive action. Best-effort:
 *  never blocks or fails the action it records (fire-and-forget). */
export async function logAudit(opts: {
  request?: Request;
  orgId?: string | null;
  actorUserId?: string | null;
  action: string;
  target?: Record<string, unknown>;
}): Promise<void> {
  try {
    await ensureSchema();
    await db.insert(auditLog).values({
      id: ulid(),
      orgId: opts.orgId ?? null,
      actorUserId: opts.actorUserId ?? null,
      action: opts.action,
      target: opts.target ?? {},
      ip: opts.request ? clientIp(opts.request) : null,
    });
  } catch {
    /* best-effort */
  }
}

export type AuditRow = {
  id: string;
  action: string;
  target: Record<string, unknown>;
  ip: string | null;
  createdAt: Date;
  actorEmail: string | null;
};

/** Recent audit entries for an org (newest first), with the actor's email joined. */
export async function recentAudit(orgId: string, limit = 100): Promise<AuditRow[]> {
  await ensureSchema();
  const { users } = await import("~/db/schema");
  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      target: auditLog.target,
      ip: auditLog.ip,
      createdAt: auditLog.createdAt,
      actorEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorUserId, users.id))
    .where(eq(auditLog.orgId, orgId))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  return rows as AuditRow[];
}
