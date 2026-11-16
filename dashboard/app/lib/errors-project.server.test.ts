// BAC-89: error groups are per project, and the Errors page reads one project's groups.
// Real Postgres: DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test <this file>
import { describe, expect, test } from "bun:test";
import { ErrorSource } from "./error-kinds";
import type { GroupWrite } from "./errors-sink";

const url = process.env.USAGE_TEST_DATABASE_URL;
const ready = !!url && process.env.DATABASE_URL === url;

describe("error groups by environment", () => {
  test.skipIf(!ready)("the same error in dev and production is two groups; reads filter by project", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    const { recordError, listErrorGroups, errorStatusCounts, errorServices } = await import("./errors.server");
    const { pgDerivedErrorStore } = await import("./errors-store.server");
    await ensureSchema();
    const org = `err-env-test-${Date.now()}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'Err env test', ${org})`);
    try {
      const raw = { type: "TypeError", message: "x is undefined", service: "api", stack: "at f (a.js:1:2)" };
      await recordError(org, "dev", raw);
      await recordError(org, "production", raw);
      await recordError(org, "production", raw);
      await recordError(org, "production", { ...raw, service: "worker", message: "other" });
      const all = await listErrorGroups(org, { status: "all" });
      expect(all).toHaveLength(3);
      const dev = await listErrorGroups(org, { status: "all", project: "dev" });
      expect(dev.map((g) => [g.project, g.count])).toEqual([["dev", 1]]);
      const prod = await listErrorGroups(org, { status: "all", project: "production" });
      expect(prod.map((g) => g.count).sort()).toEqual([1, 2]);
      expect((await errorStatusCounts(org, "production")).all).toBe(2);
      expect((await errorStatusCounts(org)).all).toBe(3);
      expect(await errorServices(org, "dev")).toEqual(["api"]);
      expect(await errorServices(org, "production")).toEqual(["api", "worker"]);

      // the derived-error store keys on the project too
      const now = new Date();
      // A minimal write; the sample's shape does not matter to the grouping key.
      const gw = { fingerprint: "fp-1", source: ErrorSource.Log, type: "Error", title: "boom", service: "api", level: "error", count: 2, sample: {}, firstAt: now, lastAt: now } as unknown as GroupWrite;
      const a = await pgDerivedErrorStore.upsertGroups(org, "dev", [gw]);
      const b = await pgDerivedErrorStore.upsertGroups(org, "production", [gw]);
      expect(a[0].id).not.toBe(b[0].id);
      expect(a[0].inserted && b[0].inserted).toBe(true);
      const u = await pgDerivedErrorStore.updateGroups(org, "production", [gw]);
      expect(u.map((r) => r.id)).toEqual([b[0].id]);
      const rows = await db.execute<{ project: string; count: number }>(sql`SELECT project, count FROM error_groups WHERE org_id = ${org} AND fingerprint = 'fp-1' ORDER BY project`);
      expect(rows.rows.map((r) => [r.project, Number(r.count)])).toEqual([["dev", 2], ["production", 4]]);
    } finally {
      await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`);
    }
  });

  test.skipIf(!ready)("the schema has the per-project unique index and not the old one", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    await ensureSchema();
    const r = await db.execute<{ indexname: string }>(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'error_groups'`);
    const names = r.rows.map((x) => x.indexname);
    expect(names).toContain("error_groups_org_project_fp_uniq");
    expect(names).not.toContain("error_groups_org_fp_uniq");
  });
});
