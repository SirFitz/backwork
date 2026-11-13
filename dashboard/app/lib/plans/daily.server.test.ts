import { describe, expect, test } from "bun:test";

// The day counters are SQL, so this runs against a real Postgres. The app's `db` reads DATABASE_URL when
// first imported, so give the same URL for both: DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test <this file>
const url = process.env.USAGE_TEST_DATABASE_URL;
const ready = !!url && process.env.DATABASE_URL === url;

describe("daily intake counters", () => {
  test.skipIf(!ready)("adds up within a UTC day, keeps days apart, and reads the first counted day", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    const { addToDaily, firstCountedDay, loadDaily } = await import("./usage.server");
    await ensureSchema();
    const org = `usage-test-${Date.now()}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'Usage test', ${org})`);
    try {
      expect(await firstCountedDay(org)).toBeNull();
      await addToDaily(org, { requests: 10, bytes: 1_000 }, Date.UTC(2026, 10, 13, 23, 59, 59));
      await addToDaily(org, { requests: 5, bytes: 500 }, Date.UTC(2026, 10, 13, 0, 0, 1));
      await addToDaily(org, { requests: 7, bytes: 70 }, Date.UTC(2026, 10, 14, 0, 0, 0));
      await addToDaily(org, { requests: 99, bytes: 99 }, Date.UTC(2026, 9, 31, 12, 0, 0));
      expect(await loadDaily(org, "2026-11-01")).toEqual([
        { day: "2026-11-13", requests: 15, bytes: 1_500 },
        { day: "2026-11-14", requests: 7, bytes: 70 },
      ]);
      expect(await firstCountedDay(org)).toBe("2026-10-31");
    } finally {
      await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`);
    }
  });
});
