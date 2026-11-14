import { describe, expect, test } from "bun:test";

// Every table and column in schema.ts must be created by the DDL string in index.server.ts
// (BAC-66: two tables were typed in schema.ts and never created). Runs against a real Postgres;
// on a fresh database it proves the DDL alone creates everything. The app's `db` reads
// DATABASE_URL when first imported, so give the same URL for both:
//   DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test app/db/ddl.server.test.ts
const url = process.env.USAGE_TEST_DATABASE_URL;
const ready = !!url && process.env.DATABASE_URL === url;

/** Tables the insights features use (BAC-67), plus the billing tables of BAC-66. */
const REQUIRED = [
  "deploys",
  "alert_state",
  "alert_events",
  "digest_settings",
  "digest_runs",
  "pinned_requests",
  "pin_settings",
  "org_billing",
  "billing_events",
] as const;

describe("schema bootstrap", () => {
  test.skipIf(!ready)("creates every table and column that schema.ts declares", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const schema = await import("~/db/schema");
    const { sql, is } = await import("drizzle-orm");
    const { PgTable, getTableConfig } = await import("drizzle-orm/pg-core");
    await ensureSchema();
    // Running it twice must be harmless (every statement is idempotent).
    globalThis.__bwSchemaReady = undefined;
    await ensureSchema();

    const res = await db.execute(sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
    const rows = res.rows as Array<{ table_name: string; column_name: string }>;
    const columns = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = columns.get(r.table_name) ?? new Set<string>();
      set.add(r.column_name);
      columns.set(r.table_name, set);
    }

    for (const name of REQUIRED) expect(columns.has(name)).toBe(true);

    const missing: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const cfg = getTableConfig(value);
      const have = columns.get(cfg.name);
      if (!have) {
        missing.push(cfg.name);
        continue;
      }
      for (const c of cfg.columns) if (!have.has(c.name)) missing.push(`${cfg.name}.${c.name}`);
    }
    expect(missing).toEqual([]);
  });

  test.skipIf(!ready)("insights rows are removed with their organisation", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    await ensureSchema();
    const org = `ddl-test-${Date.now()}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'DDL test', ${org})`);
    try {
      await db.execute(sql`INSERT INTO deploys (id, org_id, service, deployed_at) VALUES (${`${org}-d`}, ${org}, 'shop-api', now())`);
      await db.execute(sql`INSERT INTO alert_state (org_id, rule_id) VALUES (${org}, 'r1')`);
      await db.execute(sql`INSERT INTO alert_events (id, org_id, rule_id, kind, value) VALUES (${`${org}-e`}, ${org}, 'r1', 'firing', 0.42)`);
      await db.execute(sql`INSERT INTO digest_settings (org_id) VALUES (${org})`);
      await db.execute(sql`INSERT INTO digest_runs (org_id, period_start) VALUES (${org}, '2026-11-16')`);
      await db.execute(sql`INSERT INTO pinned_requests (org_id, trace_id, reason, records) VALUES (${org}, 'abc', 'manual', '[]'::jsonb)`);
      await db.execute(sql`INSERT INTO pin_settings (org_id) VALUES (${org})`);

      const defaults = await db.execute(sql`SELECT weekday, hour_utc, enabled, channel_ids FROM digest_settings WHERE org_id = ${org}`);
      expect(defaults.rows[0]).toEqual({ weekday: 1, hour_utc: 8, enabled: false, channel_ids: [] });
      const claim = await db.execute(sql`INSERT INTO digest_runs (org_id, period_start) VALUES (${org}, '2026-11-16') ON CONFLICT DO NOTHING RETURNING org_id`);
      expect(claim.rows.length).toBe(0);
    } finally {
      await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`);
    }
    for (const table of ["deploys", "alert_state", "alert_events", "digest_settings", "digest_runs", "pinned_requests", "pin_settings"]) {
      const left = await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${org}`);
      expect(left.rows[0]).toEqual({ n: 0 });
    }
  });
});
