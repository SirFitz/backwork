import { describe, expect, test } from "bun:test";
import path from "node:path";

// The claim is SQL, so it runs against a real Postgres:
// DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test <this file>
const url = process.env.USAGE_TEST_DATABASE_URL;
const ready = !!url && process.env.DATABASE_URL === url;

const NOW = Date.UTC(2026, 10, 16, 8, 5);
const HOUR = 3_600_000;
const DASHBOARD = path.resolve(import.meta.dir, "../../..");

/** Claims from a second OS process (its own pool), as a second dashboard would. */
async function claimsFromOtherProcess(org: string, period: string, nowMs: number, n: number): Promise<number> {
  const code = `
    const { claimRun } = await import("./app/lib/digest/store.server.ts");
    const r = await Promise.all(Array.from({ length: ${n} }, () => claimRun(${JSON.stringify(org)}, ${JSON.stringify(period)}, ${nowMs})));
    console.log("WON=" + r.filter(Boolean).length);
    process.exit(0);`;
  const proc = Bun.spawn(["bun", "-e", code], { cwd: DASHBOARD, env: process.env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const m = out.match(/WON=(\d+)/);
  if (!m) throw new Error(`child failed: ${out} ${await new Response(proc.stderr).text()}`);
  return Number(m[1]);
}

describe("digest_runs claims", () => {
  test.skipIf(!ready)("two processes claiming at once: exactly one winner", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    const st = await import("./store.server");
    await ensureSchema();
    const org = `digest-test-${Date.now()}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'Digest test', ${org})`);
    try {
      const [here, there] = await Promise.all([
        Promise.all(Array.from({ length: 8 }, () => st.claimRun(org, "2026-11-16", NOW))),
        claimsFromOtherProcess(org, "2026-11-16", NOW, 8),
      ]);
      expect(here.filter(Boolean).length + there).toBe(1);
      const rows = await db.execute(sql`SELECT attempts FROM digest_runs WHERE org_id = ${org}`);
      expect(rows.rows).toEqual([{ attempts: 1 }]);
      // the other process does claim when it is alone (so the race above counted it)
      expect(await claimsFromOtherProcess(org, "2026-11-23", NOW, 4)).toBe(1);
    } finally {
      await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`);
    }
  }, 60_000);

  test.skipIf(!ready)("a failed send is retried after an hour, at most 3 attempts; sent runs never again; next week is new", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    const st = await import("./store.server");
    const { DELIVERY_OK } = await import("./delivery");
    await ensureSchema();
    const org = `digest-retry-${Date.now()}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'Digest retry', ${org})`);
    try {
      const p = "2026-11-16";
      const first = await st.claimRun(org, p, NOW);
      expect(first?.run.attempts).toBe(1);
      const failed = { "channel:a": DELIVERY_OK, "channel:b": "HTTP 500" };
      const f1 = await st.finishRun(org, p, failed, NOW, "no destinations");
      expect(f1?.sentAt).toBeNull();
      expect(JSON.parse(f1?.error ?? "{}")).toEqual(failed);

      // not before an hour
      expect(await st.claimRun(org, p, NOW + 59 * 60_000)).toBeNull();
      // after an hour: second attempt, with the earlier answers
      const second = await st.claimRun(org, p, NOW + HOUR);
      expect(second?.run.attempts).toBe(2);
      expect(second?.previous).toEqual(failed);
      // the same hour again: already claimed
      expect(await st.claimRun(org, p, NOW + HOUR)).toBeNull();
      await st.finishRun(org, p, failed, NOW + HOUR, "x");
      const third = await st.claimRun(org, p, NOW + 2 * HOUR);
      expect(third?.run.attempts).toBe(3);
      await st.finishRun(org, p, failed, NOW + 2 * HOUR, "x");
      // three attempts: never again
      expect(await st.claimRun(org, p, NOW + 5 * HOUR)).toBeNull();

      // a sent week is never claimed again
      const p2 = "2026-11-23";
      expect((await st.claimRun(org, p2, NOW + 7 * 24 * HOUR))?.run.attempts).toBe(1);
      const sent = await st.finishRun(org, p2, { "channel:a": DELIVERY_OK }, NOW + 7 * 24 * HOUR, "x");
      expect(sent?.sentAt).toBe(NOW + 7 * 24 * HOUR);
      expect(sent?.error).toBeNull();
      expect(await st.claimRun(org, p2, NOW + 9 * 24 * HOUR)).toBeNull();
      expect((await st.lastRun(org))?.periodStart).toBe(p2);
      expect((await st.lastSentRun(org))?.periodStart).toBe(p2);

      // a run that stopped mid-send (no sent_at, no error) is not claimed again
      const p3 = "2026-11-30";
      await st.claimRun(org, p3, NOW + 14 * 24 * HOUR);
      expect(await st.claimRun(org, p3, NOW + 14 * 24 * HOUR + 2 * HOUR)).toBeNull();
    } finally {
      await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`);
    }
  }, 60_000);

  test.skipIf(!ready)("settings round trip; owners and admins only; error counts this week", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    const st = await import("./store.server");
    await ensureSchema();
    const org = `digest-set-${Date.now()}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'Digest settings', ${org})`);
    const users = ["o", "a", "m"].map((r) => `${org}-${r}`);
    try {
      expect(await st.loadDigestSettings(org)).toEqual({ enabled: false, channelIds: [], emailAdmins: false, weekday: 1, hourUtc: 8 });
      await st.saveDigestSettings(org, { enabled: true, channelIds: ["c1"], emailAdmins: true, weekday: 5, hourUtc: 23 }, null);
      expect(await st.loadDigestSettings(org)).toEqual({ enabled: true, channelIds: ["c1"], emailAdmins: true, weekday: 5, hourUtc: 23 });
      expect((await st.enabledDigests()).find((d) => d.orgId === org)?.orgName).toBe("Digest settings");

      for (const [i, role] of ["owner", "admin", "member"].entries()) {
        await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${users[i]}, ${`${users[i]}@example.test`}, 'x')`);
        await db.execute(sql`INSERT INTO memberships (id, user_id, org_id, role) VALUES (${`${users[i]}-m`}, ${users[i]}, ${org}, ${role})`);
      }
      expect((await st.ownerAndAdminEmails(org)).map((r) => r.userId).sort()).toEqual([users[1], users[0]].sort());

      await db.execute(sql`INSERT INTO error_groups (id, org_id, fingerprint) VALUES (${`${org}-g`}, ${org}, 'fp')`);
      await db.execute(sql`INSERT INTO error_events (id, group_id, org_id, created_at) VALUES
        (${`${org}-e1`}, ${`${org}-g`}, ${org}, now()), (${`${org}-e2`}, ${`${org}-g`}, ${org}, now() - interval '10 days')`);
      const counts = await st.errorCountsSince(org, [`${org}-g`], Date.now() - 7 * 24 * HOUR);
      expect(counts.get(`${org}-g`)).toBe(1);
      expect((await st.errorCountsSince(org, [], 0)).size).toBe(0);
    } finally {
      await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`);
      for (const u of users) await db.execute(sql`DELETE FROM users WHERE id = ${u}`);
    }
  }, 60_000);
});
