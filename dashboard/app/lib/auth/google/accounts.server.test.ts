import { describe, expect, test } from "bun:test";
import { resolveGoogleUser, type GoogleAccountStore, type GoogleUser } from "./accounts.server";
import { GoogleAuthError, GoogleErrorCode, GoogleIntent, type GoogleIdentity } from "./types";

function memoryStore(seed: GoogleUser[] = []): GoogleAccountStore & { users: GoogleUser[]; admins: string[] } {
  const users = [...seed];
  const admins: string[] = [];
  return {
    users,
    admins,
    async findBySub(sub) {
      return users.find((u) => u.googleSub === sub) ?? null;
    },
    async findByEmail(email) {
      return users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
    },
    async linkSub(id, sub) {
      const u = users.find((x) => x.id === id);
      if (u) u.googleSub = sub;
    },
    async isEmpty() {
      return users.length === 0;
    },
    async create(input) {
      const u: GoogleUser = { id: input.id, email: input.email, googleSub: input.googleSub, tokenVersion: 0 };
      users.push(u);
      if (input.isPlatformAdmin) admins.push(input.id);
      return u;
    },
  };
}

const ADA: GoogleIdentity = { sub: "g-1", email: "ada@example.com", name: "Ada" };

describe("resolveGoogleUser", () => {
  test("sign-up creates a user; the very first one becomes platform admin, later ones do not", async () => {
    const store = memoryStore();
    const first = await resolveGoogleUser(store, ADA, GoogleIntent.SignUp);
    expect(first.created).toBe(true);
    expect(store.admins).toEqual([first.user.id]);
    const second = await resolveGoogleUser(store, { sub: "g-2", email: "bob@example.com", name: "Bob" }, GoogleIntent.SignUp);
    expect(second.created).toBe(true);
    expect(store.admins).toEqual([first.user.id]);
  });

  test("a returning Google id signs in, even if the Google email has changed", async () => {
    const store = memoryStore([{ id: "u1", email: "ada@example.com", googleSub: "g-1", tokenVersion: 3 }]);
    const r = await resolveGoogleUser(store, { ...ADA, email: "new-address@example.com" }, GoogleIntent.SignIn);
    expect(r).toMatchObject({ created: false, linked: false, user: { id: "u1", tokenVersion: 3 } });
  });

  test("an existing password user is linked by email, ignoring case, and keeps their id", async () => {
    const store = memoryStore([{ id: "u1", email: "Ada@Example.com", googleSub: null, tokenVersion: 0 }]);
    const r = await resolveGoogleUser(store, ADA, GoogleIntent.SignIn);
    expect(r).toMatchObject({ created: false, linked: true, user: { id: "u1", googleSub: "g-1" } });
    expect(store.users[0].googleSub).toBe("g-1");
    expect(store.users.length).toBe(1);
  });

  test("sign-up for an email that already has an account signs in rather than duplicating", async () => {
    const store = memoryStore([{ id: "u1", email: "ada@example.com", googleSub: null, tokenVersion: 0 }]);
    const r = await resolveGoogleUser(store, ADA, GoogleIntent.SignUp);
    expect(r.user.id).toBe("u1");
    expect(store.users.length).toBe(1);
  });

  test("sign-in with no account creates nothing", async () => {
    const store = memoryStore();
    const err = await resolveGoogleUser(store, ADA, GoogleIntent.SignIn).catch((e) => e);
    expect((err as GoogleAuthError).code).toBe(GoogleErrorCode.NoAccount);
    expect(store.users.length).toBe(0);
  });

  test("an email already tied to a different Google id is refused", async () => {
    const store = memoryStore([{ id: "u1", email: "ada@example.com", googleSub: "g-other", tokenVersion: 0 }]);
    const err = await resolveGoogleUser(store, ADA, GoogleIntent.SignIn).catch((e) => e);
    expect((err as GoogleAuthError).code).toBe(GoogleErrorCode.AccountConflict);
    expect(store.users[0].googleSub).toBe("g-other");
  });

  test("losing a creation race signs in as the account that won", async () => {
    const store = memoryStore();
    let calls = 0;
    const racing: GoogleAccountStore = {
      ...store,
      async create(input) {
        await store.create({ ...input, id: "winner" });
        calls++;
        throw new Error("duplicate key");
      },
    };
    const r = await resolveGoogleUser(racing, ADA, GoogleIntent.SignUp);
    expect(calls).toBe(1);
    expect(r.user.id).toBe("winner");
  });
});
