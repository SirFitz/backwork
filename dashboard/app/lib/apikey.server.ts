import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { apiKeys } from "~/db/schema";
import { hashToken } from "~/lib/tenant.server";

export function newApiKey(): string {
  return "bwk_" + randomBytes(32).toString("hex");
}

/** Resolve a read-API key to its org (best-effort last-used stamp). */
export async function resolveApiKey(token: string): Promise<{ orgId: string; keyId: string } | null> {
  if (!token || !token.startsWith("bwk_")) return null;
  await ensureSchema();
  const rows = await db.select({ id: apiKeys.id, orgId: apiKeys.orgId }).from(apiKeys).where(eq(apiKeys.keyHash, hashToken(token))).limit(1);
  if (!rows.length) return null;
  void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, rows[0].id)).catch(() => {});
  return { orgId: rows[0].orgId, keyId: rows[0].id };
}

export async function createApiKey(orgId: string, name: string, userId: string): Promise<string> {
  await ensureSchema();
  const token = newApiKey();
  await db.insert(apiKeys).values({ id: ulid(), orgId, name: name.slice(0, 80), keyHash: hashToken(token), createdByUserId: userId });
  return token;
}

export async function listApiKeys(orgId: string) {
  await ensureSchema();
  return db
    .select({ id: apiKeys.id, name: apiKeys.name, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .where(eq(apiKeys.orgId, orgId))
    .orderBy(desc(apiKeys.createdAt));
}

/** Returns rows deleted (0 → not found / not this org). */
export async function revokeApiKey(orgId: string, id: string): Promise<number> {
  await ensureSchema();
  const res = await db.delete(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, orgId))).returning({ id: apiKeys.id });
  return res.length;
}

export function apiJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}

/** Bearer read-API auth. Throws a JSON 401 Response when the key is missing/invalid. */
export async function requireApiKey(request: Request): Promise<{ orgId: string }> {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const r = await resolveApiKey(token);
  if (!r) throw apiJson({ error: "unauthorized", hint: "send 'Authorization: Bearer bwk_…' with a key from /api-keys" }, 401);
  return { orgId: r.orgId };
}
