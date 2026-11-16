import { describe, expect, test } from "bun:test";

// Storage, audit and the agent snapshot for excluded paths (BAC-82), against a real Postgres.
// Skipped without one; run as the DDL test is:
//   DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test app/lib/excluded-paths.server.test.ts
const url = process.env.USAGE_TEST_DATABASE_URL;
const ready = !!url && process.env.DATABASE_URL === url;

describe("excluded paths store", () => {
  test.skipIf(!ready)("add, refuse duplicates and a full list, audit, snapshot, remove", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { orgs, projects, users, auditLog } = await import("~/db/schema");
    const { and, eq, like } = await import("drizzle-orm");
    const { ulid } = await import("ulid");
    const store = await import("./excluded-paths.server");
    const { controlsSnapshot } = await import("./controls.server");
    const { ExcludedPathError, MAX_EXCLUDED_PATHS } = await import("./excluded-paths");
    await ensureSchema();

    const orgId = ulid();
    const p1 = ulid();
    const p2 = ulid();
    const userId = ulid();
    await db.insert(users).values({ id: userId, email: `${userId}@example.test`, passwordHash: "x" });
    await db.insert(orgs).values({ id: orgId, name: "Paths test", slug: `paths-${orgId.toLowerCase()}` });
    await db.insert(projects).values([
      { id: p1, orgId, name: "production", slug: "production" },
      { id: p2, orgId, name: "staging", slug: "staging" },
    ]);
    try {
      const before = await controlsSnapshot(orgId, p1);
      expect(before.excludedPaths).toEqual([]);

      expect(await store.addExcludedPath(orgId, p1, "  /sinktest ", userId)).toBe("/sinktest");
      await store.addExcludedPath(orgId, null, "/health", userId);
      const refused = async (projectId: string | null, p: string): Promise<string> =>
        store.addExcludedPath(orgId, projectId, p, userId).then(() => "added", (e: unknown) => (e instanceof store.ExcludedPathRefused ? e.code : String(e)));
      expect(await refused(p1, "/sinktest")).toBe(ExcludedPathError.Duplicate);
      expect(await refused(p1, "sinktest")).toBe(ExcludedPathError.NoSlash);
      expect(await refused(p1, "/*")).toBe(ExcludedPathError.MatchesEverything);
      // The same path at another scope is its own entry.
      expect(await refused(p2, "/sinktest")).toBe("added");

      const snap = await controlsSnapshot(orgId, p1);
      expect(snap.excludedPaths).toEqual(["/health", "/sinktest"]);
      expect(snap.version).not.toBe(before.version);
      expect((await controlsSnapshot(orgId, p2)).excludedPaths).toEqual(["/health", "/sinktest"]);

      const audit = await db.select().from(auditLog).where(and(eq(auditLog.orgId, orgId), like(auditLog.action, "excluded_path.%")));
      expect(audit.filter((a) => a.action === store.ExcludedPathAudit.Add)).toHaveLength(3);

      // The cap is per scope.
      for (let i = 0; i < MAX_EXCLUDED_PATHS - 1; i++) await store.addExcludedPath(orgId, p2, `/fill/${i}`, userId);
      expect(await refused(p2, "/one-too-many")).toBe(ExcludedPathError.TooMany);
      expect(await refused(p1, "/still-room")).toBe("added");

      expect(await store.removeExcludedPath(orgId, p1, "/sinktest", userId)).toBe(true);
      expect(await store.removeExcludedPath(orgId, p1, "/sinktest", userId)).toBe(false);
      const after = await controlsSnapshot(orgId, p1);
      expect(after.excludedPaths).toEqual(["/health", "/still-room"]);
      const removed = await db.select().from(auditLog).where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, store.ExcludedPathAudit.Remove)));
      expect(removed).toHaveLength(1);
      expect(removed[0].target).toEqual({ pattern: "/sinktest", projectId: p1 });
    } finally {
      await db.delete(orgs).where(eq(orgs.id, orgId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});
