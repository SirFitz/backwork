import { describe, expect, test } from "bun:test";

// A Google-only user has no password (BAC-101). Runs against a real Postgres:
//   DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test app/lib/auth/google/google-only-user.server.test.ts
const url = process.env.USAGE_TEST_DATABASE_URL;
const ready = !!url && process.env.DATABASE_URL === url;

function post(path: string, fields: Record<string, string>, cookie = ""): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:3000", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields),
  });
}

describe("account with no password", () => {
  test.skipIf(!ready)("password login fails with the usual message, and the account page sets a first password without a current one", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { users } = await import("~/db/schema");
    const { eq } = await import("drizzle-orm");
    const login = await import("~/routes/login");
    const account = await import("~/routes/account");
    const { createUserSession } = await import("~/lib/auth/session.server");
    const { verifyPassword } = await import("~/lib/auth/password.server");
    await ensureSchema();

    const id = `gonly-${Date.now()}`;
    const email = `${id}@example.com`;
    await db.insert(users).values({ id, email, name: "G Only", googleSub: id, emailVerifiedAt: new Date() });
    try {
      // 1. password login against a null hash is the ordinary refusal, not a crash
      const res = (await login.action({ request: post("/login", { email, password: "Whatever12345" }), params: {}, context: {} })) as Response;
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid email or password." });

      // 2. the account page lets them set a password with no current one
      const session = await createUserSession(id, null, "/", 0);
      const cookie = (session.headers.get("Set-Cookie") ?? "").split(";")[0];
      const set = (await account.action({
        request: post("/account", { intent: "password", next: "Hunter2hunter2", confirm: "Hunter2hunter2" }, cookie),
        params: {},
        context: {},
      })) as Response;
      expect(set.status).toBe(200);
      expect(await set.json()).toMatchObject({ ok: "Password set. Other devices have been signed out.", scope: "password" });
      const row = (await db.select().from(users).where(eq(users.id, id)))[0];
      expect(row.passwordHash).toBeTruthy();
      expect(await verifyPassword(row.passwordHash!, "Hunter2hunter2")).toBe(true);
      expect(row.tokenVersion).toBe(1);

      // 3. now they have one, a wrong current password is refused as before
      const cookie2 = ((await createUserSession(id, null, "/", 1)).headers.get("Set-Cookie") ?? "").split(";")[0];
      const bad = (await account.action({
        request: post("/account", { intent: "password", current: "nope", next: "Another12345", confirm: "Another12345" }, cookie2),
        params: {},
        context: {},
      })) as Response;
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: "Current password is incorrect." });
    } finally {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  test.skipIf(!ready)("linking Google to a password account drops the password and sessions; the link is a single conditional write", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { users } = await import("~/db/schema");
    const { eq } = await import("drizzle-orm");
    const { drizzleGoogleStore, resolveGoogleUser } = await import("./accounts.server");
    await ensureSchema();
    const id = `claim-${Date.now()}`;
    const email = `${id}@gmail.com`;
    await db.insert(users).values({ id, email, passwordHash: "attacker-chosen-hash", tokenVersion: 2 });
    try {
      const r = await resolveGoogleUser(drizzleGoogleStore, { sub: `${id}-sub`, email, name: "Victim", hostedDomain: null });
      expect(r).toMatchObject({ linked: true, created: false, user: { id, tokenVersion: 3 } });
      const row = (await db.select().from(users).where(eq(users.id, id)))[0];
      expect(row.passwordHash).toBeNull();
      expect(row.googleSub).toBe(`${id}-sub`);
      // a second Google id cannot overwrite the first, and the unconditional write is gone
      expect(await drizzleGoogleStore.linkSub(id, "someone-else")).toBeNull();
      expect((await db.select().from(users).where(eq(users.id, id)))[0].googleSub).toBe(`${id}-sub`);
    } finally {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  test.skipIf(!ready)("two sign-ups at once on an empty table make exactly one platform admin", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { users } = await import("~/db/schema");
    const { sql } = await import("drizzle-orm");
    const { insertUserFirstAdmin } = await import("~/lib/auth/users.server");
    await ensureSchema();
    const tag = `race-${Date.now()}`;
    // Only meaningful on an empty users table (a fresh database).
    const existing = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    if (existing[0].n > 0) return; // not an empty database; the lock is exercised on fresh ones (CI/local stack)
    try {
      await Promise.all([1, 2, 3, 4].map((i) => insertUserFirstAdmin({ id: `${tag}-${i}`, email: `${tag}-${i}@example.com` }, { id: users.id })));
      const admins = await db.execute(sql`select count(*)::int as n from users where id like ${`${tag}-%`} and is_platform_admin`);
      expect(admins.rows[0]).toEqual({ n: 1 });
    } finally {
      await db.execute(sql`delete from users where id like ${`${tag}-%`}`);
    }
  });
});
