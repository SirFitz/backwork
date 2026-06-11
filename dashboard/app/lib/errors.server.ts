import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { errorGroups, errorEvents } from "~/db/schema";

export type ErrStatus = "open" | "resolved" | "ignored";
const LEVELS = ["fatal", "error", "warning", "info"];

// Normalize a message so near-identical errors group together: collapse numbers,
// hex, and UUIDs that vary per occurrence.
function normMsg(m: string): string {
  return m
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "<uuid>")
    .replace(/0x[0-9a-fA-F]+/g, "0x<hex>")
    .replace(/\b\d[\d.,]*\b/g, "<n>")
    .trim()
    .slice(0, 400);
}

// First meaningful stack frame, with line/col numbers stripped (they shift).
function topFrame(stack: string): string {
  const line = stack
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.startsWith("at ") || /\.(jsx?|tsx?|mjs|cjs|py|rb|go|java|ex|exs):\d+/.test(s));
  return (line || "").replace(/:\d+(:\d+)?/g, "").replace(/\b\d+\b/g, "").slice(0, 300);
}

export function fingerprintFor(type: string, message: string, stack: string): string {
  return createHash("sha256")
    .update(`${type}|${normMsg(message)}|${topFrame(stack || "")}`)
    .digest("hex")
    .slice(0, 32);
}

function asStack(s: unknown): string {
  if (typeof s === "string") return s.slice(0, 20000);
  if (Array.isArray(s)) return s.map(String).join("\n").slice(0, 20000);
  return "";
}

export type IncomingError = Record<string, unknown>;

/** Upsert one error occurrence into its group (best-effort caller can ignore failures). */
export async function recordError(orgId: string, project: string, raw: IncomingError): Promise<{ groupId: string }> {
  await ensureSchema();
  const type = String(raw.type ?? raw.name ?? raw.exception ?? "Error").slice(0, 200) || "Error";
  const message = String(raw.message ?? raw.msg ?? raw.value ?? "").slice(0, 2000);
  const stack = asStack(raw.stack ?? raw.stacktrace ?? raw.trace);
  const service = String(raw.service ?? raw.serviceName ?? raw.logger ?? "").slice(0, 200);
  const levelRaw = String(raw.level ?? raw.severity ?? "error").toLowerCase();
  const level = LEVELS.includes(levelRaw) ? levelRaw : "error";
  const fp = String(raw.fingerprint || fingerprintFor(type, message, stack)).slice(0, 200);
  const now = new Date();
  const sample = {
    type, message, stack, service, level,
    context: raw.context ?? raw.meta ?? raw.extra ?? raw.tags ?? {},
    release: raw.release ?? null,
    environment: raw.environment ?? raw.env ?? null,
    url: raw.url ?? null,
    at: now.toISOString(),
  };

  const up = await db
    .insert(errorGroups)
    .values({ id: ulid(), orgId, project, fingerprint: fp, type, message, service, level, status: "open", count: 1, sample, firstSeen: now, lastSeen: now })
    .onConflictDoUpdate({
      target: [errorGroups.orgId, errorGroups.fingerprint],
      set: {
        count: sql`${errorGroups.count} + 1`,
        lastSeen: now,
        sample, message, type, service, level,
        // a fresh occurrence reopens a resolved group (regression); 'ignored' stays muted
        status: sql`CASE WHEN ${errorGroups.status} = 'ignored' THEN 'ignored' ELSE 'open' END`,
      },
    })
    .returning({ id: errorGroups.id });

  const groupId = up[0].id;
  await db.insert(errorEvents).values({ id: ulid(), groupId, orgId, payload: sample });
  return { groupId };
}

export type ErrGroupRow = {
  id: string; project: string; fingerprint: string; type: string; message: string;
  service: string; level: string; status: ErrStatus; count: number;
  firstSeen: Date; lastSeen: Date; sample: Record<string, unknown>;
};

export async function listErrorGroups(orgId: string, opts: { status?: string; service?: string; limit?: number } = {}): Promise<ErrGroupRow[]> {
  await ensureSchema();
  const conds = [eq(errorGroups.orgId, orgId)];
  if (opts.status && opts.status !== "all") conds.push(eq(errorGroups.status, opts.status as ErrStatus));
  if (opts.service && opts.service !== "all") conds.push(eq(errorGroups.service, opts.service));
  const rows = await db.select().from(errorGroups).where(and(...conds)).orderBy(desc(errorGroups.lastSeen)).limit(opts.limit ?? 100);
  return rows as unknown as ErrGroupRow[];
}

export async function errorStatusCounts(orgId: string): Promise<Record<string, number>> {
  await ensureSchema();
  const rows = await db
    .select({ status: errorGroups.status, n: sql<number>`count(*)::int` })
    .from(errorGroups)
    .where(eq(errorGroups.orgId, orgId))
    .groupBy(errorGroups.status);
  const out: Record<string, number> = { all: 0, open: 0, resolved: 0, ignored: 0 };
  for (const r of rows) { out[r.status] = r.n; out.all += r.n; }
  return out;
}

export async function errorServices(orgId: string): Promise<string[]> {
  await ensureSchema();
  const rows = await db
    .selectDistinct({ service: errorGroups.service })
    .from(errorGroups)
    .where(eq(errorGroups.orgId, orgId));
  return rows.map((r) => r.service).filter(Boolean).sort();
}

export async function getErrorGroup(orgId: string, id: string): Promise<ErrGroupRow | null> {
  await ensureSchema();
  const rows = await db.select().from(errorGroups).where(and(eq(errorGroups.id, id), eq(errorGroups.orgId, orgId))).limit(1);
  return (rows[0] as unknown as ErrGroupRow) ?? null;
}

export async function recentEvents(orgId: string, groupId: string, limit = 25): Promise<Array<{ id: string; createdAt: Date; payload: Record<string, unknown> }>> {
  await ensureSchema();
  const rows = await db
    .select({ id: errorEvents.id, createdAt: errorEvents.createdAt, payload: errorEvents.payload })
    .from(errorEvents)
    .where(and(eq(errorEvents.groupId, groupId), eq(errorEvents.orgId, orgId)))
    .orderBy(desc(errorEvents.createdAt))
    .limit(limit);
  return rows as Array<{ id: string; createdAt: Date; payload: Record<string, unknown> }>;
}

/** Returns the number of groups updated (0 = not found / not this org → caller can 404). */
export async function setErrorStatus(orgId: string, id: string, status: ErrStatus): Promise<number> {
  await ensureSchema();
  const res = await db.update(errorGroups).set({ status }).where(and(eq(errorGroups.id, id), eq(errorGroups.orgId, orgId))).returning({ id: errorGroups.id });
  return res.length;
}
