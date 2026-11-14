import { describe, expect, test } from "bun:test";

// The claim is SQL, so it runs against a real Postgres:
// DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test <this file>
const url = process.env.USAGE_TEST_DATABASE_URL;
const ready = !!url && process.env.DATABASE_URL === url;

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

describe("alert_state and alert_events", () => {
  test.skipIf(!ready)("two simultaneous claims have exactly one winner; resolve once; history and delivery recorded", async () => {
    const pg = (await import("pg")).default;
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    const st = await import("./alert-state.server");
    await ensureSchema();
    const org = `alert-test-${Date.now()}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'Alert test', ${org})`);
    // A second pool stands in for a second dashboard process: its own connections.
    const other = new pg.Pool({ connectionString: url, max: 4 });
    try {
      // pending bookkeeping: the first start is kept, a clear empties it
      await st.setPending(org, "r1", NOW - 60_000, 480);
      await st.setPending(org, "r1", NOW, 490);
      expect((await st.loadStates(org)).get("r1")).toMatchObject({ firing: false, pendingSince: NOW - 60_000, value: 490 });

      // Many concurrent claims from both "processes": one winner.
      const viaOther = async (): Promise<boolean> => {
        const c = await other.connect();
        try {
          await c.query("BEGIN");
          const r = await c.query(
            `INSERT INTO alert_state (org_id, rule_id, firing, value, since, last_notified_at, pending_since)
             VALUES ($1, 'r1', true, 1, now(), now(), NULL)
             ON CONFLICT (org_id, rule_id) DO UPDATE SET firing = EXCLUDED.firing, pending_since = NULL
             WHERE alert_state.firing <> EXCLUDED.firing RETURNING rule_id`,
            [org],
          );
          await c.query("COMMIT");
          return (r.rowCount ?? 0) > 0;
        } finally {
          c.release();
        }
      };
      const results = await Promise.all([
        st.claimTransition(org, "r1", true, 480, NOW).then((c) => c !== null),
        st.claimTransition(org, "r1", true, 481, NOW).then((c) => c !== null),
        viaOther(),
        st.claimTransition(org, "r1", true, 482, NOW).then((c) => c !== null),
        viaOther(),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);

      const s = (await st.loadStates(org)).get("r1");
      expect(s?.firing).toBe(true);
      expect(s?.pendingSince).toBeNull();
      // a pending start never touches a firing row
      await st.setPending(org, "r1", NOW, 1);
      expect((await st.loadStates(org)).get("r1")?.pendingSince).toBeNull();

      // Resolve: two at once, one winner; a third later finds nothing to resolve.
      const resolved = await Promise.all([st.claimTransition(org, "r1", false, 90, NOW + 60_000), st.claimTransition(org, "r1", false, 91, NOW + 60_000)]);
      expect(resolved.filter((r) => r !== null)).toHaveLength(1);
      expect(await st.claimTransition(org, "r1", false, 92, NOW + 120_000)).toBeNull();
      // a resolve for a rule that never fired is not a transition
      expect(await st.claimTransition(org, "never", false, 1, NOW)).toBeNull();

      // Delivery: a failure is visible, the retry's answer merges in.
      const win = resolved.find((r) => r !== null)!;
      await st.recordDelivery(org, win.eventId, { c1: "HTTP 500", c2: "ok" });
      await st.recordDelivery(org, win.eventId, { c1: "ok" });
      const events = await st.recentEvents(org);
      const kinds = events.map((e) => e.kind);
      // The winning firing claim may have come from the other pool (no event row then); the
      // resolve came from claimTransition, so its row is there.
      expect(kinds[0]).toBe("resolved");
      expect(events[0].delivered).toEqual({ c1: "ok", c2: "ok" });
      expect(events[0].value).toBe(resolved[0] ? 90 : 91);

      // History keeps the last 5 per rule, newest first.
      for (let i = 0; i < 7; i++) await st.claimTransition(org, "r2", i % 2 === 0, i, NOW + i * 60_000);
      const r2 = (await st.recentEvents(org)).filter((e) => e.ruleId === "r2");
      expect(r2.map((e) => e.value)).toEqual([6, 5, 4, 3, 2]);
      expect(r2[0].delivered).toBeNull();

      await st.forgetRule(org, "r2");
      expect((await st.recentEvents(org)).some((e) => e.ruleId === "r2")).toBe(false);
      expect((await st.loadStates(org)).has("r2")).toBe(false);
    } finally {
      await other.end();
      await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`);
    }
  });
});
