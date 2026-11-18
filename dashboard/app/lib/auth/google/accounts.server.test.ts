import { describe, expect, test } from "bun:test";
import { resolveGoogleUser, type GoogleAccountStore, type GoogleUser } from "./accounts.server";
import { GoogleAuthError, GoogleErrorCode, type GoogleIdentity } from "./types";

interface MemUser extends GoogleUser {
  passwordHash: string | null;
}

function memoryStore(seed: MemUser[] = []): GoogleAccountStore & { users: MemUser[]; admins: string[] } {
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
      if (!u || u.googleSub) return null;
      u.googleSub = sub;
      u.passwordHash = null;
      u.tokenVersion += 1;
      return u;
    },
    async create(input) {
      const u: MemUser = { id: input.id, email: input.email, googleSub: input.googleSub, tokenVersion: 0, passwordHash: null };
      if (users.length === 0) admins.push(u.id);
      users.push(u);
      return u;
    },
  };
}

const ADA: GoogleIdentity = { sub: "g-1", email: "ada@gmail.com", name: "Ada", hostedDomain: null };
const user = (over: Partial<MemUser> = {}): MemUser => ({ id: "u1", email: "ada@gmail.com", googleSub: null, tokenVersion: 0, passwordHash: "hash", ...over });
const codeOf = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as GoogleAuthError).code;

describe("resolveGoogleUser", () => {
  test("a new Google user is created for Gmail or Workspace emails; only the first user becomes platform admin", async () => {
    const store = memoryStore();
    const first = await resolveGoogleUser(store, { ...ADA, email: "ada@corp.example", hostedDomain: "corp.example" });
    expect(first.created).toBe(true);
    const second = await resolveGoogleUser(store, { sub: "g-2", email: "bob@gmail.com", name: "Bob", hostedDomain: null });
    expect(second.created).toBe(true);
    expect(store.admins).toEqual([first.user.id]);
  });

  test("a returning Google id signs in, even if the Google email has changed", async () => {
    const store = memoryStore([user({ googleSub: "g-1", tokenVersion: 3 })]);
    const r = await resolveGoogleUser(store, { ...ADA, email: "new-address@gmail.com" });
    expect(r).toMatchObject({ created: false, linked: false, user: { id: "u1", tokenVersion: 3 } });
  });

  test("linking a Gmail address to a password account drops the password and bumps token_version (pre-claim takeover)", async () => {
    const store = memoryStore([user({ email: "Ada@Gmail.com", tokenVersion: 4 })]);
    const r = await resolveGoogleUser(store, ADA);
    expect(r).toMatchObject({ created: false, linked: true, user: { id: "u1", googleSub: "g-1", tokenVersion: 5 } });
    expect(store.users[0].passwordHash).toBeNull();
    expect(store.users.length).toBe(1);
  });

  test("a Workspace account (hd claim) may link too, also on a non-Gmail address", async () => {
    const store = memoryStore([user({ email: "jane@acme.com" })]);
    const r = await resolveGoogleUser(store, { sub: "g-9", email: "jane@acme.com", name: "Jane", hostedDomain: "acme.com" });
    expect(r.linked).toBe(true);
    expect(store.users[0].passwordHash).toBeNull();
  });

  test("a custom-domain address without hd is refused outright: nothing read, linked or created", async () => {
    const calls: string[] = [];
    const base = memoryStore([user({ email: "jane@acme.com" })]);
    const spy: GoogleAccountStore = {
      findBySub: async (s) => (calls.push("findBySub"), base.findBySub(s)),
      findByEmail: async (e) => (calls.push("findByEmail"), base.findByEmail(e)),
      linkSub: async (i, s) => (calls.push("linkSub"), base.linkSub(i, s)),
      create: async (i) => (calls.push("create"), base.create(i)),
    };
    const unknown = { sub: "g-9", email: "new@acme.com", name: "New", hostedDomain: null };
    expect(await codeOf(resolveGoogleUser(spy, { ...unknown, email: "jane@acme.com" }))).toBe(GoogleErrorCode.EmailNotSupported);
    expect(await codeOf(resolveGoogleUser(spy, unknown))).toBe(GoogleErrorCode.EmailNotSupported);
    expect(calls).toEqual([]);
    expect(base.users[0]).toMatchObject({ googleSub: null, passwordHash: "hash", tokenVersion: 0 });
    expect(base.users.length).toBe(1);
  });

  test("an email already tied to a different Google id is refused, even for Gmail", async () => {
    const store = memoryStore([user({ googleSub: "g-other" })]);
    expect(await codeOf(resolveGoogleUser(store, ADA))).toBe(GoogleErrorCode.AccountConflict);
    expect(store.users[0].googleSub).toBe("g-other");
  });

  test("losing the link race to a different Google id is a conflict, to the same id a sign-in", async () => {
    const base = memoryStore([user()]);
    const lostToOther: GoogleAccountStore = { ...base, async linkSub() { base.users[0].googleSub = "g-other"; return null; } };
    expect(await codeOf(resolveGoogleUser(lostToOther, ADA))).toBe(GoogleErrorCode.AccountConflict);
    const base2 = memoryStore([user()]);
    const lostToSame: GoogleAccountStore = { ...base2, async linkSub() { base2.users[0].googleSub = "g-1"; return null; } };
    expect((await resolveGoogleUser(lostToSame, ADA)).user.id).toBe("u1");
  });

  test("losing a creation race signs in as the account that won, applying the same link rules", async () => {
    const store = memoryStore();
    const racing: GoogleAccountStore = {
      ...store,
      async create(input) {
        await store.create({ ...input, id: "winner" });
        throw new Error("duplicate key");
      },
    };
    expect((await resolveGoogleUser(racing, ADA)).user.id).toBe("winner");

    // the winner is a password account made by someone else
    const store2 = memoryStore();
    const racing2: GoogleAccountStore = {
      ...store2,
      async create() {
        store2.users.push(user({ id: "attacker", email: "jane@acme.com" }));
        throw new Error("duplicate key");
      },
    };
    // a Workspace token links the account the other tab made (it is a password account, so it is linked, password dropped)
    const r2 = await resolveGoogleUser(racing2, { sub: "g-9", email: "jane@acme.com", name: "J", hostedDomain: "acme.com" });
    expect(r2.linked).toBe(true);
    expect(store2.users.find((u) => u.id === "attacker")?.passwordHash).toBeNull();
  });
});
