import { describe, expect, test } from "bun:test";

// The bulk peer read against a real Postgres (opt-in). The app's `db` reads DATABASE_URL when
// first imported, so give the same URL for both:
//   DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test app/lib/hops/peers.server.test.ts
const url = process.env.USAGE_TEST_DATABASE_URL;
const ready = !!url && process.env.DATABASE_URL === url;

describe("peer_services bulk read", () => {
  test.skipIf(!ready)("all() lists the organisation's pairs newest first and peerServicesFor keeps the newest", async () => {
    const { db } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    const { peerStore, peerServicesFor } = await import("~/lib/hops/peers.server");
    const org = `test-peers-${Date.now()}`;
    await peerStore.save(org, [{ peer: "pay.internal", service: "payments" }, { peer: "risk.internal", service: "risk" }]);
    await peerStore.save(`${org}-other`, [{ peer: "pay.internal", service: "elsewhere" }]);
    await db.execute(sql`UPDATE peer_services SET last_seen = now() - interval '1 hour' WHERE org_id = ${org}`);
    await peerStore.save(org, [{ peer: "pay.internal", service: "payments-v2" }]);
    try {
      const all = await peerStore.all(org);
      expect(all[0]).toEqual({ peer: "pay.internal", service: "payments-v2" });
      expect(all.length).toBe(3);
      const map = await peerServicesFor(org);
      expect(map.get("pay.internal")).toBe("payments-v2");
      expect(map.get("risk.internal")).toBe("risk");
      expect(map.size).toBe(2);
    } finally {
      await db.execute(sql`DELETE FROM peer_services WHERE org_id IN (${org}, ${`${org}-other`})`);
    }
  });
});
