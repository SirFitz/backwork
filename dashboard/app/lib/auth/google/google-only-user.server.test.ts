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
});
